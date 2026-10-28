import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { runAgent, agentRequest } from '../src/agent.js';
const query = {
  source: 'quality-inspections',
  filters: [{ field: 'inspectionDate', op: 'eq', value: '2099-01-01' }],
  limit: 1,
};
test('같은 프로세스에서도 매 요청 로그인 상태를 확인하고 임의 코드나 쓰기 명령은 받지 않는다', async () => {
  let logged = true,
    calls = 0;
  const dependencies = {
    token: async () => {
      calls++;
      if (!logged) throw Error('logged out');
      return 'safe';
    },
    api: { structuredQuery: async (token) => ({ tokenPresent: token === 'safe' }) },
  };
  assert.deepEqual(await agentRequest({ id: 1, method: 'query', params: query }, dependencies), {
    tokenPresent: true,
  });
  logged = false;
  await assert.rejects(
    agentRequest({ id: 2, method: 'query', params: query }, dependencies),
    /logged out/,
  );
  await assert.rejects(
    agentRequest({ id: 3, method: 'update', params: {} }, dependencies),
    /읽기 요청/,
  );
  assert.equal(calls, 2);
});
test('큰 입력과 잘못된 JSON을 한 건의 오류로 처리하고 뒤의 요청을 계속 실행한다', async () => {
  let output = '',
    calls = 0;
  const input = Readable.from([
    Buffer.from('x'.repeat(20000) + '\n{bad}\n'),
    Buffer.from(JSON.stringify({ id: 'ok', method: 'query', params: query })),
  ]);
  await runAgent({
    input,
    output: new Writable({
      write(chunk, _enc, done) {
        output += chunk.toString();
        done();
      },
    }),
    execute: async () => {
      calls++;
      return { items: [] };
    },
  });
  const lines = output.trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].ok, false);
  assert.equal(lines[1].ok, false);
  assert.equal(lines[2].ok, true);
  assert.equal(calls, 1);
});
test('기존 파일이면 인증 전에 거부하고 stdout backpressure를 지킨다', async () => {
  let auth = 0;
  await assert.rejects(
    agentRequest(
      { id: 1, method: 'image', params: { inspectionId: 'fake', index: 1, output: 'existing' } },
      {
        newPath: async () => {
          throw Error('exists');
        },
        token: async () => {
          auth++;
        },
      },
    ),
    /exists/,
  );
  assert.equal(auth, 0);
  let writes = 0;
  await runAgent({
    input: Readable.from(['{"id":1}\n{"id":2}\n']),
    output: new Writable({
      highWaterMark: 1,
      write(_chunk, _enc, done) {
        writes++;
        setTimeout(done, 5);
      },
    }),
    execute: async () => ({ items: [] }),
  });
  assert.equal(writes, 2);
});
test('수신자가 stdout을 닫으면 다음 조회를 실행하지 않는다', { timeout: 1000 }, async () => {
  let calls = 0;
  const output = new Writable({
    highWaterMark: 1,
    write(_chunk, _enc, _done) {
      setImmediate(() => output.destroy());
    },
  });
  await runAgent({
    input: Readable.from(['{"id":1}\n{"id":2}\n']),
    output,
    execute: async () => {
      calls++;
      return {};
    },
  });
  assert.equal(calls, 1);
});
