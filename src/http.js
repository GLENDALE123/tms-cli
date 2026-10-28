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
  const target = new URL(url);
  const serviceLabel =
    target.pathname.startsWith('/tms/v1/') ||
    (target.pathname.startsWith('/v1/') && serviceName(url) === 'other')
      ? '검색 서버'
      : 'Firebase';
  const started = diagnostics ? performance.now() : 0;
  let response;
  const { retryConnect = false, ...fetchOptions } = options;
  const settings = { ...fetchOptions, redirect: 'error', signal: AbortSignal.timeout(30000) };
  try {
    if (retryConnect) {
      const { fetchReadOnly } = await import('./connect-retry.js');
      const { retrievalTransport } = await import('./transport.js');
      settings.dispatcher = retrievalTransport;
      response = await fetchReadOnly(url, settings, {
        onRetry: (code) => {
          if (diagnostics)
            process.stderr.write(
              JSON.stringify({ event: 'tms.connect.retry', code, attempt: 1 }) + '\n',
            );
        },
      });
    } else response = await fetch(url, settings);
  } catch {
    if (diagnostics)
      process.stderr.write(
        `${JSON.stringify({ event: 'tms.request', service: serviceName(url), method: options.method || 'GET', headersMs: Math.round(performance.now() - started), status: null, success: false })}\n`,
      );
    throw new Error(`${serviceLabel}에 연결하지 못했습니다. 네트워크를 확인하세요.`);
  }
  if (diagnostics)
    process.stderr.write(
      `${JSON.stringify({ event: 'tms.request', service: serviceName(url), method: options.method || 'GET', headersMs: Math.round(performance.now() - started), status: response.status, success: response.ok })}\n`,
    );
  if (!response.ok) {
    if (response.status === 401)
      throw new Error('인증이 만료되었거나 비활성화되었습니다. tms login으로 다시 로그인하세요.');
    if (response.status === 403)
      throw new Error(
        serviceLabel === '검색 서버'
          ? '접근이 거부되었습니다. TMS 계정 권한과 조회 범위를 확인하세요.'
          : '접근이 거부되었습니다. Firebase 보안 규칙과 조회 조건을 확인하세요.',
      );
    if (response.status === 404)
      throw new Error('문서 또는 파일을 찾을 수 없거나 접근할 수 없습니다.');
    let reason = '';
    try {
      const data = await response.json();
      const retrievalErrors = {
        invalid_or_expired_cursor:
          '페이지 커서가 만료되었거나 사용자·조회 조건이 다릅니다. 처음부터 다시 조회하세요.',
        query_requires_index:
          '현재 필드 조합에 필요한 Firestore 복합 색인이 없습니다. 조건을 조정하거나 관리자에게 알려주세요.',
        query_timeout:
          '조회 시간이 초과되었습니다. 날짜·제품 등 조건이나 limit를 좁혀 다시 실행하세요.',
        query_capacity_exceeded:
          '조회 한도를 초과했습니다. 잠시 후 더 좁은 조건으로 다시 실행하세요.',
        server_busy: '동시 요청이 많습니다. 잠시 후 다시 실행하세요.',
        policy_unavailable: '현재 권한을 확인하지 못했습니다. 잠시 후 다시 실행하세요.',
        query_unavailable: '조회를 완료하지 못했습니다. 조회 실패를 자료 없음으로 판단하지 마세요.',
        invalid_query:
          '조회 조건이 올바르지 않습니다. 해당 업무의 tms catalog --source 결과를 확인하세요.',
        invalid_plan: '조회 계획이 올바르지 않습니다. tms plan --help와 자료 사전을 확인하세요.',
        index_not_ready:
          '이전 색인 검색을 사용할 수 없습니다. tms catalog와 tms query를 사용하세요.',
        source_not_indexed:
          '이전 색인 검색을 사용할 수 없습니다. tms catalog와 tms query를 사용하세요.',
      };
      reason =
        typeof data.error === 'string' && Object.hasOwn(retrievalErrors, data.error)
          ? retrievalErrors[data.error]
          : data.error?.status || data.error?.message || '';
    } catch {
      /* no response details */
    }
    throw new Error(`${serviceLabel} 요청 실패 (${response.status})${reason ? `: ${reason}` : ''}`);
  }
  return response;
}
