/**
 * Global video read-side (P9): the cross-channel listing behind the Search
 * page and the single-video detail behind the Video page. Pure Prisma reads —
 * the WHERE/sort semantics come from video-query.ts, shared verbatim with the
 * per-channel listing (ChannelsService.listVideos), so the two can never
 * drift; the only additions here are the channel-title join and the status
 * trail.
 */
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { CopyState, VideoStatusEvent } from '@tubevault/db';
import { LocalFileStore } from '@tubevault/storage';
import {
  ACTIVE_JOB_STATUSES,
  type DeleteVideosResponse,
  type VideoDeleteMode,
  type VideoDeleteReason,
  type VideoDetailResponse,
  type VideoListResponse,
  type VideoStatusEventDto,
} from '@tubevault/types';

import { API_CONFIG, type ApiConfig } from '../config';
import { PrismaService } from '../prisma.service';
import { VideoStateService } from '../video-state.service';
import { toVideoDto } from './dto-mappers';
import { VIDEO_ORDER_BY, videoWhere, type VideoListQuery } from './video-query';

function toStatusEventDto(row: VideoStatusEvent): VideoStatusEventDto {
  return {
    // Prisma's StatusAxis is the same 'COPY' | 'SOURCE' union as the DTO's.
    axis: row.axis,
    from: row.oldState,
    to: row.newState,
    note: row.note,
    at: row.at.toISOString(),
  };
}

/** copyStates that hold a media file → RECLAIM can free space; others → not_eligible. */
const RECLAIMABLE_STATES: readonly CopyState[] = ['HEALTHY', 'PARTIAL_KEPT'];

/** One id's delete outcome (bytes freed on success; a per-id reason on failure). */
type DeleteOutcome = { ok: true; freedBytes: bigint } | { ok: false; reason: VideoDeleteReason };

@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);
  // LAZY (mirrors media.controller): the LocalFileStore ctor mkdirs the vault
  // root, so a full AppModule boot that never deletes must not pay for it — and
  // an e2e app without a writable vault root must still boot.
  private _store: LocalFileStore | null = null;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(VideoStateService) private readonly videoState: VideoStateService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  private get store(): LocalFileStore {
    this._store ??= new LocalFileStore(this.config.vaultRoot);
    return this._store;
  }

  async list(query: VideoListQuery): Promise<VideoListResponse> {
    // Cross-channel search: `search` also matches the joined channel title
    // (EP-15 only — the per-channel listing's channel is fixed from the path).
    const where = videoWhere(query, { searchChannelTitle: true });
    const [videos, total] = await Promise.all([
      this.prisma.video.findMany({
        where,
        orderBy: VIDEO_ORDER_BY[query.sort],
        take: query.limit,
        skip: query.offset,
        include: { channel: { select: { title: true } } },
      }),
      this.prisma.video.count({ where }),
    ]);
    return {
      videos: videos.map((v) => ({ ...toVideoDto(v), channelTitle: v.channel.title })),
      total,
    };
  }

  async detail(id: string): Promise<VideoDetailResponse> {
    const video = await this.prisma.video.findUnique({
      where: { id },
      include: {
        channel: { select: { title: true } },
        // Ascending: the trail reads top-down as "how this copy got here".
        // `at` has second-level seeds only in tests; real writes are
        // monotonic per video (single-writer state service). The id tiebreak
        // keeps same-instant rows (bulk seeds, sub-ms transitions) in a
        // STABLE insert order instead of a pg-plan-dependent shuffle.
        statusEvents: { orderBy: [{ at: 'asc' }, { id: 'asc' }] },
        // CR-16: the video's single active DOWNLOAD row, if any. The
        // ux_job_active_download partial unique (type=DOWNLOAD AND status ∈
        // ACTIVE_JOB_STATUSES) guarantees at most one, so `take: 1` is exact,
        // not a truncation. Reusing ACTIVE_JOB_STATUSES keeps this filter from
        // ever drifting from that index (and from the queue code's notion of
        // "active"); terminal rows (COMPLETED/FAILED/CANCELED) are excluded.
        jobs: {
          where: { type: 'DOWNLOAD', status: { in: [...ACTIVE_JOB_STATUSES] } },
          select: { id: true, status: true },
          take: 1,
        },
      },
    });
    if (video === null) {
      throw new NotFoundException(`unknown video: ${id}`);
    }
    const activeDownload = video.jobs[0] ?? null;
    return {
      video: toVideoDto(video),
      channelTitle: video.channel.title,
      // Detail-only (CR-14): the lean VideoDto list projection stays unchanged.
      description: video.description,
      activeDownloadJobId: activeDownload?.id ?? null,
      activeDownloadStatus: activeDownload?.status ?? null,
      events: video.statusEvents.map(toStatusEventDto),
    };
  }

  /**
   * CR-27 video-level deletion (EP-39/40) — shared by the single + bulk verbs.
   * Each id is handled INDEPENDENTLY (per-id verdict); a failure never aborts the
   * others. `freedBytes` sums only the fully-successful (`deleted`) ids — an
   * fs_error id is reported in `failed` and NOT counted (its space wasn't freed).
   */
  async deleteVideos(videoIds: string[], mode: VideoDeleteMode): Promise<DeleteVideosResponse> {
    const deleted: string[] = [];
    const failed: { videoId: string; reason: VideoDeleteReason }[] = [];
    let freedBytes = 0n;
    for (const videoId of videoIds) {
      const outcome = await this.deleteOne(videoId, mode);
      if (outcome.ok) {
        deleted.push(videoId);
        freedBytes += outcome.freedBytes;
      } else {
        failed.push({ videoId, reason: outcome.reason });
      }
    }
    return { deleted, freedBytes: Number(freedBytes), failed };
  }

  private async deleteOne(videoId: string, mode: VideoDeleteMode): Promise<DeleteOutcome> {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      select: { channelId: true, copyState: true, sourceState: true, sizeBytes: true },
    });
    if (video === null) {
      return { ok: false, reason: 'not_found' };
    }

    // ACTIVE-JOB guard — an active DOWNLOAD (QUEUED/RUNNING/PAUSED) or LIVE_CAPTURE
    // (QUEUED/RUNNING) owns the row; per-video cleanup never auto-cancels (unlike
    // the CR-06 channel purge). The user cancels first if they really mean it.
    const activeJob = await this.prisma.job.findFirst({
      where: {
        videoId,
        OR: [
          { type: 'DOWNLOAD', status: { in: [...ACTIVE_JOB_STATUSES] } },
          { type: 'LIVE_CAPTURE', status: { in: ['QUEUED', 'RUNNING'] } },
        ],
      },
      select: { id: true },
    });
    if (activeJob !== null) {
      return { ok: false, reason: 'active_job' };
    }

    const priorBytes = video.sizeBytes ?? 0n;

    if (mode === 'reclaim') {
      // Only a video that actually HOLDS media frees space.
      if (!RECLAIMABLE_STATES.includes(video.copyState)) {
        return { ok: false, reason: 'not_eligible' };
      }
      // DB FIRST (it is the truth): CAS the settled state → CANDIDATE AND clear the
      // media scalars in ONE tx. A CAS-lost (a concurrent re-verify moved it) writes
      // nothing → not_eligible now.
      const payload = await this.prisma.$transaction(async (tx) => {
        const frame = await this.videoState.applyTransition(
          tx,
          videoId,
          video.copyState,
          'CANDIDATE',
          'reclaim: media deleted',
        );
        if (frame === null) {
          return null;
        }
        await tx.video.update({
          where: { id: videoId },
          data: {
            mediaExt: null,
            sizeBytes: null,
            checksumSha256: null,
            width: null,
            height: null,
            sourceDurationSeconds: null,
          },
        });
        return frame;
      });
      if (payload === null) {
        return { ok: false, reason: 'not_eligible' };
      }
      await this.videoState.publishChanged(payload);
      return this.wipeMedia(video.channelId, videoId, priorBytes);
    }

    // PURGE — delete the row; the schema's onDelete: Cascade removes its Job /
    // LiveSession / VideoStatusEvent (/JobEvent) rows. Publish a removal frame
    // with the pre-delete snapshot so SSE clients refetch (the row is gone).
    await this.prisma.video.delete({ where: { id: videoId } });
    await this.videoState.publishChanged({
      videoId,
      channelId: video.channelId,
      copyState: video.copyState,
      sourceState: video.sourceState,
    });
    return this.wipeMedia(video.channelId, videoId, priorBytes);
  }

  /**
   * Best-effort per-video media wipe AFTER the DB commit (the DB is the truth): a
   * failure → `fs_error` on this id, but the committed DB change STANDS. An absent
   * dir (nothing on disk) is a clean success — reclaim of a 0-byte row, or a
   * double-delete. `removeDirWithinRoot` is containment-guarded + ENOENT-tolerant.
   */
  private wipeMedia(channelId: string, videoId: string, priorBytes: bigint): DeleteOutcome {
    try {
      this.deleteVideoDir(channelId, videoId);
      return { ok: true, freedBytes: priorBytes };
    } catch (err) {
      this.logger.warn(
        `video ${videoId} deleted from DB but media wipe failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { ok: false, reason: 'fs_error' };
    }
  }

  /**
   * The per-video on-disk wipe (`protected` = the fs_error test seam). An absent
   * dir is a clean no-op (reclaim of a 0-byte row / a double-delete);
   * `removeDirWithinRoot` is containment-guarded + ENOENT-tolerant.
   */
  protected deleteVideoDir(channelId: string, videoId: string): void {
    const dir = this.store.existingDir(channelId, videoId);
    if (dir !== null) {
      this.store.removeDirWithinRoot(dir);
    }
  }
}
