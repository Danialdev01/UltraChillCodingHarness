# Load run

2026-11-24T15:30:53.302Z · 50 users · 5 min · http://127.0.0.1:3497

Roles: watch 9, native 11, git 15, terminal 15

## Client

| Measure | n | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| ack_ms:subscribe:project | 50 | 1.93 | 3.4 | 19.02 | 19.02 |
| ack_ms:subscribe:terminal | 15 | 0.46 | 0.95 | 0.95 | 0.95 |
| ack_ms:subscribe:thread | 50 | 4.9 | 11.01 | 20.81 | 20.81 |
| ack_ms:subscribe:user | 50 | 0.5 | 1.03 | 2.35 | 2.35 |
| ack_ms:subscribe:workspace | 50 | 1.18 | 2.48 | 2.75 | 2.75 |
| ack_ms:terminal.close | 15 | 5.86 | 12.25 | 12.25 | 12.25 |
| ack_ms:terminal.create | 15 | 10.71 | 22.96 | 22.96 | 22.96 |
| ack_ms:thread.create | 50 | 11.73 | 20.06 | 20.74 | 20.74 |
| ack_ms:thread.send | 41 | 20.25 | 51.29 | 64.94 | 64.94 |
| activity_lag_ms | 41 | 0.41 | 0.98 | 1.44 | 1.44 |
| bootstrap_ms | 517 | 10.92 | 15.84 | 23.59 | 31.78 |
| document_ttfb_ms | 517 | 11.91 | 26.72 | 49.52 | 124 |
| git_branches_ms | 80 | 8.02 | 34.47 | 41.61 | 41.61 |
| git_log_ms | 80 | 7.76 | 41.28 | 42.55 | 42.55 |
| git_refresh_ms | 80 | 8.7 | 42.64 | 43.53 | 43.53 |
| git_status_ms | 80 | 8.17 | 41.18 | 42.72 | 42.72 |
| keystroke_echo_ms | 21945 | 1.04 | 2.76 | 6.4 | 22.28 |
| replay_frames | 50 | 1 | 1 | 1 | 1 |
| rsc_prefetch_ms | 2585 | 55.03 | 86.75 | 100.65 | 115.84 |
| turn_bytes | 40 | 194433 | 198705 | 203490 | 203490 |
| turn_delta_frames | 40 | 501 | 501 | 501 | 501 |
| turn_first_token_ms | 40 | 390.61 | 446.86 | 449.95 | 449.95 |
| turn_frames | 40 | 542 | 561 | 582 | 582 |
| turn_ms | 40 | 25422.2 | 25475.47 | 25477.23 | 25477.23 |

## Errors

None.

## Server (/metrics)

- Event-loop delay p99 per scrape: p50 11.57 ms, max 13.22 ms
- Event-loop utilisation: mean 0.14, max 0.42
- API RSS: mean 323.89 MB, max 325.45 MB; heap used max 110.03 MB
- Engine wait p50/p99: 0.5 / 0.99 ms; process p50/p99: 13.54 / 79.83 ms
- cgroup memory: max 954.73 MB; OOM kills 0
- WebSocket connections max 50; subscriptions by topic (max): user 50, workspace 50, project 50, thread 50
- Watched projects max 15

| Group | RSS mean MB | RSS max MB | CPU cores | peak processes |
| --- | --- | --- | --- | --- |
| server | 260.73 | 262.23 | 0.166 | 1 |
| web | 178.01 | 264.63 | 0.194 | 1 |
| postgres | 0 | 0 | 0 | 0 |
| mysqld | 0 | 0 | 0 | 0 |
| claude | 0 | 0 | 0 | 0 |
| codex | 0 | 0 | 0 | 0 |
| shell | 8.93 | 9.56 | 0.005 | 16 |
| git | 0 | 0 | 0 | 0 |
| rg | 0 | 0 | 0 | 0 |
| python | 0 | 0 | 0 | 0 |
| soffice | 0 | 0 | 0 | 0 |
| chromium | 0 | 0 | 0 | 0 |
| other | 0 | 0 | 0 | 0 |
| system | 42.66 | 44.45 | 0.018 | 15 |

Web requests: document 517, rsc_prefetch 5170

Bootstrap requests: browser 617, ssr 3102

