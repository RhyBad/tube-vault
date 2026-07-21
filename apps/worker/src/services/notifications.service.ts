/**
 * In-app notification rows (the Notification model = the dashboard feed) plus,
 * since P8, the external fan-out through @tubevault/notify.
 *
 * Dedupe/debounce ports v1 `application/notify_dispatch.py`: a repeated
 * dedupeKey within the window is suppressed (v1 `_DEFAULT_DEBOUNCE` = 6h,
 * `exists_since`). v2 refinement: only UNDISMISSED rows suppress — the owner
 * dismissing an alert deliberately re-arms it.
 *
 * External dispatch (P8): fires ONLY when emit() actually inserts a row —
 * a debounced emission delivers nothing, which is exactly how the dispatcher
 * satisfies PLAN.md's dedupe-window requirement without its own bookkeeping.
 * DELIBERATE v1 SIMPLIFICATION: v1 queued durable NOTIFY jobs (5 retries +
 * dead-letter health); v2 is best-effort direct fan-out — fire-and-forget so
 * a slow webhook can never extend job latency, each send bounded by notify's
 * 10s abort, and the in-app row remains the durable record.
 */
import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { Notification } from '@tubevault/db';
import { PrismaClient } from '@tubevault/db';
import { redact, registerSecret } from '@tubevault/engine';
import { dispatch, type NotifyChannelRow } from '@tubevault/notify';
import {
  SECRET_CONFIG_KEYS,
  type NotificationChannelType,
  type NotifyEvent,
} from '@tubevault/types';

import { PrismaService } from '../prisma.service';
import { botWallAlert, downloadFailedAlert, type NotificationDraft } from './alerts';

/** v1 notify_dispatch `_DEFAULT_DEBOUNCE = timedelta(hours=6)`. */
export const DEBOUNCE_WINDOW_MS = 6 * 60 * 60 * 1000;

@Injectable()
export class NotificationsService implements OnApplicationShutdown {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly prisma: PrismaClient;
  /** In-flight external dispatches — the test-visible seam (settle below). */
  private readonly pendingDispatches = new Set<Promise<void>>();

  constructor(@Inject(PrismaService) prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Insert the notification row UNLESS an undismissed row with the same
   * dedupeKey exists within the debounce window. Returns true when a row was
   * inserted, false when debounced (or when the DB write failed — alerting
   * must never break the actual job, v1 `safe_publish` posture).
   *
   * A REAL insert also fans the event out to the enabled external channels
   * (fire-and-forget; see the class doc).
   *
   * Same-key emitters are SERIALIZED with a pg advisory xact lock: under
   * downloadConcurrency 4 two terminal failures can both pass the findFirst
   * window check before either inserts (TOCTOU) → duplicate bot-wall rows.
   * The lock releases automatically at commit/rollback.
   */
  async emit(draft: NotificationDraft): Promise<boolean> {
    // P8 backstop redaction ONCE at the entry: the same clean text feeds the
    // row AND the external senders (bodies are often stderr-derived).
    const clean: NotificationDraft = {
      ...draft,
      title: redact(draft.title),
      body: redact(draft.body),
    };
    const row = await this.insertRow(clean);
    if (row !== null) {
      this.queueExternalDispatch(clean, row.createdAt);
    }
    return row !== null;
  }

  /** The inserted row (its createdAt is the wire timestamp), or null when debounced/failed. */
  private async insertRow(draft: NotificationDraft): Promise<Notification | null> {
    try {
      if (draft.dedupeKey !== undefined) {
        const dedupeKey = draft.dedupeKey;
        return await this.prisma.$transaction(async (tx) => {
          // hashtext() is pg's stable text→int4 hash; widen to the bigint
          // advisory-lock keyspace. Colliding keys just over-serialize.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${dedupeKey})::bigint)`;
          const existing = await tx.notification.findFirst({
            where: {
              dedupeKey,
              dismissedAt: null,
              createdAt: { gte: new Date(Date.now() - DEBOUNCE_WINDOW_MS) },
            },
            select: { id: true },
          });
          if (existing !== null) {
            return null; // debounced — same episode already surfaced
          }
          return tx.notification.create({ data: this.rowData(draft) });
        });
      }
      return await this.prisma.notification.create({ data: this.rowData(draft) });
    } catch (err) {
      this.logger.warn(
        `notification emit failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Fire-and-forget external fan-out with a catch (nothing may throw into the
   * emitting job) and a test-visible ledger so suites can await settlement
   * instead of sleeping. Awaiting is ALWAYS bounded: each send carries the
   * notify package's 10s abort.
   */
  private queueExternalDispatch(draft: NotificationDraft, createdAt: Date): void {
    const task = this.dispatchExternal(draft, createdAt).catch((err: unknown) => {
      this.logger.warn(
        `external notify dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    this.pendingDispatches.add(task);
    void task.finally(() => this.pendingDispatches.delete(task));
  }

  private async dispatchExternal(draft: NotificationDraft, createdAt: Date): Promise<void> {
    const channels = await this.prisma.notificationChannel.findMany({
      where: { enabled: true },
    });
    if (channels.length === 0) {
      return; // the common self-hosted case: no external targets configured
    }
    // P8 defense-in-depth (v1 parity: every channel secret registered before
    // any network use): the worker is a separate process from the api (fresh
    // redaction registry), so the dispatch path registers the secret config
    // fields itself before the senders/loggers could possibly echo them.
    for (const row of channels) {
      for (const key of SECRET_CONFIG_KEYS[row.type as NotificationChannelType] ?? []) {
        const value =
          typeof row.config === 'object' && row.config !== null
            ? (row.config as Record<string, unknown>)[key]
            : undefined;
        if (typeof value === 'string' && value !== '') {
          registerSecret(value);
        }
      }
    }
    const event: NotifyEvent = {
      type: draft.type,
      severity: draft.severity,
      // The STORED row's timestamp (v1 delivered the stored event's `at`) —
      // never a re-stamped `new Date()`: the in-app record and the wire agree.
      at: createdAt.toISOString(),
      title: draft.title,
      body: draft.body,
      ...(draft.channelId !== undefined ? { channelId: draft.channelId } : {}),
      ...(draft.videoId !== undefined ? { videoId: draft.videoId } : {}),
      ...(draft.dedupeKey !== undefined ? { dedupeKey: draft.dedupeKey } : {}),
    };
    const targets: NotifyChannelRow[] = channels.map((row) => ({
      id: row.id,
      type: row.type,
      name: row.name,
      config: row.config,
      events: row.events,
      minSeverity: row.minSeverity,
      enabled: row.enabled,
    }));
    // dispatch() applies the wants-filter (type∈events ∧ severity≥min),
    // swallows + logs every failure, and never throws.
    await dispatch(event, targets, { logger: this.logger });
  }

  /** TEST SEAM: resolve once every queued external dispatch has settled. */
  async settleExternalDispatches(): Promise<void> {
    while (this.pendingDispatches.size > 0) {
      await Promise.allSettled([...this.pendingDispatches]);
    }
  }

  /**
   * Shutdown drain (P8): fire-and-forget must not become fire-and-LOSE on a
   * graceful shutdown — await every in-flight external dispatch before the
   * process exits. BOUNDED by construction: each send carries the notify
   * package's 10s abort, so this resolves within one send window even against
   * a dead receiver.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.settleExternalDispatches();
  }

  private rowData(draft: NotificationDraft): {
    type: string;
    severity: NotificationDraft['severity'];
    title: string;
    body: string;
    channelId?: string;
    videoId?: string;
    dedupeKey?: string;
  } {
    return {
      type: draft.type,
      severity: draft.severity,
      title: draft.title,
      body: draft.body,
      channelId: draft.channelId,
      videoId: draft.videoId,
      dedupeKey: draft.dedupeKey,
    };
  }

  /**
   * The `download.failed` alert, dedupe-keyed on the video's CURRENT
   * VideoStatusEvent count (v1 counts events AFTER the FAILED transition is
   * appended — call this after the transition, like v1 does).
   */
  async emitDownloadFailed(
    video: { readonly id: string; readonly channelId: string; readonly title: string },
    reason: string,
  ): Promise<void> {
    let statusEventCount = 0;
    try {
      statusEventCount = await this.prisma.videoStatusEvent.count({
        where: { videoId: video.id },
      });
    } catch {
      // best-effort: a failed count only weakens the dedupe key, never the alert
    }
    await this.emit(downloadFailedAlert(video, reason, statusEventCount));
  }

  /** The deduped systemic bot-wall alert (once per episode, not per video). */
  async emitBotWall(): Promise<void> {
    await this.emit(botWallAlert());
  }
}
