#!/usr/bin/env node
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { login } from '../src/login.js';
import { loadSession, clearSession, sessionStoreKind, useLocalFile } from '../src/session-store.js';
import { currentToken } from '../src/session.js';
import { retrievalCatalog, retrievalEndpoint, retrieveImage, retrieveSpec, assertNewDownloadPath, validateStructuredQuery, structuredQuery, validatePlan, executePlan } from '../src/retrieval.js';
import { createCriteriaStore, bindCriteria } from '../src/criteria.js';
import { serviceNotice, showFirstRunNotice } from '../src/notice.js';
import { updateCli } from '../src/update.js';
import { authSourceName, inspectIdToken } from '../src/auth-source.js';

const help = `TMS CLI — 에이전트용 읽기 전용 검색

  tms login
  tms login --device            # 다른 기기의 브라우저 로그인 후 이 환경에 저장
  tms doctor                    # 런타임·인증 소스·로그인 상태를 로컬 점검
  tms doctor --online           # 실제 검색 서비스 접근까지 확인
  tms whoami
  tms logout
  tms update                    # 전역 설치된 CLI를 최신 버전으로 갱신
  tms notice                    # 서비스 종료 안내 다시 보기
  tms catalog                   # 업무 자료와 필드·연결 기준 확인
  tms catalog --source 업무명   # 해당 업무의 필드 사전 확인
  tms guide                     # 에이전트용 조회 안내
  tms query --help              # 필드 조회 JSON 예시
  tms plan --help               # 다단계 조회 JSON 예시
  tms query                     # 표준 입력의 필드 조건 JSON을 서비스로 전달
  tms plan                      # 사전을 참고해 작성한 단계별 조회 계획을 실행
  tms agent                     # JSONL 읽기 요청을 같은 프로세스·연결로 반복 실행
  tms criteria save 이름        # 표준 입력의 조회 기준을 이 기기에 저장
  tms criteria list             # 저장된 조회 기준 확인
  tms criteria show 이름        # 기준과 필요한 변수 확인
  tms criteria run 이름         # 표준 입력의 변수로 기준 실행
  tms criteria remove 이름      # 이 기기의 조회 기준 삭제
  tms image --inspection 검사ID --index 번호 --output 파일경로
  tms spec --id 발주문서ID --kind product|film --output 파일경로
  tms auth export --stdout       # 승인된 보안 파이프로 단기 ID 토큰 전달

사용자는 자연어로 질문하고 에이전트가 검색 조건을 구성합니다.
자료 범위와 사용자 권한은 tms catalog에서 확인하세요.
예약 보고나 정기 조회는 CLI를 호출하는 스크립트와 스케줄러 사용을 권장합니다. 자세한 내용은 tms guide를 확인하세요.`;

const queryHelp = `tms query: 조건 필수. stdin으로 JSON을 보내거나 --json 다음에 JSON 문자열을 전달하세요.
예: {"source":"coating-schedule","filters":[{"field":"date","op":"eq","value":"2026-10-27"}],"limit":20}
PowerShell: @{source='coating-schedule';filters=@(@{field='date';op='eq';value='2026-10-27'});limit=20} | ConvertTo-Json -Depth 8 -Compress | tms query
limit는 1~50이며 nextCursor로 다음 페이지를 조회합니다. fields 배열로 필요한 반환 필드를 선택하세요. 관리자 조회에서 저장 필드만 선택하면 해당 필드만 가져오며 문서 읽기 수는 filters와 limit에 좌우됩니다. 필드와 사용자 범위는 tms catalog에서 확인하세요. 날짜는 질문의 실제 날짜로 바꾸세요.`;
const planHelp = `tms plan: stdin 또는 --json으로 {"steps":[{"id":"schedule","query":{"source":"coating-schedule","filters":[{"field":"date","op":"eq","value":"2026-10-27"}],"limit":20}}]} 형식 전달. tms guide와 catalog에서 관계와 제한을 확인하세요.`;
function output(value) { process.stdout.write(`${value}\n`); }
function print(value) { output(JSON.stringify(value, null, 2)); }
function imageOptions(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i], value = args[i + 1];
    if (!['--inspection', '--index', '--output'].includes(name) || !value || value.startsWith('--') || Object.hasOwn(flags, name)) throw new Error('이미지 저장에는 --inspection, --index, --output이 필요합니다.');
    flags[name] = value;
  }
  if (!flags['--inspection'] || !/^(?:[1-9]|[1-9][0-9]|100)$/.test(flags['--index'] ?? '') || !flags['--output']) throw new Error('이미지 저장에는 --inspection, --index, --output이 필요합니다.');
  return flags;
}
function specOptions(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i], value = args[i + 1];
    if (!['--id', '--kind', '--output'].includes(name) || !value || value.startsWith('--') || Object.hasOwn(flags, name)) throw new Error('사양서 저장에는 --id, --kind product|film, --output이 필요합니다.');
    flags[name] = value;
  }
  if (!flags['--id'] || !['product', 'film'].includes(flags['--kind']) || !flags['--output']) throw new Error('사양서 저장에는 --id, --kind product|film, --output이 필요합니다.');
  return flags;
}
async function readQueryStdin(validate = value => value) {
  let size = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 16384) throw new Error('검색 요청이 너무 깁니다.');
    chunks.push(chunk);
  }
  let query;
  try { query = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('검색 요청은 JSON 형식이어야 합니다.'); }
  return validate(query);
}

function parseArgumentQuery(value, validate) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 16384) throw new Error('검색 JSON을 확인하세요.');
  let data; try { data = JSON.parse(value); } catch { throw new Error('검색 요청은 JSON 형식이어야 합니다.'); }
  return validate(data);
}

async function main(args) {
  const [group, action, ...rest] = args;
  if (group === 'notice' && !action) { output(serviceNotice); return; }
  await showFirstRunNotice();
  if (!group || ['--help', '-h', 'help'].includes(group)) { output(help); return; }
  if (group === '--version') { const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')); output(pkg.version); return; }
  if (group === 'doctor' && ['--help', '-h'].includes(action) && !rest.length) { output('tms doctor [--online]: Node·인증 소스·키링/주입 토큰·서비스 설정을 JSON으로 점검합니다. --online만 실제 서비스 인증을 확인합니다. 비밀번호·토큰·업무 데이터는 출력하지 않습니다.'); return; }
  if (group === 'doctor' && (!action || action === '--online') && !rest.length) {
    const { diagnose } = await import('../src/doctor.js');
    const report = await diagnose({ online: action === '--online' });
    print(report); if (!(action === '--online' ? report.ready : report.localReady)) process.exitCode = 1; return;
  }
  if (group === 'auth' && action === 'export' && rest.length === 1 && rest[0] === '--stdout') {
    if (process.stdout.isTTY) throw new Error('ID 토큰은 터미널·채팅에 표시하지 말고 승인된 보안 입력으로 직접 파이프하세요.');
    retrievalEndpoint();
    const token = await currentToken(); inspectIdToken(token);
    await retrievalCatalog(token); output(token); return;
  }
  if (group === 'auth') throw new Error('단기 ID 토큰 전달은 tms auth export --stdout을 승인된 보안 입력과 직접 연결하세요. 일반 진단 도구나 채팅에서 실행하지 마세요.');
  if (group === 'update' && ['--help', '-h'].includes(action) && !rest.length) { output('tms update: npm으로 @hs-jig/tms-cli 전역 설치를 최신 공개 버전으로 갱신합니다.'); return; }
  if (group === 'update' && !action) { output('TMS CLI를 최신 공개 버전으로 갱신합니다.'); await updateCli(); output('업데이트 완료. tms --version으로 버전을 확인하세요.'); return; }
  if (group === 'guide' && !action) { output(await readFile(new URL('../AGENT_GUIDE.md', import.meta.url), 'utf8')); return; }
  if (group === 'agent' && ['--help','-h'].includes(action) && !rest.length) { output('tms agent: stdin으로 한 줄에 {"id":"1","method":"query","params":{"source":"업무명","filters":[...],"limit":10}} 전송. catalog/query/plan/image/spec만 지원하며 응답은 한 줄의 {id,ok,result|error}입니다. EOF까지 연결을 재사용하고 매 요청 현재 로그인과 서버 권한을 확인합니다.'); return; }
  if (group === 'agent' && !action) { const {runAgent}=await import('../src/agent.js'); await runAgent(); return; }
  if (['query', 'plan'].includes(group) && ['--help', '-h'].includes(action) && !rest.length) { output(group === 'query' ? queryHelp : planHelp); return; }
  if (group === 'image' && ['--help', '-h'].includes(action) && !rest.length) { output('tms image --inspection 검사ID --index 번호 --output 파일경로'); return; }
  if (group === 'spec' && ['--help', '-h'].includes(action) && !rest.length) { output('tms spec --id 발주문서ID --kind product|film --output 파일경로'); return; }
  if (group === 'login' && ['--help', '-h'].includes(action) && !rest.length) { output('tms login [--device] [--no-browser]: 일반 PC는 로컬 브라우저, 원격·헤드리스는 공개 로그인 링크를 사용합니다. 받은 세션은 실행 환경에 저장해 재사용하며 토큰은 출력하지 않습니다.'); return; }
  if (group === 'login' && [action, ...rest].filter(Boolean).every(value => ['--device', '--no-browser'].includes(value)) && new Set([action, ...rest].filter(Boolean)).size === [action, ...rest].filter(Boolean).length) {
    if (authSourceName() !== 'os-keyring') throw new Error('주입 인증이 설정돼 있습니다. TMS_ID_TOKEN / TMS_ID_TOKEN_FILE을 해제한 뒤 일반 로그인을 실행하세요.');
    const flags = [action, ...rest], noBrowser = flags.includes('--no-browser');
    let device = flags.includes('--device') || process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
    try { await loadSession(); } catch (error) {
      if (error?.code === 'TMS_KEYRING_UNAVAILABLE' && process.platform !== 'win32') { await useLocalFile(); device = true; process.stderr.write('OS 보안 저장소가 없어 이 환경의 사용자 전용 로컬 세션 파일에 토큰을 저장합니다.\n'); }
      else if (error?.code !== 'TMS_KEYRING_INVALID_SESSION') throw error;
    }
    const session = device ? await (await import('../src/device-login.js')).deviceLogin({ ...(noBrowser ? { launch: () => {} } : {}) }) : await login({ ...(noBrowser ? { launch: () => {} } : {}) });
    output(`${session.email} 로그인 완료 (${await sessionStoreKind()})`); return;
  }
  if (group === 'logout' && !action) {
    if (authSourceName() !== 'os-keyring') throw new Error('외부 주입 인증은 이 명령으로 지울 수 없습니다. 실행 환경의 토큰 변수 또는 비밀 파일 주입을 해제하세요. 기존 OS 로그인은 변경하지 않았습니다.');
    await clearSession(); output('이 기기의 로그인 정보를 삭제했습니다.'); return;
  }
  if (group === 'whoami' && !action) {
    retrievalEndpoint();
    const token = await currentToken(), session = inspectIdToken(token);
    await retrievalCatalog(token);
    print({ email: session.email, uid: session.uid, source: authSourceName() === 'os-keyring' ? await sessionStoreKind() : authSourceName(), verifiedBy: 'retrieval-service' }); return;
  }
  if (group === 'criteria') {
    const store = createCriteriaStore();
    if (action === 'list' && !rest.length) { print({ criteria: await store.list() }); return; }
    if (rest.length !== 1 || !['save', 'show', 'run', 'remove'].includes(action)) throw new Error('조회 기준 명령과 이름을 확인하세요.');
    const [name] = rest;
    if (action === 'save') { print(await store.save(name, await readQueryStdin(value => value))); return; }
    if (action === 'show') { print(await store.load(name)); return; }
    if (action === 'remove') { await store.remove(name); print({ name, removed: true }); return; }
    retrievalEndpoint();
    const { template } = await store.load(name);
    const bound = bindCriteria(template, await readQueryStdin(value => value));
    const token = await currentToken();
    print(bound.kind === 'query' ? await structuredQuery(token, bound.request) : await executePlan(token, bound.request)); return;
  }
  if (group === 'catalog' && !action) { retrievalEndpoint(); print(await retrievalCatalog(await currentToken())); return; }
  if (group === 'catalog' && action === '--source' && rest.length === 1) { retrievalEndpoint(); print(await retrievalCatalog(await currentToken(), undefined, rest[0])); return; }
  if (group === 'query' && (!action || action === '--json' && rest.length === 1)) {
    retrievalEndpoint();
    const query = action ? parseArgumentQuery(rest[0], validateStructuredQuery) : await readQueryStdin(validateStructuredQuery);
    print(await structuredQuery(await currentToken(), query)); return;
  }
  if (group === 'plan' && (!action || action === '--json' && rest.length === 1)) {
    retrievalEndpoint();
    const plan = action ? parseArgumentQuery(rest[0], validatePlan) : await readQueryStdin(validatePlan);
    print(await executePlan(await currentToken(), plan)); return;
  }
  if (group === 'image' || (group === 'retrieve' && action === 'image')) {
    const flags = imageOptions(group === 'image' ? [action, ...rest].filter(value => value !== undefined) : rest), destination = resolve(flags['--output']);
    await assertNewDownloadPath(destination);
    retrievalEndpoint();
    await retrieveImage(await currentToken(), flags['--inspection'], Number(flags['--index']), destination);
    print({ inspectionId: flags['--inspection'], index: Number(flags['--index']), path: destination }); return;
  }
  if (group === 'spec') {
    const flags = specOptions([action, ...rest].filter(value => value !== undefined)), destination = resolve(flags['--output']);
    await assertNewDownloadPath(destination);
    retrievalEndpoint();
    await retrieveSpec(await currentToken(), flags['--id'], flags['--kind'], destination);
    print({ orderId: flags['--id'], kind: flags['--kind'], path: destination }); return;
  }
  if (group === 'retrieve') throw new Error('별도 색인 검색이 제거되었습니다. tms catalog와 tms query를 사용하세요.');
  if (['search', 'production', 'integrated', 'injection', 'shipment', 'sample', 'jig', 'quality', 'firestore', 'storage'].includes(group)) throw new Error('기존 Firebase 직접 조회는 권한 검증 문제로 중단되었습니다. tms catalog와 tms query를 사용하세요.');
  throw new Error('알 수 없는 명령입니다. tms --help를 확인하세요.');
}

const commandStarted = performance.now();
main(process.argv.slice(2)).catch(error => { console.error(`오류: ${error.message}`); process.exitCode = 1; }).finally(() => {
  if (process.env.TMS_CLI_DIAGNOSTICS === '1') {
    const command = process.argv[2], known = new Set(['login', 'logout', 'whoami', 'doctor', 'auth', 'catalog', 'query', 'plan', 'image', 'spec', 'criteria', 'update', 'guide', 'notice','agent']);
    process.stderr.write(`${JSON.stringify({ event: 'tms.command', command: known.has(command) ? command : 'other', elapsedMs: Math.round(performance.now() - commandStarted), success: !process.exitCode })}\n`);
  }
});
