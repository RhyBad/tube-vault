#!/usr/bin/env bash
# Run on the upstream/dev side. Publish a clean release SNAPSHOT to the public GitHub repo.
# - Snapshot only (NO upstream git history reaches GitHub).
# - Excludes internal/AI/planning files via .publishignore (source side).
# - Preserves GitHub-native community dirs (locales/ docs/ .github/ CHANGELOG.md) — merge-publish, not force-mirror.
# - Fail-closed guard: aborts if any forbidden file slipped into the snapshot.
# Usage: publish-from-upstream.sh vX.Y.Z [--dry-run]
set -euo pipefail
VERSION="${1:?usage: publish-from-upstream.sh vX.Y.Z [--dry-run]}"
DRY=""; [ "${2:-}" = "--dry-run" ] && DRY="--dry-run"
GH_REMOTE="${GH_REMOTE:-git@github.com:RhyBad/tube-vault.git}"
WORK="$(mktemp -d)"; git clone --depth 1 "$GH_REMOTE" "$WORK/gh"

# 1) refresh canonical keys → public locales/en.json (adjust to your extraction)
#    npm run i18n:extract -- --out "$WORK/gh/locales/en.json"

# 2) sync code snapshot: exclude internal (source) + preserve community dirs (dest)
rsync -a --delete $DRY \
  --exclude '.git/' --exclude-from='.publishignore' \
  --exclude 'locales/' --exclude 'docs/' --exclude '.github/' --exclude 'CHANGELOG.md' \
  ./ "$WORK/gh/"

# 3) FAIL-CLOSED GUARD: no forbidden files may exist in the snapshot about to be published
LEAKS="$(cd "$WORK/gh" && find . -path ./.git -prune -o \
  \( -iname 'CLAUDE.md' -o -name '.claude' -o -name 'AGENTS.md' -o -name '.cursorrules' \
     -o -name '*.private.*' -o -name '.env' -o -name '*.key' -o -name '*.pem' \) -print)"
if [ -n "$LEAKS" ]; then echo "✗ ABORT — forbidden files in snapshot:"; echo "$LEAKS"; exit 1; fi
echo "✓ guard passed (no internal/AI/secret files)"

[ -n "$DRY" ] && { echo "-- dry-run: nothing pushed --"; exit 0; }
cd "$WORK/gh"
git add -A && git commit -m "release: $VERSION" || echo "no changes"
git tag "$VERSION" && git push origin HEAD --tags   # tag push → GitHub release.yml (build → GHCR → Release)
echo "published $VERSION → GitHub"
