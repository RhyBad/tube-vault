import { Module } from '@nestjs/common';

import { WORKER_CONFIG, loadWorkerConfig, type WorkerConfig } from './config';
import { ControlSubscriber } from './control/control-subscriber';
import { engineConfigProvider } from './engine.provider';
import { CompletenessScanScheduler } from './jobs/completeness-scan.scheduler';
import { DownloadConsumer } from './jobs/download.processor';
import { EnumerateConsumer } from './jobs/enumerate.processor';
import { JobRecorder } from './jobs/job-recorder';
import { LiveCaptureConsumer } from './jobs/live-capture.processor';
import { LiveProbeConsumer } from './jobs/live-probe.processor';
import { LiveReconciler } from './jobs/live-reconciler';
import { LiveScanScheduler } from './jobs/live-scan.scheduler';
import { Reconciler } from './jobs/reconciler';
import { ReEnumerateScanScheduler } from './jobs/reenumerate-scan.scheduler';
import { SourceCheckConsumer } from './jobs/source-check.processor';
import { SourceCheckScanScheduler } from './jobs/source-check-scan.scheduler';
import { VerifyConsumer } from './jobs/verify.processor';
import { KeepAliveService } from './keep-alive';
import { PrismaService } from './prisma.service';
import { RedisPublisher } from './redis-publisher';
import { RoleBootstrap } from './role';
import { CompletenessChecker } from './services/completeness-checker';
import { LiveFinalizer } from './services/live-finalizer';
import { NotificationsService } from './services/notifications.service';
import { SessionService } from './services/session.service';
import { VideoStateService } from './services/video-state.service';

@Module({
  providers: [
    // Parsed once at boot; loadWorkerConfig THROWS on missing/invalid env
    // (WORKER_ROLE, DATABASE_URL) so a misconfigured worker refuses to start.
    { provide: WORKER_CONFIG, useFactory: (): WorkerConfig => loadWorkerConfig(process.env) },
    engineConfigProvider,
    PrismaService,
    JobRecorder,
    ControlSubscriber,
    RedisPublisher,
    VideoStateService,
    NotificationsService,
    // P8: disabled gracefully when TUBEVAULT_CREDENTIAL_KEY_FILE is unset
    // (cookies() inactive → all jobs run cookie-less, exactly the P7 behavior).
    SessionService,
    EnumerateConsumer,
    DownloadConsumer,
    VerifyConsumer,
    Reconciler,
    ReEnumerateScanScheduler, // CR-09: periodic re-enumeration (archive role)
    SourceCheckScanScheduler, // CR-09: periodic source re-check scheduler (archive role)
    SourceCheckConsumer, // CR-09: per-video source-availability probe (archive role)
    CompletenessScanScheduler, // CR-20: completeness re-check sweep scheduler (archive role)
    CompletenessChecker, // CR-20: measure + resolve one parked capture (archive role)
    // P10 live role: scan scheduler → probe → capture, with their own boot
    // reconcile pass + the shared finalize service (capture + reconciler).
    LiveFinalizer,
    LiveReconciler,
    LiveScanScheduler,
    LiveProbeConsumer,
    LiveCaptureConsumer,
    RoleBootstrap,
    KeepAliveService, // event-loop anchor; cleared on shutdown (PID-1 drain contract)
  ],
})
export class WorkerModule {}
