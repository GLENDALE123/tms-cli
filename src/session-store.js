import { mkdir, lstat, open, rename, unlink, rmdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import * as keyringStore from './credentials.js';
import { stateDirectory } from './state.js';

const issue = (code, message) => Object.assign(new Error(message), { code });
export function createCredentialStore({
  directory = join(stateDirectory(), 'auth'),
  platform = process.platform,
  uid = process.getuid?.(),
  keyring = keyringStore,
} = {}) {
  const marker = join(directory, 'backend.json'),
    sessionPath = join(directory, 'session.json'),
    lock = join(directory, '.lock');
  function unsafe() {
    return issue(
      'TMS_SESSION_STORE_UNSAFE',
      '로컬 세션 폴더는 현재 사용자 소유·0700, 세션 파일은 0600인 일반 파일이어야 합니다.',
    );
  }
  async function checkDirectory(create = false) {
    if (platform === 'win32')
      throw issue('TMS_SESSION_FILE_UNSUPPORTED', 'Windows에서는 OS 보안 저장소를 사용하세요.');
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    const s = await lstat(directory);
    if (!s.isDirectory() || s.uid !== uid || (s.mode & 0o777) !== 0o700) throw unsafe();
  }
  async function read(path) {
    let file;
    try {
      const before = await lstat(path);
      const safe = (s) =>
        s.isFile() && s.uid === uid && (s.mode & 0o777) === 0o600 && s.size > 0 && s.size <= 16384;
      if (!safe(before)) throw unsafe();
      file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const s = await file.stat();
      if (!safe(s) || s.ino !== before.ino || s.dev !== before.dev) throw unsafe();
      const bytes = Buffer.alloc(16385),
        { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      const after = await file.stat();
      if (
        bytesRead !== s.size ||
        !safe(after) ||
        after.size !== s.size ||
        after.mtimeMs !== s.mtimeMs ||
        after.ctimeMs !== s.ctimeMs
      )
        throw unsafe();
      return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (error?.code?.startsWith('TMS_')) throw error;
      throw unsafe();
    } finally {
      await file?.close().catch(() => {});
    }
  }
  async function kind() {
    try {
      await lstat(directory);
    } catch (error) {
      if (error.code === 'ENOENT') return 'os-keyring';
      throw unsafe();
    }
    await checkDirectory();
    const value = await read(marker);
    if (!value) return 'os-keyring';
    if (value.backend !== 'local-session-file' || Object.keys(value).length !== 1) throw unsafe();
    return 'local-session-file';
  }
  async function locked(fn) {
    await checkDirectory(true);
    const deadline = Date.now() + 2000;
    for (;;) {
      try {
        await mkdir(lock, { mode: 0o700 });
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw unsafe();
        if (Date.now() >= deadline)
          throw issue(
            'TMS_SESSION_BUSY',
            '다른 프로세스가 로그인 세션을 변경 중입니다. 잠시 후 다시 실행하세요.',
          );
        await sleep(25);
      }
    }
    try {
      return await fn();
    } finally {
      await rmdir(lock);
    }
  }
  async function write(path, value) {
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    if (bytes.length > 16384) throw unsafe();
    const temp = join(directory, '.session-' + randomBytes(12).toString('hex'));
    let file;
    try {
      file = await open(temp, 'wx', 0o600);
      await file.chmod(0o600);
      await file.writeFile(bytes);
      await file.sync();
      await file.close();
      file = null;
      await rename(temp, path);
    } finally {
      await file?.close().catch(() => {});
      await unlink(temp).catch(() => {});
    }
  }
  const validate = (s) => {
    if (
      !s ||
      typeof s.uid !== 'string' ||
      !s.uid ||
      s.uid.length > 128 ||
      typeof s.refreshToken !== 'string' ||
      !s.refreshToken ||
      s.refreshToken.length > 8192 ||
      (s.idToken !== undefined && (typeof s.idToken !== 'string' || s.idToken.length > 4096))
    )
      throw unsafe();
    return s;
  };
  async function loadSession() {
    if ((await kind()) === 'os-keyring') return keyring.loadSession();
    await checkDirectory();
    const s = await read(sessionPath);
    return s ? validate(s) : null;
  }
  async function saveSession(session, { expected } = {}) {
    if ((await kind()) === 'os-keyring') return keyring.saveSession(session, { expected });
    return locked(async () => {
      const current = await read(sessionPath);
      if (
        expected &&
        (!current || current.uid !== expected.uid || current.refreshToken !== expected.refreshToken)
      )
        return false;
      await write(sessionPath, validate(session));
    });
  }
  async function useLocalFile() {
    return locked(() => write(marker, { backend: 'local-session-file' }));
  }
  async function clearSession() {
    if ((await kind()) === 'os-keyring') return keyring.clearSession();
    await locked(async () => {
      await unlink(sessionPath).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    });
    // Keep the explicit backend selection: logout must not reveal an older OS account.
  }
  return { kind, loadSession, saveSession, clearSession, useLocalFile };
}
export const {
  kind: sessionStoreKind,
  loadSession,
  saveSession,
  clearSession,
  useLocalFile,
} = createCredentialStore();
