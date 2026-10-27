import { config } from './config.js';
import { loadSession, saveSession } from './credentials.js';
import { request } from './http.js';

export async function currentToken() {
  const session = await loadSession();
  if (!session) throw new Error('로그인이 필요합니다. tms login을 실행하세요.');
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: session.refreshToken });
  const response = await request(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(config.apiKey)}`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
  });
  const data = await response.json();
  if (!data.id_token || !data.refresh_token || data.user_id !== session.uid) throw new Error('인증 응답이 올바르지 않습니다. 다시 로그인하세요.');
  if (data.refresh_token !== session.refreshToken) await saveSession({ ...session, refreshToken: data.refresh_token });
  return data.id_token;
}
