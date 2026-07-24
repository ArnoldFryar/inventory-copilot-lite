'use strict';

const assert = require('assert').strict;
const ExcelJS = require('exceljs');

delete process.env.ENABLE_HOST_DIAGNOSTICS;
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

    console.log(`\n${passed} HTTP integration tests passed`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

run().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
