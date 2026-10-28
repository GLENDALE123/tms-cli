import { createHash } from 'node:crypto';
const service = 'tms-cli:hs-jig-b2093';
const account = 'firebase-session';

async function entry(name = account) {
  const { Entry } = await import('@napi-rs/keyring');
  // Do not silently use Linux's nonpersistent kernel keyring.
  return new Entry(service, name, { linux: { store: 'secret-service' } });
}

const fingerprint = (session) => createHash('sha256').update(session.refreshToken).digest('hex');
const missing = (error) => /no entry|not found|not exist/i.test(String(error));

// Keep the refresh credential readable by older CLI versions. On Windows the
// password API stores UTF-16: a 1,374-char JWT alone exceeded its 1,280-char
// limit. The separate binary entry stores UTF-8 within the same OS vault.
export function createSessionStore(getEntry = entry) {
  async function baseSession() {
    let value;
    try {
      value = (await getEntry(account)).getPassword();
    } catch (error) {
      if (missing(error)) return null;
      throw new Error('운영체제 보안 저장소를 읽을 수 없습니다.');
    }
    if (!value) return null;
    try {
      const s = JSON.parse(value);
      if (
        typeof s.refreshToken !== 'string' ||
        !s.refreshToken ||
        typeof s.uid !== 'string' ||
        !s.uid
      )
        throw new Error();
      return s;
    } catch {
      throw new Error('저장된 로그인 정보가 올바르지 않습니다. tms login으로 다시 로그인하세요.');
    }
  }
  async function loadSession() {
    const s = await baseSession();
    if (!s) return null;
    try {
      const bytes = (await getEntry(`${account}:id-cache`)).getSecret();
      if (!bytes || bytes.length > 16384) return s;
      const cache = JSON.parse(Buffer.from(bytes).toString('utf8'));
      if (
        cache.version === 1 &&
        cache.uid === s.uid &&
        cache.refreshHash === fingerprint(s) &&
        typeof cache.idToken === 'string' &&
        cache.idToken &&
        Number.isFinite(cache.idTokenIssuedAt) &&
        Number.isFinite(cache.idTokenExpiresAt)
      ) {
        return {
          ...s,
          idToken: cache.idToken,
          idTokenIssuedAt: cache.idTokenIssuedAt,
          idTokenExpiresAt: cache.idTokenExpiresAt,
        };
      }
    } catch {
      /* Optional cache is not an alternative to the refresh credential. */
    }
    return s;
  }
  async function saveSession(s, { expected } = {}) {
    const base = { uid: s.uid, email: s.email, refreshToken: s.refreshToken };
    const text = JSON.stringify(base);
    try {
      const credential = await getEntry(account);
      if (expected) {
        const current = JSON.parse(credential.getPassword() || 'null');
        if (
          !current ||
          current.uid !== expected.uid ||
          current.refreshToken !== expected.refreshToken
        )
          return false;
      }
      // Do not rewrite an unchanged refresh credential during ID-cache writes.
      // In particular, logout cannot be undone merely by publishing that cache.
      const onlyCache =
        expected && s.uid === expected.uid && s.refreshToken === expected.refreshToken;
      if (!onlyCache && credential.getPassword() !== text) credential.setPassword(text);
    } catch {
      throw new Error(
        '운영체제 보안 저장소에 로그인 정보를 저장할 수 없습니다. 보안 저장소를 사용할 수 있는지 확인하세요.',
      );
    }
    if (typeof s.idToken === 'string' && s.idToken) {
      try {
        const latest = await baseSession();
        if (!latest || latest.uid !== s.uid || latest.refreshToken !== s.refreshToken) return false;
        const cache = {
          version: 1,
          uid: s.uid,
          refreshHash: fingerprint(s),
          idToken: s.idToken,
          idTokenIssuedAt: s.idTokenIssuedAt,
          idTokenExpiresAt: s.idTokenExpiresAt,
        };
        (await getEntry(`${account}:id-cache`)).setSecret(
          Buffer.from(JSON.stringify(cache), 'utf8'),
        );
      } catch {
        /* Cache failure preserves the refresh login; never use plaintext. */
      }
    } else {
      try {
        (await getEntry(`${account}:id-cache`)).deletePassword();
      } catch {
        /* No usable ID cache after a fresh login. */
      }
    }
  }
  async function clearSession() {
    try {
      (await getEntry(account)).deletePassword();
    } catch (error) {
      if (!missing(error)) throw new Error('운영체제 보안 저장소를 지울 수 없습니다.');
    }
    try {
      (await getEntry(`${account}:id-cache`)).deletePassword();
    } catch {
      /* No refresh session means no cached token can be used. */
    }
  }
  return { loadSession, saveSession, clearSession };
}

export const { loadSession, saveSession, clearSession } = createSessionStore();
