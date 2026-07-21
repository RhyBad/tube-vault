/**
 * Error-kind classification (NEW in v2, no v1 equivalent).
 *
 * Composes the ported bot-wall detector and availability classifier into the
 * worker-facing ErrorKind: the bot wall wins first (it needs its own actionable
 * alert + never looks like a loss), then the availability classification maps
 * onto retry semantics. The worker maps terminal kinds to BullMQ's
 * UnrecoverableError (immediate FAILED, no retries).
 */
import type { ErrorKind, SourceState } from '@tubevault/types';

import { classifyAvailability } from './availability.js';
import { isBotWall } from './bot-wall.js';

/**
 * SourceState -> ErrorKind. PRIVATE joins DELETED as SOURCE_GONE: v1 treats a
 * private original as a loss (it badges Rescued), and retrying it unattended is
 * futile — the members/age gates stay AUTH (actionable: import cookies).
 * AVAILABLE is unreachable from an error message; mapped defensively to UNKNOWN.
 */
const SOURCE_TO_ERROR_KIND: Readonly<Record<SourceState, ErrorKind>> = {
  RATE_LIMITED: 'RATE_LIMITED',
  MEMBERS_ONLY: 'AUTH',
  AGE_GATED: 'AUTH',
  GEO_BLOCKED: 'GEO_BLOCKED',
  DELETED: 'SOURCE_GONE',
  PRIVATE: 'SOURCE_GONE',
  TRANSIENT_ERROR: 'TRANSIENT',
  UNKNOWN: 'UNKNOWN',
  AVAILABLE: 'UNKNOWN',
};

/** Classify a failed download/probe's stderr (or message) into an ErrorKind. */
export function classifyErrorKind(stderrOrMessage: string): ErrorKind {
  if (isBotWall(stderrOrMessage)) {
    return 'BOT_WALL';
  }
  return SOURCE_TO_ERROR_KIND[classifyAvailability(null, stderrOrMessage)];
}

/**
 * True when the failure can never succeed on retry (the worker maps these to
 * BullMQ UnrecoverableError). SOURCE_GONE (deleted/private original) is the only
 * terminal kind; everything else — bot wall, rate limit, auth gates, geo,
 * transient, unknown — is retryable (possibly after owner action).
 */
export function isTerminalErrorKind(kind: ErrorKind): boolean {
  return kind === 'SOURCE_GONE';
}
