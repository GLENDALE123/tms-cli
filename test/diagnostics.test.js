import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from '../src/http.js';

test('진단은 명시적으로 켰을 때만 기록하고 URL·토큰·검색 조건을 남기지 않는다', async () => {
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stderr.write;
  const originalFlag = process.env.TMS_CLI_DIAGNOSTICS;
  const lines = [];
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  process.stderr.write = value => { lines.push(String(value)); return true; };
  try {
    delete process.env.TMS_CLI_DIAGNOSTICS;
    await request('https://firestore.googleapis.com/private?token=SECRET', { headers: { authorization: 'Bearer TOKEN' } });
    assert.equal(lines.length, 0);
    process.env.TMS_CLI_DIAGNOSTICS = '1';
    await request('https://firestore.googleapis.com/private?token=SECRET', { headers: { authorization: 'Bearer TOKEN' } });
    const event = JSON.parse(lines[0]);
    assert.equal(event.service, 'firestore');
    assert.equal(event.status, 200);
    assert.ok(Number.isInteger(event.headersMs));
    assert.ok(!lines[0].includes('SECRET'));
    assert.ok(!lines[0].includes('TOKEN'));
    assert.ok(!lines[0].includes('private'));
  } finally {
    if (originalFlag === undefined) delete process.env.TMS_CLI_DIAGNOSTICS;
    else process.env.TMS_CLI_DIAGNOSTICS = originalFlag;
    process.stderr.write = originalWrite;
    globalThis.fetch = originalFetch;
  }
});
