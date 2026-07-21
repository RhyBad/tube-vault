/**
 * @tubevault/notify — external notification delivery (P8).
 *
 * Depends only on @tubevault/types; `fetch` is injected for tests. Pure
 * payload builders port the v1 adapter HTTP contracts EXACTLY; the dispatcher
 * is deliberate best-effort direct fan-out (see dispatch.ts for the accepted
 * v1 NOTIFY-job-lane simplification).
 */
export * from './channel.js';
export * from './dispatch.js';
export * from './send.js';
export * from './senders.js';
