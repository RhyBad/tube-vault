import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AuthController } from './auth/auth.controller';
import { SessionAuthGuard } from './auth/auth.guard';
import { LoginRateLimiter } from './auth/login-rate-limiter';
import { SessionTokenCodec } from './auth/session-token';
import { ChannelsController } from './channels/channels.controller';
import { ChannelsService } from './channels/channels.service';
import { engineConfigProvider } from './channels/engine.provider';
import { EnumerateQueueService, enumerateQueueProvider } from './channels/enumerate-queue';
import { VideosController } from './channels/videos.controller';
import { VideosService } from './channels/videos.service';
import { API_CONFIG, loadApiConfig, type ApiConfig } from './config';
import { EventsController } from './events.controller';
import { HealthController } from './health.controller';
import { LiveSessionsController } from './live/live-sessions.controller';
import { LiveSessionsService } from './live/live-sessions.service';
import { MediaController } from './media/media.controller';
import { NotificationChannelsController } from './notifications/notification-channels.controller';
import { NotificationChannelsService } from './notifications/notification-channels.service';
import { NotificationsController } from './notifications/notifications.controller';
import { PrismaService } from './prisma.service';
import { DownloadQueueService, downloadQueueProvider } from './queue/download-queue';
import { QueueController } from './queue/queue.controller';
import { QueueService } from './queue/queue.service';
import { RedisPublisher } from './redis-publisher';
import { RedisPubSubService } from './redis-pubsub.service';
import { SessionController } from './session/session.controller';
import { SessionService } from './session/session.service';
import { SettingsController } from './settings.controller';
import { DISK_USAGE_READER, LocalDiskUsageReader } from './storage/disk-usage';
import { StorageController } from './storage/storage.controller';
import { StorageService } from './storage/storage.service';
import { VersionController } from './version.controller';
import { VideoStateService } from './video-state.service';

@Module({
  controllers: [
    HealthController,
    VersionController,
    AuthController,
    EventsController,
    SettingsController,
    ChannelsController,
    VideosController,
    MediaController,
    QueueController,
    SessionController,
    StorageController,
    LiveSessionsController,
    NotificationChannelsController,
    NotificationsController,
  ],
  providers: [
    // Parsed once at boot; loadApiConfig THROWS on missing/invalid env, so a
    // misconfigured api refuses to come up instead of serving unauthenticated.
    { provide: API_CONFIG, useFactory: (): ApiConfig => loadApiConfig(process.env) },
    {
      provide: SessionTokenCodec,
      useFactory: (config: ApiConfig): SessionTokenCodec =>
        new SessionTokenCodec(config.sessionKey),
      inject: [API_CONFIG],
    },
    {
      provide: LoginRateLimiter,
      // v1 defaults: capacity 5, one token per 60s, per client IP.
      useFactory: (): LoginRateLimiter => new LoginRateLimiter(() => Date.now()),
    },
    PrismaService,
    RedisPubSubService,
    RedisPublisher,
    VideoStateService,
    engineConfigProvider,
    EnumerateQueueService,
    enumerateQueueProvider,
    ChannelsService,
    VideosService,
    DownloadQueueService,
    downloadQueueProvider,
    QueueService,
    // P8: no-key-file boots fine with the session feature DISABLED (503 on
    // mutations); a key file that is present but broken fails the config load.
    SessionService,
    NotificationChannelsService,
    StorageService,
    LiveSessionsService,
    { provide: DISK_USAGE_READER, useClass: LocalDiskUsageReader },
    { provide: APP_GUARD, useClass: SessionAuthGuard },
  ],
})
export class AppModule {}
