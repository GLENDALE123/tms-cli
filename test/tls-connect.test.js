import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createTlsConnector } from '../src/tls-connect.js';

function harness(records, behaviors) {
  const sockets = [],
    options = [];
  const connector = createTlsConnector({
    resolve: (_host, _options, done) => queueMicrotask(() => done(null, records)),
    dial(value) {
      options.push(value);
      const socket = new EventEmitter();
      socket.destroyed = false;
      socket.setNoDelay = () => {};
      socket.destroy = () => {
        socket.destroyed = true;
      };
      socket.authorized = true;
      sockets.push(socket);
      behaviors[value.host]?.(socket);
      return socket;
    },
    delayMs: 5,
    timeoutMs: 40,
  });
  let callbacks = 0;
  const result = new Promise((resolve) =>
    connector(
      { protocol: 'https:', hostname: 'service.example', port: '10000' },
      (error, socket) => {
        callbacks++;
        resolve({ error, socket });
      },
    ),
  );
  return { sockets, options, result, callbacks: () => callbacks };
}
const addresses = [
  { address: '192.0.2.1', family: 4 },
  { address: '192.0.2.2', family: 4 },
];
test('느린 TLS를 두 번째 검증 연결이 앞서면 패자를 닫고 HTTP에는 소켓 하나만 넘긴다', async () => {
  const h = harness(addresses, {
    '192.0.2.2': (s) => setTimeout(() => s.emit('secureConnect'), 1),
  });
  const { error, socket } = await h.result;
  assert.equal(error, null);
  assert.equal(socket, h.sockets[1]);
  assert.equal(h.sockets[0].destroyed, true);
  h.sockets[0].emit('secureConnect');
  h.sockets[0].emit('error', Error('late failure'));
  assert.equal(h.callbacks(), 1);
  for (const option of h.options) {
    assert.equal(option.servername, 'service.example');
    assert.equal(option.rejectUnauthorized, true);
    assert.equal(option.port, 10000);
    assert.equal(Object.hasOwn(option, 'headers'), false);
  }
});
test('인증되지 않은 소켓은 거절하고 빠른 단일 주소는 추가 연결을 만들지 않는다', async () => {
  const failed = harness(addresses.slice(0, 1), {
    '192.0.2.1': (s) =>
      setTimeout(() => {
        s.authorized = false;
        s.emit('secureConnect');
      }, 1),
  });
  assert.equal((await failed.result).error.code, 'CERTIFICATE_VERIFY_FAILED');
  assert.equal(failed.sockets[0].destroyed, true);
  const quick = harness(addresses, {
    '192.0.2.1': (s) => setTimeout(() => s.emit('secureConnect'), 1),
  });
  assert.equal((await quick.result).socket, quick.sockets[0]);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(quick.sockets.length, 1);
});
test('주소 실패는 즉시 다음 주소를 사용하고 IPv6 실패 시 IPv4를 남기며 시간 초과는 모두 닫는다', async () => {
  const records = [
    { address: '2001:db8::1', family: 6 },
    { address: '2001:db8::2', family: 6 },
    ...addresses,
  ];
  const h = harness(records, {
    '2001:db8::1': (s) => setTimeout(() => s.emit('error', Error('offline')), 1),
    '192.0.2.1': (s) => setTimeout(() => s.emit('secureConnect'), 1),
  });
  assert.equal((await h.result).socket, h.sockets[1]);
  assert.deepEqual(
    h.options.map((o) => o.host),
    ['2001:db8::1', '192.0.2.1'],
  );
  const timeout = harness(addresses, {});
  // The connector deadline is deliberately unref'ed in a real CLI.
  const keepAlive = setTimeout(() => {}, 100);
  assert.equal((await timeout.result).error.code, 'UND_ERR_CONNECT_TIMEOUT');
  clearTimeout(keepAlive);
  assert.ok(timeout.sockets.every((s) => s.destroyed));
});
