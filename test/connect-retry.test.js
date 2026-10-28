import test from 'node:test';
import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import { fetchReadOnly } from '../src/connect-retry.js';
import { createServer } from 'node:net';
test('전송 전 연결 실패만 한 번 재시도하고 전송 뒤 오류나 상태 응답은 반복하지 않는다', async () => {
  let calls = 0;
  const failure = () => {
    const e = Object.assign(Error('connect'), { code: 'ECONNRESET' });
    channel('undici:client:connectError').publish({ connectParams: {}, error: e });
    return e;
  };
  const result = await fetchReadOnly(
    'https://fake.test',
    {},
    {
      send: async () => {
        calls++;
        if (calls === 1) throw Error('connect', { cause: failure() });
        return { status: 200 };
      },
    },
  );
  assert.equal(result.status, 200);
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(
    fetchReadOnly(
      'https://fake.test',
      {},
      {
        send: async () => {
          calls++;
          const cause = failure();
          const request = {};
          channel('undici:request:create').publish({ request });
          channel('undici:client:sendHeaders').publish({ request });
          throw Error('after-send', { cause });
        },
      },
    ),
    /after-send/,
  );
  assert.equal(calls, 1);
  calls = 0;
  const response = await fetchReadOnly(
    'https://fake.test',
    {},
    {
      send: async () => {
        calls++;
        return { status: 503 };
      },
    },
  );
  assert.equal(response.status, 503);
  assert.equal(calls, 1);
});
test('재시도는 한 번으로 제한하고 연결 실패 증거가 없는 오류는 반복하지 않는다', async () => {
  let calls = 0;
  await assert.rejects(
    fetchReadOnly(
      'https://fake.test',
      {},
      {
        send: async () => {
          calls++;
          throw Error('unknown');
        },
      },
    ),
  );
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(
    fetchReadOnly(
      'https://fake.test',
      {},
      {
        send: async () => {
          calls++;
          const cause = Object.assign(Error('connect'), { code: 'ECONNRESET' });
          channel('undici:client:connectError').publish({ connectParams: {}, error: cause });
          throw Error('failed', { cause });
        },
      },
    ),
  );
  assert.equal(calls, 2);
});
test('실제 TLS 연결 초기화 오류의 fetch.cause를 연결 오류 이벤트와 대응한다', async () => {
  let connections = 0,
    retries = 0;
  const server = createServer((socket) => {
    connections++;
    socket.destroy();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(
      fetchReadOnly(
        `https://127.0.0.1:${server.address().port}/`,
        { signal: AbortSignal.timeout(3000) },
        { onRetry: () => retries++ },
      ),
    );
    assert.equal(retries, 1);
    assert.equal(connections, 2);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
