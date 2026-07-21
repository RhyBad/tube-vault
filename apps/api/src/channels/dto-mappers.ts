import type { Channel, Video } from '@tubevault/db';
import type { ChannelDto, ChannelVideoCounts, VideoDto } from '@tubevault/types';

/**
 * Row → DTO mappers: the ONLY place Prisma rows become JSON-safe transport
 * shapes. Dates go out as ISO strings; BigInt sizeBytes goes out as Number()
 * (a BigInt must never cross the JSON boundary raw — JSON.stringify throws).
 * Controllers return DTOs exclusively, never raw rows.
 */

export function toChannelDto(row: Channel, videoCounts: ChannelVideoCounts): ChannelDto {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    handle: row.handle,
    watchLive: row.watchLive,
    // CR-04: per-channel policy overrides pass through verbatim — the nullable
    // column IS the API contract (null = inherit global Settings).
    qualityCap: row.qualityCap,
    subtitleMode: row.subtitleMode,
    // CR-06: lifecycle state — null (active) or the unregister timestamp.
    unregisteredAt: row.unregisteredAt?.toISOString() ?? null,
    lastEnumeratedAt: row.lastEnumeratedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    videoCounts,
  };
}

export function toVideoDto(row: Video): VideoDto {
  return {
    id: row.id,
    channelId: row.channelId,
    title: row.title,
    contentType: row.contentType,
    copyState: row.copyState,
    sourceState: row.sourceState,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    addedAt: row.addedAt.toISOString(),
    mediaExt: row.mediaExt,
    sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
    checksumSha256: row.checksumSha256,
    width: row.width,
    height: row.height,
    sourceDurationSeconds: row.sourceDurationSeconds,
  };
}
