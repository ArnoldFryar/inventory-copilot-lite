'use strict';

const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const http = require('node:http');
const ExcelJS = require('exceljs');

const accounts = [
  { id: '11111111-1111-4111-8111-111111111111', email: 'planner-a@example.invalid' },
  { id: '22222222-2222-4222-8222-222222222222', email: 'planner-b@example.invalid' },
  { id: '33333333-3333-4333-8333-333333333333', email: 'free@example.invalid' },
].map(user => ({ ...user, aud: 'authenticated', app_metadata: {}, user_metadata: {} }));
const authTokens = new Map(accounts.map((account, index) => {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = encode({ alg: 'HS256' }) + '.' +
    encode({ sub: account.id, exp: Math.floor(Date.now() / 1000) + 3600 }) + '.fixture';
  return [token, { ...account, customer: 'cus_test_' + index }];
}));
const tokenFor = account => [...authTokens].find(([, user]) => user.id === account.id)[0];
const runs = new Map();
const events = new Set();
const providerPlans = new Map(accounts.map((_, index) => ['cus_test_' + index, index < 2 ? 'active' : 'inactive']));
const subscriptions = new Map(accounts.map((user, index) => [user.id, {
  user_id: user.id, stripe_customer_id: 'cus_test_' + index,
  plan: index < 2 ? 'pro' : 'free', subscription_status: index < 2 ? 'active' : 'inactive',
}]));
let invalidDraft = false;
let failBillingWrite = false;

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

function service() {
  return http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url, 'http://127.0.0.1');
    const table = url.pathname.slice('/rest/v1/'.length);
    const user = authTokens.get(req.headers.authorization?.slice(7));
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');

    if (req.method === 'OPTIONS') return json(res, 204);
    if (url.pathname === '/auth/v1/token') {
      const account = accounts.find(candidate => candidate.email === body.email);
      if (!account || body.password !== 'synthetic-password') return json(res, 400, { message: 'Invalid login credentials' });
      return json(res, 200, {
        user: account, access_token: tokenFor(account), refresh_token: 'test-only', token_type: 'bearer', expires_in: 3600,
      });
    }
    if (url.pathname === '/auth/v1/user') return json(res, user ? 200 : 401, user || { message: 'Sign in' });
    if (url.pathname === '/auth/v1/logout') return json(res, 204);
    if (url.pathname === '/auth/v1/recover') return json(res, 200, {});
    if (url.pathname === '/v1/chat/completions') {
      const supplied = JSON.parse(body.messages[1].content);
      assert.equal(supplied.rows.length, 1);
      const draft = { actions: [{ reference: invalidDraft ? 99 : 1, action: 'verify_receipt' }] };
      return json(res, 200, { model: 'test-provider', choices: [{ message: { content: JSON.stringify(draft) } }] });
    }
    if (table === 'rpc/record_subscription_event') {
      if (failBillingWrite) return json(res, 503, { message: 'Synthetic unavailable database' });
      if (!events.has(body.p_event_id)) {
        events.add(body.p_event_id);
        const existing = subscriptions.get(body.p_user_id);
        subscriptions.set(body.p_user_id, { ...existing, plan: body.p_plan, subscription_status: body.p_status });
      }
      return json(res, 200, null);
    }

    let rows;
    if (table === 'profiles') rows = accounts.map(account => ({ ...account, is_admin: false }));
    else if (table === 'stripe_processed_events') rows = [...events].map(id => ({ id }));
    else if (table === 'user_subscriptions') rows = [...subscriptions.values()];
    else if (table === 'analysis_runs') rows = [...runs.values()];
    else if (table === 'events' && req.method === 'POST') return json(res, 201);
    else return json(res, 404, { message: 'Unexpected test service request' });

    if (table === 'analysis_runs' && req.method === 'POST') {
      if (!runs.has(body.id)) runs.set(body.id, body);
      return json(res, 201);
    }
    if (table === 'user_subscriptions' && req.method === 'POST') {
      if (!subscriptions.has(body.user_id)) subscriptions.set(body.user_id, body);
      return json(res, 201);
    }
    const params = url.searchParams;
    for (const [name, filter] of params) {
      if (filter.startsWith('eq.')) rows = rows.filter(row => String(row[name]) === filter.slice(3));
      if (filter.startsWith('lt.')) rows = rows.filter(row => row[name] < filter.slice(3));
    }
    if (req.method === 'DELETE') {
      for (const row of rows) runs.delete(row.id);
      return json(res, 204);
    }
    if (params.get('order')?.startsWith('uploaded_at.desc')) {
      rows = rows.sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at));
    }
    const offset = Number(params.get('offset') || 0);
    rows = rows.slice(offset, offset + Number(params.get('limit') || rows.length));
    const columns = params.get('select')?.split(',');
    if (columns && columns[0] !== '*') {
      rows = rows.map(row => Object.fromEntries(columns.map(name => [name, row[name]])));
    }
    if ((req.headers.accept || '').includes('vnd.pgrst.object')) {
      return rows.length === 1 ? json(res, 200, rows[0]) : json(res, 406, { code: 'PGRST116' });
    }
    return json(res, 200, rows);
  });
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + server.address().port;
}

async function verifyAccountInBrowser(base, mockUrl, account, file) {
  const { chromium } = require('playwright');
  const executablePath = process.env.TEST_CHROMIUM_PATH;
  const browser = await chromium.launch(executablePath ? {
    executablePath,
    args: ['--no-sandbox', '--single-process', '--disable-dev-shm-usage', '--disable-gpu',
      '--disable-software-rasterizer', '--disable-webgl', '--no-zygote', '--in-process-gpu'],
  } : {});
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(10_000);
    const faults = [];
    page.on('pageerror', error => faults.push(error.message));
    await page.route('**/*', route => {
      const origin = new URL(route.request().url()).origin;
      return origin === base || origin === mockUrl ? route.continue() : route.abort();
    });
    await page.goto(base);
    await page.locator('#signInBtn').waitFor();
    await page.locator('#signInBtn').press('Enter');
    await page.locator('#authEmail').fill(account.email);
    await page.locator('#authPassword').fill('incorrect-password');
    await page.locator('#authSubmitBtn').click();
    await page.locator('#authError').filter({ hasText: 'Invalid login credentials' }).waitFor();
    await page.locator('#authForgot').click();
    await page.locator('#authSubmitBtn').click();
    await page.locator('#authError').filter({ hasText: 'Check your inbox for the password reset link.' }).waitFor()
      .catch(async error => { throw new Error(await page.locator('#authModal').innerText(), { cause: error }); });
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'signInBtn');
    await page.locator('#signInBtn').click();
    await page.locator('#authEmail').fill(account.email);
    await page.locator('#authPassword').fill('synthetic-password');
    await page.locator('#authSubmitBtn').click();
    await page.locator('#planBadge').filter({ hasText: /pro/i }).waitFor();

    const choose = (name, csv) => page.locator('#csvfile').setInputFiles({
      name, mimeType: 'text/csv', buffer: Buffer.from(csv),
    });
    const analyze = () => page.getByRole('button', { name: 'Analyze inventory', exact: true }).click();
    const resultRows = page.locator('#resultsBody tr');
    await choose('near-limit-browser.csv', file);
    const started = performance.now();
    await analyze();
    await resultRows.first().waitFor();
    const elapsed = Math.round(performance.now() - started);
    assert.equal(await resultRows.count(), 50);
    await page.locator('#saveRunBtn').click();
    const saved = page.getByRole('button', { name: 'Open near-limit-browser.csv' });
    await saved.waitFor();
    await page.getByRole('button', { name: 'New analysis' }).click();
    await saved.click();
    await page.locator('#inventoryUpload').waitFor({ state: 'hidden' });
    await resultRows.first().waitFor();
    assert.equal(await resultRows.count(), 50);
    await page.locator('#inventoryExports summary').click();
    await page.locator('#filterPart').fill('00000');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#exportBtn').click(),
    ]);
    const csv = await readFile(await download.path(), 'utf8');
    const lines = csv.split('\r\n');
    assert.equal(lines.length, 2);
    assert.match(lines[1], /^00000,East,/);
    assert.match(lines[1], /near-limit-browser\.csv,.*manual,filtered,49000,/);

    await page.getByRole('button', { name: 'New analysis' }).click();
    await choose('custom-erp.csv', 'Material code,Physical stock,ADU,Lead Time\n00042,25,10,14');
    await analyze();
    await page.locator('[name=part_number]').selectOption('Material code');
    await page.locator('[name=on_hand]').selectOption('Physical stock');
    await page.locator('#saveInventoryMapping').check();
    await page.getByRole('button', { name: 'Analyze with this mapping' }).click();
    await resultRows.getByText('00042', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'New analysis' }).click();
    await choose('custom-erp-reordered.csv', 'Physical stock,ADU,Material code,Lead Time,Extra\n25,10,00043,14,x');
    await analyze();
    await resultRows.getByText('00043', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'New analysis' }).click();
    await choose('custom-erp-renamed.csv', 'Actual stock,ADU,Material code,Lead Time\n25,10,00044,14');
    await analyze();
    await page.getByRole('heading', { name: 'Review column mapping' }).waitFor();
    assert.equal(await page.locator('[name=on_hand]').inputValue(), '');
    assert.deepEqual(faults, []);
    console.log(`Browser sign-in, recovery feedback, explicit save, reopen, filtered export, and mapping reuse passed. ${file.length} bytes / 49,000 rows rendered in ${elapsed} ms.`);
  } finally {
    await browser.close();
  }
}

async function run() {
  const mock = service();
  const mockUrl = await listen(mock);
  Object.assign(process.env, {
    NODE_ENV: 'test', PLAN: 'free', UPLOAD_RATE_MAX: '100',
    SUPABASE_URL: mockUrl, SUPABASE_ANON_KEY: 'test-anon', SUPABASE_SERVICE_KEY: 'test-service',
    STRIPE_SECRET_KEY: 'sk_test_fixture', STRIPE_PRO_PRICE_ID: 'price_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture',
    OPENAI_API_KEY: 'test-ai', AI_BASE_URL: mockUrl + '/v1',
  });
  const plans = require('./plans');
  const realStripe = plans.getStripe();
  plans.getStripe = () => ({
    webhooks: realStripe.webhooks,
    prices: {
      retrieve: async id => {
        assert.equal(id, 'price_fixture');
        return { unit_amount: 4900, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } };
      },
    },
    checkout: { sessions: {
      create: async session => {
        assert.equal(session.customer, 'cus_test_2');
        assert.equal(session.line_items[0].price, 'price_fixture');
        return { url: mockUrl + '/checkout' };
      },
    } },
    billingPortal: { sessions: {
      create: async session => {
        assert.equal(session.customer, 'cus_test_0');
        return { url: mockUrl + '/portal' };
      },
    } },
    subscriptions: {
      list: ({ customer }) => ({
        autoPagingToArray: async () => [{
          id: 'sub_' + customer, created: 10, status: providerPlans.get(customer),
          items: { data: [{ price: { id: 'price_fixture' } }] },
        }],
      }),
    },
  });

  const { app } = require('./server');
  const server = http.createServer(app);
  const base = await listen(server);
  const [pro, other, free] = accounts;
  const request = (path, account, options = {}) => fetch(base + path, {
    ...options, headers: { ...(account ? { Authorization: 'Bearer ' + tokenFor(account) } : {}), ...options.headers },
  });
  const post = (path, account, body) => request(path, account, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const upload = (account, text) => {
    const form = new FormData();
    form.append('csvfile', new Blob([text], { type: 'text/csv' }), 'account-inventory.csv');
    return request('/upload', account, { method: 'POST', body: form });
  };
  try {
    const file = 'SKU,Qty On Hand,ADU,Lead Time,Warehouse,Description\n' +
      Array.from({ length: 49_000 }, (_, i) => [
        String(i).padStart(5, '0'), i === 0 ? 0 : 20, 3, 15, 'East', 'x'.repeat(78),
      ].join(',')).join('\n');

    const preview = await (await upload(free, file)).json();
    assert.equal(preview.summary.total, 49_000);
    assert.equal(preview.results.length, 50);
    assert.equal(preview.analysisId, undefined);
    const full = await (await upload(pro, file)).json();
    assert.equal(full.plan.key, 'pro');
    assert.equal(full.results.length, 49_000);
    assert.ok(full.analysisId);
    assert.equal(runs.size, 0);
    assert.equal((await post('/api/runs', free, { analysisId: full.analysisId })).status, 403);
    assert.equal((await post('/api/runs', other, { analysisId: full.analysisId })).status, 409);
    const saved = await post('/api/runs', pro, { analysisId: full.analysisId });
    assert.equal(saved.status, 201);
    assert.equal((await post('/api/runs', pro, { analysisId: full.analysisId })).status, 200);
    assert.equal(runs.size, 1);
    const loaded = await (await request('/api/runs/' + full.analysisId, pro)).json();
    assert.equal(loaded.results_json.length, 49_000);
    assert.equal(loaded.completeness, 'full');
    assert.equal((await request('/api/runs/' + full.analysisId, other)).status, 404);
    assert.equal((await request('/api/runs/' + full.analysisId + '/compare', other)).status, 404);
    await request('/api/runs/' + full.analysisId, other, { method: 'DELETE' });
    assert.equal(runs.size, 1);
    console.log('Pro, Free, owner isolation, duplicate save, and 49,000-row reload passed.');

    const workbookResponse = await post('/api/inventory/export.xlsx', pro, {
      analysisId: full.analysisId, saved: true, rowIds: [loaded.results_json[0].row_id],
    });
    assert.equal(workbookResponse.status, 200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(await workbookResponse.arrayBuffer()));
    assert.equal(workbook.getWorksheet('Inventory').getCell('A2').value, '00000');
    assert.equal(workbook.getWorksheet('Source').getCell('B5').value, 49_000);

    const draftPayload = {
      analysisId: full.analysisId, saved: true, rowIds: [loaded.results_json[0].row_id], helperType: 'expedite_email',
    };
    const draft = await post('/api/ai-helper', pro, draftPayload);
    assert.equal(draft.status, 200);
    assert.match((await draft.json()).text, /00000 at East/);
    invalidDraft = true;
    assert.equal((await post('/api/ai-helper', pro, draftPayload)).status, 502);
    console.log('Text-safe XLSX and grounded AI draft passed.');

    const price = await (await request('/api/billing/price')).json();
    assert.equal(price.price.amount, 4900);
    assert.equal((await post('/api/billing/checkout', null, {})).status, 401);
    assert.equal((await post('/api/billing/checkout', pro, {})).status, 409);
    const checkout = await post('/api/billing/checkout', free, {});
    assert.equal((await checkout.json()).url, mockUrl + '/checkout');
    const portal = await post('/api/billing/portal', pro, {});
    assert.equal((await portal.json()).url, mockUrl + '/portal');
    const webhook = async (id, type) => {
      const body = JSON.stringify({ id, type, data: { object: { mode: 'subscription', customer: 'cus_test_2' } } });
      const signature = realStripe.webhooks.generateTestHeaderString({ payload: body, secret: 'whsec_fixture' });
      return request('/api/billing/webhook', null, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature }, body,
      });
    };
    providerPlans.set('cus_test_2', 'active');
    failBillingWrite = true;
    assert.equal((await webhook('evt_payment', 'checkout.session.completed')).status, 503);
    assert.equal(events.size, 0);
    failBillingWrite = false;
    assert.equal((await webhook('evt_payment', 'checkout.session.completed')).status, 200);
    assert.equal((await (await request('/api/plan', free)).json()).plan, 'pro');
    assert.equal((await webhook('evt_payment', 'checkout.session.completed')).status, 200);
    assert.equal(events.size, 1);
    providerPlans.set('cus_test_2', 'canceled');
    assert.equal((await webhook('evt_cancel', 'customer.subscription.deleted')).status, 200);
    assert.equal((await webhook('evt_delayed', 'customer.subscription.created')).status, 200);
    assert.equal((await (await request('/api/plan', free)).json()).plan, 'free');
    console.log('Checkout, portal, price, billing retry, duplicate event and delayed update passed.');
    if (process.env.TEST_ACCOUNT_BROWSER === '1') await verifyAccountInBrowser(base, mockUrl, pro, file);
  } finally {
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => mock.close(resolve))]);
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
