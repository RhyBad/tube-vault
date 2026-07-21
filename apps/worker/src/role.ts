import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';

import { WORKER_CONFIG, type WorkerConfig, type WorkerRole } from './config';
import { ControlSubscriber } from './control/control-subscriber';
import { DownloadConsumer } from './jobs/download.processor';
import { EnumerateConsumer } from './jobs/enumerate.processor';
import { LiveCaptureConsumer } from './jobs/live-capture.processor';
import { LiveProbeConsumer } from './jobs/live-probe.processor';
import { LiveReconciler } from './jobs/live-reconciler';
import { LiveScanScheduler } from './jobs/live-scan.scheduler';
import { CompletenessScanScheduler } from './jobs/completeness-scan.scheduler';
import { Reconciler } from './jobs/reconciler';
import { ReEnumerateScanScheduler } from './jobs/reenumerate-scan.scheduler';
import { SourceCheckConsumer } from './jobs/source-check.processor';
import { SourceCheckScanScheduler } from './jobs/source-check-scan.scheduler';
import { VerifyConsumer } from './jobs/verify.processor';

/** Every startable consumer — the starter map below is exhaustive over this union. */
export type ConsumerToken =
  | 'job:control-subscriber'
  | 'bullmq:enumerate'
  | 'bullmq:download'
  | 'bullmq:verify'
  | 'bullmq:reenumerate-scan'
  | 'bullmq:source-check-scan'
  | 'bullmq:source-check'
  | 'bullmq:completeness-scan'
  | 'bullmq:live-scan'
  | 'bullmq:live-probe'
  | 'bullmq:live-capture';

/**
 * Which consumers each role runs — the ROLE ISOLATION table (PLAN.md owner
 * decision 4: two services from one app so downloads can never interrupt live
 * capture). archive owns enumerate/download/verify; live owns the scan
 * scheduler + probe + capture. Both need the control subscriber (cancel/pause
 * commands address jobs on either role) — and it comes FIRST: a consumer
 * picking up work before the subscriber is live could miss a cancel aimed at
 * its very first job.
 *
 * THIS TABLE IS THE SINGLE START SOURCE: onApplicationBootstrap iterates it
 * (in order) through the exhaustive starter map, so the wiring can never drift
 * from the table — a role-branch typo used to be able to silently start the
 * wrong consumer set next to a live capture.
 */
export function consumersForRole(role: WorkerRole): readonly ConsumerToken[] {
  switch (role) {
    case 'archive':
      return [
        'job:control-subscriber',
        'bullmq:enumerate',
        'bullmq:download',
        'bullmq:verify',
        'bullmq:reenumerate-scan',
        'bullmq:source-check-scan',
        'bullmq:source-check',
        'bullmq:completeness-scan',
      ];
    case 'live':
      return [
        'job:control-subscriber',
        'bullmq:live-scan',
        'bullmq:live-probe',
        'bullmq:live-capture',
      ];
  }
}

/**
 * Boots the consumer set for this replica's WORKER_ROLE and logs the role
 * banner (the compose smoke greps for it). The role's OWN boot reconciler runs
 * FIRST (recovered work is enqueued exactly once, with no live worker racing
 * the sweep — PLAN.md anti-stall), then the table's consumers in table order.
 */
@Injectable()
export class RoleBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger(RoleBootstrap.name);

  constructor(
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    @Inject(ControlSubscriber) private readonly controlSubscriber: ControlSubscriber,
    @Inject(EnumerateConsumer) private readonly enumerateConsumer: EnumerateConsumer,
    @Inject(DownloadConsumer) private readonly downloadConsumer: DownloadConsumer,
    @Inject(VerifyConsumer) private readonly verifyConsumer: VerifyConsumer,
    @Inject(Reconciler) private readonly reconciler: Reconciler,
    @Inject(ReEnumerateScanScheduler)
    private readonly reEnumerateScanScheduler: ReEnumerateScanScheduler,
    @Inject(SourceCheckScanScheduler)
    private readonly sourceCheckScanScheduler: SourceCheckScanScheduler,
    @Inject(SourceCheckConsumer) private readonly sourceCheckConsumer: SourceCheckConsumer,
    @Inject(CompletenessScanScheduler)
    private readonly completenessScanScheduler: CompletenessScanScheduler,
    @Inject(LiveReconciler) private readonly liveReconciler: LiveReconciler,
    @Inject(LiveScanScheduler) private readonly liveScanScheduler: LiveScanScheduler,
    @Inject(LiveProbeConsumer) private readonly liveProbeConsumer: LiveProbeConsumer,
    @Inject(LiveCaptureConsumer) private readonly liveCaptureConsumer: LiveCaptureConsumer,
  ) {}

  /** Start ONE consumer by its table token. Exhaustive: a bad token cannot compile. */
  async startConsumer(token: ConsumerToken): Promise<void> {
    switch (token) {
      case 'job:control-subscriber':
        return this.controlSubscriber.start();
      case 'bullmq:enumerate':
        return this.enumerateConsumer.start();
      case 'bullmq:download':
        return this.downloadConsumer.start();
      case 'bullmq:verify':
        return this.verifyConsumer.start();
      case 'bullmq:reenumerate-scan':
        return this.reEnumerateScanScheduler.start();
      case 'bullmq:source-check-scan':
        return this.sourceCheckScanScheduler.start();
      case 'bullmq:source-check':
        return this.sourceCheckConsumer.start();
      case 'bullmq:completeness-scan':
        return this.completenessScanScheduler.start();
      case 'bullmq:live-scan':
        return this.liveScanScheduler.start();
      case 'bullmq:live-probe':
        return this.liveProbeConsumer.start();
      case 'bullmq:live-capture':
        return this.liveCaptureConsumer.start();
    }
  }

  async onApplicationBootstrap(): Promise<void> {
    const consumers = consumersForRole(this.config.role);
    this.logger.log(`worker role=${this.config.role} consumers=[${consumers.join(', ')}]`);
    // Reconcile BEFORE any consumer starts (each role sweeps only its own work).
    if (this.config.role === 'archive') {
      await this.reconciler.run();
    } else {
      await this.liveReconciler.run();
    }
    for (const token of consumers) {
      await this.startConsumer(token);
    }
  }
}
