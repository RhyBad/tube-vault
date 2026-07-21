import {
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';

/**
 * Keeps the worker's event loop alive between consumers: the live role has no
 * consumers until P10, and a drained loop would exit(0) into a compose restart
 * storm. The interval MUST be cleared on shutdown — in the deployed image node
 * is PID 1 (unless compose `init: true`), so Nest's end-of-hooks signal
 * re-raise is a kernel no-op and the ONLY way the process exits is the event
 * loop draining. A leaked interval means every `docker stop` burns the full
 * stop_grace_period and dies by SIGKILL (exit 137) — indistinguishable from a
 * clipped yt-dlp/live-capture teardown (P6/P10). Covered by
 * test/worker-shutdown.e2e.test.ts (simulated PID-1 semantics).
 */
@Injectable()
export class KeepAliveService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => undefined, 60_000);
  }

  onApplicationShutdown(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}
