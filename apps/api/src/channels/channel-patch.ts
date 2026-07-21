// Enums imported as VALUES from @tubevault/db (the types-package unions are
// type-only): z.nativeEnum needs the runtime enum object — same import the
// settings PATCH uses (settings.controller.ts).
import { QualityCap, SubtitleMode } from '@tubevault/db';
import { z } from 'zod';

/**
 * EP-12 PATCH body (CR-04). Widens the P10 strict `{watchLive}` to also carry
 * the per-channel download-policy overrides. Semantics:
 *
 * - every field is OPTIONAL — an ABSENT key means "leave unchanged" (partial
 *   patch), so an empty `{}` is a valid 200 no-op;
 * - the two enum fields are additionally NULLABLE — an explicit `null` CLEARS
 *   the override (writes the nullable column back to NULL = inherit global
 *   Settings), mirroring `Channel.qualityCap?/subtitleMode?`;
 * - `.strict()` is preserved: a typo'd/unknown key is a deliberate 400, never a
 *   silent no-op.
 *
 * `enabledContentTypes` is intentionally NOT here — per-channel content-type
 * policy is deferred to its own CR (the core gate is inert and only
 * MEMBERS_ONLY is separable today).
 */
export const channelPatchSchema = z
  .object({
    watchLive: z.boolean().optional(),
    qualityCap: z.nativeEnum(QualityCap).nullable().optional(),
    subtitleMode: z.nativeEnum(SubtitleMode).nullable().optional(),
  })
  .strict();

/** Validated EP-12 patch (the controller zod-parses it, the service applies it). */
export type ChannelPatch = z.infer<typeof channelPatchSchema>;
