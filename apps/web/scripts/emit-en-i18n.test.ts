import { describe, expect, it } from 'vitest';

import { buildEnJson, buildKoJson } from './emit-en-i18n';

// Flatten to dotted leaf-keys with the SAME semantics as the public repo's
// scripts/validate-locales.mjs (object → recurse, else leaf). The release gate
// requires every locales/*.json key to be a subset of en.json.
const leafKeys = (o: unknown, p = ''): string[] =>
  Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
    v && typeof v === 'object' ? leafKeys(v, `${p}${k}.`) : [`${p}${k}`],
  );

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

  it('emits KO as valid, pretty-printed, newline-terminated JSON', () => {
    const json = buildKoJson();
    expect(() => JSON.parse(json)).not.toThrow();
    expect(json.endsWith('\n')).toBe(true);
    expect(json).toContain('\n  '); // 2-space indented
  });

  it('KO is a non-empty, real (partial) translation — not an empty stub', () => {
    const ko = JSON.parse(buildKoJson());
    expect(Object.keys(ko).length).toBeGreaterThan(0);
    expect(ko).toHaveProperty('common'); // a translated namespace is present
  });

  it('KO keys are a STRICT SUBSET of EN keys — the exact contract the public locale gate enforces', () => {
    // validate-locales.mjs fails the release if ko.json has any key not in
    // en.json. Missing keys are fine (runtime falls back to EN); UNKNOWN keys
    // are not. This guards our generated ko.json against ever tripping it.
    const en = new Set(leafKeys(JSON.parse(buildEnJson())));
    const unknown = leafKeys(JSON.parse(buildKoJson())).filter((k) => !en.has(k));
    expect(unknown, `KO keys absent from EN: ${unknown.join(', ')}`).toEqual([]);
  });
});
