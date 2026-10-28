import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import { setTimeout as sleep } from 'node:timers/promises';

const context = new AsyncLocalStorage(),
  failedConnections = new WeakSet(),
  requests = new WeakMap();
channel('undici:request:create').subscribe(({ request }) => {
  const state = context.getStore();
  if (state) requests.set(request, state);
});
// Undici publishes fresh connectParams objects for beforeConnect/connectError;
// associate the actual Error with fetch.cause instead of those object copies.
channel('undici:client:connectError').subscribe(({ error }) => {
  if (error && typeof error === 'object') failedConnections.add(error);
});
channel('undici:client:sendHeaders').subscribe(({ request }) => {
  const state = requests.get(request);
  if (state) state.sent = true;
});

// Retry at most once, and ONLY with positive evidence that connection setup
// failed before HTTP headers were sent. No retry after a query may have run.
export async function fetchReadOnly(url, options, { send = fetch, onRetry = () => {} } = {}) {
  for (let attempt = 0; ; attempt++) {
    const state = { sent: false };
    try {
      return await context.run(state, () => send(url, options));
    } catch (error) {
      let cause = error,
        connectionError;
      for (let depth = 0; cause && depth < 4; depth++, cause = cause.cause)
        if (failedConnections.has(cause)) {
          connectionError = cause;
          break;
        }
      const transient = [
        'UND_ERR_CONNECT_TIMEOUT',
        'ECONNRESET',
        'ECONNREFUSED',
        'ENETUNREACH',
        'EHOSTUNREACH',
        'ETIMEDOUT',
      ].includes(connectionError?.code);
      if (attempt || state.sent || !transient || options.signal?.aborted) throw error;
      onRetry(connectionError.code);
      await sleep(100 + Math.floor(Math.random() * 100));
    }
  }
}
