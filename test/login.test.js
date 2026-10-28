import test from 'node:test';
import assert from 'node:assert/strict';
import { login } from '../src/login.js';

test('브라우저 로그인은 loopback, origin과 일회성 상태를 검증한 후 저장', async () => {
  let saved;
  const result = await login({
    timeoutMs: 5000,
    save: async session => { saved = session; },
    launch: url => {
      void (async () => {
        const address = new URL(url);
        const state = address.hash.slice(1);
        const base = address.origin;
        assert.equal(address.hostname, '127.0.0.1');
        const payload = JSON.stringify({ state, uid: 'abc', email: 'test@example.com', refreshToken: 'private' });
        const request = (origin, body) => fetch(`${base}/session`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body });
        assert.equal((await request('https://attacker.example', payload)).status, 403);
        assert.equal((await request(base, JSON.stringify({ state: 'wrong' }))).status, 403);
        assert.equal(saved, undefined);
        assert.equal((await fetch(base)).status, 200);
        assert.equal((await request(base, payload)).status, 200);
      })().catch(error => { throw error; });
    },
  });
  assert.deepEqual(result, { uid: 'abc', email: 'test@example.com' });
  assert.equal(saved.refreshToken, 'private');
});
