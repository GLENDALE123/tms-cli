import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionStore } from '../src/credentials.js';

function vault({ binaryFails = false } = {}) {
  const values = new Map(),
    writes = [];
  const entry = async (key) => ({
    getPassword() {
      const v = values.get(key);
      return typeof v === 'string' ? v : null;
    },
    setPassword(v) {
      if (v.length > 1280) throw Error('Windows text limit');
      values.set(key, v);
      writes.push(key);
    },
    getSecret() {
      const v = values.get(key);
      return Buffer.isBuffer(v) ? [...v] : null;
    },
    setSecret(v) {
      if (binaryFails) throw Error('vault locked');
      if (v.length > 2560) throw Error('binary limit');
      values.set(key, Buffer.from(v));
      writes.push(key);
    },
    deletePassword() {
      return values.delete(key);
    },
  });
  return { values, writes, entry, store: createSessionStore(entry) };
}
const base = { uid: 'user-a', email: 'fake@example.test', refreshToken: 'private-refresh' };
const cached = {
  ...base,
  idToken: 'x'.repeat(1374),
  idTokenIssuedAt: 1000,
  idTokenExpiresAt: 3601000,
};
test('Windows 문자열 한도보다 긴 JWT를 OS 바이너리 항목에 보존하고 이전 CLI의 갱신 항목은 유지한다', async () => {
  const v = vault();
  await v.store.saveSession(base);
  await v.store.saveSession(cached, { expected: base });
  assert.deepEqual(await v.store.loadSession(), cached);
  assert.deepEqual(JSON.parse(v.values.get('firebase-session')), base);
  assert.equal(v.writes.filter((k) => k === 'firebase-session').length, 1);
});
test('로그아웃·다른 계정·외부 CLI가 교체한 갱신 토큰에는 이전 ID 캐시를 적용하지 않는다', async () => {
  const v = vault();
  await v.store.saveSession(cached);
  v.values.set('firebase-session', JSON.stringify({ ...base, refreshToken: 'another-refresh' }));
  assert.equal((await v.store.loadSession()).idToken, undefined);
  v.values.set('firebase-session', JSON.stringify({ ...base, uid: 'user-b' }));
  assert.equal((await v.store.loadSession()).idToken, undefined);
  await v.store.clearSession();
  assert.equal(await v.store.loadSession(), null);
  assert.equal(await v.store.saveSession(cached, { expected: base }), false);
  assert.equal(await v.store.loadSession(), null, 'ID 캐시 갱신이 로그인을 복원하지 않는다');
});
test('선택 캐시 저장 실패나 손상은 갱신 로그인 정보를 파괴하지 않는다', async () => {
  const v = vault({ binaryFails: true });
  await v.store.saveSession(cached);
  assert.deepEqual(await v.store.loadSession(), base);
  const ok = vault();
  await ok.store.saveSession(base);
  ok.values.set('firebase-session:id-cache', Buffer.from('invalid json'));
  assert.deepEqual(await ok.store.loadSession(), base);
});

test('갱신 검증과 ID 캐시 저장 사이에 로그아웃하면 캐시 저장을 거절한다', async () => {
  const v = vault();
  await v.store.saveSession(base);
  let reads = 0;
  const store = createSessionStore(async (key) => {
    const credential = await v.entry(key);
    if (key === 'firebase-session') {
      const read = credential.getPassword;
      credential.getPassword = () => {
        if (++reads === 2) v.values.delete(key);
        return read();
      };
    }
    return credential;
  });
  assert.equal(await store.saveSession(cached, { expected: base }), false);
  assert.equal(await store.loadSession(), null);
  assert.equal(v.values.has('firebase-session:id-cache'), false);
});
