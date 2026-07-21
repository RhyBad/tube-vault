/**
 * The ONE video-listing query shape (P9): `GET /api/channels/:id/videos` and
 * the cross-channel `GET /api/videos` share the same strict zod schema, the
 * same WHERE builder and the same sort table — factored here so the two
 * listings can never drift on semantics (bounded search, nulls-last
 * publishedAt sorts, offset paging with a filtered total).
 *
 * Filters (CR-07/CR-08): copyState, sourceState, contentType, the derived
 * `rescued` convenience (HEALTHY copy of a vanished original), a publishedAt
 * ISO range, and search. Search is title contains-insensitive on BOTH
 * listings; the GLOBAL listing additionally matches the joined channel title
 * (opt-in via `VideoWhereOptions`, since the per-channel route's channel is
 * fixed from the path). Every clause is AND-composed so filters only ever
 * narrow — nothing silently overrides anything else.
 */
import { RESCUED_SOURCES } from '@tubevault/core';
import { ContentType, CopyState, SourceState, type Prisma } from '@tubevault/db';
import type { VideoSort } from '@tubevault/types';
import { z } from 'zod';

/** Validated listing query (the controllers zod-parse into this). */
export interface VideoListQuery {
  /** Only the GLOBAL listing accepts this; the per-channel route fixes it from the path. */
  channelId?: string;
  copyState?: CopyState;
  sourceState?: SourceState;
  contentType?: ContentType;
  /** Convenience derived filter: HEALTHY copy of a DELETED/PRIVATE original (D9 "Rescued"). */
  rescued?: boolean;
  search?: string;
  /** Inclusive publishedAt lower bound (validated ISO 8601 string). */
  publishedFrom?: string;
  /** Inclusive publishedAt upper bound (validated ISO 8601 string). */
  publishedTo?: string;
  /** CR-27: inclusive min sizeBytes (bytes) — the cleanup UI's "big files" filter. */
  sizeFrom?: number;
  sort: VideoSort;
  limit: number;
  offset: number;
}

/** Knobs the caller (per listing) toggles on the shared WHERE builder. */
export interface VideoWhereOptions {
  /** GLOBAL listing (EP-15) only: also match `search` against the joined channel title. */
  searchChannelTitle?: boolean;
}

/**
 * A query-string boolean that ONLY accepts the two literals and coerces to a
 * real boolean — deliberately NOT `z.coerce.boolean()`, whose `Boolean('false')`
 * is `true`. Absent → undefined; `'false'` → a no-op, same as absent.
 */
const queryBoolean = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

/** `GET /api/channels/:id/videos` query schema (channelId comes from the path). */
export const videosQuerySchema = z.object({
  copyState: z.nativeEnum(CopyState).optional(),
  sourceState: z.nativeEnum(SourceState).optional(),
  contentType: z.nativeEnum(ContentType).optional(),
  rescued: queryBoolean,
  search: z.string().max(200).optional(), // bounded: this feeds an ILIKE contains
  publishedFrom: z.string().datetime({ offset: true }).optional(),
  publishedTo: z.string().datetime({ offset: true }).optional(),
  // CR-27: min sizeBytes filter (bytes). Coerced from the query string; a ≤4 GB
  // media is well within a JS safe integer, converted to BigInt at the WHERE.
  // Complements sizeBytes_desc for the cleanup UI.
  sizeFrom: z.coerce.number().int().min(0).optional(),
  sort: z
    .enum([
      'publishedAt_desc',
      'publishedAt_asc',
      'addedAt_desc',
      'title_asc',
      'sizeBytes_desc',
      'sizeBytes_asc',
    ])
    .default('publishedAt_desc'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

/** `GET /api/videos` query schema: the same shape plus an optional channel filter. */
export const globalVideosQuerySchema = videosQuerySchema.extend({
  // Bounded like `search`: this lands in a WHERE — a YouTube channel id is 24
  // chars; 64 is generous headroom, anything bigger is garbage, not a filter.
  channelId: z.string().min(1).max(64).optional(),
});

/** Sort orders. publishedAt is nullable → NULLS LAST + id asc tiebreak (stable pages). */
export const VIDEO_ORDER_BY: Readonly<Record<VideoSort, Prisma.VideoOrderByWithRelationInput[]>> = {
  publishedAt_desc: [{ publishedAt: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
  publishedAt_asc: [{ publishedAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
  addedAt_desc: [{ addedAt: 'desc' }, { id: 'asc' }],
  title_asc: [{ title: 'asc' }, { id: 'asc' }],
  // CR-27: biggest reclaim targets first. sizeBytes is nullable (a CANDIDATE
  // holds none) → NULLS LAST + id tiebreak, same shape as the publishedAt sorts.
  sizeBytes_desc: [{ sizeBytes: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
  sizeBytes_asc: [{ sizeBytes: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
};

/** RESCUED_SOURCES as a Prisma `in` list — reuses the core set so the "Rescued"
 * listing filter is the single source of truth shared with `isRescued`. */
const RESCUED_SOURCE_LIST: SourceState[] = Array.from(RESCUED_SOURCES);

/**
 * The shared WHERE. Each filter contributes 0-or-1 independent AND clause, so
 * combining them only narrows (never overwrites) — e.g. `rescued=true` +
 * `copyState=CANDIDATE` keeps both clauses and yields an empty page rather than
 * silently winning. Returns `{}` (match-all) when nothing is filtered.
 */
export function videoWhere(
  query: VideoListQuery,
  options: VideoWhereOptions = {},
): Prisma.VideoWhereInput {
  const and: Prisma.VideoWhereInput[] = [];

  if (query.channelId !== undefined) and.push({ channelId: query.channelId });
  if (query.copyState !== undefined) and.push({ copyState: query.copyState });
  if (query.sourceState !== undefined) and.push({ sourceState: query.sourceState });
  if (query.contentType !== undefined) and.push({ contentType: query.contentType });

  // CR-08 "Rescued" convenience: a HEALTHY copy whose original vanished
  // (DELETED/PRIVATE) — the derived D9 status. Reuses core RESCUED_SOURCES so
  // it can never drift from `isRescued`; its own clause so it AND-composes.
  if (query.rescued === true) {
    and.push({ copyState: 'HEALTHY', sourceState: { in: RESCUED_SOURCE_LIST } });
  }

  // CR-27 min-size filter (cleanup UI). sizeBytes is a BigInt column; a nullable
  // sizeBytes never matches a bound (SQL NULL), same intended semantics as the
  // publishedAt range — a media-less row is not a reclaim target anyway.
  if (query.sizeFrom !== undefined) {
    and.push({ sizeBytes: { gte: BigInt(query.sizeFrom) } });
  }

  // CR-07 publishedAt range. publishedAt is nullable → rows with no date never
  // match a bound (SQL NULL comparison), which is the intended semantics.
  if (query.publishedFrom !== undefined || query.publishedTo !== undefined) {
    and.push({
      publishedAt: {
        ...(query.publishedFrom !== undefined ? { gte: new Date(query.publishedFrom) } : {}),
        ...(query.publishedTo !== undefined ? { lte: new Date(query.publishedTo) } : {}),
      },
    });
  }

  // Title contains-insensitive on both listings; the GLOBAL listing (EP-15)
  // also matches the joined channel title (CR-07) — opt-in so the per-channel
  // route, whose channel is path-fixed, never pays for the relation predicate.
  if (query.search !== undefined && query.search !== '') {
    const contains: Prisma.StringFilter = { contains: query.search, mode: 'insensitive' };
    and.push(
      options.searchChannelTitle
        ? { OR: [{ title: contains }, { channel: { title: contains } }] }
        : { title: contains },
    );
  }

  return and.length > 0 ? { AND: and } : {};
}
