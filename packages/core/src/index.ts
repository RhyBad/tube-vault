/**
 * @tubevault/core — the domain layer (v1 port, P2) + core services (P8).
 *
 * src/domain/* is PURE: zero runtime deps beyond @tubevault/types — no I/O, no
 * clock, no Prisma. src/services/* may use Node builtins (the credential
 * cipher needs node:crypto/node:fs per PLAN.md's architecture); core is
 * Node-only everywhere it is consumed — the browser-safe package is
 * @tubevault/types, which apps/web depends on exclusively.
 */
export * from './domain/acquisition.js';
export * from './domain/availability.js';
export * from './domain/bot-wall.js';
export * from './domain/credential.js';
export * from './domain/error-kind.js';
export * from './domain/integrity.js';
export * from './domain/live.js';
export * from './domain/policy.js';
export * from './domain/priority.js';
export * from './domain/source-recheck.js';
export * from './domain/video-status.js';
export * from './services/credential-cipher.js';
