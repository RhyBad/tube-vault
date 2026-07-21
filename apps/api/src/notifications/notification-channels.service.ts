/**
 * Notification-channel CRUD (P8): per-type zod-validated config, full '***'
 * secret masking on every read, and PATCH keep-secret merge semantics.
 *
 * Secret discipline: plaintext secrets live ONLY in the DB row; every DTO that
 * leaves this service is masked (SECRET_MASK), and a PATCH that carries the
 * mask (or omits a secret) keeps the stored value — so a client can round-trip
 * a GET response into a PATCH unchanged.
 */
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { NotificationChannel } from '@tubevault/db';
import { PrismaClient } from '@tubevault/db';
import { registerSecret } from '@tubevault/engine';
import {
  NOTIFICATION_EVENT_TYPES,
  SECRET_CONFIG_KEYS,
  SECRET_MASK,
  type NotificationChannelDto,
  type NotificationChannelListResponse,
  type NotificationChannelType,
} from '@tubevault/types';
import { z } from 'zod';

import { PrismaService } from '../prisma.service';

const severitySchema = z.enum(['INFO', 'WARNING', 'CRITICAL']);
const eventsSchema = z.array(z.enum(NOTIFICATION_EVENT_TYPES));
const nameSchema = z.string().min(1).max(100);

/**
 * Telegram Bot-API token shape: `<bot id digits>:<token>`. The token is
 * embedded in the API URL *path* (telegramApiUrl), so path/URL metacharacters
 * ('/', '?', '#', whitespace, …) are blocked AT INPUT rather than escaped at
 * send time. Deliberately NO URL-encoding downstream: the Bot API requires the
 * raw colon separator verbatim — encoding it would break every token — so the
 * only safe posture is a charset that can never need encoding.
 */
const TELEGRAM_BOT_TOKEN_RE = /^\d+:[A-Za-z0-9_-]+$/;

/** Per-type config schemas (.strict(): stray keys → 400, not silent storage). */
const CONFIG_SCHEMAS: Readonly<Record<NotificationChannelType, z.ZodType<Record<string, string>>>> =
  {
    TELEGRAM: z
      .object({
        botToken: z
          .string()
          .regex(TELEGRAM_BOT_TOKEN_RE, 'botToken must look like <digits>:<token>'),
        chatId: z.string().min(1),
      })
      .strict(),
    DISCORD: z.object({ webhookUrl: z.string().url() }).strict(),
    GOTIFY: z.object({ serverUrl: z.string().url(), appToken: z.string().min(1) }).strict(),
    NTFY: z
      .object({
        serverUrl: z.string().url(),
        topic: z.string().min(1),
        accessToken: z.string().min(1).optional(),
      })
      .strict() as z.ZodType<Record<string, string>>,
    WEBHOOK: z.object({ url: z.string().url() }).strict(),
  };

const createSchema = z
  .object({
    // v1 SMTP exists but is out of the v2 core-first scope (not in the schema
    // enum nor PLAN.md's P8 sender list) — it fails this enum with a 400.
    type: z.enum(['TELEGRAM', 'DISCORD', 'GOTIFY', 'NTFY', 'WEBHOOK']),
    name: nameSchema,
    config: z.record(z.string()),
    events: eventsSchema.optional(),
    minSeverity: severitySchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

/** `type` is deliberately ABSENT: it is immutable (.strict() → 400 on attempts). */
const updateSchema = z
  .object({
    name: nameSchema.optional(),
    config: z.record(z.string()).optional(),
    events: eventsSchema.optional(),
    minSeverity: severitySchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

function badRequest(context: string, error: z.ZodError): never {
  const details = error.issues
    .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
  throw new BadRequestException(`${context}: ${details}`);
}

@Injectable()
export class NotificationChannelsService {
  private readonly prisma: PrismaClient;

  constructor(@Inject(PrismaService) prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async list(): Promise<NotificationChannelListResponse> {
    const rows = await this.prisma.notificationChannel.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return { channels: rows.map((row) => this.toDto(row)) };
  }

  async create(body: unknown): Promise<NotificationChannelDto> {
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      badRequest('invalid notification channel', parsed.error);
    }
    const { type, name, config, events, minSeverity, enabled } = parsed.data;
    const validConfig = this.validateConfig(type, config);
    const row = await this.prisma.notificationChannel.create({
      data: {
        type,
        name,
        config: validConfig,
        // v1 default: ALL event types (opt-out, not opt-in).
        events: events ?? [...NOTIFICATION_EVENT_TYPES],
        minSeverity: minSeverity ?? 'INFO',
        enabled: enabled ?? true,
      },
    });
    return this.toDto(row);
  }

  async update(id: string, body: unknown): Promise<NotificationChannelDto> {
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      badRequest('invalid notification channel patch', parsed.error);
    }
    const existing = await this.getRow(id);
    const { name, config, events, minSeverity, enabled } = parsed.data;
    const mergedConfig =
      config !== undefined
        ? this.mergeConfig(existing.type, existing.config as Record<string, string>, config)
        : undefined;
    const row = await this.prisma.notificationChannel.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(mergedConfig !== undefined ? { config: mergedConfig } : {}),
        ...(events !== undefined ? { events } : {}),
        ...(minSeverity !== undefined ? { minSeverity } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
      },
    });
    return this.toDto(row);
  }

  async remove(id: string): Promise<{ deleted: true }> {
    await this.getRow(id); // 404 before the delete
    await this.prisma.notificationChannel.delete({ where: { id } });
    return { deleted: true };
  }

  async getRow(id: string): Promise<NotificationChannel> {
    const row = await this.prisma.notificationChannel.findUnique({ where: { id } });
    if (row === null) {
      throw new NotFoundException(`unknown notification channel: ${id}`);
    }
    return row;
  }

  /**
   * PATCH keep-secret merge: the patch is merged ONTO the stored config
   * (omitted fields keep stored values), a secret field carrying the literal
   * SECRET_MASK keeps the stored value, and an explicit '' REMOVES a key (the
   * only way to clear ntfy's optional accessToken). The MERGED config is then
   * re-validated against the type's schema.
   */
  private mergeConfig(
    type: string,
    stored: Record<string, string>,
    patch: Record<string, string>,
  ): Record<string, string> {
    const secrets = SECRET_CONFIG_KEYS[type as NotificationChannelType] ?? [];
    const merged: Record<string, string> = { ...stored };
    for (const [key, value] of Object.entries(patch)) {
      if (value === SECRET_MASK && secrets.includes(key)) {
        continue; // the mask round-tripped from a GET — keep the stored secret
      }
      if (value === '') {
        delete merged[key]; // explicit clear; required keys then fail validation
        continue;
      }
      merged[key] = value;
    }
    return this.validateConfig(type as NotificationChannelType, merged);
  }

  private validateConfig(
    type: NotificationChannelType,
    config: Record<string, string>,
  ): Record<string, string> {
    const parsed = CONFIG_SCHEMAS[type].safeParse(config);
    if (!parsed.success) {
      badRequest(`invalid ${type.toLowerCase()} channel config`, parsed.error);
    }
    // P8 defense-in-depth (v1 parity: every channel secret was registered
    // before any network use): register the secret values for log redaction
    // the moment they enter the system — create AND patch both land here.
    for (const key of SECRET_CONFIG_KEYS[type]) {
      const value = parsed.data[key];
      if (value) {
        registerSecret(value);
      }
    }
    return parsed.data;
  }

  /** Row → DTO with secret fields ALWAYS masked (full '***' — zero partial leak). */
  toDto(row: NotificationChannel): NotificationChannelDto {
    const secrets = SECRET_CONFIG_KEYS[row.type as NotificationChannelType] ?? [];
    const config: Record<string, string> = {};
    for (const [key, value] of Object.entries(row.config as Record<string, string>)) {
      config[key] = secrets.includes(key) ? SECRET_MASK : value;
    }
    return {
      id: row.id,
      type: row.type as NotificationChannelType,
      name: row.name,
      config,
      events: row.events,
      minSeverity: row.minSeverity,
      enabled: row.enabled,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
