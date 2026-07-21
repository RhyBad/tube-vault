/**
 * Emit a first-party locale key set (EN or KO) as JSON.
 *
 * EN and KO live as hand-authored TS objects (src/i18n/resources/*.{en,ko}.ts)
 * merged into `en` / `ko` — including a DEEP-merge of the dual-owned `storage`
 * namespace. We import the already-merged object (never re-concatenate the raw
 * slices, or the storage merge is lost) and serialize it verbatim: i18next
 * consumes the nested shape natively (single `translation` NS, default
 * keySeparator), so no flattening is needed.
 *
 * EN is the reference — the ONLY complete locale (fallbackLng='en'); KO is a
 * partial translation and therefore a strict key-SUBSET of EN, which is exactly
 * what the public repo's locale gate (validate-locales.mjs: keys ⊆ en.json)
 * requires. Community translations for OTHER languages live on the public repo;
 * en + ko are first-party and code-owned, regenerated on every publish.
 *
 * Run: `pnpm --filter @tubevault/web run i18n:extract [-- --locale en|ko] [-- --out <path>]`.
 * The publish flow emits BOTH en.json and ko.json into the public repo's locales/.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { en, ko } from '../src/i18n/resources/index';

/** The first-party locales this emitter can serialize. */
const LOCALES = { en, ko } as const;
export type LocaleName = keyof typeof LOCALES;

/** Serialize a locale resource object to pretty, newline-terminated JSON. */
export function buildLocaleJson(locale: LocaleName): string {
  return JSON.stringify(LOCALES[locale], null, 2) + '\n';
}

/** The canonical EN reference JSON. */
export function buildEnJson(): string {
  return buildLocaleJson('en');
}

/** The partial KO JSON (a strict key-subset of EN). */
export function buildKoJson(): string {
  return buildLocaleJson('ko');
}

/** CLI: writes <locale>.json to --out (default apps/web/dist/i18n/<locale>.json). */
function main(argv: string[]): void {
  const localeFlag = argv.indexOf('--locale');
  const requested = localeFlag >= 0 ? argv[localeFlag + 1] : 'en';
  if (!requested || !(requested in LOCALES)) {
    process.stderr.write(
      `i18n:extract → unknown locale '${requested ?? ''}' (known: ${Object.keys(LOCALES).join(', ')})\n`,
    );
    process.exit(1);
  }
  const locale = requested as LocaleName;
  const outFlag = argv.indexOf('--out');
  const out =
    outFlag >= 0 && argv[outFlag + 1]
      ? resolve(argv[outFlag + 1])
      : fileURLToPath(new URL(`../dist/i18n/${locale}.json`, import.meta.url));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, buildLocaleJson(locale));
  process.stdout.write(`i18n:extract → wrote canonical ${locale}.json to ${out}\n`);
}

// Run only when invoked directly (tsx), never when imported by the test.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
