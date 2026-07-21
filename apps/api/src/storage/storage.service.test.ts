import type { PrismaClient } from '@tubevault/db';
import { describe, expect, it } from 'vitest';

import type { ApiConfig } from '../config';
import type { DiskUsage, DiskUsageReader } from './disk-usage';
import { StorageService } from './storage.service';

function reader(u: DiskUsage): DiskUsageReader {
  return { read: () => u };
}

function svc(opts: {
  disk: DiskUsageReader;
  groupBy: unknown[];
  channels: { id: string; title: string }[];
  vaultRoot?: string;
}): StorageService {
  const prisma = {
    video: { groupBy: () => Promise.resolve(opts.groupBy) },
    channel: { findMany: () => Promise.resolve(opts.channels) },
  } as unknown as PrismaClient;
  const config = { vaultRoot: opts.vaultRoot ?? '/data/media' } as unknown as ApiConfig;
  return new StorageService(prisma, config, opts.disk);
}

describe('StorageService', () => {
  it('returns the statfs vault triple + per-channel used/count, zero-filling channels with no stored videos (BigInt→number)', async () => {
    const service = svc({
      disk: reader({ totalBytes: 1000, usedBytes: 600, freeBytes: 400 }),
      groupBy: [{ channelId: 'UCa', _sum: { sizeBytes: 900n }, _count: { _all: 3 } }],
      channels: [
        { id: 'UCa', title: 'Alpha' },
        { id: 'UCb', title: 'Bravo' },
      ],
    });
    const res = await service.stats();

    expect(res.vault).toEqual({ totalBytes: 1000, usedBytes: 600, freeBytes: 400 });
    // UCa aggregated; UCb present but zero-filled (a channel with nothing stored still shows).
    expect(res.channels).toEqual([
      { channelId: 'UCa', channelTitle: 'Alpha', usedBytes: 900, videoCount: 3 },
      { channelId: 'UCb', channelTitle: 'Bravo', usedBytes: 0, videoCount: 0 },
    ]);
    // BigInt _sum crossed the boundary as a JS number.
    expect(typeof res.channels[0]!.usedBytes).toBe('number');
  });

  it('passes the configured vaultRoot to the disk reader', async () => {
    let seen = '';
    const disk: DiskUsageReader = {
      read: (root) => {
        seen = root;
        return { totalBytes: 1, usedBytes: 0, freeBytes: 1 };
      },
    };
    await svc({ disk, groupBy: [], channels: [], vaultRoot: '/mnt/vault' }).stats();
    expect(seen).toBe('/mnt/vault');
  });
});
