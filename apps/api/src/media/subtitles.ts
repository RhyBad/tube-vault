/**
 * Pure subtitle helpers for `GET /api/media/:videoId/subtitles[/:lang]` (CR-17).
 * Mirrors media-streaming.ts: pure functions unit-tested without touching the
 * filesystem/HTTP, so the controller stays a thin wire adapter.
 *
 * Preserved subtitle sidecars are named `<videoId>.<lang>.<ext>` by the download
 * flow. Only the `<track>`-viable formats are offered — `vtt` (served verbatim)
 * and `srt` (converted to WebVTT on the fly). `ass`/anything else is ignored
 * (not renderable by `<track>`, and rare for YouTube). Every LISTED track is
 * guaranteed serveable as WebVTT: a lang that can't pass the serve endpoint's
 * `safeId` (e.g. contains a dot) is excluded from the listing too.
 */
import { isSafeId } from '@tubevault/storage';
import type { SubtitleTrackDto } from '@tubevault/types';

/** The one Content-Type the serve endpoint ever emits — `<track>` needs WebVTT. */
export const SUBTITLE_CONTENT_TYPE = 'text/vtt; charset=utf-8';

/**
 * Stored sidecar formats we can present as `<track>`-viable WebVTT, in
 * preference order (vtt first). THE single source of that order — the serve
 * endpoint (`loadSubtitleAsVtt`) reuses it, so list-side and serve-side "prefer
 * vtt over srt" can never drift apart.
 */
export const SERVEABLE_SUBTITLE_FORMATS = ['vtt', 'srt'] as const;
export type ServeableSubtitleFormat = (typeof SERVEABLE_SUBTITLE_FORMATS)[number];

function isServeableSubtitleFormat(ext: string): ext is ServeableSubtitleFormat {
  return (SERVEABLE_SUBTITLE_FORMATS as readonly string[]).includes(ext);
}

/**
 * A human display label for a BCP-47-ish lang tag ('en' → 'English'), or
 * undefined when ICU can't resolve it (an invalid tag, or a name that just
 * echoes the code) — the DTO's `label` is optional, so an unhelpful label is
 * omitted rather than faked.
 */
export function subtitleTrackLabel(lang: string): string | undefined {
  try {
    const label = new Intl.DisplayNames(['en'], { type: 'language' }).of(lang);
    if (label === undefined || label.toLowerCase() === lang.toLowerCase()) {
      return undefined;
    }
    return label;
  } catch {
    // Intl.DisplayNames.of throws RangeError on a structurally invalid tag.
    return undefined;
  }
}

/**
 * Scan a directory listing for THIS video's serveable subtitle tracks. Reads
 * only names (no fs/stat) — the caller supplies `readdir` output. Dedupes a lang
 * that has several stored formats (prefers `vtt` over `srt`), drops unsafe langs
 * (parity with the serve validator), and returns tracks sorted by lang.
 */
export function parseSubtitleTracks(names: readonly string[], videoId: string): SubtitleTrackDto[] {
  const prefix = `${videoId}.`;
  // lang -> chosen format; a later vtt upgrades an earlier srt for the same lang.
  const byLang = new Map<string, ServeableSubtitleFormat>();
  for (const name of names) {
    if (!name.startsWith(prefix)) {
      continue;
    }
    const rest = name.slice(prefix.length); // "<lang>.<ext>"
    const dot = rest.lastIndexOf('.');
    if (dot <= 0) {
      continue; // no ext, or empty lang ("<videoId>..vtt")
    }
    const lang = rest.slice(0, dot);
    const ext = rest.slice(dot + 1).toLowerCase();
    // isSafeId keeps the listing honest: only langs the serve endpoint will
    // accept (so a dotted/oversized lang is never advertised as a track).
    if (!isServeableSubtitleFormat(ext) || !isSafeId(lang)) {
      continue;
    }
    const existing = byLang.get(lang);
    if (existing === undefined || preferenceRank(ext) < preferenceRank(existing)) {
      byLang.set(lang, ext);
    }
  }
  return [...byLang.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([lang, format]) => {
      const label = subtitleTrackLabel(lang);
      // Only include `label` when present — the DTO field is optional.
      return label === undefined ? { lang, format } : { lang, label, format };
    });
}

/** Lower rank wins (vtt beats srt) when a lang has multiple stored formats. */
function preferenceRank(format: ServeableSubtitleFormat): number {
  return SERVEABLE_SUBTITLE_FORMATS.indexOf(format);
}

/** A cue's comma-decimal timecode `HH:MM:SS,mmm`; a timing line carries two. */
const SRT_TIMECODE = /(\d{2}:\d{2}:\d{2}),(\d{3})/g;

/**
 * Convert an SRT document to WebVTT: strip a leading BOM, normalize CRLF→LF,
 * prepend the mandatory `WEBVTT` header, and turn comma-decimal timecodes into
 * the dot-decimal WebVTT wants. The comma→dot pass runs ONLY on cue-timing lines
 * (those with the `-->` separator), so a comma inside cue TEXT — even a
 * timecode-shaped substring — is never touched. Numeric cue identifiers are left
 * in place (valid WebVTT cue ids), so the transform stays minimal and lossless.
 */
export function srtToVtt(srt: string): string {
  const body = srt
    .replace(/^\uFEFF/, '') // strip a leading UTF-8 BOM
    .replace(/\r\n?/g, '\n')
    .replace(/^\n+/, '') // no blank lead — the header owns the top
    .replace(/^.*-->.*$/gm, (line) => line.replace(SRT_TIMECODE, '$1.$2'));
  return `WEBVTT\n\n${body}`;
}
