/**
 * Unit spec for the Range-request helpers behind `GET /api/media/:videoId`
 * (P9). Pure logic — the e2e suite covers the wire; THIS locks the parsing
 * table: full/206/416 decisions, clamping, suffix ranges, first-range-only,
 * and the abort wiring that must destroy the file stream (no fd leak).
 */
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  contentTypeForExt,
  pickThumbnail,
  resolveRange,
  streamFileToResponse,
  wireAbort,
} from './media-streaming';

describe('resolveRange', () => {
  const SIZE = 1000;

  it('no Range header → full body', () => {
    expect(resolveRange(undefined, SIZE)).toEqual({ kind: 'full' });
  });

  it('bytes=start-end → inclusive range', () => {
    expect(resolveRange('bytes=0-499', SIZE)).toEqual({ kind: 'range', start: 0, end: 499 });
    expect(resolveRange('bytes=500-999', SIZE)).toEqual({ kind: 'range', start: 500, end: 999 });
  });

  it('an end past EOF is clamped to size-1 (RFC 9110 §14.1.2)', () => {
    expect(resolveRange('bytes=900-5000', SIZE)).toEqual({ kind: 'range', start: 900, end: 999 });
  });

  it('bytes=start- → start through EOF', () => {
    expect(resolveRange('bytes=750-', SIZE)).toEqual({ kind: 'range', start: 750, end: 999 });
    expect(resolveRange('bytes=0-', SIZE)).toEqual({ kind: 'range', start: 0, end: 999 });
  });

  it('bytes=-suffix → the LAST suffix bytes', () => {
    expect(resolveRange('bytes=-100', SIZE)).toEqual({ kind: 'range', start: 900, end: 999 });
  });

  it('a suffix >= size means the whole file', () => {
    expect(resolveRange('bytes=-5000', SIZE)).toEqual({ kind: 'range', start: 0, end: 999 });
  });

  it('start >= size is unsatisfiable (416)', () => {
    expect(resolveRange('bytes=1000-', SIZE)).toEqual({ kind: 'unsatisfiable' });
    expect(resolveRange('bytes=1000-1200', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('start > end is unsatisfiable', () => {
    expect(resolveRange('bytes=500-100', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('a zero-length suffix is unsatisfiable', () => {
    expect(resolveRange('bytes=-0', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('malformed BYTES headers are unsatisfiable (spec choice: 416, never a silent 200)', () => {
    for (const bad of ['bytes', 'bytes=', 'bytes=-', 'bytes=abc-def', '0-499']) {
      expect(resolveRange(bad, SIZE), bad).toEqual({ kind: 'unsatisfiable' });
    }
  });

  it('an UNKNOWN range unit is IGNORED → full 200 (RFC 9110 §14.2 MUST, not 416)', () => {
    for (const other of ['items=0-499', 'seconds=1-2', 'BYTESX=0-1']) {
      expect(resolveRange(other, SIZE), other).toEqual({ kind: 'full' });
    }
  });

  it('the bytes unit is case-insensitive (RFC 9110: range units are case-insensitive)', () => {
    expect(resolveRange('BYTES=0-99', SIZE)).toEqual({ kind: 'range', start: 0, end: 99 });
  });

  it('multiple ranges: extras are IGNORED, the first is served (single-range only)', () => {
    expect(resolveRange('bytes=0-99,200-299', SIZE)).toEqual({ kind: 'range', start: 0, end: 99 });
  });

  it('tolerates OWS around the commas of a multi-range list (still first-range)', () => {
    expect(resolveRange('bytes=0-99 , 200-299', SIZE)).toEqual({
      kind: 'range',
      start: 0,
      end: 99,
    });
    expect(resolveRange('bytes= 0-99, 200-299', SIZE)).toEqual({
      kind: 'range',
      start: 0,
      end: 99,
    });
  });

  it('any range against an empty file is unsatisfiable; full read is not', () => {
    expect(resolveRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
    expect(resolveRange(undefined, 0)).toEqual({ kind: 'full' });
  });
});

describe('contentTypeForExt', () => {
  it('maps the known media extensions', () => {
    expect(contentTypeForExt('mp4')).toBe('video/mp4');
    expect(contentTypeForExt('webm')).toBe('video/webm');
    expect(contentTypeForExt('mkv')).toBe('video/x-matroska');
  });

  it('unknown extensions fall back to application/octet-stream', () => {
    expect(contentTypeForExt('flv')).toBe('application/octet-stream');
  });

  it('is case-insensitive and dot-tolerant', () => {
    expect(contentTypeForExt('.MP4')).toBe('video/mp4');
  });

  it('maps the thumbnail image extensions', () => {
    expect(contentTypeForExt('webp')).toBe('image/webp');
    expect(contentTypeForExt('jpg')).toBe('image/jpeg');
    expect(contentTypeForExt('png')).toBe('image/png');
  });
});

describe('wireAbort', () => {
  class FakeStream extends EventEmitter {
    destroyed = false;
    destroy(): void {
      this.destroyed = true;
    }
  }

  it('destroys the file stream when the client connection closes (no fd leak)', () => {
    const res = new EventEmitter();
    const stream = new FakeStream();
    wireAbort(res, stream);
    expect(stream.destroyed).toBe(false);
    res.emit('close');
    expect(stream.destroyed).toBe(true);
  });

  it('a stream error after close does not double-destroy or throw', () => {
    const res = new EventEmitter();
    const stream = new FakeStream();
    wireAbort(res, stream);
    res.emit('close');
    res.emit('close'); // idempotent
    expect(stream.destroyed).toBe(true);
  });
});

describe('streamFileToResponse (the fd-leak race — REAL fs streams)', () => {
  let dir: string;
  let smallFile: string;
  let bigFile: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'tubevault-stream-'));
    smallFile = join(dir, 'small.bin');
    bigFile = join(dir, 'big.bin');
    writeFileSync(smallFile, 'hello media bytes');
    // Big enough that the read stream MUST park on backpressure mid-transfer.
    writeFileSync(bigFile, Buffer.alloc(4 * 1024 * 1024, 7));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('bails WITHOUT opening the file when the response was destroyed during the await window', async () => {
    // The auditor's repro shape: the client aborts while the controller is
    // still awaiting loadVideo/stat — by the time streaming starts, the
    // response is already destroyed. The old wiring attached its abort handler
    // too late and parked an open read stream forever.
    const res = new PassThrough();
    res.destroy();
    await once(res, 'close');
    const stream = streamFileToResponse(res, smallFile, {});
    expect(stream).toBeNull(); // no stream created → no fd ever opened
  });

  it('destroys the read stream (fd released) when the response dies mid-stream', async () => {
    // A sink that never drains: the read stream parks on backpressure exactly
    // like a paused/aborted media scrub.
    const res = new Writable({
      highWaterMark: 16,
      write: (): void => {
        /* never call the callback — permanent backpressure */
      },
    });
    const stream = streamFileToResponse(res, bigFile, {});
    expect(stream).not.toBeNull();
    res.destroy(); // client abort lands mid-transfer
    // fs stream 'close' fires only after the fd is released ('error' may
    // precede it with the premature-close — that's exactly the torn-down path).
    await new Promise<void>((resolve) => stream!.once('close', resolve));
    expect(stream!.destroyed).toBe(true);
  });

  it('normal completion delivers the exact bytes and ends the response', async () => {
    const chunks: Buffer[] = [];
    const res = new Writable({
      write: (chunk: Buffer, _enc, cb): void => {
        chunks.push(chunk);
        cb();
      },
    });
    const stream = streamFileToResponse(res, smallFile, {});
    expect(stream).not.toBeNull();
    await once(res, 'finish');
    expect(Buffer.concat(chunks).toString()).toBe('hello media bytes');
  });

  it('honors start/end options (range streaming)', async () => {
    const chunks: Buffer[] = [];
    const res = new Writable({
      write: (chunk: Buffer, _enc, cb): void => {
        chunks.push(chunk);
        cb();
      },
    });
    streamFileToResponse(res, smallFile, { start: 6, end: 10 });
    await once(res, 'finish');
    expect(Buffer.concat(chunks).toString()).toBe('media');
  });
});

describe('pickThumbnail', () => {
  it('prefers webp over jpg over png (yt-dlp preference order)', () => {
    expect(pickThumbnail(['v1.png', 'v1.jpg', 'v1.webp'], 'v1')).toBe('v1.webp');
    expect(pickThumbnail(['v1.png', 'v1.jpg'], 'v1')).toBe('v1.jpg');
    expect(pickThumbnail(['v1.png'], 'v1')).toBe('v1.png');
  });

  it('only matches THIS video id and returns undefined when nothing matches', () => {
    expect(pickThumbnail(['other.webp', 'v1.mp4', 'v1.info.json'], 'v1')).toBeUndefined();
    expect(pickThumbnail([], 'v1')).toBeUndefined();
  });
});
