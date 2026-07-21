import { Inject, Injectable } from '@nestjs/common';
import { PrismaClient } from '@tubevault/db';
import type { LiveSessionListResponse } from '@tubevault/types';

import { PrismaService } from '../prisma.service';

/** The active set — mirrors the `ux_live_session_active` partial-unique predicate. */
const ACTIVE_LIVE_STATES = ['DETECTED', 'CAPTURING'] as const;

/**
 * EP-35 read-only snapshot of the CURRENTLY active live sessions
 * (state ∈ {DETECTED, CAPTURING}), newest first. Pure read — no state
 * transition, no publish: realtime follow-up is the existing `live.changed`
 * SSE stream, this is just the page-load snapshot. `title`/`channelTitle` are
 * joined through the `video` relation (LiveSession has no direct `channel`
 * relation) in ONE query so the UI never N+1s.
 */
@Injectable()
export class LiveSessionsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaClient) {}

  async listActive(): Promise<LiveSessionListResponse> {
    const rows = await this.prisma.liveSession.findMany({
      where: { state: { in: [...ACTIVE_LIVE_STATES] } },
      orderBy: [{ startedAt: 'desc' }, { id: 'asc' }],
      include: { video: { select: { title: true, channel: { select: { title: true } } } } },
    });
    return {
      sessions: rows.map((row) => ({
        sessionId: row.id,
        videoId: row.videoId,
        title: row.video.title,
        channelId: row.channelId,
        channelTitle: row.video.channel.title,
        state: row.state,
        captureJobId: row.captureJobId,
        lastHeartbeatAt: row.lastHeartbeatAt?.toISOString() ?? null,
        startedAt: row.startedAt.toISOString(),
      })),
    };
  }
}
