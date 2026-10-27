const service = 'tms-cli:hs-jig-b2093';
const account = 'firebase-session';

async function entry() {
  const { Entry } = await import('@napi-rs/keyring');
  // Do not silently use Linux's nonpersistent kernel keyring.
  return new Entry(service, account, { linux: { store: 'secret-service' } });
}

export async function saveSession(session) {
  try { (await entry()).setPassword(JSON.stringify(session)); }
  catch { throw new Error('운영체제 보안 저장소에 로그인 정보를 저장할 수 없습니다. 보안 저장소를 사용할 수 있는지 확인하세요.'); }
}

export async function loadSession() {
  let value;
  try { value = (await entry()).getPassword(); }
  catch (error) {
    if (/no entry|not found|not exist/i.test(String(error))) return null;
    throw new Error('운영체제 보안 저장소를 읽을 수 없습니다.');
  }
  if (!value) return null;
  try {
    const session = JSON.parse(value);
    if (typeof session.refreshToken !== 'string' || !session.refreshToken) throw new Error();
    return session;
  } catch { throw new Error('저장된 로그인 정보가 올바르지 않습니다. tms login으로 다시 로그인하세요.'); }
}

export async function clearSession() {
  try { (await entry()).deletePassword(); }
  catch (error) { if (!/no entry|not found|not exist/i.test(String(error))) throw new Error('운영체제 보안 저장소를 지울 수 없습니다.'); }
}
