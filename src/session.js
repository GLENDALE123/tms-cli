import { config } from './config.js';
import { loadSession, saveSession } from './credentials.js';
import { request } from './http.js';
const changedSession = () =>
  Object.assign(new Error('갱신 중 로그인 정보가 변경되었습니다.'), {
    code: 'TMS_SESSION_CHANGED',
  });

export function createTokenProvider({
  load = loadSession,
  save = saveSession,
  send = request,
  now = Date.now,
} = {}) {
  let pending = null;
  async function token() {
    const session = await load();
    if (!session) throw new Error('로그인이 필요합니다. tms login을 실행하세요.');
    const time = now();
    if (
      typeof session.idToken === 'string' &&
      session.idToken &&
      Number.isFinite(session.idTokenIssuedAt) &&
      Number.isFinite(session.idTokenExpiresAt) &&
      session.idTokenExpiresAt - session.idTokenIssuedAt <= 3600000 &&
      time >= session.idTokenIssuedAt &&
      time < session.idTokenExpiresAt - 60000
    )
      return session.idToken;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: session.refreshToken,
    });
    const response = await send(
      `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(config.apiKey)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      },
    );
    const data = await response.json();
    if (
      typeof data.id_token !== 'string' ||
      !data.id_token ||
      typeof data.refresh_token !== 'string' ||
      !data.refresh_token ||
      data.user_id !== session.uid
    )
      throw new Error('인증 응답이 올바르지 않습니다. 다시 로그인하세요.');
    const clean = { uid: session.uid, email: session.email, refreshToken: data.refresh_token };
    const lifetime = Number(data.expires_in);
    if (Number.isFinite(lifetime) && lifetime > 60 && lifetime <= 3600 && Number.isFinite(time))
      Object.assign(clean, {
        idToken: data.id_token,
        idTokenIssuedAt: time,
        idTokenExpiresAt: time + lifetime * 1000,
      });
    const latest = await load();
    if (!latest || latest.uid !== session.uid)
      throw new Error('갱신 중 로그인 계정이 변경되었습니다. 명령을 다시 실행하세요.');
    if (
      latest.refreshToken === session.refreshToken &&
      (clean.idToken || data.refresh_token !== session.refreshToken || session.idToken)
    ) {
      try {
        if ((await save(clean, { expected: session })) === false) throw changedSession();
      } catch (error) {
        if (error?.code === 'TMS_SESSION_CHANGED') throw error;
        // Optional ID-token caching must not prevent storing a rotated refresh
        // token when a platform credential store rejects the larger entry.
        if (clean.idToken) {
          try {
            if (
              (await save(
                { uid: clean.uid, email: clean.email, refreshToken: clean.refreshToken },
                { expected: session },
              )) === false
            )
              throw changedSession();
          } catch (minimalError) {
            if (
              minimalError?.code === 'TMS_SESSION_CHANGED' ||
              data.refresh_token !== session.refreshToken
            )
              throw minimalError;
          }
        } else if (data.refresh_token !== session.refreshToken) throw error;
      }
    }
    return data.id_token;
  }
  return () => {
    if (!pending)
      pending = token().finally(() => {
        pending = null;
      });
    return pending;
  };
}

export const currentToken = createTokenProvider();
