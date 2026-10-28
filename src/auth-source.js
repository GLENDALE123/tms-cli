import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { config } from './config.js';

const fail = (code, message) => Object.assign(new Error(message), { code });
export function authSourceName(env = process.env) {
  const token = env.TMS_ID_TOKEN !== undefined,
    file = env.TMS_ID_TOKEN_FILE !== undefined;
  return token && file
    ? 'conflict'
    : token
      ? 'environment'
      : file
        ? 'protected-token-file'
        : 'os-keyring';
}

// Claims are decoded only for local format/expiry checks. The retrieval service
// still verifies the signature, revocation, approval and current permissions.
export function inspectIdToken(value, { now = Date.now(), projectId = config.projectId } = {}) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 4096 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
  )
    throw fail(
      'TMS_ID_TOKEN_INVALID',
      'Firebase ID 토큰이 필요합니다. 비밀번호나 갱신 토큰은 사용할 수 없습니다.',
    );
  let header, claims;
  try {
    const [h, p] = value.split('.');
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    throw fail('TMS_ID_TOKEN_INVALID', 'Firebase ID 토큰 형식이 올바르지 않습니다.');
  }
  if (
    !header ||
    header.alg !== 'RS256' ||
    !claims ||
    claims.aud !== projectId ||
    claims.iss !== `https://securetoken.google.com/${projectId}` ||
    typeof claims.sub !== 'string' ||
    !claims.sub ||
    claims.sub.length > 128 ||
    claims.sub.includes('/') ||
    !Number.isSafeInteger(claims.iat) ||
    !Number.isSafeInteger(claims.exp) ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > 3600
  )
    throw fail('TMS_ID_TOKEN_INVALID', '이 TMS 프로젝트의 Firebase ID 토큰이 아닙니다.');
  if (!Number.isFinite(now) || claims.iat * 1000 > now + 60000 || claims.exp * 1000 - now <= 60000)
    throw fail(
      'TMS_ID_TOKEN_EXPIRED',
      'ID 토큰이 만료됐거나 만료까지 1분 이하입니다. 새 토큰을 주입하세요. 자동 갱신하지 않습니다.',
    );
  return {
    idToken: value,
    uid: claims.sub,
    email: typeof claims.email === 'string' ? claims.email : null,
    issuedAt: claims.iat * 1000,
    expiresAt: claims.exp * 1000,
    signatureVerifiedLocally: false,
  };
}

export async function readProtectedTokenFile(
  path,
  { platform = process.platform, uid = process.getuid?.(), fs = { open, lstat } } = {},
) {
  if (platform === 'win32')
    throw fail(
      'TMS_AUTH_FILE_UNSUPPORTED',
      'Windows에서는 OS 보안 저장소 또는 TMS_ID_TOKEN을 사용하세요. 토큰 파일은 POSIX 소유권·권한 검증이 가능한 환경만 지원합니다.',
    );
  if (typeof path !== 'string' || !isAbsolute(path))
    throw fail(
      'TMS_AUTH_FILE_UNSAFE',
      'TMS_ID_TOKEN_FILE에는 소유자만 읽을 수 있는 일반 파일의 절대 경로가 필요합니다.',
    );
  let file;
  try {
    const before = await fs.lstat(path);
    const safe = (s) =>
      s.isFile() &&
      s.uid === uid &&
      [0o400, 0o600].includes(s.mode & 0o777) &&
      s.size > 0 &&
      s.size <= 8192;
    if (!safe(before))
      throw fail(
        'TMS_AUTH_FILE_UNSAFE',
        '토큰 파일은 현재 사용자 소유의 일반 파일이어야 하며 권한은 0400 또는 0600이어야 합니다. 심볼릭 링크와 공유 파일은 허용하지 않습니다.',
      );
    file = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await file.stat();
    if (!safe(opened) || opened.dev !== before.dev || opened.ino !== before.ino)
      throw fail(
        'TMS_AUTH_FILE_UNSAFE',
        '토큰 파일이 변경됐습니다. 보호된 일반 파일을 다시 지정하세요.',
      );
    const buffer = Buffer.alloc(8193),
      { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const after = await file.stat();
    if (
      bytesRead > 8192 ||
      bytesRead !== opened.size ||
      !safe(after) ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    )
      throw fail(
        'TMS_AUTH_FILE_UNSAFE',
        '읽는 중 토큰 파일이 변경됐습니다. 파일을 원자적으로 교체한 뒤 다시 실행하세요.',
      );
    return buffer.subarray(0, bytesRead).toString('utf8').trim();
  } catch (error) {
    if (error?.code?.startsWith('TMS_')) throw error;
    throw fail(
      'TMS_AUTH_FILE_UNAVAILABLE',
      '주입된 토큰 파일을 읽을 수 없습니다. 경로·소유권·권한을 확인하세요.',
    );
  } finally {
    await file?.close().catch(() => {});
  }
}

export function createExternalSessionReader({
  env = process.env,
  now = Date.now,
  readFile = readProtectedTokenFile,
} = {}) {
  return async () => {
    const source = authSourceName(env);
    if (source === 'os-keyring') return null;
    if (source === 'conflict')
      throw fail(
        'TMS_AUTH_SOURCE_CONFLICT',
        'TMS_ID_TOKEN과 TMS_ID_TOKEN_FILE 중 하나만 지정하세요. 다른 계정으로 자동 전환하지 않습니다.',
      );
    const value =
      source === 'environment' ? env.TMS_ID_TOKEN : await readFile(env.TMS_ID_TOKEN_FILE);
    return { ...inspectIdToken(value, { now: now() }), source };
  };
}
export const readExternalSession = createExternalSessionReader();
