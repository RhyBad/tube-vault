import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type {
  AddVideoByUrlResponse,
  DeleteVideosResponse,
  VideoDetailResponse,
  VideoListResponse,
} from '@tubevault/types';
import type { Response } from 'express';
import { z } from 'zod';

import { ChannelsService } from './channels.service';
import { globalVideosQuerySchema, type VideoListQuery } from './video-query';
import { VideosService } from './videos.service';

const addUrlBodySchema = z.object({ url: z.string().min(1) });

/** CR-27 delete mode — shared by the single (query) + bulk (body) verbs. */
const deleteModeSchema = z.enum(['reclaim', 'purge']);

/** `DELETE /api/videos/:id?mode=…` — mode is REQUIRED (a destructive verb is explicit). */
const deleteVideoQuerySchema = z.object({ mode: deleteModeSchema });

/**
 * `POST /api/videos/delete` body — EXPLICIT ids only (no server-side
 * filter-delete: a destructive verb must never widen its own blast radius). Bounds
 * mirror the queue bulk verb: ≤500 ids, each a bounded YouTube-id-shaped string.
 */
const bulkDeleteBodySchema = z
  .object({
    videoIds: z.array(z.string().min(1).max(64)).min(1).max(500),
    mode: deleteModeSchema,
  })
  .strict();

/**
 * The /videos surface (session-guarded by the global APP_GUARD):
 *  - POST /videos/add-url — single-video acquisition (v1 `add_by_url`): paste a
 *    watch URL → a CANDIDATE (creating its channel when needed). Idempotent:
 *    an already-known video comes back 200 {created: false}; fresh 201.
 *  - GET /videos — cross-channel listing (P9 Search page), same query
 *    semantics as the per-channel route (shared video-query.ts) + channelTitle.
 *  - GET /videos/:id — single video + channelTitle + status trail (Video page).
 */
@Controller('videos')
export class VideosController {
  constructor(
    @Inject(ChannelsService) private readonly channels: ChannelsService,
    @Inject(VideosService) private readonly videos: VideosService,
  ) {}

  @Post('add-url')
  async addByUrl(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AddVideoByUrlResponse> {
    const parsed = addUrlBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException('body must be {url: string}');
    }
    const result = await this.channels.addByUrl(parsed.data.url);
    res.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return result;
  }

  @Get()
  async list(@Query() query: Record<string, unknown>): Promise<VideoListResponse> {
    const parsed = globalVideosQuerySchema.safeParse(query);
    if (!parsed.success) {
      const details = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new BadRequestException(`invalid query: ${details}`);
    }
    return this.videos.list(parsed.data as VideoListQuery);
  }

  @Get(':id')
  async detail(@Param('id') id: string): Promise<VideoDetailResponse> {
    return this.videos.detail(id);
  }

  /**
   * EP-39 — DELETE one video. `?mode=reclaim` frees its media (row → CANDIDATE,
   * re-downloadable); `?mode=purge` removes the row too. Returns the SAME verdict
   * envelope as the bulk verb (a 1-element result), always HTTP 200.
   */
  @Delete(':id')
  async deleteOne(
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ): Promise<DeleteVideosResponse> {
    const parsed = deleteVideoQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException('query must be {mode: "reclaim" | "purge"}');
    }
    return this.videos.deleteVideos([id], parsed.data.mode);
  }

  /**
   * EP-40 — bulk DELETE. Explicit ids only; per-id verdicts in the body, always
   * HTTP 200 (like the queue bulk verb) — a partial failure is data, not an error.
   */
  @Post('delete')
  @HttpCode(HttpStatus.OK)
  async deleteBulk(@Body() body: unknown): Promise<DeleteVideosResponse> {
    const parsed = bulkDeleteBodySchema.safeParse(body);
    if (!parsed.success) {
      const details = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new BadRequestException(`invalid body: ${details}`);
    }
    return this.videos.deleteVideos(parsed.data.videoIds, parsed.data.mode);
  }
}
