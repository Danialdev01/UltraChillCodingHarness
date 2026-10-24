# Load run: baseline-2026-10-25

2026-10-24T16:37:43.689Z · 50 users · 10 min · http://127.0.0.1:3397

Roles: watch 9, native 11, git 15, terminal 15

## Client

| Measure | n | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| ack_ms:subscribe:project | 1000 | 1.26 | 2.96 | 4.65 | 11.05 |
| ack_ms:subscribe:terminal | 15 | 0.31 | 1.77 | 1.77 | 1.77 |
| ack_ms:subscribe:thread | 50 | 3.07 | 5.82 | 6.81 | 6.81 |
| ack_ms:subscribe:user | 50 | 0.4 | 1.24 | 1.68 | 1.68 |
| ack_ms:subscribe:workspace | 50 | 1.08 | 2.52 | 2.74 | 2.74 |
| ack_ms:terminal.close | 15 | 6.13 | 8.58 | 8.58 | 8.58 |
| ack_ms:terminal.create | 15 | 4.64 | 8.8 | 8.8 | 8.8 |
| ack_ms:terminal.input | 43927 | 0.4 | 1.52 | 4.11 | 43.04 |
| ack_ms:thread.create | 12 | 9.71 | 39.62 | 39.62 | 39.62 |
| ack_ms:thread.send | 80 | 10.94 | 38.85 | 63.19 | 63.19 |
| bootstrap_ms | 1016 | 13.66 | 23.97 | 34.27 | 50.74 |
| document_ttfb_ms | 1016 | 10.69 | 21.12 | 33.61 | 53.43 |
| git_branches_ms | 149 | 23.48 | 44.73 | 50.3 | 55.16 |
| git_log_ms | 149 | 30.85 | 48.4 | 55.95 | 62.72 |
| git_refresh_ms | 149 | 32.08 | 49.65 | 57.24 | 65.39 |
| git_status_ms | 149 | 32.04 | 49.34 | 57.2 | 65.35 |
| keystroke_echo_ms | 42863 | 0.58 | 2.66 | 7.27 | 43.98 |
| rsc_prefetch_ms | 5080 | 29.25 | 69.53 | 109.6 | 166.68 |
| turn_bytes | 79 | 506034 | 526039 | 538860 | 538860 |
| turn_delta_frames | 79 | 1500 | 1500 | 1500 | 1500 |
| turn_first_token_ms | 79 | 349.91 | 383.12 | 398.95 | 398.95 |
| turn_frames | 79 | 1573 | 1600 | 1608 | 1608 |
| turn_ms | 79 | 25363.33 | 25399.65 | 25412.85 | 25412.85 |

## Errors

None.

## Server (/metrics)

- Event-loop delay p99 per scrape: p50 11.5 ms, max 14.25 ms
- Event-loop utilisation: mean 0.16, max 0.42
- API RSS: mean 312.34 MB, max 351.88 MB; heap used max 116.71 MB
- Engine wait p50/p99: 0.5 / 0.99 ms; process p50/p99: 0.5 / 0.99 ms
- cgroup memory: max 1043.72 MB; OOM kills 0
- WebSocket connections max 55; subscriptions by topic (max): user 53, workspace 53, project 1060, thread 52
- Watched projects max 60

| Group | RSS mean MB | RSS max MB | CPU cores | peak processes |
| --- | --- | --- | --- | --- |
| server | 222.86 | 263.61 | 0.179 | 1 |
| web | 481.51 | 702.21 | 0.19 | 1 |
| postgres | 0 | 0 | 0 | 0 |
| mysqld | 0 | 0 | 0 | 0 |
| claude | 0 | 0 | 0 | 0 |
| codex | 0 | 0 | 0 | 0 |
| shell | 8.85 | 9.18 | 0.003 | 16 |
| git | 0 | 0 | 0 | 0 |
| rg | 0 | 0 | 0 | 0 |
| python | 0 | 0 | 0 | 0 |
| soffice | 0 | 0 | 0 | 0 |
| chromium | 0 | 0 | 0 | 0 |
| other | 0 | 0 | 0 | 0 |
| system | 18.14 | 26.9 | 0.023 | 14 |

Web requests: document 1058, static 4631, other 2951, rsc_prefetch 6420, rsc 4817

Bootstrap requests: ssr 7663, browser 1191

