import { Inject, Injectable } from '@nestjs/common';
import { PrismaClient } from '@tubevault/db';
import type { StorageStatsResponse } from '@tubevault/types';

import { API_CONFIG, type ApiConfig } from '../config';
import { PrismaService } from '../prisma.service';
import { DISK_USAGE_READER, type DiskUsageReader } from './disk-usage';

/**
 * CR-01 read-only storage stats: the live `statfs(vaultRoot)` capacity triple
 * plus per-channel `SUM(sizeBytes)`. Limits/auto-pause are out of scope.
 */
@Injectable()
export class StorageService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaClient,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DISK_USAGE_READER) private readonly disk: DiskUsageReader,
  ) {}

  async stats(): Promise<StorageStatsResponse> {
    const vault = this.disk.read(this.config.vaultRoot);

    // Per-channel footprint over videos that actually hold bytes on disk. The
    // `_sum` ignores null sizeBytes; `_count._all` then counts only those rows,
    // so usedBytes and videoCount describe the same stored set.
    const grouped = await this.prisma.video.groupBy({
      by: ['channelId'],
      where: { sizeBytes: { not: null } },
      _sum: { sizeBytes: true },
      _count: { _all: true },
    });
    const usage = new Map(
      grouped.map((g) => [
        g.channelId,
        { usedBytes: Number(g._sum.sizeBytes ?? 0n), videoCount: g._count._all },
      ]),
    );

    // Every channel is listed (zero-filled) so one with nothing downloaded yet
    // still appears in the storage view. groupBy can't include a relation, so
    // this is the established two-query + Map join (channels.service.ts).
    const channels = await this.prisma.channel.findMany({
      select: { id: true, title: true },
      orderBy: { createdAt: 'asc' },
    });

    return {
      vault,
      channels: channels.map((c) => {
        const u = usage.get(c.id);
        return {
          channelId: c.id,
          channelTitle: c.title,
          usedBytes: u?.usedBytes ?? 0,
          videoCount: u?.videoCount ?? 0,
        };
      }),
    };
  }
}
