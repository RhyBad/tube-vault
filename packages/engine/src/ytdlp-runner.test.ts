/**
 * Detached subprocess runner: line-streamed stdout, bounded stderr tail,
 * abort -> process-GROUP SIGTERM -> grace -> SIGKILL (v1 capture_subprocess
 * spawn/terminate patterns, hardened for the queue's cancel semantics).
 *
 * Tests drive `node -e` children — deterministic, no yt-dlp needed.
 */
import { describe, expect, it } from 'vitest';

import { EngineError } from './errors.js';
import { runYtdlp } from './ytdlp-runner.js';

const NODE = process.execPath;

/** A child that prints one line, then keeps the event loop alive forever. */
const HANG_AFTER_LINE = 'console.log("up"); setInterval(() => {}, 1000);';
/** Same, but traps SIGTERM so only the SIGKILL escalation can end it. */
const STUBBORN = 'process.on("SIGTERM", () => {}); console.log("up"); setInterval(() => {}, 500);';

describe('runYtdlp', () => {
  it('resolves exitCode 0 and streams stdout lines through onLine', async () => {
    const lines: string[] = [];
    const result = await runYtdlp(NODE, ['-e', 'console.log("one"); console.log("two");'], {
      onLine: (l) => lines.push(l),
    });
    expect(result).toEqual({ exitCode: 0, aborted: false, stderrTail: [] });
    expect(lines).toEqual(['one', 'two']);
  });

  it('NEVER rejects on a nonzero exit — callers decide (classification is core policy)', async () => {
    const result = await runYtdlp(NODE, [
      '-e',
      'console.error("ERROR: HTTP Error 429: Too Many Requests"); process.exit(1);',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.aborted).toBe(false);
    expect(result.stderrTail).toEqual(['ERROR: HTTP Error 429: Too Many Requests']);
  });

  it('keeps only the LAST ~50 stderr lines (bounded ring buffer)', async () => {
    const script = 'for (let i = 1; i <= 60; i++) console.error(`line ${i}`);';
    const { stderrTail } = await runYtdlp(NODE, ['-e', script]);
    expect(stderrTail).toHaveLength(50);
    expect(stderrTail[0]).toBe('line 11');
    expect(stderrTail[49]).toBe('line 60');
  });

  it('rejects with EngineError when the binary cannot be spawned', async () => {
    await expect(runYtdlp('/nonexistent/yt-dlp-bin', ['--version'])).rejects.toThrow(EngineError);
  });

  it('abort SIGTERMs the process group and resolves aborted:true (group is dead)', async () => {
    const controller = new AbortController();
    let pid = 0;
    const result = await runYtdlp(NODE, ['-e', HANG_AFTER_LINE], {
      signal: controller.signal,
      onSpawn: (p) => {
        pid = p;
      },
      onLine: () => controller.abort(),
    });
    expect(result.aborted).toBe(true);
    expect(pid).toBeGreaterThan(0);
    // The detached child was its own process-group leader; after resolution the
    // whole group must be gone (kill(-pid, 0) probes the group -> ESRCH).
    expect(() => process.kill(-pid, 0)).toThrow();
  }, 15_000);

  it('escalates to SIGKILL after killGraceMs when the child ignores SIGTERM', async () => {
    const controller = new AbortController();
    let pid = 0;
    const result = await runYtdlp(NODE, ['-e', STUBBORN], {
      signal: controller.signal,
      killGraceMs: 200,
      onSpawn: (p) => {
        pid = p;
      },
      onLine: () => controller.abort(),
    });
    expect(result.aborted).toBe(true);
    expect(result.exitCode).toBeNull(); // killed by signal, not a clean exit
    expect(() => process.kill(-pid, 0)).toThrow();
  }, 15_000);

  it('an already-aborted signal kills immediately', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runYtdlp(NODE, ['-e', HANG_AFTER_LINE], { signal: controller.signal });
    expect(result.aborted).toBe(true);
  }, 15_000);

  it('honors cwd', async () => {
    const lines: string[] = [];
    await runYtdlp(NODE, ['-e', 'console.log(process.cwd());'], {
      cwd: '/tmp',
      onLine: (l) => lines.push(l),
    });
    expect(lines[0]).toBe('/tmp');
  });
});
