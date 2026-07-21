/**
 * `/api/notification-channels` CRUD + `/:id/test` (P8). Session-guarded by the
 * global APP_GUARD; strict zod bodies live in the service.
 *
 * Test-send is the ONLY dispatch the api performs (the worker owns
 * event-driven dispatch): it records the v1-parity `system.test` Notification
 * row and delivers to the ONE target channel via @tubevault/notify's
 * dispatchTest — bypassing enabled/wants filters (v1 send_test), with the
 * REAL fetch and the 10s abort.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { PrismaClient } from '@tubevault/db';
import { dispatchTest, type NotifyChannelRow } from '@tubevault/notify';
import type {
  NotificationChannelDto,
  NotificationChannelListResponse,
  NotifyEvent,
  TestNotificationChannelResponse,
} from '@tubevault/types';

import { PrismaService } from '../prisma.service';
import { NotificationChannelsService } from './notification-channels.service';

/** The v1 EventBus.send_test event, verbatim (title/body/severity). */
function systemTestEvent(now: Date): NotifyEvent {
  return {
    type: 'system.test',
    severity: 'INFO',
    at: now.toISOString(),
    title: 'TubeVault test notification',
    body: 'If you can see this, this channel is configured correctly.',
    // No dedupeKey: repeated tests always send (v1 parity).
  };
}

@Controller('notification-channels')
export class NotificationChannelsController {
  private readonly prisma: PrismaClient;

  constructor(
    @Inject(NotificationChannelsService) private readonly channels: NotificationChannelsService,
    @Inject(PrismaService) prisma: PrismaClient,
  ) {
    this.prisma = prisma;
  }

  @Get()
  async list(): Promise<NotificationChannelListResponse> {
    return this.channels.list();
  }

  @Post()
  async create(@Body() body: unknown): Promise<NotificationChannelDto> {
    return this.channels.create(body);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: unknown): Promise<NotificationChannelDto> {
    return this.channels.update(id, body);
  }

  @Delete(':id')
  async remove(@Param('id') id: string): Promise<{ deleted: true }> {
    return this.channels.remove(id);
  }

  @Post(':id/test')
  @HttpCode(HttpStatus.OK)
  async test(@Param('id') id: string): Promise<TestNotificationChannelResponse> {
    const row = await this.channels.getRow(id); // 404 on a missing channel
    const event = systemTestEvent(new Date());

    // The in-app feed row first (v1: send_test records the notification), so
    // the dashboard shows the test even when external delivery fails.
    await this.prisma.notification.create({
      data: { type: event.type, severity: event.severity, title: event.title, body: event.body },
    });

    const target: NotifyChannelRow = {
      id: row.id,
      type: row.type,
      name: row.name,
      config: row.config,
      events: row.events,
      minSeverity: row.minSeverity,
      enabled: row.enabled,
    };
    const outcome = await dispatchTest(event, target, {}); // real fetch, 10s abort
    return { delivered: outcome.ok, detail: outcome.detail };
  }
}
