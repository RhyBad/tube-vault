import type { JobEvent, Prisma, Settings } from '@tubevault/db';
import type { JobEventDto, JobStatus, QueueItemDto, SettingsDto } from '@tubevault/types';

/**
 * Queue-surface row → DTO mappers (the ONLY place these Prisma rows become
 * JSON-safe transport shapes): Dates → ISO strings, BigInt byte counts →
 * Number() — a raw BigInt would make JSON.stringify throw.
 */

/** The join the queue listing hydrates (title + channel title for the table). */
export const QUEUE_ITEM_INCLUDE = {
  video: {
    select: { title: true, channelId: true, channel: { select: { title: true } } },
  },
} satisfies Prisma.JobInclude;

export type QueueItemRow = Prisma.JobGetPayload<{ include: typeof QUEUE_ITEM_INCLUDE }>;

/**
 * Statuses whose rows carry an HONEST progress object: RUNNING is live,
 * PAUSED keeps its numbers (the bar freezes where it stopped), COMPLETED keeps
 * its final ones (a finished bar reads 100%). QUEUED/FAILED/CANCELED rows are
 * zeroed by the recorder — mapping them as null instead of a lying 0% object.
 */
const PROGRESS_STATUSES: readonly JobStatus[] = ['RUNNING', 'PAUSED', 'COMPLETED'];

export function toQueueItemDto(row: QueueItemRow): QueueItemDto {
  return {
    jobId: row.id,
    videoId: row.videoId ?? '',
    title: row.video?.title ?? '',
    channelId: row.video?.channelId ?? row.channelId ?? '',
    channelTitle: row.video?.channel.title ?? '',
    status: row.status,
    priority: row.priority,
    attempt: row.attempt,
    progress: PROGRESS_STATUSES.includes(row.status)
      ? {
          pct: row.progressPct,
          downloadedBytes: Number(row.downloadedBytes),
          totalBytes: row.totalBytes === null ? null : Number(row.totalBytes),
          speedBps: row.speedBps,
          etaSeconds: row.etaSeconds,
          currentFile: row.currentFile,
        }
      : null,
    errorKind: row.errorKind,
    error: row.error,
    enqueuedAt: row.enqueuedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    pausedAt: row.pausedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

export function toJobEventDto(row: JobEvent): JobEventDto {
  return {
    id: row.id,
    level: row.level,
    message: row.message,
    context: row.context,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toSettingsDto(row: Settings): SettingsDto {
  return {
    downloadConcurrency: row.downloadConcurrency,
    qualityCap: row.qualityCap,
    subtitleMode: row.subtitleMode,
  };
}
