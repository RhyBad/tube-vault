import { BadRequestException, Body, Controller, Get, Inject, Patch } from '@nestjs/common';
import { PrismaClient, QualityCap, SubtitleMode, type Prisma } from '@tubevault/db';
// The SHARED clamp bounds (the worker's download-concurrency clamp imports the
// same constants): out-of-range values are CLAMPED, never rejected, because
// the worker clamps at every pickup anyway; the api storing what it will
// enforce keeps GET honest.
import { CONCURRENCY_MAX, CONCURRENCY_MIN, type SettingsDto } from '@tubevault/types';
import { z } from 'zod';

import { PrismaService } from './prisma.service';
import { toSettingsDto } from './queue/dto-mappers';

const patchSchema = z
  .object({
    downloadConcurrency: z.number().int().optional(),
    qualityCap: z.nativeEnum(QualityCap).optional(),
    subtitleMode: z.nativeEnum(SubtitleMode).optional(),
  })
  .strict(); // typo'd keys → 400, not a silent no-op

/**
 * The real Settings API (P6b — replaces the P4 placeholder): the singleton
 * row, created with schema defaults on first read, partially updatable.
 * Session-guarded by the global APP_GUARD.
 */
@Controller('settings')
export class SettingsController {
  private readonly prisma: PrismaClient;

  constructor(@Inject(PrismaService) prisma: PrismaClient) {
    this.prisma = prisma;
  }

  @Get()
  async settings(): Promise<SettingsDto> {
    // create-if-missing with schema defaults (same upsert the worker uses).
    const row = await this.prisma.settings.upsert({
      where: { id: 'singleton' },
      update: {},
      create: {},
    });
    return toSettingsDto(row);
  }

  @Patch()
  async update(@Body() body: unknown): Promise<SettingsDto> {
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      const details = parsed.error.issues
        .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
        .join('; ');
      throw new BadRequestException(`invalid settings patch: ${details}`);
    }
    const { downloadConcurrency, qualityCap, subtitleMode } = parsed.data;
    const data: Prisma.SettingsUpdateInput = {
      ...(downloadConcurrency !== undefined
        ? {
            downloadConcurrency: Math.min(
              CONCURRENCY_MAX,
              Math.max(CONCURRENCY_MIN, downloadConcurrency),
            ),
          }
        : {}),
      ...(qualityCap !== undefined ? { qualityCap } : {}),
      ...(subtitleMode !== undefined ? { subtitleMode } : {}),
    };
    const row = await this.prisma.settings.upsert({
      where: { id: 'singleton' },
      update: data,
      create: data as Prisma.SettingsCreateInput,
    });
    return toSettingsDto(row);
  }
}
