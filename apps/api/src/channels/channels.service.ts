import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { classifyContentType, classifyErrorKind, publishedAtFromMetadata } from '@tubevault/core';
import type { Channel, Prisma } from '@tubevault/db';
import {
  AbortedError,
  EngineError,
  enumerateArgs,
  infoToChannelInfo,
  infoToVideoMetadata,
  metadataArgs,
  runYtdlpJson,
  type ChannelInfo,
  type EngineConfig,
  type VideoMetadata,
} from '@tubevault/engine';
import { LocalFileStore } from '@tubevault/storage';
import {
  enumerateAddOptions,
  type AddVideoByUrlResponse,
  type ChannelDto,
  type ChannelListResponse,
  type ChannelVideoCounts,
  type ChannelVideosResponse,
  type DeleteChannelResponse,
  type RegisterChannelResponse,
} from '@tubevault/types';
import type { Queue } from 'bullmq';

import { API_CONFIG, type ApiConfig } from '../config';
import { PrismaService } from '../prisma.service';
import { QueueService } from '../queue/queue.service';
import { SessionService } from '../session/session.service';
import type { ChannelPatch } from './channel-patch';
import { toChannelDto, toVideoDto } from './dto-mappers';
import { ENGINE_CONFIG } from './engine.provider';
import { ENUMERATE_QUEUE } from './enumerate-queue';
import { VIDEO_ORDER_BY, videoWhere, type VideoListQuery } from './video-query';

/** Validated `GET /channels/:id/videos` query (the controller zod-parses it). */
export type VideosQuery = Omit<VideoListQuery, 'channelId'>;

const EMPTY_COUNTS: ChannelVideoCounts = { total: 0, candidates: 0, healthy: 0 };

/**
 * P5 acquisition orchestration (v1 `AcquisitionService.register_channel` /
 * `add_by_url` split across api + worker): the api does the SYNC, cheap parts —
 * resolve identity via a flat extract, upsert the Channel, record a durable
 * ENUMERATE Job row and enqueue it — while the candidate upserts happen
 * asynchronously in the archive worker's ENUMERATE processor.
 */
@Injectable()
export class ChannelsService {
  private readonly logger = new Logger(ChannelsService.name);
  /** Lazy: only a channel PURGE should touch (or create) the vault root. */
  private storeHandle?: LocalFileStore;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ENGINE_CONFIG) private readonly engine: EngineConfig,
    @Inject(ENUMERATE_QUEUE) private readonly enumerateQueue: Queue,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(SessionService) private readonly session: SessionService,
    @Inject(QueueService) private readonly queue: QueueService,
  ) {}

  private store(): LocalFileStore {
    this.storeHandle ??= new LocalFileStore(this.config.vaultRoot);
    return this.storeHandle;
  }

  async registerChannel(url: string): Promise<RegisterChannelResponse> {
    const info = await this.extractWithSession((cookiesFile) =>
      enumerateArgs(this.engine, url, cookiesFile),
    );
    let channelInfo: ChannelInfo;
    try {
      channelInfo = infoToChannelInfo(info);
    } catch (err) {
      // yt-dlp resolved SOMETHING, but not a channel we can key on.
      throw new HttpException(
        { message: err instanceof Error ? err.message : String(err) },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // Idempotent registration (v1 parity): create when new; NEVER overwrite the
    // title/handle of an existing row — the owner may have curated them. CR-06:
    // re-registering a previously-unregistered channel REACTIVATES it (clears
    // unregisteredAt → collection resumes), still without touching title/handle.
    const existing = await this.prisma.channel.findUnique({
      where: { id: channelInfo.channelId },
    });
    let channel: Channel;
    if (existing === null) {
      channel = await this.prisma.channel.create({
        data: {
          id: channelInfo.channelId,
          url: channelInfo.url ?? url,
          title: channelInfo.title,
          handle: channelInfo.handle,
        },
      });
    } else if (existing.unregisteredAt !== null) {
      channel = await this.prisma.channel.update({
        where: { id: existing.id },
        data: { unregisteredAt: null },
      });
    } else {
      channel = existing;
    }

    const enumerateJobId = await this.ensureEnumerateJob(channel.id, url);
    return {
      channel: toChannelDto(channel, await this.countsFor(channel.id)),
      enumerateJobId,
      alreadyRegistered: existing !== null,
    };
  }

  /**
   * The durable-row-first enqueue (PLAN.md queue mechanics). App-level dedupe:
   * an already-active (QUEUED/RUNNING) ENUMERATE job for this channel is reused
   * instead of double-enqueued. The race window (two concurrent registers both
   * missing the active row) is NOT closed by anything below — each racer mints
   * its own cuid, so the custom BullMQ jobIds never collide and both rows +
   * both listings go through. That outcome is harmless (the processor's
   * candidate writes are idempotent via `skipDuplicates`; the loser just wastes
   * a listing); P6's reconciler/queue work may tighten it.
   *
   * NOTE: row-then-add is NOT atomic. A crash between the Job insert and
   * `queue.add` leaves a QUEUED row with no BullMQ job — the P6 boot reconciler
   * owns re-enqueueing/failing those orphans.
   */
  private async ensureEnumerateJob(channelId: string, url: string): Promise<string> {
    const active = await this.prisma.job.findFirst({
      where: { type: 'ENUMERATE', channelId, status: { in: ['QUEUED', 'RUNNING'] } },
      orderBy: { enqueuedAt: 'desc' },
    });
    if (active !== null) {
      return active.id;
    }
    const row = await this.prisma.job.create({
      data: { type: 'ENUMERATE', status: 'QUEUED', channelId, payload: { url } },
    });
    // bullJobId mirrors the row id: one DB row, executions keyed by the same id.
    await this.prisma.job.update({ where: { id: row.id }, data: { bullJobId: row.id } });
    // Canonical options from @tubevault/types — the worker's boot reconciler
    // re-adds with the SAME helper, so the retry policy can never drift. The
    // jobId inside ties the BullMQ job to the durable row (NOT a dedupe — see
    // doc above).
    await this.enumerateQueue.add('enumerate', { jobId: row.id }, enumerateAddOptions(row.id));
    return row.id;
  }

  /**
   * P10 + CR-04: patch one channel. A partial update —
   *
   * - `watchLive` flips live watching. ON initializes `nextLivePollAt = now` so
   *   the very next 30s scan tick probes the channel (no dormant-interval wait
   *   for the first probe). OFF nulls the POLL-CADENCE fields (the scan's
   *   due-query can never match) but deliberately KEEPS `lastLiveSeenAt` — it is
   *   an OBSERVATION, not cadence state, so re-enabling resumes on the dense
   *   interval. These side-effects fire ONLY when `watchLive` is in the patch.
   * - `qualityCap`/`subtitleMode` set the per-channel download-policy overrides;
   *   an explicit `null` writes the column back to NULL (inherit global).
   *
   * An ABSENT key leaves its column untouched, so `{}` is a valid no-op.
   */
  async updateChannel(channelId: string, patch: ChannelPatch): Promise<ChannelDto> {
    const existing = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (existing === null) {
      throw new NotFoundException(`unknown channel: ${channelId}`);
    }
    const data: Prisma.ChannelUpdateInput = {
      ...(patch.watchLive !== undefined
        ? patch.watchLive
          ? { watchLive: true, nextLivePollAt: new Date() }
          : { watchLive: false, lastLivePollAt: null, nextLivePollAt: null }
        : {}),
      ...(patch.qualityCap !== undefined ? { qualityCap: patch.qualityCap } : {}),
      ...(patch.subtitleMode !== undefined ? { subtitleMode: patch.subtitleMode } : {}),
    };
    const channel = await this.prisma.channel.update({ where: { id: channelId }, data });
    return toChannelDto(channel, await this.countsFor(channelId));
  }

  /**
   * CR-06 channel delete. Preservation-first — two modes:
   *
   * - **unregister (default):** stop collection but KEEP the archive. Stamps
   *   `unregisteredAt` (the JOB-07 re-enumeration scan + the live-scan due-query
   *   both exclude it) and nulls the live-poll cadence + `watchLive`. Channel
   *   row, Video rows and disk media all survive and stay browsable/served;
   *   reversible by re-registering.
   * - **purge (`purgeMedia:true`):** hard delete. Cleanup ORDER matters —
   *   (1) stop new live probes from being minted mid-teardown; (2) cancel every
   *   in-flight job (a RUNNING download's child must stop writing BEFORE the
   *   disk wipe races it — a 503 here aborts the purge for a safe retry);
   *   (3) delete DB rows in one tx: `channel.delete` cascades Videos → their
   *   Jobs/LiveSessions/events, and the channel-SCOPED jobs (ENUMERATE etc.,
   *   `videoId` null, no FK) are removed explicitly; (4) wipe the on-disk media
   *   dir — best-effort + containment-guarded, so an fs error never fails an
   *   already-committed DB delete (the DB is the source of truth).
   */
  async deleteChannel(
    channelId: string,
    opts: { purgeMedia: boolean },
  ): Promise<DeleteChannelResponse> {
    const existing = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (existing === null) {
      throw new NotFoundException(`unknown channel: ${channelId}`);
    }

    if (!opts.purgeMedia) {
      await this.prisma.channel.update({
        where: { id: channelId },
        data: {
          unregisteredAt: new Date(),
          watchLive: false,
          lastLivePollAt: null,
          nextLivePollAt: null,
        },
      });
      return { channelId, mode: 'unregistered', videosDeleted: 0, mediaPurged: false };
    }

    // (1) stop new live probes, (2) cancel in-flight work (may 503 → retry).
    await this.prisma.channel.update({
      where: { id: channelId },
      data: { watchLive: false, lastLivePollAt: null, nextLivePollAt: null },
    });
    await this.queue.cancelActiveForChannel(channelId);

    // (3) delete DB rows: cascade Videos + explicit channel-scoped jobs.
    const videosDeleted = await this.prisma.video.count({ where: { channelId } });
    await this.prisma.$transaction([
      this.prisma.job.deleteMany({ where: { channelId } }),
      this.prisma.channel.delete({ where: { id: channelId } }),
    ]);

    // (4) wipe disk media (best-effort — DB is committed, the truth).
    let mediaPurged = false;
    try {
      this.store().removeDirWithinRoot(this.store().channelDir(channelId));
      mediaPurged = true;
    } catch (err) {
      this.logger.warn(
        `channel ${channelId} purged from DB but media wipe failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return { channelId, mode: 'purged', videosDeleted, mediaPurged };
  }

  async listChannels(): Promise<ChannelListResponse> {
    const [channels, counts] = await Promise.all([
      this.prisma.channel.findMany({ orderBy: { createdAt: 'asc' } }),
      this.allCounts(),
    ]);
    return {
      channels: channels.map((c: Channel) => toChannelDto(c, counts.get(c.id) ?? EMPTY_COUNTS)),
    };
  }

  async listVideos(channelId: string, query: VideosQuery): Promise<ChannelVideosResponse> {
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (channel === null) {
      throw new NotFoundException(`unknown channel: ${channelId}`);
    }
    // The SHARED where/sort semantics (video-query.ts) with the channel pinned
    // from the path — GET /api/videos runs the very same builders.
    const where = videoWhere({ ...query, channelId });
    const [videos, total] = await Promise.all([
      this.prisma.video.findMany({
        where,
        orderBy: VIDEO_ORDER_BY[query.sort],
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.video.count({ where }),
    ]);
    return { videos: videos.map(toVideoDto), total };
  }

  async addByUrl(url: string): Promise<AddVideoByUrlResponse> {
    const info = await this.extractWithSession((cookiesFile) =>
      metadataArgs(this.engine, url, cookiesFile),
    );
    let meta: VideoMetadata;
    try {
      meta = infoToVideoMetadata(info);
    } catch (err) {
      throw new HttpException(
        { message: err instanceof Error ? err.message : String(err) },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (meta.channelId === null) {
      // v1 add_by_url parity: without a channel there is nothing to attach to.
      throw new HttpException(
        { message: `video '${meta.videoId}' has no channel id; cannot archive` },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // Create the owning channel when missing; never touch an existing row.
    // VideoMetadata (v1 parity) does not expose channel_url, so a fresh channel
    // gets the canonical /channel/<id> URL.
    await this.prisma.channel.upsert({
      where: { id: meta.channelId },
      update: {},
      create: {
        id: meta.channelId,
        title: meta.channelTitle ?? meta.channelId,
        url: `https://www.youtube.com/channel/${meta.channelId}`,
      },
    });

    const existing = await this.prisma.video.findUnique({ where: { id: meta.videoId } });
    if (existing !== null) {
      return { video: toVideoDto(existing), created: false };
    }
    const video = await this.prisma.video.create({
      data: {
        id: meta.videoId,
        channelId: meta.channelId,
        title: meta.title,
        contentType: classifyContentType(meta.liveStatus),
        publishedAt: publishedAtFromMetadata(meta.timestamp, meta.uploadDate),
        // CR-14: capture the description here — this is the ONLY acquisition
        // path with a full metadata fetch (flat channel enumeration carries
        // none). Exposed on GET /api/videos/:id, not on the lean VideoDto.
        description: meta.description,
        // sourceDurationSeconds is deliberately NOT written here: acquisition
        // never seeds it (v1 parity) — its only writer is the download/verify
        // flow (P6), where it is the truncation-check (D10) reference.
        // copyState CANDIDATE + sourceState UNKNOWN via schema defaults
      },
    });
    return { video: toVideoDto(video), created: true };
  }

  /**
   * P8: inject the owner session (when USABLE) into a sync extract as a
   * short-lived 0600 cookie tmpfile, cleaned up the MOMENT the child returns
   * (v1: minimal on-disk exposure of decrypted cookies). Absent/EXPIRED/
   * undecryptable session → undefined → extraction proceeds cookie-less
   * (preservation-first). The api records NO auth outcome — the worker owns
   * session health (its per-job fold is the single writer).
   */
  private async extractWithSession(argsFor: (cookiesFile?: string) => string[]): Promise<unknown> {
    const cookies = await this.session.cookiesTempFile();
    try {
      return await this.extract(argsFor(cookies?.path));
    } finally {
      await cookies?.cleanup();
    }
  }

  /**
   * Run a sync yt-dlp JSON extraction under the configured deadline. A wedged
   * child must not hang the HTTP request forever (nor leak: the runner
   * group-kills on abort) → 504 {message, errorKind: TRANSIENT}. Any other
   * failure → 502 {message, errorKind}.
   */
  private async extract(args: string[]): Promise<unknown> {
    try {
      return await runYtdlpJson(this.engine.ytdlpBin, args, {
        signal: AbortSignal.timeout(this.config.syncExtractTimeoutMs),
      });
    } catch (err) {
      if (err instanceof AbortedError) {
        throw new HttpException(
          {
            message: `yt-dlp did not finish within ${this.config.syncExtractTimeoutMs}ms`,
            errorKind: 'TRANSIENT',
          },
          HttpStatus.GATEWAY_TIMEOUT,
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      const stderr =
        err instanceof EngineError && err.stderrTail !== undefined
          ? err.stderrTail.join('\n')
          : message;
      throw new HttpException(
        { message, errorKind: classifyErrorKind(stderr) },
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  private async countsFor(channelId: string): Promise<ChannelVideoCounts> {
    const grouped = await this.prisma.video.groupBy({
      by: ['copyState'],
      where: { channelId },
      _count: { _all: true },
    });
    const counts = { ...EMPTY_COUNTS };
    for (const g of grouped) {
      counts.total += g._count._all;
      if (g.copyState === 'CANDIDATE') counts.candidates = g._count._all;
      if (g.copyState === 'HEALTHY') counts.healthy = g._count._all;
    }
    return counts;
  }

  /** ONE groupBy over Video for the whole channel list (no N+1 count queries). */
  private async allCounts(): Promise<Map<string, ChannelVideoCounts>> {
    const grouped = await this.prisma.video.groupBy({
      by: ['channelId', 'copyState'],
      _count: { _all: true },
    });
    const map = new Map<string, ChannelVideoCounts>();
    for (const g of grouped) {
      const counts = map.get(g.channelId) ?? { total: 0, candidates: 0, healthy: 0 };
      counts.total += g._count._all;
      if (g.copyState === 'CANDIDATE') counts.candidates = g._count._all;
      if (g.copyState === 'HEALTHY') counts.healthy = g._count._all;
      map.set(g.channelId, counts);
    }
    return map;
  }
}
