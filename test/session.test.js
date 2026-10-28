import test from 'node:test';
import assert from 'node:assert/strict';
import { createTokenProvider } from '../src/session.js';

test('만료 전 ID 토큰은 OS 보안 저장소에서 재사용하고 만료 직전에 갱신한다', async () => {
  let time = 100000, calls = 0, saves = 0;
  let session = { uid: 'fake-user', email: 'fake@example.test', refreshToken: 'refresh' };
  const current = createTokenProvider({ external: async () => null, load: async () => structuredClone(session), save: async value => { session = value; saves++; }, now: () => time, send: async () => { calls++; return { json: async () => ({ user_id: 'fake-user', id_token: `id-${calls}`, refresh_token: 'refresh', expires_in: '3600' }) }; } });
  assert.deepEqual(await Promise.all(Array.from({ length: 20 }, () => current())), Array(20).fill('id-1'));
  assert.equal(calls, 1);
  assert.equal(saves, 1);
  time += 30000;
  assert.equal(await current(), 'id-1'); assert.equal(calls, 1);
  time = session.idTokenExpiresAt - 60000;
  assert.equal(await current(), 'id-2'); assert.equal(calls, 2);
  time = session.idTokenIssuedAt - 1;
  assert.equal(await current(), 'id-3', '시계가 과거로 이동하면 캐시를 사용하지 않는다');
});

test('선택적 ID 토큰 캐시를 저장하지 못해도 갱신 토큰은 최소 형식으로 보존한다', async () => {
  let session = { uid: 'own', refreshToken: 'old' }, attempts = 0;
  const current = createTokenProvider({ external: async () => null, load: async () => session, save: async value => { attempts++; if (value.idToken) throw new Error('entry too large'); session = value; }, send: async () => ({ json: async () => ({ user_id: 'own', id_token: 'new-id', refresh_token: 'rotated', expires_in: 3600 }) }) });
  assert.equal(await current(), 'new-id');
  assert.equal(session.refreshToken, 'rotated');
  assert.equal(session.idToken, undefined);
  assert.equal(attempts, 2);
});

test('다른 계정의 갱신 응답과 로그인 해제는 캐시로 우회하지 않는다', async () => {
  let session = { uid: 'own', refreshToken: 'refresh' };
  const current = createTokenProvider({ external: async () => null, load: async () => session, save: async () => { throw new Error('저장하면 안 됨'); }, send: async () => ({ json: async () => ({ user_id: 'other', id_token: 'wrong', refresh_token: 'refresh' }) }) });
  await assert.rejects(current(), /인증 응답/);
  session = null;
  await assert.rejects(current(), /로그인이 필요/);
});

test('마지막 읽기 후 로그아웃이 감지되면 선택 캐시 실패로 취급해 토큰을 반환하지 않는다', async () => {
 const session={uid:'own',refreshToken:'refresh'};
 const current=createTokenProvider({external:async()=>null,load:async()=>session,save:async()=>false,send:async()=>({json:async()=>({user_id:'own',id_token:'id',refresh_token:'refresh',expires_in:3600})})});
 await assert.rejects(current(),{code:'TMS_SESSION_CHANGED'});
});
