import { Agent } from 'undici';
import { createTlsConnector } from './tls-connect.js';

// This dispatcher is used only by the already validated read-only service URL.
// Auth refresh keeps its normal transport. Pools and TLS tickets stay in memory.
export const retrievalTransport = new Agent({
  connect: createTlsConnector(),
  connections: 2,
  pipelining: 1,
  keepAliveTimeout: 30000,
  keepAliveMaxTimeout: 30000,
});
