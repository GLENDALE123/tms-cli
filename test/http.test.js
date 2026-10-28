import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from '../src/http.js';

test('검색 실패는 재시도·조건 수정에 필요한 사유를 보여주고 SDK 원문은 노출하지 않는다', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'query_requires_index', message: 'PRIVATE SDK URL' }), { status: 400 });
    await assert.rejects(request('https://search.example/tms/v1/query'), error => /복합 색인/.test(error.message) && !/PRIVATE/.test(error.message));
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'server_busy' }), { status: 503 });
    await assert.rejects(request('https://search.example/tms/v1/query'), /잠시 후/);
    globalThis.fetch = async () => new Response('{}', { status: 403 });
    await assert.rejects(request('https://search.example/tms/v1/query'), error => error.code === 'TMS_ACCESS_DENIED' && error.status === 403 && /TMS 계정 권한/.test(error.message));
    globalThis.fetch = async () => new Response('{}', { status: 401 });
    await assert.rejects(request('https://search.example/tms/v1/query'), { code: 'TMS_AUTH_REJECTED', status: 401 });
    globalThis.fetch = async () => { throw Error('PRIVATE transport detail'); };
    await assert.rejects(request('https://search.example/tms/v1/query'), error => error.code === 'TMS_NETWORK_UNAVAILABLE' && !error.message.includes('PRIVATE'));
  } finally { globalThis.fetch = original; }
});
