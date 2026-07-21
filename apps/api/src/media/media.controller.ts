/**
 * `GET|HEAD /api/media/:videoId` (+ `/thumbnail`) — Range-capable media
 * streaming for the P9 Video page's `<video>` tag (same-origin, so the
 * tv_session cookie flows and the global APP_GUARD covers it like every other
 * route).
 *
 * Uses the RAW express response (@Res without passthrough) on purpose: Nest's
 * StreamableFile cannot answer Range requests (no 206/Content-Range), and a
 * seekable player is the whole point. Thrown HttpExceptions still go through
 * Nest's exception layer (it replies via the platform adapter), so 404s stay
 * consistent JSON.
 *
 * File resolution is title-change-proof: `existingDir` finds the directory by
 * its immutable videoId prefix first; only when no directory exists yet does
 * `pathsFor` (current title) name the expected leaf. `fs.stat` is the size
 * truth — the DB's sizeBytes is display metadata, never a streaming bound.
 *
 * SECURITY (P9 audit): `mediaExt` is a DB string that gets joined into the
 * media path — it passes the storage shape guard (`isSafeMediaExt`) AND the
 * final path passes `isPathContained` before any fd is opened; either failing
 * is a 404 (an unserveable row, not a 500).
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Controller,
  Get,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Req,
  Res,
} from '@nestjs/common';
import type { Video } from '@tubevault/db';
import {
  isPathContained,
  isSafeMediaExt,
  LocalFileStore,
  safeId,
  VideoPaths,
} from '@tubevault/storage';
import type { SubtitleListResponse } from '@tubevault/types';
import type { Request, Response } from 'express';

import { API_CONFIG, type ApiConfig } from '../config';
import { PrismaService } from '../prisma.service';
import {
  contentTypeForExt,
  pickThumbnail,
  resolveRange,
  streamFileToResponse,
} from './media-streaming';
import {
  parseSubtitleTracks,
  SERVEABLE_SUBTITLE_FORMATS,
  srtToVtt,
  SUBTITLE_CONTENT_TYPE,
} from './subtitles';

@Controller('media')
export class MediaController {
  private readonly logger = new Logger(MediaController.name);

  /**
   * LAZY on purpose: the LocalFileStore constructor mkdirs the vault root, and
   * doing that at DI time would make every api boot (and every e2e module
   * compile) touch the filesystem even when media is never served. First
   * request pays the (idempotent, recursive) mkdir instead.
   */
  private _store: LocalFileStore | null = null;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  private get store(): LocalFileStore {
    this._store ??= new LocalFileStore(this.config.vaultRoot);
    return this._store;
  }

  @Get(':videoId')
  async media(
    @Param('videoId') videoId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const video = await this.loadVideo(videoId);
    if (video.mediaExt === null) {
      throw new NotFoundException(`video has no preserved media: ${videoId}`);
    }
    const filePath = this.containedMediaPath(video, video.mediaExt);
    let size: number;
    try {
      size = (await stat(filePath)).size;
    } catch {
      throw new NotFoundException(`media file missing on disk: ${videoId}`);
    }

    const range = resolveRange(req.headers.range, size);
    if (range.kind === 'unsatisfiable') {
      res
        .status(416)
        .set({ 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' })
        .end();
      return;
    }

    // HEAD carries the exact 200/206 header story WITHOUT ever opening the
    // file — express routes HEAD through this GET handler, and streaming into
    // a bodyless response would read the whole file into a discarded sink.
    const headersOnly = req.method === 'HEAD';
    const contentType = contentTypeForExt(video.mediaExt);
    if (range.kind === 'full') {
      res.status(200).set({
        'Content-Type': contentType,
        'Content-Length': String(size),
        'Accept-Ranges': 'bytes',
      });
      if (headersOnly) {
        res.end();
        return;
      }
      streamFileToResponse(res, filePath, {});
      return;
    }

    res.status(206).set({
      'Content-Type': contentType,
      'Content-Length': String(range.end - range.start + 1),
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      'Accept-Ranges': 'bytes',
    });
    if (headersOnly) {
      res.end();
      return;
    }
    streamFileToResponse(res, filePath, { start: range.start, end: range.end });
  }

  @Get(':videoId/thumbnail')
  async thumbnail(@Param('videoId') videoId: string, @Res() res: Response): Promise<void> {
    const video = await this.loadVideo(videoId);
    const dir = this.videoDir(video);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      throw new NotFoundException(`no thumbnail for ${videoId}`); // dir never created
    }
    const found = pickThumbnail(names, video.id);
    if (found === undefined) {
      throw new NotFoundException(`no thumbnail for ${videoId}`);
    }
    const filePath = join(dir, found);
    let size: number;
    try {
      size = (await stat(filePath)).size;
    } catch {
      // readdir→stat race: the file vanished in between (re-download cleanup,
      // manual delete) — that's a 404, never a 500.
      throw new NotFoundException(`no thumbnail for ${videoId}`);
    }
    res.status(200).set({
      'Content-Type': contentTypeForExt(found.split('.').pop() ?? ''),
      'Content-Length': String(size),
      // Thumbnails are effectively immutable per video; the Video page
      // re-requests the poster on every mount — an hour of private caching
      // saves that round-trip without letting a shared cache keep it.
      'Cache-Control': 'private, max-age=3600',
    });
    streamFileToResponse(res, filePath, {});
  }

  /**
   * List THIS video's preserved subtitle tracks (CR-17). A LIST, so a known
   * video with no sidecars is an empty array — only an unknown video / malformed
   * id 404s (via loadVideo/videoDir). The dir-scan + format filtering lives in
   * the pure parseSubtitleTracks; the controller stays a thin adapter.
   */
  @Get(':videoId/subtitles')
  async subtitles(@Param('videoId') videoId: string): Promise<SubtitleListResponse> {
    const video = await this.loadVideo(videoId);
    const dir = this.videoDir(video); // 404 on a malformed id
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return { subtitles: [] }; // dir never created → known video, no tracks
    }
    return { subtitles: parseSubtitleTracks(names, video.id) };
  }

  /**
   * Serve one subtitle track AS WebVTT (CR-17) for the player's `<track>` — a
   * stored .srt is converted on the fly, a native .vtt streamed verbatim. Mirrors
   * the thumbnail 404 rules exactly (unknown video / missing file / bad id → 404).
   */
  @Get(':videoId/subtitles/:lang')
  async subtitle(
    @Param('videoId') videoId: string,
    @Param('lang') lang: string,
    @Res() res: Response,
  ): Promise<void> {
    const video = await this.loadVideo(videoId);
    const dir = this.videoDir(video); // 404 on a malformed id
    const vtt = await this.loadSubtitleAsVtt(dir, video.id, lang);
    if (vtt === null) {
      throw new NotFoundException(`no subtitles for ${videoId}/${lang}`);
    }
    const body = Buffer.from(vtt, 'utf8');
    res
      .status(200)
      .set({
        'Content-Type': SUBTITLE_CONTENT_TYPE,
        'Content-Length': String(body.byteLength),
        // Same posture as thumbnails: per-video-stable text, re-fetched on every
        // mount — an hour of private caching without a shared cache retaining it.
        'Cache-Control': 'private, max-age=3600',
      })
      .end(body);
  }

  /**
   * Resolve `lang` to a serveable track and return its WebVTT text, or null when
   * none exists. Prefers a native .vtt (verbatim) over a stored .srt (converted).
   * lang is safeId-validated (a traversal-shaped lang → null, never a filesystem
   * escape) and the built path is containment-checked before any read.
   */
  private async loadSubtitleAsVtt(
    dir: string,
    videoId: string,
    lang: string,
  ): Promise<string | null> {
    let safeLang: string;
    try {
      safeLang = safeId(lang, 'lang');
    } catch {
      return null; // malformed lang — nothing on disk can safely match it
    }
    // Same preference order as the listing (vtt before srt) — one source, no drift.
    for (const format of SERVEABLE_SUBTITLE_FORMATS) {
      const filePath = new VideoPaths(dir, videoId).subtitle(safeLang, format);
      const contained = isPathContained(this.config.vaultRoot, filePath, {
        allowRoot: false,
        requireAbsoluteCandidate: false,
      });
      if (!contained) {
        this.logger.warn(`refusing subtitle for ${videoId}/${lang}: path escapes the vault`);
        continue;
      }
      try {
        const raw = await readFile(filePath, 'utf8');
        return format === 'srt' ? srtToVtt(raw) : raw;
      } catch {
        continue; // ENOENT / vanished mid-read — try the next format, else 404
      }
    }
    return null;
  }

  private async loadVideo(videoId: string): Promise<Video> {
    const video = await this.prisma.video.findUnique({ where: { id: videoId } });
    if (video === null) {
      throw new NotFoundException(`unknown video: ${videoId}`);
    }
    return video;
  }

  /** existingDir first (immutable-id identity survives title changes), else pathsFor. */
  private videoDir(video: Video): string {
    try {
      return (
        this.store.existingDir(video.channelId, video.id) ??
        this.store.pathsFor(video.channelId, video.id, video.title).directory
      );
    } catch {
      // safeId rejected a malformed id — nothing on disk can match it.
      throw new NotFoundException(`unknown video: ${video.id}`);
    }
  }

  /** Shape-guard the DB ext, build the path, and PROVE it stays in the vault. */
  private containedMediaPath(video: Video, mediaExt: string): string {
    if (!isSafeMediaExt(mediaExt)) {
      this.logger.warn(`refusing media for ${video.id}: mediaExt fails the shape guard`);
      throw new NotFoundException(`media file missing on disk: ${video.id}`);
    }
    const filePath = new VideoPaths(this.videoDir(video), video.id).media(mediaExt);
    // Belt-and-suspenders: the ext guard + safeId make traversal impossible by
    // construction; this asserts the CONCLUSION on the final path anyway.
    const contained = isPathContained(this.config.vaultRoot, filePath, {
      allowRoot: false,
      requireAbsoluteCandidate: false,
    });
    if (!contained) {
      this.logger.warn(`refusing media for ${video.id}: resolved path escapes the vault`);
      throw new NotFoundException(`media file missing on disk: ${video.id}`);
    }
    return filePath;
  }
}
