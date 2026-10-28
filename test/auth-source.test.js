import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createExternalSessionReader,
  inspectIdToken,
  readProtectedTokenFile,
} from '../src/auth-source.js';
import { createTokenProvider } from '../src/session.js';

const time = 1700000000000;
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
function jwt(overrides = {}) {
  return [
    encode({ alg: 'RS256', kid: 'synthetic-only' }),
    encode({
      aud: 'hs-jig-b2093',
      iss: 'https://securetoken.google.com/hs-jig-b2093',
      sub: 'synthetic-user',
      iat: time / 1000,
      exp: time / 1000 + 3600,
      ...overrides,
    }),
    'syntheticSignature',
  ].join('.');
}
test('명시한 단기 토큰은 키링·갱신·저장 없이 사용하고 잘못된 소스는 기존 계정으로 대체하지 않는다', async () => {
  const env = { TMS_ID_TOKEN: jwt() };
  let loads = 0,
    sends = 0,
    saves = 0;
  const external = createExternalSessionReader({ env, now: () => time });
  const provider = createTokenProvider({
    external,
    load: async () => {
      loads++;
      throw Error('DBus absent');
    },
    send: async () => {
      sends++;
      throw Error();
    },
    save: async () => {
      saves++;
    },
  });
  assert.equal(await provider(), env.TMS_ID_TOKEN);
  assert.equal((await external()).signatureVerifiedLocally, false);
  env.TMS_ID_TOKEN = jwt({ sub: 'next-user' });
  assert.equal(await provider(), env.TMS_ID_TOKEN);
  env.TMS_ID_TOKEN = jwt({ exp: time / 1000 + 30 });
  await assert.rejects(provider(), { code: 'TMS_ID_TOKEN_EXPIRED' });
  assert.deepEqual([loads, sends, saves], [0, 0, 0]);
});
test('다른 프로젝트·미래·긴 유효기간·갱신 토큰과 충돌하는 소스를 인증으로 취급하지 않는다', async () => {
  for (const value of [
    'synthetic-refresh',
    'Bearer ' + jwt(),
    jwt({ aud: 'another-project' }),
    jwt({ sub: '../bad' }),
    jwt({ iat: time / 1000 + 120 }),
    jwt({ exp: time / 1000 + 7200 }),
  ]) {
    assert.throws(
      () => inspectIdToken(value, { now: time }),
      (error) => /^TMS_ID_TOKEN_/.test(error.code) && !error.message.includes(value),
    );
  }
  const reader = createExternalSessionReader({
    env: { TMS_ID_TOKEN: jwt(), TMS_ID_TOKEN_FILE: '/secret/token' },
    readFile: async () => {
      throw Error('should not read');
    },
  });
  await assert.rejects(reader(), { code: 'TMS_AUTH_SOURCE_CONFLICT' });
  await assert.rejects(createExternalSessionReader({ env: { TMS_ID_TOKEN: '' } })(), {
    code: 'TMS_ID_TOKEN_INVALID',
  });
});
function fileSystem({
  mode = 0o100600,
  owner = 1000,
  link = false,
  changed = false,
  swapped = false,
} = {}) {
  const data = Buffer.from(jwt() + '\n');
  let opened = 0,
    closed = 0,
    stats = 0;
  const stat = () => ({
    isFile: () => !link,
    uid: owner,
    mode,
    size: data.length,
    dev: 1,
    ino: 2,
    mtimeMs: 1,
    ctimeMs: 1,
  });
  const fs = {
    lstat: async () => stat(),
    open: async () => {
      opened++;
      return {
        stat: async () => {
          const s = stat();
          if (swapped) s.ino = 3;
          if (changed && ++stats === 2) s.mtimeMs = 2;
          return s;
        },
        read: async (buffer) => {
          data.copy(buffer);
          return { bytesRead: data.length };
        },
        close: async () => {
          closed++;
        },
      };
    },
  };
  return { fs, calls: () => ({ opened, closed }) };
}
test('보호된 파일은 매 요청 다시 읽고 소유권·권한·링크·열기 교체·읽는 중 변경을 검사한다', async () => {
  const valid = fileSystem();
  const load = () =>
    readProtectedTokenFile('/secret/token', { platform: 'linux', uid: 1000, fs: valid.fs });
  assert.equal(await load(), jwt());
  assert.equal(await load(), jwt());
  assert.deepEqual(valid.calls(), { opened: 2, closed: 2 });
  for (const options of [
    { mode: 0o100644 },
    { mode: 0o100700 },
    { owner: 0 },
    { link: true },
    { swapped: true },
    { changed: true },
  ]) {
    const invalid = fileSystem(options);
    await assert.rejects(
      readProtectedTokenFile('/secret/token', { platform: 'linux', uid: 1000, fs: invalid.fs }),
      { code: 'TMS_AUTH_FILE_UNSAFE' },
    );
    assert.equal(invalid.calls().opened, invalid.calls().closed);
  }
  await assert.rejects(
    readProtectedTokenFile('/secret/token', { platform: 'win32', fs: valid.fs }),
    { code: 'TMS_AUTH_FILE_UNSUPPORTED' },
  );
});
test('토큰 파일의 교체는 다음 요청에 반영되며 파일 오류도 키링으로 대체하지 않는다', async () => {
  let value = jwt(),
    reads = 0;
  const reader = createExternalSessionReader({
    env: { TMS_ID_TOKEN_FILE: '/secret/token' },
    now: () => time,
    readFile: async () => {
      reads++;
      if (!value) throw Error('secret source unavailable');
      return value;
    },
  });
  assert.equal((await reader()).uid, 'synthetic-user');
  value = jwt({ sub: 'rotated-user' });
  assert.equal((await reader()).uid, 'rotated-user');
  value = null;
  await assert.rejects(reader());
  assert.equal(reads, 3);
});
