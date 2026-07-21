/**
 * THE root-confinement rule (P6b): one normalized core shared by everything
 * that decides "is this path under that root?" — the api cancel endpoint's
 * staging wipe (`isPathWithinRoot`, strict-inside: Job.stagingDir is a DB
 * string and `rm -rf` on it must never reach outside the vault) and the
 * LocalFileStore write guard (`assertWithinRoot`, root-allowed). Two diverging
 * implementations of this rule is exactly the audit bug this file closes.
 *
 * Pure lexical resolution: symlinks are NOT followed — nothing inside the
 * vault creates them, and the structural guarantees (safeId/sanitizeComponent)
 * hold regardless.
 */
import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface PathContainmentOptions {
  /**
   * Whether the root ITSELF counts as contained. The staging wipe says no
   * (deleting the whole vault can never pass as a staging wipe); the
   * LocalFileStore write guard says yes (writing at the root is fine).
   */
  allowRoot: boolean;
  /**
   * Reject relative candidates outright instead of resolving them against the
   * process cwd. A STORED pointer (stagingDir) must be absolute — resolving it
   * would make the delete verdict cwd-dependent. LocalFileStore builds its
   * candidates by joining onto its own (possibly relative) root, so it
   * resolves both sides the same way instead.
   */
  requireAbsoluteCandidate: boolean;
}

/** The shared normalized core — both public rules below delegate here. */
export function isPathContained(
  root: string,
  candidate: string,
  opts: PathContainmentOptions,
): boolean {
  if (opts.requireAbsoluteCandidate && !isAbsolute(candidate)) {
    return false;
  }
  const rel = relative(resolve(root), resolve(candidate));
  if (isAbsolute(rel)) {
    return false; // disjoint tree (e.g. another drive root)
  }
  if (rel === '') {
    return opts.allowRoot;
  }
  // '..' or '../…' escapes; a plain leaf that merely STARTS with dots (a child
  // named '..x') does not — string-prefix is not containment, either way.
  return rel !== '..' && !rel.startsWith(`..${sep}`);
}

/**
 * True when `candidate` is a STRICT descendant of `root` after resolving `.`
 * and `..` segments (root itself excluded, relative candidates rejected — see
 * the option docs above). Used by the api's cancel staging wipe.
 */
export function isPathWithinRoot(root: string, candidate: string): boolean {
  return isPathContained(root, candidate, { allowRoot: false, requireAbsoluteCandidate: true });
}
