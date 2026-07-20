// Validate every locales/*.json: parses as JSON, keys are a subset of en.json (no unknown keys).
// Missing keys are OK (runtime falls back to English). Fails CI on parse error or unknown keys.
import { readdirSync, readFileSync } from "node:fs";
const dir = "locales";
const flat = (o, p = "") => Object.entries(o).flatMap(([k, v]) =>
  v && typeof v === "object" ? flat(v, `${p}${k}.`) : [`${p}${k}`]);
const en = new Set(flat(JSON.parse(readFileSync(`${dir}/en.json`, "utf8"))));
let bad = 0;
for (const f of readdirSync(dir).filter(f => f.endsWith(".json") && f !== "en.json")) {
  let json; try { json = JSON.parse(readFileSync(`${dir}/${f}`, "utf8")); }
  catch (e) { console.error(`✗ ${f}: invalid JSON — ${e.message}`); bad++; continue; }
  const unknown = flat(json).filter(k => !en.has(k));
  if (unknown.length) { console.error(`✗ ${f}: unknown keys not in en.json: ${unknown.join(", ")}`); bad++; }
  else console.log(`✓ ${f}`);
}
process.exit(bad ? 1 : 0);
