/**
 * The in-app notification center, read side (P8; rows exist since P6a, P9
 * renders this): newest-first keyset listing + dismiss. Session-guarded by the
 * global APP_GUARD.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import type { Notification } from '@tubevault/db';
import { PrismaClient } from '@tubevault/db';
import type {
  BulkDismissNotificationsResponse,
  DismissAllNotificationsResponse,
  DismissNotificationResponse,
  NotificationDismissFailureReason,
  NotificationDto,
  NotificationListResponse,
  NotificationSeverity,
} from '@tubevault/types';
import { z } from 'zod';

import { PrismaService } from '../prisma.service';

const querySchema = z.object({
  undismissed: z.enum(['true', 'false']).optional(),
  limit: z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined || raw === '') return 100; // default
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 500) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'limit must be an integer in [1, 500]',
        });
        return z.NEVER;
      }
      return n;
    }),
  cursor: z.string().min(1).optional(),
});

/** `POST /notifications/dismiss` body (1..500 ids — a bounded, explicit batch,
 * mirroring the queue bulk verb, EP-25). */
const bulkDismissBodySchema = z
  .object({
    ids: z.array(z.string().min(1).max(64)).min(1).max(500),
  })
  .strict();

function toNotificationDto(row: Notification): NotificationDto {
  return {
    id: row.id,
    type: row.type,
    severity: row.severity as NotificationSeverity,
    title: row.title,
    body: row.body,
    channelId: row.channelId,
    videoId: row.videoId,
    dedupeKey: row.dedupeKey,
    createdAt: row.createdAt.toISOString(),
    dismissedAt: row.dismissedAt?.toISOString() ?? null,
  };
}

@Controller('notifications')
export class NotificationsController {
  private readonly prisma: PrismaClient;

  constructor(@Inject(PrismaService) prisma: PrismaClient) {
    this.prisma = prisma;
  }

  @Get()
  async list(@Query() query: Record<string, string>): Promise<NotificationListResponse> {
    const parsed = querySchema.safeParse(query);
    if (!parsed.success) {
      const details = parsed.error.issues
        .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
        .join('; ');
      throw new BadRequestException(`invalid notifications query: ${details}`);
    }
    const { undismissed, limit, cursor } = parsed.data;
    if (cursor !== undefined) {
      // An unknown cursor must be a clean 400, never Prisma's odd unknown-
      // cursor semantics (silently empty pages / engine errors depending on
      // version) — the anchor row has to exist.
      const anchor = await this.prisma.notification.findUnique({
        where: { id: cursor },
        select: { id: true },
      });
      if (anchor === null) {
        throw new BadRequestException('invalid notifications query: unknown cursor');
      }
    }
    // Keyset paging on the (createdAt desc, id desc) order via the opaque row-id
    // cursor; take limit+1 to learn whether another page exists.
    const rows = await this.prisma.notification.findMany({
      where: undismissed === 'true' ? { dismissedAt: null } : {},
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor !== undefined ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, limit);
    return {
      notifications: page.map(toNotificationDto),
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  @Post(':id/dismiss')
  @HttpCode(HttpStatus.OK)
  async dismiss(@Param('id') id: string): Promise<DismissNotificationResponse> {
    const row = await this.prisma.notification.findUnique({ where: { id } });
    if (row === null) {
      throw new NotFoundException(`unknown notification: ${id}`);
    }
    if (row.dismissedAt !== null) {
      return { notification: toNotificationDto(row) }; // idempotent: first dismissal wins
    }
    const updated = await this.prisma.notification.update({
      where: { id },
      data: { dismissedAt: new Date() },
    });
    return { notification: toNotificationDto(updated) };
  }

  /**
   * "Mark all read" (EP-41, CR-28): dismiss every currently-undismissed row in
   * one shot. Idempotent — the `dismissedAt: null` filter means already-dismissed
   * rows are never re-stamped, so `dismissed` is the count NEWLY dismissed by this
   * call (0 on a repeat). Not a deletion; rows remain listable. Always 200.
   */
  @Post('dismiss-all')
  @HttpCode(HttpStatus.OK)
  async dismissAll(): Promise<DismissAllNotificationsResponse> {
    const { count } = await this.prisma.notification.updateMany({
      where: { dismissedAt: null },
      data: { dismissedAt: new Date() },
    });
    return { dismissed: count };
  }

  /**
   * Bulk dismiss by EXPLICIT id (EP-42, CR-28) — the mirror of the queue bulk
   * verb (EP-25). Each id is an independent verdict: a missing id lands in
   * `failed` (reason `not_found`); an existing-but-already-dismissed id is an
   * idempotent no-op (neither counted nor failed); `dismissed` is the count
   * NEWLY dismissed by this call. Duplicate ids collapse (a row cannot be newly
   * dismissed — or reported not_found — twice). Never deletes rows. Always 200.
   */
  @Post('dismiss')
  @HttpCode(HttpStatus.OK)
  async dismissBulk(@Body() body: unknown): Promise<BulkDismissNotificationsResponse> {
    const parsed = bulkDismissBodySchema.safeParse(body);
    if (!parsed.success) {
      const details = parsed.error.issues
        .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
        .join('; ');
      throw new BadRequestException(`invalid body: ${details}`);
    }
    const ids = [...new Set(parsed.data.ids)];
    const existing = await this.prisma.notification.findMany({
      where: { id: { in: ids } },
      select: { id: true, dismissedAt: true },
    });
    const dismissedAtById = new Map(existing.map((row) => [row.id, row.dismissedAt]));
    const failed: { id: string; reason: NotificationDismissFailureReason }[] = [];
    const toDismiss: string[] = [];
    for (const id of ids) {
      if (!dismissedAtById.has(id)) {
        failed.push({ id, reason: 'not_found' });
      } else if (dismissedAtById.get(id) === null) {
        toDismiss.push(id); // existing + undismissed → dismiss now
      }
      // else: existing + already dismissed → idempotent no-op
    }
    let dismissed = 0;
    if (toDismiss.length > 0) {
      // The `dismissedAt: null` guard keeps the count truthful under a
      // concurrent dismiss — only rows THIS call flips are counted.
      const { count } = await this.prisma.notification.updateMany({
        where: { id: { in: toDismiss }, dismissedAt: null },
        data: { dismissedAt: new Date() },
      });
      dismissed = count;
    }
    return { dismissed, failed };
  }
}
