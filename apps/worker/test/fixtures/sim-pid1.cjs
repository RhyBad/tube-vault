// Preload (node --require) that simulates PID-1 signal semantics for the worker
// shutdown e2e: in a container without an init process, node runs as PID 1 and
// the kernel IGNORES default-disposition signals — so when Nest's shutdown-hook
// handler removes its own listener and re-raises SIGTERM, the re-raise is a
// no-op. A permanent no-op JS listener reproduces exactly that: the re-raise is
// delivered to this listener (never the default terminate), and the process can
// only exit by draining its event loop — which is what main.ts must guarantee.
process.on('SIGTERM', () => {
  /* swallow the re-raise, exactly like the kernel does for PID 1 */
});
