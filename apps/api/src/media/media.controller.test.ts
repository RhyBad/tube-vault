/**
 * MediaController unit spec (P9 audit fixes) — the seams the e2e wire can't
 * reach deterministically:
 *  - HEAD must answer with full 200/206 headers WITHOUT ever opening the file
 *    (spied streamFileToResponse);
 *  - a hostile `mediaExt` row (`x/../../etc/passwd`) must 404, never stream an
 *    out-of-vault file;
 *  - the thumbnail readdir→stat race (file deleted between the two) must 404,
 *    not 500;
 *  - thumbnail 200s carry Cache-Control (thumbnails are immutable-ish; the
 *    Video page re-requests the poster on every mount).
 *
 * Real tmp vault on disk; fs/promises is partially mocked (real by default) so
 * ONLY the race test can interpose on stat.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotFoundException } from '@nestjs/common';
import type { Video } from '@tubevault/db';
import type { Request, Response } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiConfig } from '../config';
import type { PrismaService } from '../prisma.service';
import { MediaController } from './media.controller';
import * as streaming from './media-streaming';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, stat: vi.fn(actual.stat), readdir: vi.fn(actual.readdir) };
});

const CH = 'UCunitchannel00000000001';
const VID = 'unitvid0001';
const VID_BADEXT = 'unitvid0002';

const MEDIA = Buffer.from('0123456789'); // 10 bytes

function videoRow(overrides: Partial<Video>): Video {
  return {
    id: VID,
    channelId: CH,
    title: 'Unit video',
    contentType: 'REGULAR',
    copyState: 'HEALTHY',
    sourceState: 'UNKNOWN',
    publishedAt: null,
    addedAt: new Date(),
    mediaExt: 'mp4',
    sizeBytes: BigInt(MEDIA.length),
    checksumSha256: null,
    width: null,
    height: null,
    sourceDurationSeconds: null,
    ...overrides,
  } as unknown as Video;
}

/** Records status/headers; never a real socket — streaming is spied instead. */
function fakeRes(): Response & { statusCode: number; headers: Record<string, string> } {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    destroyed: false,
    closed: false,
    ended: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    set(fields: Record<string, string>) {
      Object.assign(this.headers, fields);
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
    on() {
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; headers: Record<string, string> };
}

function fakeReq(method: string, range?: string): Request {
  return { method, headers: range !== undefined ? { range } : {} } as unknown as Request;
}

describe('MediaController (unit, real tmp vault)', () => {
  let dataDir: string;
  let controller: MediaController;
  let rows: Map<string, Video>;
  let streamSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'tubevault-media-unit-'));
    const vaultRoot = join(dataDir, 'media');
    const dir = join(vaultRoot, CH, `${VID} - Unit video`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${VID}.mp4`), MEDIA);
    writeFileSync(join(dir, `${VID}.webp`), Buffer.from('webp-bytes'));
    // The traversal TARGET a hostile mediaExt row points at — real and outside
    // the vault, so a missing guard would happily stat + stream it.
    writeFileSync(join(dataDir, 'secret.txt'), 'owner secret outside the vault');

    rows = new Map<string, Video>([
      [VID, videoRow({})],
      [
        VID_BADEXT,
        videoRow({
          id: VID_BADEXT,
          title: 'Hostile ext row',
          mediaExt: 'x/../../../secret.txt',
        } as Partial<Video>),
      ],
    ]);
    const prisma = {
      video: {
        findUnique: ({ where }: { where: { id: string } }) =>
          Promise.resolve(rows.get(where.id) ?? null),
      },
    } as unknown as PrismaService;
    controller = new MediaController(prisma, { vaultRoot } as ApiConfig);
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.mocked(stat).mockClear();
    streamSpy = vi.spyOn(streaming, 'streamFileToResponse').mockReturnValue(null);
  });

  describe('HEAD (headers only — the fd must never be opened)', () => {
    it('HEAD → 200 headers (Content-Length/Accept-Ranges/Content-Type), no stream opened', async () => {
      const res = fakeRes();
      await controller.media(VID, fakeReq('HEAD'), res);
      expect(res.statusCode).toBe(200);
      expect(res.headers['Content-Length']).toBe(String(MEDIA.length));
      expect(res.headers['Accept-Ranges']).toBe('bytes');
      expect(res.headers['Content-Type']).toBe('video/mp4');
      expect(streamSpy).not.toHaveBeenCalled();
    });

    it('HEAD with a Range → 206 headers, still no stream', async () => {
      const res = fakeRes();
      await controller.media(VID, fakeReq('HEAD', 'bytes=2-5'), res);
      expect(res.statusCode).toBe(206);
      expect(res.headers['Content-Range']).toBe(`bytes 2-5/${MEDIA.length}`);
      expect(res.headers['Content-Length']).toBe('4');
      expect(streamSpy).not.toHaveBeenCalled();
    });

    it('GET (control) does open the stream', async () => {
      const res = fakeRes();
      await controller.media(VID, fakeReq('GET'), res);
      expect(res.statusCode).toBe(200);
      expect(streamSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('hostile mediaExt (path containment)', () => {
    it('404s a traversal mediaExt row and never opens a stream', async () => {
      const res = fakeRes();
      await expect(controller.media(VID_BADEXT, fakeReq('GET'), res)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(streamSpy).not.toHaveBeenCalled();
    });
  });

  describe('thumbnail', () => {
    it('404s (not 500) when the file vanishes between readdir and stat', async () => {
      const enoent = Object.assign(new Error('ENOENT: gone'), { code: 'ENOENT' });
      vi.mocked(stat).mockRejectedValueOnce(enoent);
      const res = fakeRes();
      await expect(controller.thumbnail(VID, res)).rejects.toBeInstanceOf(NotFoundException);
      expect(streamSpy).not.toHaveBeenCalled();
    });

    it('200s carry Cache-Control: private, max-age=3600', async () => {
      const res = fakeRes();
      await controller.thumbnail(VID, res);
      expect(res.statusCode).toBe(200);
      expect(res.headers['Content-Type']).toBe('image/webp');
      expect(res.headers['Cache-Control']).toBe('private, max-age=3600');
    });
  });
});
