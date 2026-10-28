import test from 'node:test';
import assert from 'node:assert/strict';
import { validateStructuredQuery } from '../src/retrieval.js';

test('허용된 페이지 한도를 넘으면 서버 요청 전에 다음 행동을 안내한다', () => {
  const query = { source: 'packaging-reports', filters: [{ field: 'workDate', op: 'eq', value: '2026-10-27' }], limit: 100 };
  assert.throws(() => validateStructuredQuery(query), /1부터 50까지/);
  assert.equal(validateStructuredQuery({ ...query, limit: 50 }).limit, 50);
});
import { retrievalEndpoint, retrieveImage, retrieveSpec, structuredQuery, retrievalCatalog, executePlan } from '../src/retrieval.js';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('신뢰되지 않은 서비스에 로그인 토큰을 보내지 않음', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('{}'); };
  try {
    assert.match(retrievalEndpoint(), /^https:\/\/oracle\.tail1b2b2b\.ts\.net:10000\/tms\/v1\/search$/);
    await assert.rejects(structuredQuery('secret', { source: 'jig-requests', filters: [{ field: 'itemName', op: 'eq', value: '가상' }] }, { endpoint: 'https://evil.example/v1/search', trustedOrigins: [] }), /신뢰/);
    await assert.rejects(structuredQuery('secret', { source: 'jig-requests', filters: [{ field: 'itemName', op: 'eq', value: '가상' }] }, { endpoint: 'http://search.example/v1/search', trustedOrigins: ['http://search.example'] }), /신뢰/);
    assert.equal(calls, 0);
    assert.throws(() => validateStructuredQuery({ source: 'jig-requests', filters: [], rawFirestore: true }));
  } finally { globalThis.fetch = original; }
});

test('검사 이미지는 신뢰된 서비스에서 내려받고 기존 파일과 실패한 부분 파일을 보호', async () => {
  const original = globalThis.fetch;
  const dir = await mkdtemp(join(tmpdir(), 'tms-retrieve-image-'));
  const options = { endpoint: 'https://search.example/v1/search', trustedOrigins: ['https://search.example'] };
  let calls = 0;
  globalThis.fetch = async (url, request) => {
    calls++;
    assert.match(url, /\/v1\/image\?id=q&index=1$/);
    assert.equal(request.headers.authorization, 'Bearer id-token');
    return new Response('image', { headers: { 'content-type': 'image/png' } });
  };
  try {
    const path = join(dir, 'photo.png');
    await retrieveImage('id-token', 'q', 1, path, options);
    assert.equal(await readFile(path, 'utf8'), 'image');
    await writeFile(path, 'original');
    await assert.rejects(retrieveImage('id-token', 'q', 1, path, options), { code: 'EEXIST' });
    assert.equal(calls, 1);
    assert.equal(await readFile(path, 'utf8'), 'original');
    globalThis.fetch = async () => new Response('bad', { headers: { 'content-type': 'text/html' } });
    const failed = join(dir, 'failed.png');
    await assert.rejects(retrieveImage('id-token', 'q', 1, failed, options), /형식/);
    await assert.rejects(stat(failed), { code: 'ENOENT' });
  } finally { globalThis.fetch = original; await rm(dir, { recursive: true, force: true }); }
});

test('사양서는 인증된 검색 서비스에서 지정 파일로 저장하고 덮어쓰지 않는다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tms-spec-'));
  const original = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, options) => { sent = { url, options }; return new Response('pdf', { headers: { 'content-type': 'application/pdf' } }); };
  try {
    const dest = join(dir, 'spec.pdf'), options = { endpoint: 'https://search.example/v1/search', trustedOrigins: ['https://search.example'] };
    await retrieveSpec('token', 'order-id', 'product', dest, options);
    assert.equal(await readFile(dest, 'utf8'), 'pdf');
    assert.match(sent.url, /\/v1\/spec\?id=order-id&kind=product$/);
    await assert.rejects(retrieveSpec('token', 'order-id', 'product', dest, options), { code: 'EEXIST' });
    await assert.rejects(retrieveSpec('token', 'order-id', 'film', join(dir, 'bad.pdf'), { endpoint: 'https://evil.example/v1/search', trustedOrigins: [] }), /신뢰/);
    globalThis.fetch = async () => new Response('pptx', { headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' } });
    const pptx = join(dir, 'spec.pptx');
    await retrieveSpec('token', 'order-id', 'film', pptx, options);
    assert.equal(await readFile(pptx, 'utf8'), 'pptx');
  } finally { globalThis.fetch = original; await rm(dir, { recursive: true, force: true }); }
});

test('승인된 HTTPS 서비스에만 사용자 토큰과 구조화된 검색을 보낸다', async () => {
  const original = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, options) => { sent = { url, options }; return new Response('{"items":[]}'); };
  try {
    const payload = { source: 'jig-requests', filters: [{ field: 'itemName', op: 'prefix', value: '구직각' }] };
    const result = await structuredQuery('id-token', payload, { endpoint: 'https://search.example/v1/search', trustedOrigins: ['https://search.example'] });
    assert.deepEqual(result.items, []);
    assert.equal(sent.options.headers.authorization, 'Bearer id-token');
    assert.deepEqual(JSON.parse(sent.options.body), payload);
  } finally { globalThis.fetch = original; }
});

test('필드 쿼리는 승인된 검색 서버에만 전달하고 외부 서버로는 토큰을 보내지 않는다', async () => {
  const original = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, options) => { sent = { url, options }; return new Response('{"items":[]}'); };
  try {
    const query = { source: 'jig-requests', filters: [{ field: 'itemName', op: 'prefix', value: '50G' }], limit: 20 };
    await structuredQuery('id-token', query, { endpoint: 'https://search.example/v1/search', trustedOrigins: ['https://search.example'] });
    assert.equal(sent.url, 'https://search.example/v1/query');
    assert.deepEqual(JSON.parse(sent.options.body), query);
    await assert.rejects(structuredQuery('secret', query, { endpoint: 'https://evil.example/v1/search', trustedOrigins: [] }), /신뢰/);
  } finally { globalThis.fetch = original; }
});

test('자료 사전은 신뢰된 서비스에서만 가져온다', async () => {
  const original = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, options) => { sent = { url, options }; return new Response('{"sources":[]}'); };
  try {
    await retrievalCatalog('id-token', { endpoint: 'https://search.example/v1/search', trustedOrigins: ['https://search.example'] });
    assert.equal(sent.url, 'https://search.example/v1/catalog');
    assert.equal(sent.options.headers.authorization, 'Bearer id-token');
    await retrievalCatalog('id-token', { endpoint: 'https://search.example/v1/search', trustedOrigins: ['https://search.example'] }, 'sample-requests');
    assert.equal(sent.url, 'https://search.example/v1/catalog?source=sample-requests');
    await assert.rejects(retrievalCatalog('id-token', { endpoint: 'https://search.example/v1/search', trustedOrigins: ['https://search.example'] }, '../users'), /업무 자료/);
    await assert.rejects(retrievalCatalog('secret', { endpoint: 'https://evil.example/v1/search', trustedOrigins: [] }), /신뢰/);
  } finally { globalThis.fetch = original; }
});

test('조회 계획은 신뢰된 서비스에만 전송한다', async () => {
  const original = globalThis.fetch; let sent;
  globalThis.fetch = async (url, options) => { sent = { url, options }; return new Response('{"steps":{}}'); };
  try {
    const plan = { steps: [{ id: 'one', query: { source: 'jig-requests', filters: [{ field: 'itemName', op: 'eq', value: '가상' }] } }] };
    await executePlan('id-token', plan, { endpoint: 'https://search.example/v1/search', trustedOrigins: ['https://search.example'] });
    assert.equal(sent.url, 'https://search.example/v1/plan');
    assert.deepEqual(JSON.parse(sent.options.body), plan);
    await assert.rejects(executePlan('secret', plan, { endpoint: 'https://evil.example/v1/search', trustedOrigins: [] }), /신뢰/);
  } finally { globalThis.fetch = original; }
});

test('공유 HTTPS 주소의 TMS 경로를 조회 종류별로 유지한다', async () => {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return new Response('{}'); };
  const options = { endpoint: 'https://search.example:10000/tms/v1/search', trustedOrigins: ['https://search.example:10000'] };
  try {
    await retrievalCatalog('token', options);
    await structuredQuery('token', { source: 'jig-requests', filters: [{ field: 'itemName', op: 'eq', value: '가상' }] }, options);
    await executePlan('token', { steps: [{ id: 'one' }] }, options);
    assert.deepEqual(calls.map(call => call.url), ['https://search.example:10000/tms/v1/catalog', 'https://search.example:10000/tms/v1/query', 'https://search.example:10000/tms/v1/plan']);
    assert.throws(() => retrievalEndpoint({ endpoint: 'https://search.example:10000/other/v1/search', trustedOrigins: ['https://search.example:10000'] }));
  } finally { globalThis.fetch = original; }
});
