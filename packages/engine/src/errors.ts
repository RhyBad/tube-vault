/**
 * The engine's single failure type (v1 `EngineError` port).
 *
 * Carries the bounded stderr tail of the failed child process so callers (the
 * worker) can classify the failure via @tubevault/core (`classifyErrorKind`,
 * `isBotWall`) — the engine reports, it never decides retry semantics.
 */
export class EngineError extends Error {
  /** Last ~50 stderr lines of the failed child, when a child actually ran. */
  readonly stderrTail?: readonly string[];

  constructor(message: string, stderrTail?: readonly string[]) {
    super(message);
    this.name = 'EngineError';
    this.stderrTail = stderrTail;
  }
}
