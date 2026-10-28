import { readFile } from 'node:fs/promises';
import { loadSession, sessionStoreKind } from './session-store.js';
import { currentToken, reusableIdToken } from './session.js';
import { authSourceName, readExternalSession } from './auth-source.js';
import { retrievalEndpoint, retrievalCatalog } from './retrieval.js';

export function supportedNode(version) {
  const parts = String(version).replace(/^v/, '').split('.').map(Number);
  return (
    parts.length === 3 &&
    parts.every(Number.isSafeInteger) &&
    (parts[0] > 20 || (parts[0] === 20 && (parts[1] > 18 || (parts[1] === 18 && parts[2] >= 1))))
  );
}

export async function diagnose({
  online = false,
  node = process.versions.node,
  platform = process.platform,
  env = process.env,
  load = loadSession,
  external = readExternalSession,
  token = currentToken,
  endpoint = retrievalEndpoint,
  catalog = retrievalCatalog,
  now = Date.now,
} = {}) {
  const version = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ).version;
  const report = {
    version,
    runtime: { node, minimum: '20.18.1', supported: supportedNode(node), platform },
    auth: { source: authSourceName(env), status: 'not_checked' },
    service: { status: 'not_checked', verification: 'not_run' },
    localReady: false,
    ready: false,
    actions: [],
  };
  if (!report.runtime.supported) {
    report.actions.push(
      'Node.js 20.18.1 이상을 사용하세요. CLI는 런타임을 자동 교체하지 않습니다.',
    );
    return report;
  }
  try {
    endpoint();
    report.service.status = 'configured';
  } catch {
    report.service.status = 'disabled_or_invalid';
    report.actions.push('검색 서비스 설정과 TMS_CLI_DISABLE_NETWORK를 확인하세요.');
  }
  try {
    const injected = await external();
    if (injected) {
      report.auth.status = 'available';
      report.auth.expiresAt = new Date(injected.expiresAt).toISOString();
    } else {
      if (load === loadSession) report.auth.source = await sessionStoreKind();
      const session = await load();
      if (!session) {
        report.auth.status = 'login_required';
        report.actions.push(
          'tms login으로 로그인하세요. 원격·헤드리스 환경에서는 tms login --device가 브라우저 링크를 제공합니다.',
        );
      } else
        report.auth.status = reusableIdToken(session, now()) ? 'available' : 'refresh_required';
    }
  } catch (error) {
    report.auth.status =
      error?.code === 'TMS_KEYRING_UNAVAILABLE' ? 'store_unavailable' : 'invalid';
    report.auth.code =
      typeof error?.code === 'string' && /^TMS_[A-Z_]+$/.test(error.code)
        ? error.code
        : 'TMS_AUTH_UNAVAILABLE';
    report.actions.push(
      report.auth.status === 'store_unavailable'
        ? 'tms login --device로 브라우저 로그인 후 권한이 제한된 로컬 세션 파일을 사용하거나, 단기 ID 토큰을 별도로 주입하세요.'
        : '명시한 인증 소스·유효기간·파일 권한을 확인하세요. 잘못된 주입 토큰을 다른 로그인으로 대체하지 않습니다.',
    );
  }
  report.localReady =
    report.service.status === 'configured' &&
    ['available', 'refresh_required'].includes(report.auth.status);
  if (online && report.localReady) {
    try {
      const result = await catalog(await token());
      report.service.verification = 'authorized';
      report.service.sourceCount = result.sources.length;
      report.ready = true;
    } catch (error) {
      report.service.verification =
        {
          TMS_AUTH_REJECTED: 'authentication_rejected',
          TMS_ACCESS_DENIED: 'access_denied',
          TMS_NETWORK_UNAVAILABLE: 'unreachable',
        }[error?.code] ?? 'failed';
      report.actions.push(
        '서비스 인증·승인·권한 또는 네트워크 확인에 실패했습니다. 조회 결과 없음으로 처리하거나 웹앱·직접 Firebase 접근으로 우회하지 마세요.',
      );
    }
  }
  if (!online && report.localReady)
    report.actions.push(
      '로컬 정보만 확인했습니다. 실제 접근 확인은 tms doctor --online으로 실행하세요.',
    );
  return report;
}
