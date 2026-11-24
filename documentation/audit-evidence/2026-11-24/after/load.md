# Load run

2026-11-24T15:53:16.329Z · 50 users · 5 min · http://127.0.0.1:3497

Roles: git 15, watch 9, native 11, terminal 15

## Client

| Measure | n | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| ack_ms:subscribe:project | 50 | 2.06 | 4.73 | 14.69 | 14.69 |
| ack_ms:subscribe:terminal | 15 | 0.43 | 1.18 | 1.18 | 1.18 |
| ack_ms:subscribe:thread | 50 | 4.03 | 10.66 | 11.67 | 11.67 |
| ack_ms:subscribe:user | 50 | 0.5 | 1.22 | 2.37 | 2.37 |
| ack_ms:subscribe:workspace | 50 | 1.37 | 2.76 | 4.48 | 4.48 |
| ack_ms:terminal.close | 15 | 7.92 | 12.29 | 12.29 | 12.29 |
| ack_ms:terminal.create | 15 | 15.73 | 29.07 | 29.07 | 29.07 |
| ack_ms:thread.send | 41 | 21.91 | 36.53 | 64.77 | 64.77 |
| activity_lag_ms | 41 | 0.39 | 0.99 | 1.41 | 1.41 |
| bootstrap_ms | 524 | 11.08 | 16.49 | 27.59 | 36.82 |
| document_ttfb_ms | 524 | 11.4 | 30.98 | 51.81 | 70.77 |
| git_branches_ms | 79 | 7.81 | 35.75 | 39.31 | 39.31 |
| git_log_ms | 79 | 7.76 | 37.85 | 46.78 | 46.78 |
| git_refresh_ms | 79 | 8.66 | 39.36 | 54.31 | 54.31 |
| git_status_ms | 79 | 8.17 | 38.94 | 54.28 | 54.28 |
| keystroke_echo_ms | 21945 | 1.02 | 2.75 | 8.21 | 33.38 |
| replay_frames | 50 | 1 | 1 | 1 | 1 |
| rsc_prefetch_ms | 2620 | 61.47 | 89.45 | 120.35 | 174.48 |
| turn_bytes | 40 | 195228 | 198810 | 198826 | 198826 |
| turn_delta_frames | 40 | 501 | 502 | 502 | 502 |
| turn_first_token_ms | 40 | 397.3 | 442.38 | 442.6 | 442.6 |
| turn_frames | 40 | 543 | 554 | 555 | 555 |
| turn_ms | 40 | 25432.8 | 25477.66 | 25488.47 | 25488.47 |

## Errors

None.

## Server (/metrics)

- Event-loop delay p99 per scrape: p50 11.76 ms, max 14.51 ms
- Event-loop utilisation: mean 0.13, max 0.19
- API RSS: mean 320.66 MB, max 329.73 MB; heap used max 115.86 MB
- Engine wait p50/p99: 0.5 / 0.99 ms; process p50/p99: 12.36 / 64.5 ms
- cgroup memory: max 712.71 MB; OOM kills 0
- WebSocket connections max 50; subscriptions by topic (max): user 50, workspace 50, project 50, thread 50
- Watched projects max 15

| Group | RSS mean MB | RSS max MB | CPU cores | peak processes |
| --- | --- | --- | --- | --- |
| server | 256.96 | 266.8 | 0.161 | 1 |
| web | 188.56 | 261.04 | 0.199 | 1 |
| postgres | 0 | 0 | 0 | 0 |
| mysqld | 0 | 0 | 0 | 0 |
| claude | 0 | 0 | 0 | 0 |
| codex | 0 | 0 | 0 | 0 |
| shell | 8.75 | 9.54 | 0.005 | 16 |
| git | 0 | 0 | 0 | 0 |
| rg | 0 | 0 | 0 | 0 |
| python | 0 | 0 | 0 | 0 |
| soffice | 0 | 0 | 0 | 0 |
| chromium | 0 | 0 | 0 | 0 |
| other | 0 | 0 | 0 | 0 |
| system | 41.04 | 42.64 | 0.019 | 15 |

Web requests: document 524, static 0, other 0, rsc_prefetch 5240

Bootstrap requests: ssr 3144, browser 624

