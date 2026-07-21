import { describe, expect, it } from 'vitest';

import { buildEnJson } from './emit-en-i18n';

describe('emit-en-i18n', () => {
  it('produces valid, pretty-printed, newline-terminated JSON', () => {
    const json = buildEnJson();
    expect(() => JSON.parse(json)).not.toThrow();
    expect(json.endsWith('\n')).toBe(true);
    expect(json).toContain('\n  '); // 2-space indented
  });

  it('includes the canonical top-level EN namespaces', () => {
    const en = JSON.parse(buildEnJson());
    for (const key of [
      'common',
      'shell',
      'queue',
      'videos',
      'video',
      'live',
      'settings',
      'storage',
    ]) {
      expect(en, `missing top-level namespace: ${key}`).toHaveProperty(key);
    }
  });

  it('preserves the dual-owned `storage` deep-merge (a shallow spread would clobber one side)', () => {
    const en = JSON.parse(buildEnJson());
    // components slice owns the DS gauge keys; the storage slice owns the S-ST
    // screen keys — both must survive under `storage`.
    expect(en.storage).toHaveProperty('free'); // DS gauge (components.en.storage)
    expect(en.storage).toHaveProperty('title'); // S-ST screen (storage.en.storage)
  });
});
