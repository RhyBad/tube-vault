# TubeVault

> **Status:** early — **0.x** (pre-1.0). Self-hosted, single-user; APIs may change before 1.0.

Self-hosted, single-user **YouTube archiving vault**. Preserve the channels you care about — keep a healthy
copy even if the original disappears from YouTube.

> **How this repo works:** development happens **upstream on a private upstream instance**. This GitHub
> repository is the **public publish mirror + build/release + community surface**. GitHub Actions builds the
> public multi-arch Docker image (GHCR, amd64+arm64) and cuts releases. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Quick start
```bash
cp .env.example .env      # edit secrets/paths
docker compose up -d      # pulls the published GHCR image (amd64/arm64)
```
See [docs/install.md](docs/install.md) and [docs/configuration.md](docs/configuration.md).

## Docs
[Install](docs/install.md) · [Configuration](docs/configuration.md) · [Credential](docs/credential.md) · [Features](docs/features.md)

## Contributing
**Code PRs are not accepted** (developed upstream). **Issues** and **translations** are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md).

## Security
Report vulnerabilities privately — see [SECURITY.md](SECURITY.md). Do not open public issues for security.

## License
Licensed per directory:
- **Code** — everything not listed below — **AGPL-3.0-or-later** ([LICENSE](LICENSE))
- **`locales/`** (translations) — **MIT**
- **`docs/` + README** (documentation) — **CC-BY-4.0**

Component split is recorded in [NOTICE](NOTICE). Uses [yt-dlp](https://github.com/yt-dlp/yt-dlp) (Unlicense).
See [DISCLAIMER.md](DISCLAIMER.md) — you are responsible for complying with YouTube's ToS and copyright.
