# Disposable Paperclip QA instance (ALR-1337)

Native paperclipai 2026.1012.0 instance, isolated from the live `default` instance.
Script: `scripts/qa-instance/bwsm-qa.sh` (canonical runtime copy: `/home/paperclip/paperclip-qa/bwsm-qa.sh`).

| | QA | live (never touched) |
|---|---|---|
| URL | http://127.0.0.1:3199 | :3100 |
| Embedded Postgres | 54399 | 54329 |
| Data | /home/paperclip/paperclip-qa/bwsm-qa | ~/.paperclip/instances/default |
| Service | systemd --user `paperclip-bwsm-qa` | |

Commands: `start | stop | status | reset | teardown | cli <paperclipai args> | install-plugin <sha>`.
- `bwsm-qa.sh install-plugin 22d85b9` builds that SHA and installs it.
- `bwsm-qa.sh cli plugin list` runs paperclipai against the QA instance only (live credentials/env are stripped, HOME is sandboxed).
- `reset` wipes DB/data and restarts; `teardown` removes everything. Rollback = `teardown`; the live instance is unaffected.
- Loopback only. No live secrets: use fixture secrets; real Bitwarden tokens only if a Decision Brief approves it.
