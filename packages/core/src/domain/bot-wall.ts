/**
 * Bot-wall detection (F2). Ported from v1 `src/tubevault/domain/events.py`
 * (`is_bot_wall` + `_BOT_WALL_SIGNATURES`).
 */

/**
 * The phrase (lower-cased) that uniquely identifies YouTube's "confirm you're
 * not a bot" wall. Deliberately NOT "sign in to confirm" — that also matches the
 * age-gate ("sign in to confirm your age") and other auth prompts; "not a bot"
 * is specific to the bot wall. Keying off the stable phrase (no apostrophe) is
 * robust to the real message's curly apostrophe in "you're".
 */
const BOT_WALL_SIGNATURES: readonly string[] = ['not a bot'];

/**
 * True if `errorText` is YouTube's anti-bot sign-in wall (vs an ordinary
 * failure, or a DIFFERENT auth prompt like age-gate/members-only).
 *
 * Used to raise a distinct, actionable alert ("import cookies / retry") rather
 * than burying the bot wall in a generic download failure.
 */
export function isBotWall(errorText: string): boolean {
  const lowered = errorText.toLowerCase();
  return BOT_WALL_SIGNATURES.some((signature) => lowered.includes(signature));
}
