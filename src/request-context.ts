/**
 * Request-scoped BW client, used by the HTTP transport.
 *
 * Under principal propagation the client carries one user's identity, so it cannot be
 * a module-level singleton. The active client lives in an AsyncLocalStorage for the
 * duration of the request, and `createClientFromEnv()` consults it (see bw-client.ts).
 *
 * stdio does not use this: there is one process, one user, one set of credentials.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { BwClient } from './bw-client.js';

const storage = new AsyncLocalStorage<BwClient>();

export function runWithClient<T>(client: BwClient, fn: () => Promise<T>): Promise<T> {
  return storage.run(client, fn);
}

/** The active request's client, or undefined under stdio. */
export function currentClient(): BwClient | undefined {
  return storage.getStore();
}
