import { config } from './config.js';
import { request } from './http.js';
import { lstat, open, unlink } from 'node:fs/promises';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export function retrievalEndpoint({ endpoint = config.retrievalEndpoint, trustedOrigins = config.trustedRetrievalOrigins } = {}) {
  if (process.env.TMS_CLI_DISABLE_NETWORK === '1') throw new Error('검색 서비스 연결이 비활성화되어 있습니다.');
  if (!endpoint) throw new Error('독립 검색 서비스가 아직 배포·설정되지 않았습니다.');
  let url;
  try { url = new URL(endpoint); } catch { throw new Error('검색 서비스 주소가 올바르지 않습니다.'); }
  if (url.protocol !== 'https:' || url.username || url.password || !['/v1/search', '/tms/v1/search'].includes(url.pathname) || url.search || url.hash || !Array.isArray(trustedOrigins) || !trustedOrigins.includes(url.origin)) throw new Error('신뢰할 수 있는 검색 서비스 주소가 아닙니다.');
  return url.toString();
}

function actionEndpoint(action, options) {
  const url = new URL(retrievalEndpoint(options));
  url.pathname = url.pathname.replace(/\/v1\/search$/, `/v1/${action}`);
  return url;
}

export function validateStructuredQuery(query) {
  const keys = new Set(['source', 'filters', 'order', 'limit', 'cursor', 'fields']);
  if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).some(key => !keys.has(key)) || typeof query.source !== 'string' || !query.source || !Array.isArray(query.filters) || !query.filters.length || Buffer.byteLength(JSON.stringify(query), 'utf8') > 16384) throw new Error('조건이 있는 업무별 쿼리 JSON이 필요합니다. tms query --help에서 예시를 확인하세요.');
  if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 50)) throw new Error('필드 조회 limit는 1부터 50까지입니다. 다음 페이지는 nextCursor를 사용하세요.');
  if (query.fields !== undefined && (!Array.isArray(query.fields) || !query.fields.length || query.fields.length > 30 || query.fields.some(value => typeof value !== 'string' || !value))) throw new Error('반환 fields는 필드 이름 배열로 1~30개 지정하세요.');
  return query;
}

export async function structuredQuery(token, query, options) {
  const target = actionEndpoint('query', options);
  const payload = validateStructuredQuery(query);
  const response = await request(target.toString(), { retryConnect:true,method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  return response.json();
}

export function validatePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) || Object.keys(plan).some(k => k !== 'steps') || !Array.isArray(plan.steps) || !plan.steps.length || plan.steps.length > 8 || Buffer.byteLength(JSON.stringify(plan), 'utf8') > 16384) throw new Error('제한된 조회 계획 JSON이 필요합니다.');
  return plan;
}

export async function executePlan(token, plan, options) {
  const target = actionEndpoint('plan', options);
  const response = await request(target.toString(), { retryConnect:true,method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(validatePlan(plan)) });
  return response.json();
}

export async function retrievalCatalog(token, options, source) {
  const target = actionEndpoint('catalog', options);
  if (source !== undefined) {
    if (typeof source !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(source)) throw new Error('업무 자료 이름을 확인하세요.');
    target.searchParams.set('source', source);
  }
  const response = await request(target.toString(), { retryConnect:true,headers: { authorization: `Bearer ${token}` } });
  return response.json();
}

export async function retrieveImage(token, id, number, destination, options) {
  const target = actionEndpoint('image', options);
  if (typeof id !== 'string' || !id || id.length > 1500 || id.includes('/') || id === '.' || id === '..' || !Number.isInteger(number) || number < 1 || number > 100) throw new Error('검사 ID와 이미지 번호를 확인하세요.');
  target.search = new URLSearchParams({ id, index: String(number) }).toString();
  await saveDownload(target, token, destination, ['image/jpeg', 'image/png', 'image/gif', 'image/webp'], 20 * 1024 * 1024, '이미지');
}

export async function assertNewDownloadPath(destination) {
  try { await lstat(destination); }
  catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  const error = new Error('저장 경로에 파일이 이미 있습니다. 다른 --output 경로를 지정하세요.');
  error.code = 'EEXIST';
  throw error;
}

export async function retrieveSpec(token, id, kind, destination, options) {
  const target = actionEndpoint('spec', options);
  if (typeof id !== 'string' || !id || id.length > 1500 || id.includes('/') || id === '.' || id === '..' || !['product', 'film'].includes(kind)) throw new Error('발주 문서 ID와 사양서 종류를 확인하세요.');
  target.search = new URLSearchParams({ id, kind }).toString();
  await saveDownload(target, token, destination, ['application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'image/jpeg', 'image/png', 'image/gif', 'image/webp'], 30 * 1024 * 1024, '사양서');
}

async function saveDownload(target, token, destination, allowed, maxBytes, label) {
  const file = await open(destination, 'wx', 0o600);
  const identity = await file.stat();
  try {
    const response = await request(target.toString(), { retryConnect:true,headers: { authorization: `Bearer ${token}` } });
    if (!allowed.includes(response.headers.get('content-type')?.split(';')[0].toLowerCase())) throw new Error(`지원하지 않는 ${label} 형식입니다.`);
    let size = 0;
    const bounded = new Transform({ transform(chunk, _encoding, callback) { size += chunk.length; callback(size > maxBytes ? new Error(`${label} 크기가 너무 큽니다.`) : null, chunk); } });
    await pipeline(Readable.fromWeb(response.body), bounded, file.createWriteStream());
  } catch (error) {
    await file.close().catch(() => {});
    try { const current = await lstat(destination); if (current.isFile() && current.dev === identity.dev && current.ino === identity.ino) await unlink(destination); } catch { /* already removed */ }
    throw error;
  }
}
