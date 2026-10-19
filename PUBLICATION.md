# Public distribution

This repository contains a fresh snapshot of version 2.1.0-beta.5. It intentionally starts a new Git history.

The development repository stays private. Do not mirror, fork, push private refs, or copy its .git directory into this repository.

For each update, export an explicit source snapshot, remove personal skills and evidence, runtime settings, access URLs, host identifiers, logs and generated packages. Run secret scanning on the exact staged contents and the public repository history before pushing.

Bundled skills are limited to browser-agent, coding-agent, office-documents, and work-agent. Store personal skills and their references outside the public tree.

The Alpine rootfs binary is excluded. Existing host deployment records are excluded; README describes the public source and does not certify a user's live deployment.

No private remote is configured in this snapshot. Keep future publication commits independent of private development history.

## Validation for this snapshot

Checked on 2026-10-19 in a clean Linux environment:

- Gitleaks 8.30.1 directory scan: no findings; official release checksum verified.
- Smoke: 40/40. Parity: 21/21. Security self-review: 19/19.
- Complete npm test:security and npm test:session commands exited successfully.
- 239 MCP tools registered. JSON/YAML and changed JavaScript syntax checked.
- Personal career files, private host addresses, access domains, hostnames and private Git history excluded.

These checks do not certify live Windows, browser sessions, Docker deployment or cross-host production E2E. The included CI workflow has not yet run on GitHub.
