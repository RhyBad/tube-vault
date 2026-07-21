/**
 * Range-request helpers for `GET /api/media/:videoId` (P9). Pure functions —
 * the controller stays a thin wire adapter, and the parsing table is unit-
 * tested without touching the filesystem or HTTP.
 *
 * Spec choices (PLAN.md P9 media contract):
 *  - single-range only: a multi-range header serves the FIRST range and
 *    ignores the extras (a multipart/byteranges body buys nothing for one
 *    <video> tag and costs a whole encoder);
 *  - an UNKNOWN range unit (`items=…`) means the header is IGNORED → 200 full
 *    (RFC 9110 §14.2 MUST — a unit we don't speak is not a bytes request we
 *    can refuse);
 *  - malformed BYTES headers → 416 (never a silent 200: a player that sent a
 *    Range it considers vital must hear "no", not get the whole file
 *    mislabeled);
 *  - end past EOF is clamped to size-1 (RFC 9110 §14.1.2).
 */
import { createReadStream, type ReadStream } from 'node:fs';
import { pipeline } from 'node:stream';

/** What the media endpoint should do for a given Range header + file size. */
export type RangeResolution =
  { kind: 'full' } | { kind: 'range'; start: number; end: number } | { kind: 'unsatisfiable' };

/** `<unit>=<range-set>` — RFC 9110 ranges-specifier (unit = an HTTP token). */
const RANGE_HEADER = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+)\s*=\s*([\s\S]*)$/;

/** `<start>-<end?>` or `-<suffix>`; the first range of a list, OWS-tolerant around the comma. */
const FIRST_RANGE_SPEC = /^(\d*)-(\d*)[ \t]*(?:,|$)/;

export function resolveRange(header: string | undefined, size: number): RangeResolution {
  if (header === undefined) {
    return { kind: 'full' };
  }
  const unitMatch = RANGE_HEADER.exec(header);
  if (unitMatch === null) {
    return { kind: 'unsatisfiable' }; // no unit=set shape at all
  }
  const [, unit, rangeSet] = unitMatch;
  if ((unit as string).toLowerCase() !== 'bytes') {
    // Unknown range unit: the header MUST be ignored (RFC 9110 §14.2) — serve
    // the full body rather than 416 a request we simply don't understand.
    return { kind: 'full' };
  }
  const match = FIRST_RANGE_SPEC.exec(rangeSet as string);
  if (match === null) {
    return { kind: 'unsatisfiable' };
  }
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') {
    return { kind: 'unsatisfiable' }; // "bytes=-" carries no position at all
  }

  if (rawStart === '') {
    // Suffix form: the LAST <suffix> bytes. Zero-length is unsatisfiable, and
    // an oversized suffix means the whole file (RFC 9110 §14.1.2).
    const suffix = Number(rawEnd);
    if (suffix === 0 || size === 0) {
      return { kind: 'unsatisfiable' };
    }
    return { kind: 'range', start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (start >= size || start > end) {
    return { kind: 'unsatisfiable' };
  }
  return { kind: 'range', start, end };
}

/**
 * Content-Type by file extension — media the download flow can produce plus
 * the thumbnail image types; anything else is an honest octet-stream.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  mp4: 'video/mp4',
  m4a: 'audio/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

export function contentTypeForExt(ext: string): string {
  const key = ext.replace(/^\.+/, '').toLowerCase();
  return CONTENT_TYPES[key] ?? 'application/octet-stream';
}

/** The minimal event surfaces wireAbort needs (Response / ReadStream subsets). */
interface CloseEmitter {
  on(event: 'close', listener: () => void): unknown;
}
interface Destroyable {
  destroy(): void;
}

/**
 * A client abort must destroy the file stream — otherwise every scrubbed-away
 * <video> request leaks an open fd until GC. `close` fires for BOTH normal
 * completion and aborts; destroying an already-ended stream is a no-op, so one
 * handler covers both without state.
 */
export function wireAbort(res: CloseEmitter, stream: Destroyable): void {
  res.on('close', () => stream.destroy());
}

/** Thumbnail extensions in preference order (yt-dlp writes `<id>.<ext>`). */
const THUMBNAIL_EXTS = ['webp', 'jpg', 'png'] as const;

/** Pick THIS video's thumbnail from a directory listing, webp > jpg > png. */
export function pickThumbnail(names: readonly string[], videoId: string): string | undefined {
  return THUMBNAIL_EXTS.map((ext) => `${videoId}.${ext}`).find((name) => names.includes(name));
}

/** The response surface streaming needs (express Response is one; tests drive plain Writables). */
export interface StreamableResponse extends NodeJS.WritableStream {
  destroyed: boolean;
  /** True after 'close' — stream.Writable and http.OutgoingMessage both expose it (Node ≥ 18). */
  closed?: boolean;
}

/**
 * Open + pipe a file into a response, abort-race-proof (the P9 audit's fd
 * leak): a client abort landing while the controller is still awaiting
 * loadVideo/stat happens BEFORE any abort wiring could exist, so the old
 * pipe+wireAbort combo wrote into a destroyed response and parked the read
 * stream (fd + buffer) forever. Two layers close that:
 *  1. bail BEFORE `createReadStream` when the response is already dead — the
 *     fd is never opened;
 *  2. `stream.pipeline` — either side failing/closing early destroys the
 *     other (errors are swallowed on purpose: headers are already gone
 *     mid-stream and pipeline has torn both sides down).
 * A defensive wireAbort close listener stays as belt-and-suspenders.
 *
 * Returns the stream (null when it bailed) so tests can observe fd release.
 */
export function streamFileToResponse(
  res: StreamableResponse,
  filePath: string,
  opts: { start?: number; end?: number },
): ReadStream | null {
  if (res.destroyed || res.closed === true) {
    return null;
  }
  const stream = createReadStream(filePath, opts);
  // A media-stream error must never surface as an unhandled 'error' crash —
  // pipeline reports it to the callback and destroys both sides; this listener
  // only mutes the re-emission on the source.
  stream.on('error', () => {});
  pipeline(stream, res, () => {
    /* both sides are already torn down by pipeline on any failure */
  });
  wireAbort(res, stream);
  return stream;
}
