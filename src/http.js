function serviceName(url) {
  const host = new URL(url).hostname;
  if (host === 'firestore.googleapis.com') return 'firestore';
  if (host === 'firebasestorage.googleapis.com') return 'storage';
  if (host === 'securetoken.googleapis.com') return 'auth';
  if (host.endsWith('.cloudfunctions.net')) return 'functions';
  return 'other';
}

export async function request(url, options = {}) {
  const diagnostics = process.env.TMS_CLI_DIAGNOSTICS === '1';
  const started = diagnostics ? performance.now() : 0;
  let response;
  try { response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30000) }); }
  catch {
    if (diagnostics) process.stderr.write(`${JSON.stringify({ event: 'tms.request', service: serviceName(url), method: options.method || 'GET', headersMs: Math.round(performance.now() - started), status: null, success: false })}\n`);
    throw new Error('Firebase에 연결하지 못했습니다. 네트워크를 확인하세요.');
  }
  if (diagnostics) process.stderr.write(`${JSON.stringify({ event: 'tms.request', service: serviceName(url), method: options.method || 'GET', headersMs: Math.round(performance.now() - started), status: response.status, success: response.ok })}\n`);
  if (!response.ok) {
    if (response.status === 401) throw new Error('인증이 만료되었거나 비활성화되었습니다. tms login으로 다시 로그인하세요.');
    if (response.status === 403) throw new Error('접근이 거부되었습니다. Firebase 보안 규칙과 조회 조건을 확인하세요.');
    if (response.status === 404) throw new Error('문서 또는 파일을 찾을 수 없거나 접근할 수 없습니다.');
    let reason = '';
    try {
      const data = await response.json();
      const retrievalErrors = { invalid_or_expired_cursor: '검색 조건 또는 색인이 변경되어 페이지를 처음부터 다시 조회해야 합니다.', index_not_ready: '검색 색인이 아직 준비되지 않았습니다.', source_not_indexed: '요청한 자료가 아직 색인되지 않았습니다.' };
      reason = typeof data.error === 'string' && Object.hasOwn(retrievalErrors, data.error) ? retrievalErrors[data.error] : data.error?.status || data.error?.message || '';
    } catch { /* no response details */ }
    throw new Error(`Firebase 요청 실패 (${response.status})${reason ? `: ${reason}` : ''}`);
  }
  return response;
}
