/**
 * Sentinel-prefixed yt-dlp progress parsing. The line shape is produced by
 * `--progress-template "download:TVPROG1 %(progress)j"` (PLAN.md verified
 * fact): yt-dlp emits `TVPROG1 {json}` per progress event. Parsing is
 * telemetry-only and must NEVER throw on garbage — the download result comes
 * from the directory scan, not from these lines.
 */
import { describe, expect, it } from 'vitest';

import { parseProgressLine } from './progress.js';

const line = (payload: object): string => `TVPROG1 ${JSON.stringify(payload)}`;

describe('parseProgressLine', () => {
  it('parses a downloading frame (v1 progress_from_hook mapping, camelCased)', () => {
    const frame = parseProgressLine(
      line({
        status: 'downloading',
        downloaded_bytes: 1024,
        total_bytes: 4096,
        speed: 512.5,
        eta: 6,
        filename: '/staging/abc.mp4',
        fragment_index: 3,
        fragment_count: 10,
      }),
    );
    expect(frame).toEqual({
      phase: 'DOWNLOADING',
      downloadedBytes: 1024,
      totalBytes: 4096,
      speedBps: 512.5,
      etaSeconds: 6,
      filename: '/staging/abc.mp4',
      fragmentIndex: 3,
      fragmentCount: 10,
    });
  });

  it('maps finished/error statuses to their phases', () => {
    expect(parseProgressLine(line({ status: 'finished', downloaded_bytes: 9 }))?.phase).toBe(
      'FINISHED',
    );
    expect(parseProgressLine(line({ status: 'error' }))?.phase).toBe('ERROR');
  });

  it('falls back to total_bytes_estimate when total_bytes is absent (v1 semantics)', () => {
    const frame = parseProgressLine(
      line({ status: 'downloading', downloaded_bytes: 1, total_bytes_estimate: 2000.7 }),
    );
    expect(frame?.totalBytes).toBe(2000);
  });

  it('coerces string numbers and truncates byte/eta values to integers', () => {
    const frame = parseProgressLine(
      line({ status: 'downloading', downloaded_bytes: '1536.9', eta: 4.8, speed: '256.5' }),
    );
    expect(frame?.downloadedBytes).toBe(1536);
    expect(frame?.etaSeconds).toBe(4);
    expect(frame?.speedBps).toBe(256.5);
  });

  it('treats null/absent/non-finite optionals as null (never NaN)', () => {
    const frame = parseProgressLine(
      line({ status: 'downloading', speed: null, eta: 'Unknown', total_bytes: 'NaN' }),
    );
    expect(frame).toEqual({
      phase: 'DOWNLOADING',
      downloadedBytes: 0,
      totalBytes: null,
      speedBps: null,
      etaSeconds: null,
      filename: null,
      fragmentIndex: null,
      fragmentCount: null,
    });
  });

  it('passes through unknown keys without failing (yt-dlp adds fields freely)', () => {
    const frame = parseProgressLine(
      line({ status: 'downloading', downloaded_bytes: 5, elapsed: 1.2, _percent_str: ' 50.0%' }),
    );
    expect(frame?.downloadedBytes).toBe(5);
  });

  it('returns null for non-sentinel lines', () => {
    expect(parseProgressLine('[download] Destination: /staging/abc.mp4')).toBeNull();
    expect(parseProgressLine('')).toBeNull();
    expect(parseProgressLine('TVPROG1')).toBeNull(); // sentinel without payload separator
  });

  it('never throws on garbage after the sentinel', () => {
    expect(parseProgressLine('TVPROG1 not-json-at-all')).toBeNull();
    expect(parseProgressLine('TVPROG1 {"status": "warming-up"}')).toBeNull(); // unknown status
    expect(parseProgressLine('TVPROG1 {"no_status": true}')).toBeNull();
    expect(parseProgressLine('TVPROG1 [1,2,3]')).toBeNull();
  });

  it('tolerates a trailing carriage return (CRLF-safe)', () => {
    expect(parseProgressLine(`${line({ status: 'finished' })}\r`)?.phase).toBe('FINISHED');
  });
});
