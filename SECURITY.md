# Security Policy

## Reporting a vulnerability
**Do NOT open a public issue for security problems.** Report privately via **GitHub Security Advisories**:
the repo's **Security** tab → **"Report a vulnerability"** (private vulnerability reporting). We'll coordinate
a fix and disclosure with you.

Flag anything touching **credential / YouTube-cookie handling, secret storage, or auth** with extra priority —
this tool stores an owner cookie jar and a dashboard shared-secret.

## Supported versions
The latest published release (**0.x**). Fixes land in the next release.

## Scope
Self-hosted, single-user tool. Report code/image issues here. Deployment misconfigurations of your own
instance (exposed ports, weak secret, missing TLS) are your responsibility — see `docs/configuration.md`.
