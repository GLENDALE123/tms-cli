import { setImmediate } from 'node:timers/promises';
import { resolve } from 'node:path';
import { currentToken } from './session.js';
import {
  retrievalEndpoint,
  retrievalCatalog,
  structuredQuery,
  executePlan,
  validateStructuredQuery,
  validatePlan,
  assertNewDownloadPath,
  retrieveImage,
  retrieveSpec,
} from './retrieval.js';

const MAX_LINE = 16384;
async function* messages(input) {
  let parts = [],
    bytes = 0,
    large = false;
  for await (const chunk of input) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    while (start < data.length) {
      const end = data.indexOf(10, start),
        stop = end < 0 ? data.length : end,
        part = data.subarray(start, stop);
      if (!large) {
        bytes += part.length;
        if (bytes > MAX_LINE) {
          large = true;
          parts = [];
        } else parts.push(part);
      }
      if (end < 0) break;
      yield large
        ? { error: '요청 한 줄은 16KiB 이하여야 합니다.' }
        : { line: Buffer.concat(parts).toString('utf8').trim() };
      parts = [];
      bytes = 0;
      large = false;
      start = end + 1;
    }
  }
  if (bytes || large)
    yield large
      ? { error: '요청 한 줄은 16KiB 이하여야 합니다.' }
      : { line: Buffer.concat(parts).toString('utf8').trim() };
}
const validId = (value) =>
  typeof value === 'string' &&
  value &&
  value.length <= 1500 &&
  !value.includes('/') &&
  !['.', '..'].includes(value);
function drain(output) {
  return new Promise((resolve, reject) => {
    const clean = () => {
      output.off('drain', ready);
      output.off('close', closed);
      output.off('error', failed);
    };
    const ready = () => {
        clean();
        resolve(true);
      },
      closed = () => {
        clean();
        resolve(false);
      },
      failed = (e) => {
        clean();
        reject(e);
      };
    output.once('drain', ready);
    output.once('close', closed);
    output.once('error', failed);
  });
}
export async function agentRequest(
  message,
  {
    token = currentToken,
    api = { retrievalCatalog, structuredQuery, executePlan, retrieveImage, retrieveSpec },
    newPath = assertNewDownloadPath,
  } = {},
) {
  if (
    !message ||
    typeof message !== 'object' ||
    Array.isArray(message) ||
    Object.keys(message).some((k) => !['id', 'method', 'params'].includes(k)) ||
    !(
      (typeof message.id === 'string' && message.id.length <= 80) ||
      Number.isSafeInteger(message.id)
    )
  )
    throw new Error('id, method, params 형식의 JSON 요청이 필요합니다.');
  const p = message.params ?? {},
    method = message.method;
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('params는 객체여야 합니다.');
  if (method === 'query') validateStructuredQuery(p);
  else if (method === 'plan') validatePlan(p);
  else if (method === 'catalog') {
    if (
      Object.keys(p).some((k) => k !== 'source') ||
      (p.source !== undefined &&
        (typeof p.source !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(p.source)))
    )
      throw new Error('자료 이름을 확인하세요.');
  } else if (method === 'image' || method === 'spec') {
    const keys =
      method === 'image' ? ['inspectionId', 'index', 'output'] : ['id', 'kind', 'output'];
    if (
      Object.keys(p).some((k) => !keys.includes(k)) ||
      typeof p.output !== 'string' ||
      !p.output ||
      !(method === 'image'
        ? validId(p.inspectionId) && Number.isInteger(p.index) && p.index >= 1 && p.index <= 100
        : validId(p.id) && ['product', 'film'].includes(p.kind))
    )
      throw new Error('파일 조회 인수를 확인하세요.');
    p.output = resolve(p.output);
    await newPath(p.output);
  } else throw new Error('agent는 catalog, query, plan, image, spec 읽기 요청만 지원합니다.');
  retrievalEndpoint();
  // Read the OS session for EVERY message, so logout/account changes are not
  // bypassed by a process-local token. The vault cache avoids network refresh.
  const auth = await token();
  if (method === 'query') return api.structuredQuery(auth, p);
  if (method === 'plan') return api.executePlan(auth, p);
  if (method === 'catalog') return api.retrievalCatalog(auth, undefined, p.source);
  if (method === 'image') await api.retrieveImage(auth, p.inspectionId, p.index, p.output);
  else await api.retrieveSpec(auth, p.id, p.kind, p.output);
  return { path: p.output };
}
export async function runAgent({
  input = process.stdin,
  output = process.stdout,
  execute = agentRequest,
} = {}) {
  for await (const item of messages(input)) {
    if (!item.error && !item.line) continue;
    // Return a drained connection to the HTTP pool before reading the next
    // message; do not create a second TLS connection in the same microtask.
    await setImmediate();
    let message, reply;
    try {
      if (item.error) throw new Error(item.error);
      message = JSON.parse(item.line);
      const result = await execute(message);
      reply = { id: message.id, ok: true, result };
    } catch (error) {
      const id =
        (typeof message?.id === 'string' && message.id.length <= 80) ||
        Number.isSafeInteger(message?.id)
          ? message.id
          : null;
      reply = { id, ok: false, error: error.message };
    }
    if (output.destroyed || output.writableEnded) return;
    if (!output.write(JSON.stringify(reply) + '\n') && !(await drain(output))) return;
  }
}
