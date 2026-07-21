/**
 * @tubevault/storage — the filesystem vault layer (v1 `adapters/storage.py`
 * LocalFileStore, ported one-for-one). Consumed by the worker (P6) and the
 * api's media serving (P9). Zero runtime deps — Node fs only.
 */
export * from './local-file-store.js';
export * from './path-containment.js';
