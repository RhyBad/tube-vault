# Install
1. Copy `.env.example` → `.env`, set `TUBEVAULT_SECRET` (long random) and paths.
2. `docker compose up -d` (pulls `ghcr.io/rhybad/tubevault`).
3. Open the dashboard, enter the shared secret.
4. (Optional) import a YouTube cookie for members-only/age-restricted content — see `credential.md`.
See `configuration.md` for all env vars/volumes. Reverse-proxy behind TLS for anything beyond localhost.
