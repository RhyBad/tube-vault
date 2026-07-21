/**
 * Per-channel policy: global defaults + per-channel overrides (D13).
 *
 * Ported from v1 `src/tubevault/domain/policy.py`. Effective policy is resolved
 * at job time: each field is the channel's override if set, else the global
 * default. v1's `INHERIT` sentinel becomes an ABSENT (`undefined`) field, so
 * `null` can remain a meaningful value (e.g. "no capacity cap").
 *
 * Also home to the pure yt-dlp decisions v1 kept in `adapters/engine_ytdlp.py`
 * (`format_selector` / `subtitle_opts`): they are policy semantics, not I/O, so
 * v2 moves them into the domain; the engine package consumes them in P3.
 */
import type { ContentType } from '@tubevault/types';

/** Kinds of archive strategy (v1 ArchiveMode). */
export type ArchiveMode = 'FULL_BACKUP' | 'CURATION';

/** Max quality to fetch. UNLIMITED is an explicit value, not 'no preference'. */
export type QualityCap = 'UNLIMITED' | 'P2160' | 'P1440' | 'P1080' | 'P720';

/** AUTO = auto-generated only; MANUAL = creator-authored only. */
export type SubtitleMode = 'AUTO' | 'MANUAL' | 'BOTH';

/**
 * Content types that need an authenticated owner session to fetch (F2/D7). Even
 * when enabled in policy they are off until a usable session exists — so we
 * never attempt gated content we cannot retrieve. Age-gating is a source state
 * (orthogonal), not a content type, so it is not listed here.
 */
export const SESSION_GATED_CONTENT: ReadonlySet<ContentType> = new Set(['MEMBERS_ONLY']);

/** Concrete global defaults; every field has a value. */
export interface GlobalPolicy {
  readonly archiveMode: ArchiveMode;
  readonly enabledContentTypes: ReadonlySet<ContentType>;
  readonly qualityCap: QualityCap;
  readonly perChannelCapacityBytes: number | null; // null = no cap
  readonly subtitleMode: SubtitleMode;
  readonly autoPause: boolean;
}

/**
 * Per-channel overrides; an ABSENT (`undefined`) field means 'use the global
 * value' (v1 INHERIT). `perChannelCapacityBytes: null` is a real override
 * ("no cap"), distinct from absent.
 */
export interface ChannelPolicy {
  readonly archiveMode?: ArchiveMode;
  readonly enabledContentTypes?: ReadonlySet<ContentType>;
  readonly qualityCap?: QualityCap;
  readonly perChannelCapacityBytes?: number | null;
  readonly subtitleMode?: SubtitleMode;
  readonly autoPause?: boolean;
}

/** The effective policy for a channel after merging overrides onto defaults. */
export interface ResolvedPolicy {
  readonly archiveMode: ArchiveMode;
  readonly enabledContentTypes: ReadonlySet<ContentType>;
  readonly qualityCap: QualityCap;
  readonly perChannelCapacityBytes: number | null;
  readonly subtitleMode: SubtitleMode;
  readonly autoPause: boolean;
}

/** Merge a channel's overrides onto the global defaults, field by field. */
export function resolvePolicy(defaults: GlobalPolicy, override: ChannelPolicy): ResolvedPolicy {
  return {
    archiveMode: override.archiveMode ?? defaults.archiveMode,
    enabledContentTypes: override.enabledContentTypes ?? defaults.enabledContentTypes,
    qualityCap: override.qualityCap ?? defaults.qualityCap,
    // `??` would swallow a meaningful null ("no cap"); only absent means inherit.
    perChannelCapacityBytes:
      override.perChannelCapacityBytes === undefined
        ? defaults.perChannelCapacityBytes
        : override.perChannelCapacityBytes,
    subtitleMode: override.subtitleMode ?? defaults.subtitleMode,
    autoPause: override.autoPause ?? defaults.autoPause,
  };
}

/**
 * Whether this content type is archived. Session-gated types (members-only, F2)
 * also require `sessionActive`: enabled-in-policy but no usable owner session
 * means effectively off, so the worker never queues gated content it cannot
 * fetch. The default `false` is the safe one — callers without a session see
 * gated types off.
 */
export function isContentTypeEnabled(
  policy: ResolvedPolicy,
  contentType: ContentType,
  sessionActive = false,
): boolean {
  if (!policy.enabledContentTypes.has(contentType)) {
    return false;
  }
  // Gated types need a session; non-gated types ignore it.
  return sessionActive || !SESSION_GATED_CONTENT.has(contentType);
}

/**
 * The persisted (JSON) shape of a ChannelPolicy: only OVERRIDDEN fields are
 * present; inherited fields are omitted (v1 `channel_policy_to_dict` sparse
 * convention). Sets become sorted arrays.
 */
export interface ChannelPolicyJson {
  readonly archiveMode?: ArchiveMode;
  readonly enabledContentTypes?: readonly ContentType[];
  readonly qualityCap?: QualityCap;
  readonly perChannelCapacityBytes?: number | null;
  readonly subtitleMode?: SubtitleMode;
  readonly autoPause?: boolean;
}

type MutableChannelPolicyJson = {
  -readonly [K in keyof ChannelPolicyJson]: ChannelPolicyJson[K];
};

/** Serialize only the OVERRIDDEN fields; inherited (absent) fields are omitted. */
export function channelPolicyToJson(policy: ChannelPolicy): ChannelPolicyJson {
  const out: MutableChannelPolicyJson = {};
  if (policy.archiveMode !== undefined) {
    out.archiveMode = policy.archiveMode;
  }
  if (policy.enabledContentTypes !== undefined) {
    out.enabledContentTypes = [...policy.enabledContentTypes].sort();
  }
  if (policy.qualityCap !== undefined) {
    out.qualityCap = policy.qualityCap;
  }
  if (policy.perChannelCapacityBytes !== undefined) {
    out.perChannelCapacityBytes = policy.perChannelCapacityBytes;
  }
  if (policy.subtitleMode !== undefined) {
    out.subtitleMode = policy.subtitleMode;
  }
  if (policy.autoPause !== undefined) {
    out.autoPause = policy.autoPause;
  }
  return out;
}

type MutableChannelPolicy = {
  -readonly [K in keyof ChannelPolicy]: ChannelPolicy[K];
};

/** Rebuild a ChannelPolicy; absent keys stay absent (inherit). */
export function channelPolicyFromJson(json: ChannelPolicyJson): ChannelPolicy {
  const out: MutableChannelPolicy = {};
  if (json.archiveMode !== undefined) {
    out.archiveMode = json.archiveMode;
  }
  if (json.enabledContentTypes !== undefined) {
    out.enabledContentTypes = new Set(json.enabledContentTypes);
  }
  if (json.qualityCap !== undefined) {
    out.qualityCap = json.qualityCap;
  }
  if (json.perChannelCapacityBytes !== undefined) {
    out.perChannelCapacityBytes = json.perChannelCapacityBytes;
  }
  if (json.subtitleMode !== undefined) {
    out.subtitleMode = json.subtitleMode;
  }
  if (json.autoPause !== undefined) {
    out.autoPause = json.autoPause;
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Pure yt-dlp decisions (v1 adapters/engine_ytdlp.py — consumed by P3's engine)
// --------------------------------------------------------------------------- //

const HEIGHT_CAP: Readonly<Record<Exclude<QualityCap, 'UNLIMITED'>, number>> = {
  P2160: 2160,
  P1440: 1440,
  P1080: 1080,
  P720: 720,
};

/** yt-dlp format expression for a quality cap (F5). UNLIMITED = best available. */
export function formatSelector(qualityCap: QualityCap): string {
  if (qualityCap === 'UNLIMITED') {
    return 'bestvideo*+bestaudio/best';
  }
  const height = HEIGHT_CAP[qualityCap];
  return `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`;
}

/** The subtitle decision for a subtitle mode (v1 `subtitle_opts` semantics). */
export interface SubtitleDecision {
  readonly writeSubtitles: boolean;
  readonly writeAutomaticSub: boolean;
  readonly subtitleLangs: readonly string[];
}

/** Which subtitle tracks to fetch for a mode. All languages preserved (F4). */
export function subtitleDecision(mode: SubtitleMode): SubtitleDecision {
  return {
    writeSubtitles: mode === 'MANUAL' || mode === 'BOTH',
    writeAutomaticSub: mode === 'AUTO' || mode === 'BOTH',
    subtitleLangs: ['all'],
  };
}
