const status = document.querySelector('#status');
function firebaseErrorMessage(code) {
  switch (code) {
    case 'INVALID_LOGIN_CREDENTIALS':
    case 'INVALID_PASSWORD':
    case 'EMAIL_NOT_FOUND':
      return 'TMS 이메일 또는 비밀번호를 확인하지 못했습니다. 평소 TMS 앱에 로그인하는 이메일인지 확인해 주세요.';
    case 'USER_DISABLED': return '비활성화된 TMS 계정입니다. 관리자에게 문의해 주세요.';
    case 'TOO_MANY_ATTEMPTS_TRY_LATER': return '로그인 시도가 일시적으로 제한됐습니다. 잠시 후 다시 시도해 주세요.';
    case 'OPERATION_NOT_ALLOWED':
    case 'PASSWORD_LOGIN_DISABLED': return '이 Firebase 프로젝트에서 이메일·비밀번호 로그인이 허용되지 않았습니다.';
    case 'API_KEY_HTTP_REFERRER_BLOCKED':
    case 'API_KEY_SERVICE_BLOCKED':
    case 'API_KEY_INVALID': return 'Firebase API 키의 사용 제한 또는 설정을 확인해야 합니다.';
    default: return 'TMS 로그인 요청을 처리하지 못했습니다. 네트워크와 계정 인증 설정을 확인해 주세요.';
  }
}
document.querySelector('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button');
  button.disabled = true;
  status.textContent = '로그인 중...';
  try {
    const state = location.hash.slice(1);
    if (!/^[a-f0-9]{64}$/.test(state)) throw new Error('로그인 요청이 올바르지 않습니다.');
    const password = form.elements.namedItem('password').value;
    form.elements.namedItem('password').value = '';
    let response;
    try {
      response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(document.body.dataset.apiKey)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: form.elements.namedItem('email').value.trim(), password, returnSecureToken: true }),
      });
    } catch { throw new Error('TMS 인증 서버에 연결하지 못했습니다. 네트워크와 브라우저 연결을 확인해 주세요.'); }
    const data = await response.json();
    if (data.mfaPendingCredential) throw new Error('이 계정에는 추가 인증이 필요합니다. 현재 CLI는 이 인증 방식을 지원하지 않습니다.');
    if (!response.ok || !data.refreshToken || !data.localId) throw new Error(firebaseErrorMessage(data.error?.message));
    const result = await fetch('/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state, refreshToken: data.refreshToken, uid: data.localId, email: data.email }),
    });
    if (!result.ok) throw new Error('CLI에 로그인 정보를 전달하지 못했습니다. 터미널을 확인하세요.');
    history.replaceState(null, '', '/');
    form.hidden = true;
    status.textContent = '로그인했습니다. 이 창을 닫고 터미널로 돌아가세요.';
  } catch (error) {
    status.textContent = error.message || '로그인 중 오류가 발생했습니다.';
    button.disabled = false;
  }
});
