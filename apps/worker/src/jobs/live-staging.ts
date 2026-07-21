/**
 * Live staging-dir inspection (P10) — shared by the capture supervisor's
 * byte-stall watchdog and the finalize/reconcile paths. Ported from v1
 * `adapters/capture_subprocess.py` (`_SIDECAR_EXTS`, `bytes_so_far`,
 * `_find_media`): recorded MEDIA bytes are the size of the in-progress media
 * file(s) EXCLUDING sidecars — counting a sidecar (a late info.json flush)
 * would falsely read as growth and mask a real stall.
 *
 * CONTINUATION (the P10 loop): a capture that ends without ending the
 * broadcast (stall/shutdown/crash) leaves its partial here and the video goes
 * back to QUEUED; the NEXT execution renames that partial aside to
 * `prior-<epochms>-<origname>` (preservePriorAttempt) before spawning — the
 * v2-native shape of v1's per-attempt staging dirs (live_capture.py:284-287:
 * a re-leased capture "can never clobber the partial the crashed attempt left
 * behind"). Every scan below sees BOTH fresh and prior files; publication
 * keeps the LARGEST single media file (v1 _find_media parity) under its
 * ORIGINAL name.
 */
import { readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** v1 `_LIVE_STAGING`: DISTINCT from the download '.incoming' — both under the video dir. */
export const LIVE_CAPTURE_STAGING_DIR = '.incoming.live';

/** Extensions of NON-media artifacts in the staging dir (v1 _SIDECAR_EXTS). */
const SIDECAR_EXTS: ReadonlySet<string> = new Set([
  'json',
  'vtt',
  'srt',
  'ass',
  'jpg',
  'jpeg',
  'png',
  'webp',
  'part',
  'ytdl',
]);

/** A prior attempt's preserved file: `prior-<epochms>-<origname>`. */
const PRIOR_FILE_RE = /^prior-\d+-(.+)$/;

/** Same, capturing the <epochms> generation key (CR-24 supersession reclaim). */
const PRIOR_GEN_RE = /^prior-(\d+)-/;

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

interface StagedFile {
  /** The on-disk name (possibly prior-prefixed). */
  name: string;
  /** The name the file HAD when recorded — what a publication must restore. */
  originalName: string;
  path: string;
  size: number;
  prior: boolean;
}

/**
 * Files in `dir` belonging to this video — fresh (`<videoId>.*`) AND preserved
 * (`prior-<epochms>-<videoId>.*`) — with sizes; [] on a missing dir.
 */
function videoFiles(dir: string, videoId: string): StagedFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return []; // staging gone / never created — zero bytes, no artifacts
  }
  const out: StagedFile[] = [];
  for (const name of names) {
    const priorMatch = PRIOR_FILE_RE.exec(name);
    const originalName = priorMatch?.[1] ?? name;
    if (!originalName.startsWith(`${videoId}.`)) {
      continue;
    }
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (st.isFile()) {
        out.push({ name, originalName, path, size: st.size, prior: priorMatch !== null });
      }
    } catch {
      continue; // vanished mid-scan (a fragment merge); best-effort
    }
  }
  return out;
}

/**
 * Recorded media bytes so far (v1 `bytes_so_far`): the summed size of this
 * video's NON-sidecar files — prior-preserved partials included, so the
 * retained-file scan sees a continuation's bytes. With `--no-part` yt-dlp
 * writes straight to the final name (plus `.fNNN.` split-format fragments,
 * which ARE media), so this grows while a healthy stream records — a frozen
 * value while the child is alive is the hung-but-alive signal the watchdog
 * acts on (prior files never grow: they only offset the total, never mask a
 * stall).
 */
export function liveMediaBytes(stagingDir: string, videoId: string): number {
  let total = 0;
  for (const file of videoFiles(stagingDir, videoId)) {
    if (!SIDECAR_EXTS.has(extOf(file.originalName))) {
      total += file.size;
    }
  }
  return total;
}

/**
 * Rename a prior attempt's MEDIA files aside to `prior-<epochms>-<origname>`
 * so the fresh yt-dlp (which records straight to `<videoId>.<ext>` under
 * `--no-part`) can never clobber the preserved bytes — v1's per-attempt
 * staging dirs, v2-native. Sidecars stay put (the fresh run rewrites them);
 * already-preserved `prior-*` files are left alone. Returns how many files
 * were preserved. Best-effort: a rename failure loses at worst that one
 * partial to the fresh run's overwrite, never the capture itself.
 */
export function preservePriorAttempt(stagingDir: string, videoId: string): number {
  const epochMs = Date.now();
  let preserved = 0;
  for (const file of videoFiles(stagingDir, videoId)) {
    if (file.prior || SIDECAR_EXTS.has(extOf(file.originalName))) {
      continue;
    }
    try {
      renameSync(file.path, join(stagingDir, `prior-${epochMs}-${file.name}`));
      preserved += 1;
    } catch {
      continue; // best-effort (see doc)
    }
  }
  return preserved;
}

/**
 * CR-24: reclaim SUPERSEDED prior-attempt partials. A live capture records with
 * `--live-from-start`, so a continuation re-attempt (stall/shutdown/crash, or a
 * worker redeploy) re-downloads the broadcast from the beginning — once the
 * CURRENT attempt's media bytes reach a preserved prior generation's, that prior
 * is a redundant duplicate. Left alone it lingers until finalize wipes staging,
 * inflating the vault (a redeploy mid-capture can strand ~GB). Delete each prior
 * GENERATION (grouped by its `<epochms>`) whose media bytes are ≤ the current
 * attempt's, keeping any generation the current attempt hasn't caught up to yet
 * (still a valid fallback if the fresh run produces nothing). Returns bytes
 * reclaimed. Best-effort — a vanished/locked file is simply skipped.
 *
 * HARD SAFETY: only files matching `prior-<epochms>-` are ever removed. The
 * current attempt's `<videoId>.*` files carry no such prefix, so even a logic
 * slip can never delete the live recording in flight.
 */
export function reclaimSupersededPriors(stagingDir: string, videoId: string): number {
  const files = videoFiles(stagingDir, videoId);
  let currentBytes = 0;
  for (const file of files) {
    if (!file.prior && !SIDECAR_EXTS.has(extOf(file.originalName))) {
      currentBytes += file.size;
    }
  }
  if (currentBytes <= 0) {
    return 0; // no current media yet — every prior is still the fallback
  }
  // Group prior files by generation epoch; media bytes drive the supersede test.
  const generations = new Map<string, { files: StagedFile[]; mediaBytes: number }>();
  for (const file of files) {
    if (!file.prior) {
      continue;
    }
    const epoch = PRIOR_GEN_RE.exec(file.name)?.[1];
    if (epoch === undefined) {
      continue;
    }
    const gen = generations.get(epoch) ?? { files: [], mediaBytes: 0 };
    gen.files.push(file);
    if (!SIDECAR_EXTS.has(extOf(file.originalName))) {
      gen.mediaBytes += file.size;
    }
    generations.set(epoch, gen);
  }
  let reclaimed = 0;
  for (const gen of generations.values()) {
    if (gen.mediaBytes <= 0 || gen.mediaBytes > currentBytes) {
      continue; // still ahead of the current attempt — keep as the fallback
    }
    for (const file of gen.files) {
      try {
        rmSync(file.path, { force: true });
        reclaimed += file.size;
      } catch {
        continue; // best-effort — a vanished/locked file is fine
      }
    }
  }
  return reclaimed;
}

/** What a finished/killed capture left behind, resolved by dir-scan (never stdout). */
export interface LiveCaptureArtifacts {
  /** The recording (the LARGEST non-sidecar file across fresh + prior, v1 _find_media); null = EMPTY. */
  mediaPath: string | null;
  /** The media extension (for Video.mediaExt); null when no media. */
  mediaExt: string | null;
  /** The basename the media publishes under — the ORIGINAL recorded name (a
   * winning prior file sheds its `prior-<epochms>-` prefix); null when no media. */
  mediaPublishName: string | null;
  /** Sidecars worth preserving alongside (info.json etc.) — .part/.ytdl scratch
   * and PRIOR sidecars excluded (the fresh run's sidecars describe the kept dir). */
  sidecarPaths: string[];
}

/** Sidecars that are PRESERVED (published with the media); scratch files are not. */
const PUBLISHABLE_SIDECAR_EXTS: ReadonlySet<string> = new Set([
  'json',
  'vtt',
  'srt',
  'ass',
  'jpg',
  'jpeg',
  'png',
  'webp',
]);

/**
 * Resolve the artifacts of a live staging dir (v1 `_find_media` + the result
 * mapping): media = the largest non-sidecar file across fresh AND
 * prior-preserved partials (an interrupted split-format capture leaves `.fNNN`
 * fragments — v1 kept the largest and dropped the rest with the staging dir,
 * an accepted D10 limit; the continuation loop extends the same rule across
 * attempts); publishable FRESH sidecars ride along; `.part`/`.ytdl` scratch
 * and prior sidecars never leave staging.
 */
export function resolveLiveCaptureArtifacts(
  stagingDir: string,
  videoId: string,
): LiveCaptureArtifacts {
  const files = videoFiles(stagingDir, videoId);
  const sidecarPaths: string[] = [];
  let media: StagedFile | null = null;
  for (const file of files) {
    const ext = extOf(file.originalName);
    if (SIDECAR_EXTS.has(ext)) {
      if (PUBLISHABLE_SIDECAR_EXTS.has(ext) && !file.prior) {
        sidecarPaths.push(file.path);
      }
      continue;
    }
    if (file.size > 0 && (media === null || file.size > media.size)) {
      media = file;
    }
  }
  return {
    mediaPath: media?.path ?? null,
    mediaExt: media === null ? null : extOf(media.originalName),
    mediaPublishName: media?.originalName ?? null,
    sidecarPaths,
  };
}
