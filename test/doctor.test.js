import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, supportedNode } from '../src/doctor.js';

const base = {
  env: {},
  endpoint: () => 'https://approved.example/tms',
  external: async () => null,
  now: () => 100000,
};
test('지원 런타임을 판별하며 최소 버전 설치를 강요하거나 인증·네트워크를 자동 시도하지 않는다', async () => {
  for (const version of ['20.18.1', '20.19.0', '22.22.0', '24.13.0'])
    assert.equal(supportedNode(version), true);
  for (const version of ['18.20.0', '20.18.0', 'invalid'])
    assert.equal(supportedNode(version), false);
  const report = await diagnose({
    ...base,
    node: '20.18.0',
    external: async () => {
      throw Error('must not read');
    },
  });
  assert.equal(report.runtime.supported, false);
  assert.equal(report.auth.status, 'not_checked');
  assert.equal(report.ready, false);
});
test('키링 불가·로그인 부재를 구분하고 원본 에러·계정·토큰은 진단에 출력하지 않는다', async () => {
  const missing = await diagnose({ ...base, load: async () => null });
  assert.equal(missing.auth.status, 'login_required');
  const unavailable = await diagnose({
    ...base,
    load: async () => {
      throw Object.assign(Error('private native detail'), { code: 'TMS_KEYRING_UNAVAILABLE' });
    },
  });
  assert.equal(unavailable.auth.status, 'store_unavailable');
  assert.equal(unavailable.ready, false);
  assert.doesNotMatch(JSON.stringify(unavailable), /private native detail/);
});
test('로컬 준비와 실제 승인 여부를 구분하고 온라인 실패를 데이터 없음으로 바꾸지 않는다', async () => {
  let sends = 0;
  const deps = {
    ...base,
    env: { TMS_ID_TOKEN: 'synthetic-secret-token' },
    external: async () => ({
      idToken: 'synthetic-secret-token',
      uid: 'secret-uid',
      email: 'private@example.test',
      expiresAt: 1000000,
    }),
    load: async () => {
      throw Error('must skip keyring');
    },
    token: async () => 'synthetic-secret-token',
    catalog: async () => {
      sends++;
      return { sources: Array(30) };
    },
  };
  const offline = await diagnose(deps);
  assert.equal(offline.localReady, true);
  assert.equal(offline.ready, false);
  assert.equal(sends, 0);
  const online = await diagnose({ ...deps, online: true });
  assert.equal(online.ready, true);
  assert.equal(online.service.sourceCount, 30);
  assert.equal(sends, 1);
  assert.doesNotMatch(JSON.stringify(online), /synthetic-secret-token|secret-uid|private@example/);
  const denied = await diagnose({
    ...deps,
    online: true,
    catalog: async () => {
      throw Error('sensitive response');
    },
  });
  assert.equal(denied.ready, false);
  assert.equal(denied.service.verification, 'failed');
  assert.doesNotMatch(JSON.stringify(denied), /sensitive response/);
  const expired = await diagnose({
    ...deps,
    online: true,
    catalog: async () => {
      throw Object.assign(Error('private'), { code: 'TMS_AUTH_REJECTED' });
    },
  });
  assert.equal(expired.service.verification, 'authentication_rejected');
  const unavailable = await diagnose({
    ...deps,
    online: true,
    catalog: async () => {
      throw Object.assign(Error('private'), { code: 'TMS_NETWORK_UNAVAILABLE' });
    },
  });
  assert.equal(unavailable.service.verification, 'unreachable');
});
