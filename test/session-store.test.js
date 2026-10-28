import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCredentialStore } from '../src/session-store.js';
const session = {
  uid: 'synthetic-user',
  email: 'fake@example.test',
  refreshToken: 'synthetic-refresh',
};
test('선택하지 않은 저장소는 기존 OS 로그인을 유지하며 파일을 만들지 않는다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tms-store-select-'));
  let loads = 0;
  try {
    const store = createCredentialStore({
      directory: join(root, 'auth'),
      keyring: {
        loadSession: async () => {
          loads++;
          return session;
        },
      },
    });
    assert.equal(await store.kind(), 'os-keyring');
    assert.deepEqual(await store.loadSession(), session);
    assert.equal(loads, 1);
    await assert.rejects(stat(join(root, 'auth')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test(
  'POSIX 세션은 0700/0600으로 보존·재사용하고 로그아웃 뒤 갱신이 되살리지 않으며 OS로 전환하지 않는다',
  { skip: process.platform === 'win32' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'tms-store-posix-'));
    let osReads = 0;
    try {
      const options = {
          directory: join(root, 'auth'),
          keyring: {
            loadSession: async () => {
              osReads++;
              return { uid: 'other-os-account' };
            },
          },
        },
        store = createCredentialStore(options);
      await store.useLocalFile();
      await store.saveSession(session);
      assert.equal((await stat(options.directory)).mode & 0o777, 0o700);
      assert.equal((await stat(join(options.directory, 'session.json'))).mode & 0o777, 0o600);
      assert.deepEqual(await createCredentialStore(options).loadSession(), session);
      await store.clearSession();
      assert.equal(
        await store.saveSession({ ...session, idToken: 'old-cache' }, { expected: session }),
        false,
      );
      assert.equal(await store.loadSession(), null);
      assert.equal(osReads, 0);
      await store.saveSession(session);
      await chmod(join(options.directory, 'session.json'), 0o644);
      await assert.rejects(store.loadSession(), { code: 'TMS_SESSION_STORE_UNSAFE' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
