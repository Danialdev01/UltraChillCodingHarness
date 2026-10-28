# Load run: after-2026-10-26

2026-10-26T06:10:08.605Z · 50 users · 10 min · http://127.0.0.1:3397

Roles: git 15, watch 9, native 11, terminal 15

## Client

| Measure | n | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| ack_ms:subscribe:project | 50 | 1.48 | 2.66 | 14.68 | 14.68 |
| ack_ms:subscribe:terminal | 15 | 0.29 | 0.64 | 0.64 | 0.64 |
| ack_ms:subscribe:thread | 50 | 2.83 | 6.08 | 8.76 | 8.76 |
| ack_ms:subscribe:user | 50 | 0.38 | 0.81 | 1.01 | 1.01 |
| ack_ms:subscribe:workspace | 50 | 1.05 | 1.82 | 2.24 | 2.24 |
| ack_ms:terminal.close | 15 | 6.27 | 6.62 | 6.62 | 6.62 |
| ack_ms:terminal.create | 15 | 4.6 | 6.11 | 6.11 | 6.11 |
| ack_ms:thread.create | 50 | 8.06 | 11.57 | 13.76 | 13.76 |
| ack_ms:thread.send | 79 | 12.89 | 36.08 | 43.54 | 43.54 |
| activity_lag_ms | 79 | 0.39 | 1.36 | 1.62 | 1.62 |
| bootstrap_ms | 1033 | 8.59 | 12.6 | 17.03 | 36.06 |
| document_ttfb_ms | 1033 | 11.99 | 19.15 | 27.44 | 52.12 |
| git_branches_ms | 162 | 6.2 | 29.92 | 41.01 | 44.4 |
| git_log_ms | 162 | 5.94 | 32.01 | 40.45 | 44.49 |
| git_refresh_ms | 162 | 6.93 | 32.97 | 45 | 47.08 |
| git_status_ms | 162 | 6.67 | 32.93 | 44.95 | 47.03 |
| keystroke_echo_ms | 42863 | 0.55 | 1.9 | 4.12 | 30.28 |
| replay_frames | 50 | 1 | 1 | 1 | 1 |
| rsc_prefetch_ms | 5165 | 24.93 | 63.46 | 89.38 | 116.47 |
| turn_bytes | 77 | 178270 | 187807 | 189545 | 189545 |
| turn_delta_frames | 77 | 501 | 501 | 501 | 501 |
| turn_first_token_ms | 77 | 351.25 | 382.38 | 392.13 | 392.13 |
| turn_frames | 77 | 532 | 558 | 564 | 564 |
| turn_ms | 77 | 25365.24 | 25397.73 | 25424.58 | 25424.58 |

## Errors

None.

## Server (/metrics)

- Event-loop delay p99 per scrape: p50 11.03 ms, max 12.12 ms
- Event-loop utilisation: mean 0.11, max 0.16
- API RSS: mean 237.25 MB, max 249.85 MB; heap used max 60.27 MB
- Engine wait p50/p99: 0.5 / 0.99 ms; process p50/p99: 8.23 / 42.29 ms
- cgroup memory: max 944.36 MB; OOM kills 0
- WebSocket connections max 53; subscriptions by topic (max): user 53, workspace 53, project 52, thread 52
- Watched projects max 15

| Group | RSS mean MB | RSS max MB | CPU cores | peak processes |
| --- | --- | --- | --- | --- |
| server | 181.34 | 194.61 | 0.133 | 1 |
| web | 311.44 | 459.99 | 0.158 | 1 |
| postgres | 0 | 0 | 0 | 0 |
| mysqld | 0 | 0 | 0 | 0 |
| claude | 0 | 0 | 0 | 0 |
| codex | 0 | 0 | 0 | 0 |
| shell | 8.83 | 9.19 | 0.003 | 16 |
| git | 0 | 0 | 0 | 0 |
| rg | 0 | 0 | 0 | 0 |
| python | 0 | 0 | 0 | 0 |
| soffice | 0 | 0 | 0 | 0 |
| chromium | 0 | 0 | 0 | 0 |
| other | 0 | 0 | 0 | 0 |
| system | 17.06 | 25.28 | 0.019 | 14 |

Web requests: document 1072, static 3713, rsc 210, other 2626, rsc_prefetch 6594

Bootstrap requests: browser 1192, ssr 6352

