# Contributing to TubeVault

## How this project is developed
TubeVault is developed in a **private upstream repository**. This GitHub repository is a **publish
mirror**: clean release snapshots are pushed here, and GitHub Actions builds the public Docker image (GHCR)
and creates releases. **Development does not happen on GitHub**, and code flows one-way (upstream → GitHub).

## Code contributions — not accepted
Because code is one-directional (the private upstream repo is the source of truth) and development is fast-moving / AI-assisted,
**pull requests that change source code will not be merged.** Please don't spend effort on code PRs — open an
**Issue** instead (bug report or feature request) and it will be triaged upstream.

## What IS welcome ✅
- **Issues** — bug reports and feature requests (templates provided).
- **Translations** — add or improve locale files under `locales/`. **This is the one place PRs are merged.**
- **Docs** — fixes/improvements to `docs/` via PR.

## Translating (the welcome PR path)
1. Copy `locales/en.json` (the canonical key set) to `locales/<lang>.json` (BCP-47 code, e.g. `ja`, `de`, `fr`).
2. Translate the **values** only — keep the **keys** unchanged.
3. Partial is fine: any missing/blank key **falls back to English at runtime** (`fallbackLng: "en"`). Never
   delete keys.
4. Open a PR. CI validates JSON + that keys are a subset of `en.json`.

`locales/en.json` is generated upstream from the app's message keys and refreshed on each release — treat it
as read-only (translate against it, don't edit it).
