import type { PrismaClient } from '@tubevault/db';
import { describe, expect, it } from 'vitest';

import { LiveSessionsService } from './live-sessions.service';

/**
 * EP-35 read-only snapshot: pins the ACTIVE-only filter, newest-first order,
 * the video→channel join (title + channelTitle in one query, no N+1), and the
 * row→DTO mapping (Dates→ISO, nullable captureJobId/lastHeartbeatAt preserved,
 * sessionId = row id, channelId = the row's own column). Deterministic — the
 * Prisma call is mocked, no DB.
 */
function svc(rows: unknown[]): { service: LiveSessionsService; captured: () => unknown } {
  let captured: unknown;
  const prisma = {
    liveSession: {
      findMany: (args: unknown) => {
        captured = args;
        return Promise.resolve(rows);
      },
    },
  } as unknown as PrismaClient;
  return { service: new LiveSessionsService(prisma), captured: () => captured };
}

describe('LiveSessionsService.listActive', () => {
  it('queries only active sessions, newest-first, joining title + channelTitle', async () => {
    const { service, captured } = svc([]);
    await service.listActive();

    expect(captured()).toEqual({
      where: { state: { in: ['DETECTED', 'CAPTURING'] } },
      orderBy: [{ startedAt: 'desc' }, { id: 'asc' }],
      include: { video: { select: { title: true, channel: { select: { title: true } } } } },
    });
  });

  it('maps rows to LiveSessionDto (Dates→ISO, nullables preserved, joined titles)', async () => {
    const { service } = svc([
      {
        id: 'sess-capturing',
        videoId: 'vidA',
        channelId: 'UCchan1',
        state: 'CAPTURING',
        captureJobId: 'job-1',
        startedAt: new Date('2026-07-09T10:00:00.000Z'),
        lastHeartbeatAt: new Date('2026-07-09T10:05:00.000Z'),
        video: { title: 'Live stream A', channel: { title: 'Channel One' } },
      },
      {
        id: 'sess-detected',
        videoId: 'vidB',
        channelId: 'UCchan2',
        state: 'DETECTED',
        captureJobId: null,
        startedAt: new Date('2026-07-09T09:00:00.000Z'),
        lastHeartbeatAt: null,
        video: { title: 'Upcoming B', channel: { title: 'Channel Two' } },
      },
    ]);

    const res = await service.listActive();

    expect(res).toEqual({
      sessions: [
        {
          sessionId: 'sess-capturing',
          videoId: 'vidA',
          title: 'Live stream A',
          channelId: 'UCchan1',
          channelTitle: 'Channel One',
          state: 'CAPTURING',
          captureJobId: 'job-1',
          lastHeartbeatAt: '2026-07-09T10:05:00.000Z',
          startedAt: '2026-07-09T10:00:00.000Z',
        },
        {
          sessionId: 'sess-detected',
          videoId: 'vidB',
          title: 'Upcoming B',
          channelId: 'UCchan2',
          channelTitle: 'Channel Two',
          state: 'DETECTED',
          captureJobId: null,
          lastHeartbeatAt: null,
          startedAt: '2026-07-09T09:00:00.000Z',
        },
      ],
    });
  });
});
