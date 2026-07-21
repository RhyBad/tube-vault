/**
 * LocalFileStore contract tests — the v1 `tests/adapters/test_local_file_store.py`
 * suite ported one-for-one, entirely against a temp dir (no real NAS). They pin
 * the on-disk layout and every safety property the Vault depends on: paths can
 * never escape the storage root, and a completed file appears only via atomic
 * rename.
 */
import { mkdtempSync, mkdirSync, linkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { LocalFileStore, isSafeId, isSafeMediaExt, sanitizeComponent, safeId } from './index.js';
import { existsSync, readFileSync } from 'node:fs';

let tmp: string;
const tmpDirs: string[] = [];

function store(): LocalFileStore {
  tmp = mkdtempSync(join(tmpdir(), 'tv-storage-'));
  tmpDirs.push(tmp);
  return new LocalFileStore(join(tmp, 'vault'));
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- layout ---------------------------------------------------------------- //

describe('layout', () => {
  it('creates the root on construction', () => {
    const fs = store();
    expect(fs.root).toBe(join(tmp, 'vault'));
    expect(existsSync(fs.root)).toBe(true);
  });

  it('paths follow <root>/<channelId>/<videoId> - <title>/ with videoId-prefixed sidecars', () => {
    const fs = store();
    const paths = fs.pathsFor('UC_chan123', 'vidABC', 'My Great Video');
    expect(paths.directory).toBe(join(fs.root, 'UC_chan123', 'vidABC - My Great Video'));
    expect(paths.infoJson).toBe(join(paths.directory, 'vidABC.info.json'));
    expect(paths.media('mp4')).toBe(join(paths.directory, 'vidABC.mp4'));
    expect(paths.media('.mkv')).toBe(join(paths.directory, 'vidABC.mkv')); // leading dot stripped
    expect(paths.thumbnail('webp')).toBe(join(paths.directory, 'vidABC.thumbnail.webp'));
    expect(paths.subtitle('en')).toBe(join(paths.directory, 'vidABC.en.vtt'));
    expect(paths.subtitle('ko', 'srt')).toBe(join(paths.directory, 'vidABC.ko.srt'));
  });

  it('every sidecar is videoId-prefixed (DB-loss recovery: the dir is self-describing)', () => {
    const fs = store();
    const p = fs.pathsFor('UCx', 'theVid', 'title');
    for (const path of [p.infoJson, p.media('mkv'), p.thumbnail('jpg'), p.subtitle('en')]) {
      expect(path.split('/').pop()!.startsWith('theVid')).toBe(true);
    }
  });
});

// --- sanitization & traversal safety --------------------------------------- //

describe('sanitizeComponent', () => {
  it('neutralizes dangerous titles', () => {
    expect(sanitizeComponent('normal title')).toBe('normal title');
    expect(sanitizeComponent('a/b/c')).not.toContain('/');
    expect(sanitizeComponent('a\\b')).not.toContain('\\');
    expect(['', '.', '..']).not.toContain(sanitizeComponent('   ...trim... '));
    expect(sanitizeComponent('')).toBe('untitled');
    expect(sanitizeComponent('..')).toBe('untitled');
    expect(sanitizeComponent('\x00\x01\x02')).toBe('untitled');
    // truncation is by UTF-8 BYTES, not characters (NAME_MAX is a byte limit)
    expect(Buffer.byteLength(sanitizeComponent('x'.repeat(500)), 'utf8')).toBeLessThanOrEqual(200);
  });

  it('byte-truncates CJK/emoji without splitting a codepoint (no U+FFFD garbage)', () => {
    for (const title of ['한'.repeat(200), '😀'.repeat(200), 'ｱ'.repeat(200)]) {
      const out = sanitizeComponent(title);
      expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(200);
      expect(out).not.toContain('�'); // a split codepoint would decode to the replacement char
    }
  });

  it("re-strips after truncation: a byte cut can't expose a trailing dot/space", () => {
    // 199 'a's + '.' + tail: the 200-byte cut lands exactly after the dot.
    const out = sanitizeComponent('a'.repeat(199) + '.' + 'b'.repeat(100));
    expect(out.endsWith('.')).toBe(false);
    expect(out.endsWith(' ')).toBe(false);
    const spaceCut = sanitizeComponent('a'.repeat(198) + ' c' + 'd'.repeat(100));
    expect(spaceCut.endsWith(' ')).toBe(false);
  });
});

describe('safeId + traversal safety', () => {
  it('a traversal-shaped title becomes a single leaf, never extra path levels', () => {
    const fs = store();
    const paths = fs.pathsFor('UCchan', 'vid1', '../../../../etc/passwd');
    expect(paths.directory.startsWith(fs.root)).toBe(true);
    // the title became a single leaf component under the channel dir
    expect(join(paths.directory, '..')).toBe(join(fs.root, 'UCchan'));
  });

  it('rejects unsafe, empty, or oversized channel/video ids', () => {
    const fs = store();
    expect(() => fs.pathsFor('../evil', 'vid', 't')).toThrow(/unsafe/);
    expect(() => fs.pathsFor('chan', '../../evil', 't')).toThrow(/unsafe/);
    expect(() => fs.pathsFor('chan', 'evil/slash', 't')).toThrow(/unsafe/);
    expect(() => fs.pathsFor('chan', '', 't')).toThrow(/unsafe/);
    expect(() => fs.pathsFor('chan', 'v'.repeat(65), 't')).toThrow(/unsafe/);
    expect(() => safeId('ok_id-123', 'videoId')).not.toThrow();
    expect(() => safeId('has space', 'videoId')).toThrow(/unsafe/);
  });

  it('isSafeId is the boolean core of safeId (same rule, no throw)', () => {
    // Accepts the ids YouTube emits AND hyphenated language tags (en-US, zh-Hans).
    for (const ok of ['dQw4w9WgXcQ', 'en', 'en-US', 'zh-Hans', 'ok_id-123']) {
      expect(isSafeId(ok), ok).toBe(true);
    }
    // Rejects exactly what safeId throws on: separators, dots, empty, oversized.
    for (const bad of ['../evil', 'evil/slash', 'a.b', 'has space', '', 'v'.repeat(65)]) {
      expect(isSafeId(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('a long CJK/emoji title leaf stays within NAME_MAX (255 bytes) and is creatable', () => {
    const fs = store();
    for (const title of ['한'.repeat(200), '😀'.repeat(200), 'ｱ'.repeat(200), 'a'.repeat(500)]) {
      const paths = fs.pathsFor('UClongchan', 'vid12345678', title);
      const leaf = paths.directory.split('/').pop()!;
      expect(Buffer.byteLength(leaf, 'utf8')).toBeLessThanOrEqual(255);
      fs.ensureDir(paths); // must not throw ENAMETOOLONG
      expect(existsSync(paths.directory)).toBe(true);
    }
  });
});

// --- atomic publish -------------------------------------------------------- //

describe('publishAtomically', () => {
  it('moves staged → dest (fsync + rename), consuming the staged file', () => {
    const fs = store();
    const paths = fs.pathsFor('UCc', 'vid', 'title');
    fs.ensureDir(paths);
    const dest = paths.media('mp4');
    const staged = fs.stagingFor(dest);
    writeFileSync(staged, 'complete-content');
    expect(existsSync(dest)).toBe(false); // not visible as final yet
    fs.publishAtomically(staged, dest);
    expect(readFileSync(dest, 'utf8')).toBe('complete-content');
    expect(existsSync(staged)).toBe(false); // consumed by the rename
  });

  it('staging path is hidden and in the SAME directory (same fs ⇒ rename is atomic)', () => {
    const fs = store();
    const dest = fs.pathsFor('UCc', 'vid', 't').media('mp4');
    const staged = fs.stagingFor(dest);
    expect(join(staged, '..')).toBe(join(dest, '..'));
    expect(staged.split('/').pop()!.startsWith('.')).toBe(true);
  });

  it('REFUSES silent overwrite unless overwrite: true (preserved copies are precious)', () => {
    const fs = store();
    const dest = fs.pathsFor('UCc', 'vid', 't').media('mp4');
    mkdirSync(join(dest, '..'), { recursive: true });
    writeFileSync(dest, 'existing-precious-copy');
    const staged = fs.stagingFor(dest);
    writeFileSync(staged, 'new-content');
    expect(() => fs.publishAtomically(staged, dest)).toThrow(/overwrite/);
    expect(readFileSync(dest, 'utf8')).toBe('existing-precious-copy');
    expect(existsSync(staged)).toBe(true); // untouched
    fs.publishAtomically(staged, dest, { overwrite: true }); // explicit is allowed
    expect(readFileSync(dest, 'utf8')).toBe('new-content');
  });

  it('rejects a dest outside the storage root', () => {
    const fs = store();
    const staged = join(fs.root, '.staged');
    writeFileSync(staged, 'x');
    expect(() => fs.publishAtomically(staged, join(tmp, 'outside.mp4'))).toThrow(/escapes/);
  });
});

// --- accounting ------------------------------------------------------------ //

describe('accounting', () => {
  it('freeSpaceBytes is positive', () => {
    expect(store().freeSpaceBytes()).toBeGreaterThan(0);
  });

  it('diskUsage returns a coherent total/used/free triple (used = total − free)', () => {
    const fs = store();
    const u = fs.diskUsage();
    expect(u.totalBytes).toBeGreaterThan(0);
    expect(u.freeBytes).toBeGreaterThan(0);
    expect(u.freeBytes).toBeLessThanOrEqual(u.totalBytes);
    // The one deterministic invariant: within a SINGLE statfs the trio sums.
    // (freeBytes is NOT compared across calls — live disk free space drifts
    // between two statfs syscalls, which would make that assertion flaky.)
    expect(u.usedBytes).toBe(u.totalBytes - u.freeBytes);
    expect(u.usedBytes).toBeGreaterThanOrEqual(0);
  });

  it('dirSizeBytes sums regular files recursively; missing dir = 0', () => {
    const fs = store();
    const paths = fs.pathsFor('UCc', 'vid', 't');
    fs.ensureDir(paths);
    writeFileSync(paths.media('mp4'), Buffer.alloc(1000, 120));
    writeFileSync(paths.infoJson, Buffer.alloc(50, 121));
    mkdirSync(join(paths.directory, 'nested'));
    writeFileSync(join(paths.directory, 'nested', 'extra.bin'), Buffer.alloc(7, 1));
    expect(fs.dirSizeBytes(paths.directory)).toBe(1057);
    expect(fs.dirSizeBytes(join(fs.root, 'does-not-exist'))).toBe(0);
  });

  it('excludes symlinks and counts hardlinks ONCE (dev:ino dedupe)', () => {
    const fs = store();
    const paths = fs.pathsFor('UCc', 'vid', 't');
    fs.ensureDir(paths);
    const real = paths.media('mp4');
    writeFileSync(real, Buffer.alloc(1000, 120));
    symlinkSync(real, join(paths.directory, 'link.mp4')); // must NOT be counted
    linkSync(real, join(paths.directory, 'hard.mp4')); // same inode → once
    expect(fs.dirSizeBytes(paths.directory)).toBe(1000);
  });

  it('existingDir locates the prior directory by videoId (title changed ≠ orphaned copy)', () => {
    const fs = store();
    const first = fs.pathsFor('UCc', 'vidZ', 'Original Title');
    fs.ensureDir(first);
    expect(fs.existingDir('UCc', 'vidZ')).toBe(first.directory);
    expect(fs.existingDir('UCc', 'otherVid')).toBeNull();
    expect(fs.existingDir('UCother', 'vidZ')).toBeNull();
  });

  it('ensureDir is idempotent', () => {
    const fs = store();
    const paths = fs.pathsFor('UCc', 'vid', 't');
    fs.ensureDir(paths);
    fs.ensureDir(paths); // second call must not throw
    expect(existsSync(paths.directory)).toBe(true);
  });
});

describe('isSafeMediaExt', () => {
  it('accepts plain alphanumeric extensions up to 16 chars', () => {
    for (const ok of ['mp4', 'webm', 'mkv', 'm4a', 'MP4', 'a1B2', 'x'.repeat(16)]) {
      expect(isSafeMediaExt(ok), ok).toBe(true);
    }
  });

  it('rejects traversal, separators, dots and empties (a DB row is NOT a trusted path)', () => {
    for (const bad of [
      '',
      '.',
      '..',
      'mp4/../../etc/passwd',
      'x/../../etc/passwd',
      '../mp4',
      'mp4/evil',
      'mp4\\evil',
      '.mp4',
      'mp 4',
      'x'.repeat(17),
    ]) {
      expect(isSafeMediaExt(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

// --- media deletion (CR-06 channel purge) ---------------------------------- //

describe('channelDir + removeDirWithinRoot', () => {
  it('channelDir is <root>/<safeId(channelId)>', () => {
    const fs = store();
    expect(fs.channelDir('UC_chan123')).toBe(join(fs.root, 'UC_chan123'));
  });

  it('channelDir rejects an unsafe channelId (safeId throws — never build a path from it)', () => {
    const fs = store();
    for (const bad of ['../etc', 'a/b', '', 'x'.repeat(65), 'a.b']) {
      expect(() => fs.channelDir(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it('removeDirWithinRoot recursively deletes a real channel/video dir', () => {
    const fs = store();
    const dir = fs.pathsFor('UCchan', 'vid1', 'A Title').directory;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'vid1.mp4'), 'data');
    expect(existsSync(dir)).toBe(true);

    fs.removeDirWithinRoot(fs.channelDir('UCchan'));
    expect(existsSync(fs.channelDir('UCchan'))).toBe(false);
  });

  it('removeDirWithinRoot on a missing dir is a no-op (ENOENT tolerated by force)', () => {
    const fs = store();
    expect(() => fs.removeDirWithinRoot(fs.channelDir('UCnever'))).not.toThrow();
  });

  it('removeDirWithinRoot REFUSES the root itself (allowRoot:false — never nuke the vault)', () => {
    const fs = store();
    expect(() => fs.removeDirWithinRoot(fs.root)).toThrow(/root/i);
    expect(existsSync(fs.root)).toBe(true);
  });

  it('removeDirWithinRoot REFUSES a path that escapes the root', () => {
    const fs = store();
    const outside = join(tmp, 'not-the-vault');
    mkdirSync(outside, { recursive: true });
    expect(() => fs.removeDirWithinRoot(outside)).toThrow();
    expect(() => fs.removeDirWithinRoot(join(fs.root, '..', 'not-the-vault'))).toThrow();
    expect(existsSync(outside)).toBe(true); // untouched
  });
});

// --- removeOrphanedMedia (CR-21: ext-change orphan / double-count fix) ------- //

describe('removeOrphanedMedia', () => {
  // A realistic video dir: the CURRENT media + every sidecar shape the Vault
  // emits, PLUS a stale prior-ext media file left by a re-download whose
  // container changed (the RplRUa_21Ng incident). keepExt names the survivor.
  function seedVideoDir(fs: LocalFileStore): string {
    const dir = fs.pathsFor('UCchan', 'vidX', 'A Title').directory;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'vidX.mkv'), Buffer.alloc(100, 1)); // CURRENT media (keepExt)
    writeFileSync(join(dir, 'vidX.mp4'), Buffer.alloc(200, 2)); // STALE prior-ext media
    writeFileSync(join(dir, 'vidX.info.json'), '{}'); // compound sidecar
    writeFileSync(join(dir, 'vidX.thumbnail.jpg'), 'img'); // compound sidecar
    writeFileSync(join(dir, 'vidX.en.vtt'), 'sub'); // compound sidecar
    writeFileSync(join(dir, 'vidX.ko.srt'), 'sub'); // compound sidecar
    writeFileSync(join(dir, 'vidX.webp'), 'thumb'); // single-token NON_MEDIA ext
    writeFileSync(join(dir, 'vidX.jpg'), 'thumb'); // single-token NON_MEDIA ext
    return dir;
  }

  const SIDECARS = [
    'vidX.mkv',
    'vidX.info.json',
    'vidX.thumbnail.jpg',
    'vidX.en.vtt',
    'vidX.ko.srt',
    'vidX.webp',
    'vidX.jpg',
  ];

  it('removes ONLY the prior-ext media file, keeping the current media + every sidecar', () => {
    const fs = store();
    const dir = seedVideoDir(fs);
    const removed = fs.removeOrphanedMedia(dir, 'vidX', 'mkv');
    expect(removed).toEqual(['vidX.mp4']);
    expect(existsSync(join(dir, 'vidX.mp4'))).toBe(false); // stale media gone
    for (const keep of SIDECARS) {
      expect(existsSync(join(dir, keep)), keep).toBe(true);
    }
  });

  it('normalizes a leading dot on keepExt (".mkv" keeps vidX.mkv)', () => {
    const fs = store();
    const dir = seedVideoDir(fs);
    fs.removeOrphanedMedia(dir, 'vidX', '.mkv');
    expect(existsSync(join(dir, 'vidX.mkv'))).toBe(true);
    expect(existsSync(join(dir, 'vidX.mp4'))).toBe(false);
  });

  it("leaves a DIFFERENT video's media untouched (matches the videoId prefix only)", () => {
    const fs = store();
    const dir = seedVideoDir(fs);
    writeFileSync(join(dir, 'otherVid.mp4'), 'other');
    fs.removeOrphanedMedia(dir, 'vidX', 'mkv');
    expect(existsSync(join(dir, 'otherVid.mp4'))).toBe(true);
  });

  it('missing directory is a no-op (returns [])', () => {
    const fs = store();
    expect(fs.removeOrphanedMedia(join(fs.root, 'nope'), 'vidX', 'mkv')).toEqual([]);
  });

  it('rejects an unsafe videoId (safeId throws — never scan a path built from it)', () => {
    const fs = store();
    for (const bad of ['../etc', 'a/b', '', 'x'.repeat(65)]) {
      expect(() => fs.removeOrphanedMedia(fs.root, bad, 'mkv'), JSON.stringify(bad)).toThrow();
    }
  });

  it('containment guard: never unlinks a file outside the storage root', () => {
    const fs = store();
    const outside = join(tmp, 'outside-dir');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'vidX.mp4'), 'precious');
    expect(fs.removeOrphanedMedia(outside, 'vidX', 'mkv')).toEqual([]);
    expect(existsSync(join(outside, 'vidX.mp4'))).toBe(true); // untouched
  });
});
