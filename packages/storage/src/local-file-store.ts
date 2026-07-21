/**
 * LocalFileStore: a filesystem-backed vault for a home NAS (v1
 * `adapters/storage.py`, ported one-for-one — D3).
 *
 * Layout: `<root>/<channelId>/<videoId> - <sanitized title>/` with
 * videoId-prefixed sidecars inside. Safety properties enforced here:
 *
 * - channelId/videoId are strict, length-bounded identifiers — anything outside
 *   `[A-Za-z0-9_-]` (or too long) is rejected, so they can't introduce path levels.
 * - titles are sanitized to a single, separator-free leaf, truncated by UTF-8 BYTE
 *   length (not characters) so a CJK/emoji title can't overflow NAME_MAX (255 bytes).
 * - `pathsFor` and `publishAtomically` both confirm the result stays under root.
 * - completed files appear only via `fs.renameSync` (atomic replace, POSIX
 *   rename(2) = Python os.replace) after fsync, and publishing never silently
 *   clobbers an existing file unless `overwrite: true`.
 * - the directory identity is the immutable videoId; `existingDir` finds a prior
 *   directory for a video so a changed title never orphans the preserved copy.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { isPathContained } from './path-containment.js';

const UNSAFE_ID = /[^A-Za-z0-9_-]/;
const NAME_MAX = 255; // Linux per-component byte limit (ext4/ZFS/XFS)
const MAX_ID_LEN = 64; // YouTube ids are far shorter; bounds the leaf budget
const DEFAULT_TITLE_BYTES = 200;

/**
 * Boolean core of {@link safeId}: true iff `value` is a non-empty,
 * length-bounded `[A-Za-z0-9_-]` token. Callers that need a filter/predicate
 * (e.g. the media layer listing only serveable subtitle langs) use this so
 * their notion of "safe" can never drift from the throwing validator.
 */
export function isSafeId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_ID_LEN && !UNSAFE_ID.test(value);
}

/**
 * Validate an id is `[A-Za-z0-9_-]` and length-bounded; throw otherwise.
 *
 * IDs come from YouTube and are always in this set, so a dirty/oversized id
 * signals a bug or tampering — rejecting avoids silent collisions and overflow.
 */
export function safeId(value: string, field: string): string {
  if (!isSafeId(value)) {
    throw new Error(`unsafe, empty, or oversized ${field}: ${JSON.stringify(value)}`);
  }
  return value;
}

/** A media extension a path may safely embed: plain alphanumeric token, bounded. */
const SAFE_MEDIA_EXT = /^[A-Za-z0-9]{1,16}$/;

/**
 * MEDIA-EXTENSION shape guard (P9 audit): `Video.mediaExt` is a DB string that
 * both the api's media streaming and the worker's verify probe join into a
 * filesystem path (`<videoId>.<ext>`). A hostile row (`x/../../etc/passwd`)
 * must never turn that join into traversal — a plain bounded token cannot.
 */
export function isSafeMediaExt(ext: string): boolean {
  return SAFE_MEDIA_EXT.test(ext);
}

/**
 * Single-token file extensions that are NEVER the primary media file — the
 * Vault's thumbnails/subtitles/partials. Mirrors the engine's sidecar set so an
 * ext-change media cleanup ({@link LocalFileStore.removeOrphanedMedia}) can
 * never delete a same-dir thumbnail (`<id>.webp`) or subtitle (`<id>.srt`).
 */
const NON_MEDIA_EXTS: ReadonlySet<string> = new Set([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'vtt',
  'srt',
  'ass',
  'json',
  'part',
  'ytdl',
]);

/**
 * Truncate to at most `maxBytes` UTF-8 bytes without splitting a codepoint
 * (v1 `_truncate_utf8`; Python's decode(..., 'ignore') drops the partial tail —
 * here we back the cut up to the codepoint boundary, never emitting U+FFFD).
 */
function truncateUtf8(text: string, maxBytes: number): string {
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.length <= maxBytes) {
    return text;
  }
  let end = maxBytes;
  // A byte 0b10xxxxxx is a UTF-8 continuation: cutting there would split the
  // codepoint that starts before it — back up to (and exclude) its lead byte.
  while (end > 0 && ((encoded[end] as number) & 0xc0) === 0x80) {
    end -= 1;
  }
  return encoded.subarray(0, end).toString('utf8');
}

/** Python's `str.strip(" .")` — strip any of {space, dot} from BOTH ends. */
function stripDotsAndSpaces(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && (text[start] === ' ' || text[start] === '.')) start += 1;
  while (end > start && (text[end - 1] === ' ' || text[end - 1] === '.')) end -= 1;
  return text.slice(start, end);
}

/**
 * Turn an arbitrary title into a safe single path component (never empty).
 *
 * Truncation is by UTF-8 byte length to respect NAME_MAX; the trailing dot/space
 * strip is re-applied afterwards so truncation can't leave a hidden/relative name.
 * (v1 `sanitize_component`, ported verbatim.)
 */
export function sanitizeComponent(title: string, maxBytes = DEFAULT_TITLE_BYTES): string {
  // eslint-disable-next-line no-control-regex -- stripping control chars IS the point
  let text = title.replace(/[\x00-\x1f]/g, '');
  for (const ch of ['/', '\\', ':']) {
    text = text.split(ch).join(' ');
  }
  text = text.split(/\s+/).filter(Boolean).join(' '); // collapse whitespace
  text = stripDotsAndSpaces(text); // never "." / ".." / hidden
  text = truncateUtf8(text, maxBytes);
  text = stripDotsAndSpaces(text); // re-strip: truncation may expose a trailing dot/space
  return text || 'untitled';
}

/**
 * Resolved on-disk locations for one video's media + sidecars (v1 `VideoPaths`).
 * Every file is prefixed with the immutable `videoId` so the directory is
 * self-describing and re-bootstrappable even if the application DB is lost.
 */
export class VideoPaths {
  constructor(
    readonly directory: string,
    readonly videoId: string,
  ) {}

  get infoJson(): string {
    return join(this.directory, `${this.videoId}.info.json`);
  }

  media(ext: string): string {
    return join(this.directory, `${this.videoId}.${ext.replace(/^\.+/, '')}`);
  }

  thumbnail(ext: string): string {
    return join(this.directory, `${this.videoId}.thumbnail.${ext.replace(/^\.+/, '')}`);
  }

  subtitle(lang: string, ext = 'vtt'): string {
    return join(this.directory, `${this.videoId}.${lang}.${ext.replace(/^\.+/, '')}`);
  }
}

/** Filesystem implementation of the v1 FileStore port. */
export class LocalFileStore {
  private readonly _root: string;

  constructor(root: string) {
    this._root = root;
    mkdirSync(this._root, { recursive: true });
  }

  get root(): string {
    return this._root;
  }

  pathsFor(channelId: string, videoId: string, title: string): VideoPaths {
    const channel = safeId(channelId, 'channelId');
    const video = safeId(videoId, 'videoId');
    // Budget the title so the leaf "<videoId> - <title>" stays within NAME_MAX
    // bytes (ids are ASCII by safeId, so chars == bytes for them).
    const budget = Math.max(16, NAME_MAX - video.length - ' - '.length);
    const leaf = `${video} - ${sanitizeComponent(title, budget)}`;
    const directory = join(this._root, channel, leaf);
    this.assertWithinRoot(directory);
    return new VideoPaths(directory, video);
  }

  /**
   * Find an already-created directory for this video (identity = videoId).
   * Lets callers reuse a prior directory when a video's title has changed,
   * instead of creating a divergent leaf and orphaning the preserved copy.
   */
  existingDir(channelId: string, videoId: string): string | null {
    const channel = safeId(channelId, 'channelId');
    const video = safeId(videoId, 'videoId');
    const parent = join(this._root, channel);
    let entries;
    try {
      entries = readdirSync(parent, { withFileTypes: true });
    } catch {
      return null; // channel dir does not exist yet
    }
    const matches = entries
      .filter((e) => e.isDirectory() && e.name.startsWith(`${video} - `))
      .map((e) => e.name)
      .sort();
    return matches.length > 0 ? join(parent, matches[0] as string) : null;
  }

  ensureDir(paths: VideoPaths): void {
    mkdirSync(paths.directory, { recursive: true });
  }

  /** The hidden same-directory partial for `dest` (same fs ⇒ rename is atomic). */
  stagingFor(dest: string): string {
    return join(dirname(dest), `.${basename(dest)}.part`);
  }

  /**
   * fsync the staged file → atomic rename over `dest` → fsync the parent dir.
   * Refuses to clobber an existing file unless `overwrite: true` (a preserved
   * copy must never vanish silently), and confirms `dest` stays under root.
   */
  publishAtomically(staged: string, dest: string, opts: { overwrite?: boolean } = {}): void {
    this.assertWithinRoot(dest);
    if (existsSync(dest) && !opts.overwrite) {
      throw new Error(`refusing to overwrite without overwrite: true: ${dest}`);
    }
    mkdirSync(dirname(dest), { recursive: true });
    fsyncPath(staged);
    renameSync(staged, dest); // atomic replace within the same filesystem
    fsyncPath(dirname(dest));
  }

  freeSpaceBytes(): number {
    const s = statfsSync(this._root);
    return s.bavail * s.bsize;
  }

  /**
   * One statfs of the vault root → the capacity triple the storage dashboard
   * needs (CR-01). `totalBytes` = all data blocks; `freeBytes` = blocks
   * available to an unprivileged writer (the same figure as `freeSpaceBytes()`);
   * `usedBytes` = total − free, so the trio always sums and "used" folds in the
   * root-reserved slack (matches a capacity bar's used%). A single syscall keeps
   * the three numbers coherent (no drift across separate statfs calls).
   */
  diskUsage(): { totalBytes: number; usedBytes: number; freeBytes: number } {
    const s = statfsSync(this._root);
    const totalBytes = s.blocks * s.bsize;
    const freeBytes = s.bavail * s.bsize;
    return { totalBytes, usedBytes: totalBytes - freeBytes, freeBytes };
  }

  /**
   * Sum regular-file bytes under `path`; symlinks excluded, hardlinks counted
   * once (dev:ino dedupe). Best-effort and resilient: never follows symlinks
   * (no traversal/inflation), and skips entries that vanish or become
   * unreadable mid-scan rather than aborting. (v1 `dir_size_bytes`.)
   */
  dirSizeBytes(path: string): number {
    let total = 0;
    const seen = new Set<string>(); // "dev:ino" — same inode via hardlink counts once
    const walk = (dir: string): void => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // dir vanished / unreadable — skip, never abort
      }
      for (const entry of entries) {
        const p = join(dir, entry.name);
        // Dirent.isDirectory() is false for symlinks-to-dirs: no link-following.
        if (entry.isDirectory()) {
          walk(p);
          continue;
        }
        try {
          const st = lstatSync(p, { bigint: true });
          if (!st.isFile()) {
            continue; // excludes symlinks, fifos, sockets, …
          }
          const key = `${st.dev}:${st.ino}`;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          total += Number(st.size);
        } catch {
          continue; // vanished mid-scan — best-effort accounting
        }
      }
    };
    walk(path);
    return total;
  }

  /**
   * The directory holding ALL of one channel's media (`<root>/<channelId>/`) —
   * the parent of every `<videoId> - <title>` leaf. `safeId` rejects a
   * malformed/oversized channelId (throws), so this is never built from a raw
   * id. Used by the CR-06 channel purge to target the whole channel at once.
   */
  channelDir(channelId: string): string {
    const dir = join(this._root, safeId(channelId, 'channelId'));
    this.assertWithinRoot(dir);
    return dir;
  }

  /**
   * Recursively remove a directory that is a STRICT descendant of the vault
   * root (CR-06 media purge). The `allowRoot:false` containment check is the
   * belt to safeId's suspenders: a caller bug or hostile id must never turn a
   * media wipe into an `rm -rf` of the vault root itself (or anything outside
   * it). `force:true` makes an already-gone dir (ENOENT) a no-op — the purge is
   * best-effort and idempotent.
   */
  removeDirWithinRoot(dir: string): void {
    if (!isPathContained(this._root, dir, { allowRoot: false, requireAbsoluteCandidate: false })) {
      throw new Error(`refusing to remove a path outside the storage root: ${dir}`);
    }
    rmSync(dir, { recursive: true, force: true });
  }

  /**
   * Remove media files left behind when a re-download produced a DIFFERENT
   * container extension (CR-21). Publishing overwrites by filename, so a
   * `.mp4`→`.mkv` change writes the new `<videoId>.mkv` but leaves the stale
   * `<videoId>.mp4` orphaned — inflating both disk usage and the post-publish
   * `dirSizeBytes` sum. This removes every `<videoId>.<ext>` file whose ext is a
   * single media-like token (so compound sidecars — `<id>.info.json`,
   * `<id>.en.vtt`, `<id>.thumbnail.jpg` — never match, since their suffix embeds
   * a dot and fails {@link isSafeMediaExt}), that is NOT a known single-token
   * sidecar ext (thumbnails/subtitles: {@link NON_MEDIA_EXTS}), and is NOT the
   * surviving `keepExt`. Each unlink is containment-guarded (a strict descendant
   * of root — belt to safeId's suspenders), and a missing dir is a no-op.
   * Returns the sorted basenames removed (for the caller's JobEvent).
   */
  removeOrphanedMedia(videoDir: string, videoId: string, keepExt: string): string[] {
    const prefix = `${safeId(videoId, 'videoId')}.`;
    const keep = keepExt.replace(/^\.+/, '').toLowerCase();
    let entries;
    try {
      entries = readdirSync(videoDir, { withFileTypes: true });
    } catch {
      return []; // dir does not exist yet — nothing to clean
    }
    const removed: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(prefix)) {
        continue;
      }
      const ext = entry.name.slice(prefix.length).toLowerCase();
      // Only a single-token media extension is a candidate: a compound sidecar
      // suffix (info.json, en.vtt, thumbnail.jpg) fails isSafeMediaExt, and a
      // single-token thumbnail/subtitle ext is excluded explicitly.
      if (!isSafeMediaExt(ext) || NON_MEDIA_EXTS.has(ext) || ext === keep) {
        continue;
      }
      const p = join(videoDir, entry.name);
      if (!isPathContained(this._root, p, { allowRoot: false, requireAbsoluteCandidate: false })) {
        continue; // never unlink outside the vault (corrupted/hostile videoDir)
      }
      rmSync(p, { force: true });
      removed.push(entry.name);
    }
    return removed.sort();
  }

  /**
   * Defense-in-depth: safeId + sanitizeComponent already make traversal
   * structurally impossible (no separators, no dot-leaves), so this only guards
   * against a future caller bug. Delegates to the SAME normalized core as the
   * api's staging-wipe rule (path-containment.ts) — root-allowed here, and
   * relative candidates resolve against cwd like the root itself does.
   */
  private assertWithinRoot(path: string): void {
    if (!isPathContained(this._root, path, { allowRoot: true, requireAbsoluteCandidate: false })) {
      throw new Error(`path escapes the storage root: ${path}`);
    }
  }
}

/** fsync a file or directory by path (v1 `_fsync_file` / `_fsync_dir`). */
function fsyncPath(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
