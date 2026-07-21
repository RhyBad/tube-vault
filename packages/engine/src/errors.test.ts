/**
 * EngineError: the engine's single failure type. It carries the bounded stderr
 * tail of the failed yt-dlp/ffprobe child so callers (worker) can classify the
 * failure (@tubevault/core classifyErrorKind) without the engine deciding.
 */
import { describe, expect, it } from 'vitest';

import { EngineError } from './errors.js';

describe('EngineError', () => {
  it('is an Error with the engine name and message', () => {
    const err = new EngineError('yt-dlp exploded');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(EngineError);
    expect(err.name).toBe('EngineError');
    expect(err.message).toBe('yt-dlp exploded');
  });

  it('carries the optional stderr tail verbatim', () => {
    const tail = ['WARNING: something', 'ERROR: HTTP Error 429: Too Many Requests'];
    const err = new EngineError('download failed', tail);
    expect(err.stderrTail).toEqual(tail);
  });

  it('leaves stderrTail undefined when the failure had no child stderr', () => {
    expect(new EngineError('spawn failed').stderrTail).toBeUndefined();
  });
});
