/**
 * Close a BullMQ Worker WITHOUT racing its own connection bring-up — and
 * WITHOUT hanging on a dead broker. Two failure shapes, both covered:
 *
 * 1. INIT-RACE CRASH: bullmq 5.79's `RedisConnection.close()` ends with
 *    `removeAllListeners()`, but the connection's in-flight `initializing`
 *    promise keeps a constructor `.catch(err => this.emit('error', err))`
 *    armed — a close that lands while the connection is still initializing
 *    (SIGTERM seconds after boot: exactly the compose `docker stop`-during-
 *    restart shape) can fire that emit AFTER the listeners are gone, which is
 *    a hard process crash (`Emitted 'error' event on RedisConnection
 *    instance`); a sibling shape leaves an ioredis reconnect timer behind and
 *    the drained-loop PID-1 exit never happens (observed: the worker survives
 *    `stop_grace_period` and dies by SIGKILL/137). Settling the worker first
 *    (`waitUntilReady`) closes that window: by the time `close()` runs,
 *    `initializing` has already resolved (or rejected — swallowed here) and
 *    the clean quit path executes.
 *
 * 2. DOWN-REDIS HANG: with the broker unreachable at shutdown,
 *    `waitUntilReady` NEVER settles (ioredis retries forever under the
 *    worker's `maxRetriesPerRequest: null`) — an unbounded await here turned
 *    every dead-broker shutdown into the full stop_grace_period + SIGKILL
 *    (guaranteed exit 137). The settle is therefore RACED against a short
 *    timeout and `close()` runs regardless; everything is wrapped so nothing
 *    can reject out of a shutdown hook.
 *
 * Applies to WORKERS only: every Queue producer in this app awaits a command
 * before it is ever closed, so queue connections are always settled already.
 */
import type { Worker } from 'bullmq';

/** How long to wait for the connection to settle before closing anyway. */
export const SETTLE_CAP_MS = 5_000;

export async function settleThenClose(worker: Worker | undefined): Promise<void> {
  if (worker === undefined) {
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      worker.waitUntilReady().catch(() => undefined), // a dead broker: close() cleans up anyway
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SETTLE_CAP_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer); // never leave a shutdown-delaying handle on the loop
  }
  await worker.close().catch(() => undefined); // shutdown must not reject on a broker error
}
