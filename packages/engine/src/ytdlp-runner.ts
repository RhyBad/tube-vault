/**
 * Detached yt-dlp subprocess runner (v1 `capture_subprocess` spawn/terminate
 * patterns, hardened for queue cancel/pause semantics):
 *
 * - `detached: true` makes the child a process-GROUP leader, so an abort can
 *   kill yt-dlp AND any helpers it spawned (`kill(-pid, ...)`) — no orphans.
 * - abort -> SIGTERM the group -> `killGraceMs` grace -> SIGKILL the group.
 * - stdout is line-streamed to `onLine` (sentinel progress lines); stderr keeps
 *   only a bounded tail — enough for error classification, never unbounded.
 * - A nonzero exit RESOLVES (callers decide what a failure means); only a
 *   spawn failure (missing binary) rejects, with an EngineError.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import { EngineError } from './errors.js';

const STDERR_TAIL_LINES = 50;
const DEFAULT_KILL_GRACE_MS = 10_000;

export interface RunYtdlpOptions {
  readonly cwd?: string;
  /** Abort = cancel/pause: SIGTERM the group, then SIGKILL after the grace. */
  readonly signal?: AbortSignal;
  /** Called for every stdout line (progress sentinel parsing happens upstream). */
  readonly onLine?: (line: string) => void;
  /** Exposes the child pid (process-group id) — used by kill probes/tests. */
  readonly onSpawn?: (pid: number) => void;
  /** SIGTERM -> SIGKILL escalation delay. Default 10s. */
  readonly killGraceMs?: number;
}

export interface RunYtdlpResult {
  /** The exit code, or null when the child died from a signal. */
  readonly exitCode: number | null;
  /** True when the run ended because the AbortSignal fired. */
  readonly aborted: boolean;
  /** The LAST ~50 stderr lines (classification input, e.g. bot-wall/429). */
  readonly stderrTail: string[];
}

/** Run a child to completion. Resolves on ANY exit; rejects only on spawn failure. */
export function runYtdlp(
  bin: string,
  args: readonly string[],
  opts: RunYtdlpOptions = {},
): Promise<RunYtdlpResult> {
  const { cwd, signal, onLine, onSpawn, killGraceMs = DEFAULT_KILL_GRACE_MS } = opts;
  return new Promise<RunYtdlpResult>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      detached: true, // own process group -> group-wide kill
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stderrTail: string[] = [];
    let aborted = false;
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;

    const killGroup = (sig: NodeJS.Signals): void => {
      if (child.pid === undefined) {
        return;
      }
      try {
        process.kill(-child.pid, sig);
      } catch {
        // The group is already gone — nothing left to kill.
      }
    };

    const onAbort = (): void => {
      aborted = true;
      killGroup('SIGTERM');
      graceTimer = setTimeout(() => killGroup('SIGKILL'), killGraceMs);
    };

    const cleanup = (): void => {
      if (graceTimer !== undefined) {
        clearTimeout(graceTimer);
      }
      signal?.removeEventListener('abort', onAbort);
    };

    child.once('error', (err) => {
      // Spawn failure (ENOENT/EACCES): no pid, nothing ran — this is the one
      // condition the runner itself reports as an EngineError.
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new EngineError(`failed to launch ${bin}: ${err.message}`));
    });

    child.once('spawn', () => {
      if (child.pid !== undefined) {
        onSpawn?.(child.pid);
      }
    });

    // Read-side pipe errors are practically unreachable on Linux (a killed
    // child yields EOF, not an error), but neither readline nor this runner
    // would otherwise handle an 'error' event on these streams — and an
    // unhandled stream 'error' crashes the whole process. Swallow them:
    // 'close' still fires afterwards and settles the promise normally.
    const swallowStreamError = (): void => {};
    child.stdout.on('error', swallowStreamError);
    child.stderr.on('error', swallowStreamError);

    createInterface({ input: child.stdout }).on('line', (line) => {
      onLine?.(line);
    });
    createInterface({ input: child.stderr }).on('line', (line) => {
      stderrTail.push(line);
      if (stderrTail.length > STDERR_TAIL_LINES) {
        stderrTail.shift();
      }
    });

    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    // 'close' = process exited AND stdio drained: safe to resolve with the tail.
    child.once('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve({ exitCode: code, aborted, stderrTail });
    });
  });
}
