/**
 * isPathWithinRoot (P6b): the cancel endpoint wipes a Job row's stagingDir —
 * a DB string — so it MUST refuse anything that resolves outside the vault
 * root before `rm -rf`-ing it. Pure path math, shared here so the api and the
 * worker can never drift on the safety rule.
 */
import { describe, expect, it } from 'vitest';

import { isPathContained, isPathWithinRoot } from './index.js';

describe('isPathWithinRoot', () => {
  it('accepts descendants of the root', () => {
    expect(isPathWithinRoot('/data/media', '/data/media/UC1/v1 - t/.incoming')).toBe(true);
    expect(isPathWithinRoot('/data/media', '/data/media/UC1')).toBe(true);
  });

  it('rejects the root itself (wiping the whole vault is never a staging wipe)', () => {
    expect(isPathWithinRoot('/data/media', '/data/media')).toBe(false);
    expect(isPathWithinRoot('/data/media', '/data/media/')).toBe(false);
  });

  it('rejects paths outside the root', () => {
    expect(isPathWithinRoot('/data/media', '/tmp/evil')).toBe(false);
    expect(isPathWithinRoot('/data/media', '/data')).toBe(false);
    expect(isPathWithinRoot('/data/media', '/')).toBe(false);
  });

  it('rejects sibling prefixes (string-prefix is NOT containment)', () => {
    expect(isPathWithinRoot('/data/media', '/data/media-evil/x')).toBe(false);
  });

  it('resolves traversal segments before deciding', () => {
    expect(isPathWithinRoot('/data/media', '/data/media/UC1/../../etc/passwd')).toBe(false);
    expect(isPathWithinRoot('/data/media', '/data/media/UC1/../UC2/v')).toBe(true);
  });

  it('rejects relative candidates (a staging pointer must be absolute)', () => {
    expect(isPathWithinRoot('/data/media', 'UC1/v1')).toBe(false);
    expect(isPathWithinRoot('/data/media', './x')).toBe(false);
  });
});

describe('isPathContained (the shared core both rules delegate to)', () => {
  it('allowRoot toggles ONLY the root-itself verdict', () => {
    const strict = { allowRoot: false, requireAbsoluteCandidate: true };
    const rooty = { allowRoot: true, requireAbsoluteCandidate: true };
    expect(isPathContained('/data/media', '/data/media', strict)).toBe(false);
    expect(isPathContained('/data/media', '/data/media', rooty)).toBe(true);
    // Everything else is identical between the two modes.
    for (const opts of [strict, rooty]) {
      expect(isPathContained('/data/media', '/data/media/UC1/x', opts)).toBe(true);
      expect(isPathContained('/data/media', '/data/media-evil/x', opts)).toBe(false);
      expect(isPathContained('/data/media', '/data/media/../../etc', opts)).toBe(false);
    }
  });

  it('requireAbsoluteCandidate=false resolves relative candidates against cwd (LocalFileStore mode)', () => {
    const opts = { allowRoot: true, requireAbsoluteCandidate: false };
    // Both sides resolve against the same cwd, so a relative root contains
    // its own relative children.
    expect(isPathContained('some-root', 'some-root/child', opts)).toBe(true);
    expect(isPathContained('some-root', 'other-root/child', opts)).toBe(false);
  });
});
