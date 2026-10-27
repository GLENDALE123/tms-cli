import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCriteriaStore, bindCriteria, validateCriteria } from '../src/criteria.js';

const template = { kind: 'query', request: { source: 'quality-inspections', filters: [
  { field: 'supplier', op: 'eq', value: { $param: 'supplier' } },
  { field: 'productName', op: 'eq', value: { $param: 'product' } },
  { field: 'partName', op: 'eq', value: { $param: 'part' } },
], limit: 10 } };

test('에이전트가 만든 기준을 저장하고 매번 다른 변수로 바인딩한다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tms-criteria-test-'));
  try {
    const store = createCriteriaStore(directory);
    assert.deepEqual(await store.save('quality-jig', template), { name: 'quality-jig', kind: 'query', parameters: ['part', 'product', 'supplier'] });
    assert.deepEqual(await store.list(), ['quality-jig']);
    const saved = await store.load('quality-jig');
    const bound = bindCriteria(saved.template, { supplier: '가상 업체', product: '가상 제품', part: '외캡' });
    assert.deepEqual(bound.request.filters.map(f => f.value), ['가상 업체', '가상 제품', '외캡']);
    assert.ok((await readFile(join(directory, 'quality-jig.json'), 'utf8')).includes('$param'));
    await assert.rejects(store.save('quality-jig', template), /이미/);
    assert.throws(() => bindCriteria(template, { supplier: '업체', product: '제품' }), /변수/);
    assert.throws(() => bindCriteria(template, { supplier: '업체', product: '제품', part: '외캡', extra: 'x' }), /변수/);
    assert.throws(() => bindCriteria(template, { supplier: { refs: [] }, product: '제품', part: '외캡' }), /변수/);
    await store.remove('quality-jig');
    assert.deepEqual(await store.list(), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('기준은 실행 코드를 받지 않으며 경로와 변수 형식을 검증한다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tms-criteria-test-'));
  try {
    const store = createCriteriaStore(directory);
    await assert.rejects(store.save('../outside', template));
    await assert.rejects(store.save('con', template));
    assert.throws(() => validateCriteria({ kind: 'query', request: { ...template.request, filters: [{ field: 'supplier', op: 'eq', value: { $param: 'supplier', code: 'x' } }] } }));
    assert.throws(() => validateCriteria({ kind: 'script', request: { source: 'users' } }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('단계별 조회 계획의 변수와 이전 결과 참조를 함께 보존한다', () => {
  const plan = { kind: 'plan', request: { steps: [
    { id: 'schedule', query: { source: 'production-schedules', filters: [{ field: 'planDate', op: 'eq', value: { $param: 'day' } }], limit: 10 } },
    { id: 'orders', query: { source: 'hwaseong-coating-orders', filters: [{ field: 'orderNo', op: 'in', value: { refs: [{ step: 'schedule', field: 'orderNumber' }] } }], limit: 10 } },
  ] } };
  const bound = bindCriteria(plan, { day: '2099-01-01' });
  assert.equal(bound.request.steps[0].query.filters[0].value, '2099-01-01');
  assert.deepEqual(bound.request.steps[1].query.filters[0].value, { refs: [{ step: 'schedule', field: 'orderNumber' }] });
});
