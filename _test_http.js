'use strict';

const assert = require('assert').strict;
const ExcelJS = require('exceljs');

delete process.env.ENABLE_HOST_DIAGNOSTICS;
process.env.UPLOAD_RATE_MAX = '100';
const { app } = require('./server');
const { VALID_EVENTS } = require('./server/lib/telemetryEvents');

async function request(baseUrl, path, options) {
  return fetch(`${baseUrl}${path}`, options);
}

async function run() {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let passed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`  ✓  ${name}`);
      passed++;
    } catch (error) {
      console.error(`  ✗  ${name}`);
      throw error;
    }
  }

  try {
    console.log('\n[HTTP integration] security, errors, and telemetry contract');

    await test('health response includes baseline security headers', async () => {
      const response = await request(baseUrl, '/api/health');
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-powered-by'), null);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('x-frame-options'), 'DENY');
      assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
      assert.equal(response.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
    });

    await test('every shared telemetry event is accepted over HTTP', async () => {
      const originalLog = console.log;
      console.log = () => {};
      try {
        for (const event of VALID_EVENTS) {
          const response = await request(baseUrl, '/api/events', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ event, properties: { source: 'integration_test' } }),
          });
          assert.equal(response.status, 204, event);
        }
      } finally {
        console.log = originalLog;
      }
    });

    await test('unknown telemetry events are rejected', async () => {
      const response = await request(baseUrl, '/api/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event: 'invented_event' }),
      });
      assert.equal(response.status, 400);
    });

    await test('malformed JSON receives a client error instead of a 500', async () => {
      const response = await request(baseUrl, '/api/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"event":',
      });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: 'Invalid JSON request body.' });
    });

    await test('host diagnostics are disabled by default', async () => {
      const response = await request(baseUrl, '/health/host');
      assert.equal(response.status, 404);
    });

    await test('AI helper rejects unauthenticated requests before rate limiting', async () => {
      const response = await request(baseUrl, '/api/ai-helper', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('ratelimit-limit'), null);
    });

    await test('inventory upload accepts XLSX and analyzes the detected worksheet', async () => {
      const workbook = new ExcelJS.Workbook();
      workbook.addWorksheet('Cover').addRow(['ERP Inventory Export']);
      const worksheet = workbook.addWorksheet('Inventory');
      worksheet.addRow(['Generated', '2026-07-24']);
      worksheet.addRow(['Part No', 'QTY ON HAND', 'Avg Daily Usage', 'Lead Time']);
      worksheet.addRow(['MFG-2001', 40, 4, 15]);

      const workbookBuffer = await workbook.xlsx.writeBuffer();
      const form = new FormData();
      form.append(
        'csvfile',
        new Blob([workbookBuffer], {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }),
        'erp-inventory.xlsx'
      );

      const response = await request(baseUrl, '/upload', { method: 'POST', body: form });
      const body = await response.json();
      assert.equal(response.status, 200, body.error);
      assert.equal(body.sourceFormat, 'xlsx');
      assert.equal(body.encodingDetected, 'xlsx');
      assert.equal(body.worksheet, 'Inventory');
      assert.deepEqual(body.worksheetsAvailable, ['Cover', 'Inventory']);
      assert.equal(body.summary.total, 1);
      assert.equal(body.results[0].part_number, 'MFG-2001');
    });

    await test('inventory upload rejects legacy XLS files with an actionable error', async () => {
      const form = new FormData();
      form.append(
        'csvfile',
        new Blob(['legacy workbook'], { type: 'application/vnd.ms-excel' }),
        'legacy-inventory.xls'
      );

      const response = await request(baseUrl, '/upload', { method: 'POST', body: form });
      const body = await response.json();
      assert.equal(response.status, 400);
      assert.match(body.error, /\.csv and \.xlsx files are accepted/);
    });

    async function inventoryCSV(text, options = {}) {
      const form = new FormData();
      form.append('csvfile', new Blob([text], { type: 'text/csv' }), 'customer.csv');
      for (const [key, value] of Object.entries(options)) form.append(key, value);
      const response = await request(baseUrl, '/upload', { method: 'POST', body: form });
      return { status: response.status, body: await response.json() };
    }

    await test('customer headers require mapping and confirmed calendar conversions preserve priority', async () => {
      const text = 'Physical stock,Extra,Consumption 90D,Replenishment weeks,Material code,Warehouse\n25,no,900,2,00042,North';
      const preview = await inventoryCSV(text);
      assert.equal(preview.status, 422);
      assert.equal(preview.body.code, 'mapping_required');
      assert.equal(preview.body.examples[0][4], '00042');
      const mapped = await inventoryCSV(text, {
        mapping: JSON.stringify({ part_number: 'Material code', on_hand: 'Physical stock',
          daily_usage: 'Consumption 90D', lead_time: 'Replenishment weeks', site: 'Warehouse' }),
        usagePeriodDays: '90', leadTimeUnit: 'calendar_weeks',
      });
      assert.equal(mapped.status, 200);
      const [part] = mapped.body.results;
      assert.equal(part.part_number, '00042');
      assert.equal(part.coverage_raw, 2.5);
      assert.equal(part.lead_time, 14);
      assert.equal(part.site, 'North');
      assert.equal(mapped.body.summary.urgent_stockout, 1);
    });

    await test('limited imports show zero stock without assigning a shortage rating', async () => {
      const result = await inventoryCSV('SKU,Qty On Hand,ADU\n00012,0,10\n00013,25,', {
        mapping: JSON.stringify({ part_number: 'SKU', on_hand: 'Qty On Hand', daily_usage: 'ADU' }),
      });
      assert.equal(result.status, 200);
      assert.equal(result.body.inputScope, 'limited');
      assert.equal(result.body.summary.zero_on_hand, 1);
      assert.equal(result.body.summary.scored, 0);
      assert.equal(result.body.results[0].coverage_raw, 0);
      assert.equal(result.body.results[0].status, 'Invalid');
      assert.equal(result.body.results[1].coverage, null);
    });

    await test('Free preview preserves full counts at the 50,000-row limit', async () => {
      const rows = Array.from({ length: 50_000 }, (_, index) => `P${index},${index},1,10`);
      const headers = 'SKU,Qty On Hand,ADU,Lead Time\n';
      const result = await inventoryCSV(headers + rows.join('\n'));
      assert.equal(result.status, 200);
      assert.equal(result.body.summary.total, 50_000);
      assert.equal(result.body.results.length, 50);
      assert.equal(result.body.resultsTruncated, true);
      const over = await inventoryCSV(headers + rows.join('\n') + '\nLAST,2,1,10');
      assert.equal(over.status, 422);
      assert.match(over.body.error, /50,000 rows/);
    });

    await test('XLSX mapping chooses a worksheet and preserves formatted part identifiers', async () => {
      const workbook = new ExcelJS.Workbook();
      for (const name of ['East', 'West']) {
        const sheet = workbook.addWorksheet(name);
        sheet.addRow(['SKU', 'Qty On Hand', 'ADU', 'Lead Time']);
        const row = sheet.addRow([42, name === 'East' ? 20 : 0, 1, 10]);
        row.getCell(1).numFmt = '00000';
      }
      async function send(worksheet) {
        const form = new FormData();
        form.append('csvfile', new Blob([await workbook.xlsx.writeBuffer()]), 'sites.xlsx');
        if (worksheet) form.append('worksheet', worksheet);
        const response = await request(baseUrl, '/upload', { method: 'POST', body: form });
        return { status: response.status, body: await response.json() };
      }
      const preview = await send();
      assert.equal(preview.body.code, 'mapping_required');
      assert.deepEqual(preview.body.worksheets, ['East', 'West']);
      const selected = await send('West');
      assert.equal(selected.status, 200);
      assert.equal(selected.body.worksheet, 'West');
      assert.equal(selected.body.results[0].part_number, '00042');
      assert.equal(selected.body.summary.zero_on_hand, 1);
    });

    console.log(`\n${passed} HTTP integration tests passed`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

run().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
