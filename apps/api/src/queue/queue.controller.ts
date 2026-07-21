import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { JobStatus } from '@tubevault/db';
import {
  ENQUEUEABLE_COPY_STATES,
  type EnqueueResponse,
  type JobEventsResponse,
  type QueueBulkResponse,
  type QueueListResponse,
  type QueueMoveResponse,
} from '@tubevault/types';
import type { Response } from 'express';
import { z } from 'zod';

import { QueueService, type MoveCommand, type QueueQuery } from './queue.service';

/**
 * `POST /queue/enqueue` body. `videoIds` is bounded at 5000 — express's
 * default 100kb JSON body limit is the REAL ceiling (~6-7k ids), so a larger
 * schema cap would be unreachable; the FILTER selection is the unbounded bulk
 * path. STRICT objects on purpose: a typo'd filter key (`chanelId`) must 400,
 * not silently widen the selection to a full-vault sweep. At least one
 * selector must be present — a bare `{}` silently enqueueing nothing would
 * hide client bugs.
 */
const enqueueBodySchema = z
  .object({
    videoIds: z.array(z.string().min(1).max(64)).max(5000).optional(),
    filter: z
      .object({
        channelId: z.string().min(1).optional(),
        // Derived from the shared runtime mirror — the api can't drift from it.
        copyState: z.enum(ENQUEUEABLE_COPY_STATES).optional(),
        search: z.string().max(200).optional(), // bounded: feeds an ILIKE contains
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((body) => body.videoIds !== undefined || body.filter !== undefined, {
    message: 'provide videoIds and/or filter',
  });

const queueQuerySchema = z.object({
  status: z.nativeEnum(JobStatus).optional(),
  channelId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().min(1).optional(),
});

/**
 * `POST /queue/:jobId/move` body: EXACTLY one form — the strict branches make
 * a body carrying BOTH keys (or unknown keys) fail both sides of the union.
 */
const moveBodySchema = z.union([
  z.object({ position: z.enum(['top', 'bottom']) }).strict(),
  z.object({ afterJobId: z.string().min(1).max(64) }).strict(),
]);

/** `POST /queue/bulk` body (1..500 ids — a bounded, explicit batch). */
const bulkBodySchema = z
  .object({
    action: z.enum(['cancel', 'pause', 'resume']),
    jobIds: z.array(z.string().min(1).max(64)).min(1).max(500),
  })
  .strict();

/**
 * Queue endpoints (session-guarded by the global APP_GUARD → 401 JSON).
 * Bodies/queries are zod-validated → 400; DTOs only (BigInt-safe mappers).
 * P7 adds pause/resume/move/bulk alongside.
 */
@Controller('queue')
export class QueueController {
  constructor(@Inject(QueueService) private readonly queue: QueueService) {}

  @Post('enqueue')
  @HttpCode(HttpStatus.OK)
  async enqueue(@Body() body: unknown): Promise<EnqueueResponse> {
    const parsed = enqueueBodySchema.safeParse(body);
    if (!parsed.success) {
      const details = parsed.error.issues
        .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
        .join('; ');
      throw new BadRequestException(`invalid body: ${details}`);
    }
    return this.queue.enqueue(parsed.data);
  }

  @Get()
  async list(@Query() query: Record<string, unknown>): Promise<QueueListResponse> {
    const parsed = queueQuerySchema.safeParse(query);
    if (!parsed.success) {
      const details = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new BadRequestException(`invalid query: ${details}`);
    }
    return this.queue.list(parsed.data as QueueQuery);
  }

  /**
   * 200 {canceled:true} — the row was settled here (QUEUED/PAUSED path);
   * 202 {accepted:true} — the job is RUNNING (or won the pickup race): the
   * cancel was signalled over `job:control` and the WORKER settles it (P6a).
   */
  @Post(':jobId/cancel')
  @HttpCode(HttpStatus.OK) // settled-here path; the signalled path overrides to 202 below
  async cancel(
    @Param('jobId') jobId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ canceled: true } | { accepted: true }> {
    const outcome = await this.queue.cancel(jobId);
    if (outcome === 'signalled') {
      res.status(HttpStatus.ACCEPTED);
      return { accepted: true };
    }
    return { canceled: true };
  }

  /**
   * 200 {paused:true} — the QUEUED row was settled here (execution removed);
   * 202 {accepted:true} — the job is RUNNING: the pause was signalled over
   * `job:control` and the WORKER settles it (kill keeping staging, P6a).
   */
  @Post(':jobId/pause')
  @HttpCode(HttpStatus.OK) // settled-here path; the signalled path overrides to 202 below
  async pause(
    @Param('jobId') jobId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ paused: true } | { accepted: true }> {
    const outcome = await this.queue.pause(jobId);
    if (outcome === 'signalled') {
      res.status(HttpStatus.ACCEPTED);
      return { accepted: true };
    }
    return { paused: true };
  }

  @Post(':jobId/resume')
  @HttpCode(HttpStatus.OK)
  async resume(@Param('jobId') jobId: string): Promise<{ resumed: true }> {
    await this.queue.resume(jobId);
    return { resumed: true };
  }

  @Post(':jobId/move')
  @HttpCode(HttpStatus.OK)
  async move(@Param('jobId') jobId: string, @Body() body: unknown): Promise<QueueMoveResponse> {
    const parsed = moveBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        "invalid body: expected {position:'top'|'bottom'} OR {afterJobId}",
      );
    }
    let command: MoveCommand;
    if ('position' in parsed.data) {
      command = { kind: parsed.data.position };
    } else {
      if (parsed.data.afterJobId === jobId) {
        throw new BadRequestException('cannot move a job after itself');
      }
      command = { kind: 'after', afterJobId: parsed.data.afterJobId };
    }
    return this.queue.move(jobId, command);
  }

  /** ALWAYS 200: the per-id verdicts live in the {ok, failed} breakdown. */
  @Post('bulk')
  @HttpCode(HttpStatus.OK)
  async bulk(@Body() body: unknown): Promise<QueueBulkResponse> {
    const parsed = bulkBodySchema.safeParse(body);
    if (!parsed.success) {
      const details = parsed.error.issues
        .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
        .join('; ');
      throw new BadRequestException(`invalid body: ${details}`);
    }
    return this.queue.bulk(parsed.data);
  }

  @Get(':jobId/events')
  async events(@Param('jobId') jobId: string): Promise<JobEventsResponse> {
    return this.queue.events(jobId);
  }
}
