import { lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { stateDirectory } from './state.js';
import { validatePlan, validateStructuredQuery } from './retrieval.js';

const MAX_BYTES = 16384;
const validName = name => typeof name === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(name) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name);
const validParam = name => typeof name === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(name);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function transform(value, replace, names) {
  if (Array.isArray(value)) return value.map(item => transform(item, replace, names));
  if (!plain(value)) return value;
  if (Object.hasOwn(value, '$param')) {
    if (Object.keys(value).length !== 1 || !validParam(value.$param)) throw new Error('조회 기준의 변수 형식이 올바르지 않습니다.');
    names.add(value.$param);
    if (names.size > 20) throw new Error('조회 기준 변수는 최대 20개입니다.');
    return replace(value.$param);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, transform(item, replace, names)]));
}

export function validateCriteria(template) {
  if (!plain(template) || Object.keys(template).some(k => !['kind', 'request'].includes(k)) || !['query', 'plan'].includes(template.kind) || !plain(template.request) || Buffer.byteLength(JSON.stringify(template), 'utf8') > MAX_BYTES) throw new Error('조회 기준 형식이 올바르지 않습니다.');
  const names = new Set();
  const probe = transform(template.request, () => 'variable', names);
  if (template.kind === 'query') validateStructuredQuery(probe); else validatePlan(probe);
  return { template, parameters: [...names].sort() };
}

export function bindCriteria(template, params) {
  const { parameters } = validateCriteria(template);
  if (!plain(params) || Object.keys(params).some(key => !parameters.includes(key)) || parameters.some(key => !Object.hasOwn(params, key))) throw new Error('조회 기준에 필요한 변수 이름을 확인하세요.');
  const scalar = v => typeof v === 'string' && v.length <= 300 || typeof v === 'number' && Number.isFinite(v) || typeof v === 'boolean';
  for (const key of parameters) {
    const value = params[key];
    if (!(scalar(value) || Array.isArray(value) && value.length <= 30 && value.every(scalar))) throw new Error('조회 기준 변수 값이 올바르지 않습니다.');
  }
  const request = transform(template.request, name => params[name], new Set());
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > MAX_BYTES) throw new Error('조회 요청이 너무 큽니다.');
  if (template.kind === 'query') validateStructuredQuery(request); else validatePlan(request);
  return { kind: template.kind, request };
}

function pathFor(directory, name) {
  if (!validName(name)) throw new Error('기준 이름은 영문 소문자로 시작하는 영문 소문자·숫자·하이픈·밑줄이어야 합니다.');
  return join(directory, `${name}.json`);
}

export function createCriteriaStore(directory = join(stateDirectory(), 'criteria')) {
  return {
    async save(name, template) {
      const path = pathFor(directory, name), { parameters } = validateCriteria(template);
      const contents = `${JSON.stringify(template)}\n`;
      if (Buffer.byteLength(contents, 'utf8') > MAX_BYTES) throw new Error('조회 기준이 너무 큽니다.');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      let file, identity;
      try { file = await open(path, 'wx', 0o600); identity = await file.stat(); await file.writeFile(contents, 'utf8'); }
      catch (error) {
        if (file) await file.close().catch(() => {});
        if (identity) try { const current = await lstat(path); if (current.isFile() && current.dev === identity.dev && current.ino === identity.ino) await unlink(path); } catch { /* already removed */ }
        if (error?.code === 'EEXIST') throw new Error('같은 이름의 조회 기준이 이미 있습니다.');
        throw error;
      }
      await file.close();
      return { name, kind: template.kind, parameters };
    },
    async load(name) {
      const path = pathFor(directory, name), before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_BYTES) throw new Error('조회 기준 파일이 올바르지 않습니다.');
      const file = await open(path, 'r');
      try {
        const after = await file.stat();
        if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size > MAX_BYTES) throw new Error('조회 기준 파일이 올바르지 않습니다.');
        const raw = await file.readFile('utf8');
        if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) throw new Error('조회 기준이 너무 큽니다.');
        return validateCriteria(JSON.parse(raw));
      } finally { await file.close(); }
    },
    async list() {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
      return entries.filter(entry => entry.isFile() && entry.name.endsWith('.json') && validName(entry.name.slice(0, -5))).map(entry => entry.name.slice(0, -5)).sort();
    },
    async remove(name) { await unlink(pathFor(directory, name)); },
  };
}
