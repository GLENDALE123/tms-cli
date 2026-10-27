#!/usr/bin/env node
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { login } from '../src/login.js';
import { loadSession, clearSession } from '../src/credentials.js';
import { currentToken } from '../src/session.js';
import { retrievalCapabilities, retrievalCatalog, retrievalEndpoint, retrieve, retrieveImage, validateRetrievalQuery, validateStructuredQuery, structuredQuery, validatePlan, executePlan } from '../src/retrieval.js';
import { createCriteriaStore, bindCriteria } from '../src/criteria.js';
import { serviceNotice, showFirstRunNotice } from '../src/notice.js';

const help = `TMS CLI — 에이전트용 읽기 전용 검색

  tms login
  tms whoami
  tms logout
  tms notice                    # 서비스 종료 안내 다시 보기
  tms catalog                   # 업무 자료와 필드·연결 기준 확인
  tms guide                     # 에이전트용 조회 안내
  tms query --help              # 필드 조회 JSON 예시
  tms plan --help               # 다단계 조회 JSON 예시
  tms retrieve capabilities
  tms retrieve                  # 표준 입력의 검색 JSON을 서비스로 전달
  tms query                     # 표준 입력의 필드 조건 JSON을 서비스로 전달
  tms plan                      # 사전을 참고해 작성한 단계별 조회 계획을 실행
  tms criteria save 이름        # 표준 입력의 조회 기준을 이 기기에 저장
  tms criteria list             # 저장된 조회 기준 확인
  tms criteria show 이름        # 기준과 필요한 변수 확인
  tms criteria run 이름         # 표준 입력의 변수로 기준 실행
  tms criteria remove 이름      # 이 기기의 조회 기준 삭제
  tms retrieve image --inspection 검사ID --index 번호 --output 파일경로

사용자는 자연어로 질문하고 에이전트가 검색 조건을 구성합니다.
자료 범위와 사용자 권한은 tms catalog에서 확인하세요.`;

const queryHelp = `tms query: 조건 필수. stdin으로 JSON을 보내거나 --json 다음에 JSON 문자열을 전달하세요.
예: {"source":"production-schedules","filters":[{"field":"planDate","op":"eq","value":"2026-10-27"}],"limit":20}
PowerShell: @{source='production-schedules';filters=@(@{field='planDate';op='eq';value='2026-10-27'});limit=20} | ConvertTo-Json -Depth 8 -Compress | tms query
필드와 사용자 범위는 tms catalog에서 확인하세요. 날짜는 질문의 실제 날짜로 바꾸세요.`;
const planHelp = `tms plan: stdin 또는 --json으로 {"steps":[{"id":"schedule","query":{"source":"production-schedules","filters":[{"field":"planDate","op":"eq","value":"2026-10-27"}],"limit":20}}]} 형식 전달. tms guide와 catalog에서 관계와 제한을 확인하세요.`;
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
async function readQueryStdin(validate = validateRetrievalQuery) {
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
  if (group === '--version') { output('0.2.1'); return; }
  if (group === 'guide' && !action) { output(await readFile(new URL('../AGENT_GUIDE.md', import.meta.url), 'utf8')); return; }
  if (['query', 'plan'].includes(group) && ['--help', '-h'].includes(action) && !rest.length) { output(group === 'query' ? queryHelp : planHelp); return; }
  if (group === 'login' && !action) { const session = await login(); output(`${session.email} 로그인 완료`); return; }
  if (group === 'logout' && !action) { await clearSession(); output('이 기기의 로그인 정보를 삭제했습니다.'); return; }
  if (group === 'whoami' && !action) {
    const session = await loadSession();
    if (!session) throw new Error('로그인이 필요합니다. tms login을 실행하세요.');
    await currentToken(); print({ email: session.email, uid: session.uid }); return;
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
  if (group === 'retrieve' && !action) {
    retrievalEndpoint();
    const query = await readQueryStdin();
    print(await retrieve(await currentToken(), query)); return;
  }
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
  if (group === 'retrieve' && action === 'capabilities' && !rest.length) {
    retrievalEndpoint(); print(await retrievalCapabilities(await currentToken())); return;
  }
  if (group === 'retrieve' && action === 'image') {
    retrievalEndpoint();
    const flags = imageOptions(rest), destination = resolve(flags['--output']);
    await retrieveImage(await currentToken(), flags['--inspection'], Number(flags['--index']), destination);
    print({ inspectionId: flags['--inspection'], index: Number(flags['--index']), path: destination }); return;
  }
  if (['search', 'production', 'integrated', 'injection', 'shipment', 'sample', 'jig', 'quality', 'firestore', 'storage'].includes(group)) throw new Error('기존 Firebase 직접 조회는 권한 검증 문제로 중단되었습니다. 독립 검색 서비스가 준비되면 tms retrieve를 사용하세요.');
  throw new Error('알 수 없는 명령입니다. tms --help를 확인하세요.');
}

main(process.argv.slice(2)).catch(error => { console.error(`오류: ${error.message}`); process.exitCode = 1; });
