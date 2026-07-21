/**
 * Unresumable-partial detection (P7 — PLAN.md pause/resume: "unresumable →
 * wipe + in-place scratch restart").
 *
 * A KEPT `.part` is normally an asset (`-c` resumes it), but a stale/corrupt
 * partial can itself become the thing that fails every retry — yt-dlp refuses
 * or the server rejects the resume range. This detector spots that class from
 * the failed media pass's stderr tail so the processor can wipe staging and
 * re-run ONCE from scratch within the same execution.
 *
 * Deliberately NOT part of @tubevault/core's classifyErrorKind: unresumable is
 * a retry-INTERNAL signal consumed BEFORE failure classification (it never
 * reaches the row's errorKind), and it is a yt-dlp stderr concern — so it
 * lives with the other yt-dlp adapters in the engine.
 */

/**
 * The tight signature set (keep it SMALL — a false positive throws away real
 * download progress):
 *  - 'cannot resume'                     — yt-dlp's resume refusals ("Cannot
 *    resume this download"), and the committed fake-ytdlp `unresumable`
 *    scenario line ("The file is corrupted / cannot resume. Remove the
 *    partial file.") the P7 integration suites drive with,
 *  - 'the downloaded file is corrupt'    — yt-dlp's corrupt-partial abort,
 *  - 'http error 416' / 'requested range not satisfiable' — the server
 *    rejects the resume byte range (the .part claims more bytes than the
 *    source offers, e.g. after a format/size change between executions).
 */
const UNRESUMABLE_SIGNATURES: readonly string[] = [
  'cannot resume',
  'the downloaded file is corrupt',
  'http error 416',
  'requested range not satisfiable',
];

/**
 * True when the stderr tail of a FAILED media pass indicates the kept partial
 * itself is unresumable (case-insensitive substring match, any line).
 */
export function isUnresumablePartial(stderrTail: readonly string[]): boolean {
  return stderrTail.some((line) => {
    const lower = line.toLowerCase();
    return UNRESUMABLE_SIGNATURES.some((sig) => lower.includes(sig));
  });
}
