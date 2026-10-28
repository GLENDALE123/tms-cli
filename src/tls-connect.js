import { lookup } from 'node:dns';
import { connect } from 'node:tls';
import { isIP } from 'node:net';

// Race connection setup only. HTTP and its Authorization header are sent once,
// after a verified TLS winner is handed to the HTTP client. No pinned relay IPs.
export function createTlsConnector({
  resolve = lookup,
  dial = connect,
  delayMs = 500,
  timeoutMs = 10000,
} = {}) {
  return (options, callback) => {
    const hostname = options.hostname;
    if (
      options.protocol !== 'https:' ||
      typeof hostname !== 'string' ||
      !hostname ||
      options.httpSocket
    ) {
      queueMicrotask(() => callback(new Error('HTTPS connection required'), null));
      return;
    }
    let done = false,
      hedge,
      lastError;
    const sockets = new Set();
    const finish = (error, winner) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      clearTimeout(hedge);
      for (const socket of sockets) if (socket !== winner) socket.destroy();
      callback(error, winner ?? null);
    };
    const deadline = setTimeout(() => {
      const error = new Error('TLS connection timed out');
      error.code = 'UND_ERR_CONNECT_TIMEOUT';
      finish(error);
    }, timeoutMs);
    deadline.unref?.();
    resolve(hostname, { all: true, verbatim: true }, (error, records) => {
      if (done) return;
      if (error) {
        finish(error);
        return;
      }
      const all = [
        ...new Map(
          (records ?? [])
            .filter((r) => r && [4, 6].includes(r.family) && isIP(r.address) === r.family)
            .map((r) => [r.address, r]),
        ).values(),
      ];
      const first = all[0],
        second = all.find((r) => r.family !== first?.family) ?? all[1];
      const addresses = [first, second].filter(Boolean);
      if (!addresses.length) {
        finish(new Error('No service address'));
        return;
      }
      let started = 0,
        failed = 0;
      const start = () => {
        if (done || started >= addresses.length) return;
        const address = addresses[started++];
        let socket;
        const failure = (error) => {
          if (done) return;
          lastError = error;
          failed++;
          if (started < addresses.length) {
            clearTimeout(hedge);
            start();
          } else if (failed === started) finish(lastError);
        };
        try {
          socket = dial({
            host: address.address,
            family: address.family,
            port: Number(options.port) || 443,
            servername: hostname,
            rejectUnauthorized: true,
            ALPNProtocols: ['http/1.1'],
          });
          sockets.add(socket);
          socket.setNoDelay(true);
          socket.once('error', failure);
          socket.once('secureConnect', () => {
            if (done) {
              socket.destroy();
              return;
            }
            if (!socket.authorized) {
              const error = new Error('TLS certificate verification failed');
              error.code = 'CERTIFICATE_VERIFY_FAILED';
              socket.destroy();
              failure(error);
              return;
            }
            finish(null, socket);
          });
        } catch (error) {
          failure(error);
        }
      };
      start();
      if (!done && started < addresses.length) hedge = setTimeout(start, delayMs);
    });
  };
}
