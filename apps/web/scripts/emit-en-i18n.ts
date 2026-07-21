/**
 * Emit the canonical EN key set (the reference locale) as JSON.
 *
 * EN lives as hand-authored TS objects (src/i18n/resources/*.en.ts) merged into
 * one `en` — including a DEEP-merge of the dual-owned `storage` namespace. We
 * import that already-merged object (never re-concatenate the raw slices, or the
 * storage merge is lost) and serialize it verbatim: i18next consumes the nested
 * shape natively (single `translation` NS, default keySeparator), so no
 * flattening is needed. fallbackLng='en' means EN is the ONLY complete locale;
 * we never enforce per-locale completeness.
 *
 * Run: `pnpm --filter @tubevault/web run i18n:extract [-- --out <path>]`.
 * The publish flow points --out at the public repo's locales/en.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { en } from '../src/i18n/resources/index';

/** Serialize the canonical EN object to pretty, newline-terminated JSON. */
export function buildEnJson(): string {
  return JSON.stringify(en, null, 2) + '\n';
}

/** CLI: writes en.json to --out <path> (default apps/web/dist/i18n/en.json). */
function main(argv: string[]): void {
  const outFlag = argv.indexOf('--out');
  const out =
    outFlag >= 0 && argv[outFlag + 1]
      ? resolve(argv[outFlag + 1])
      : fileURLToPath(new URL('../dist/i18n/en.json', import.meta.url));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, buildEnJson());
  process.stdout.write(`i18n:extract → wrote canonical en.json to ${out}\n`);
}

// Run only when invoked directly (tsx), never when imported by the test.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
