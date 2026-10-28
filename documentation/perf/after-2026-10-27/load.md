# Load run: after-2026-10-27

2026-10-27T14:50:01.487Z · 50 users · 10 min · http://127.0.0.1:3397

Roles: watch 9, git 15, native 11, terminal 15

## Client

| Measure | n | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| ack_ms:subscribe:project | 50 | 1.62 | 2.48 | 2.65 | 2.65 |
| ack_ms:subscribe:terminal | 15 | 0.3 | 0.71 | 0.71 | 0.71 |
| ack_ms:subscribe:thread | 50 | 2.89 | 5.05 | 7.33 | 7.33 |
| ack_ms:subscribe:user | 50 | 0.48 | 0.82 | 1.09 | 1.09 |
| ack_ms:subscribe:workspace | 50 | 1.15 | 1.65 | 1.89 | 1.89 |
| ack_ms:terminal.close | 15 | 2.55 | 4.36 | 4.36 | 4.36 |
| ack_ms:terminal.create | 15 | 3.78 | 7 | 7 | 7 |
| ack_ms:thread.create | 50 | 8.95 | 10.46 | 11.19 | 11.19 |
| ack_ms:thread.send | 81 | 10.03 | 19.09 | 37.05 | 37.05 |
| activity_lag_ms | 81 | 0.31 | 1.01 | 5.14 | 5.14 |
| bootstrap_ms | 1021 | 7.8 | 12.68 | 18.57 | 39.82 |
| document_ttfb_ms | 1021 | 11.71 | 19.49 | 30.22 | 51.7 |
| git_branches_ms | 156 | 5.36 | 27.3 | 34.75 | 41.51 |
| git_log_ms | 156 | 5.27 | 30.4 | 41.51 | 42.85 |
| git_refresh_ms | 156 | 6.14 | 31.4 | 42.31 | 43.63 |
| git_status_ms | 156 | 5.67 | 31.19 | 42.28 | 43.59 |
| keystroke_echo_ms | 42863 | 0.5 | 1.66 | 4.06 | 17.92 |
| replay_frames | 50 | 1 | 1 | 1 | 1 |
| rsc_prefetch_ms | 5105 | 26.41 | 68.99 | 90.79 | 154.15 |
| turn_bytes | 78 | 178266 | 187857 | 191288 | 191288 |
| turn_delta_frames | 78 | 501 | 501 | 501 | 501 |
| turn_first_token_ms | 78 | 349.6 | 380.48 | 413.2 | 413.2 |
| turn_frames | 78 | 532 | 558 | 566 | 566 |
| turn_ms | 78 | 25362.44 | 25420.19 | 25464.44 | 25464.44 |

## Errors

None.

## Server (/metrics)

- Event-loop delay p99 per scrape: p50 11.04 ms, max 12.93 ms
- Event-loop utilisation: mean 0.11, max 0.16
- API RSS: mean 256.73 MB, max 268.26 MB; heap used max 60.28 MB
- Engine wait p50/p99: 0.5 / 0.99 ms; process p50/p99: 7.24 / 26.62 ms
- cgroup memory: max 864.3 MB; OOM kills 0
- WebSocket connections max 53; subscriptions by topic (max): user 53, workspace 53, project 52, thread 52
- Watched projects max 15

| Group | RSS mean MB | RSS max MB | CPU cores | peak processes |
| --- | --- | --- | --- | --- |
| server | 184.7 | 198.54 | 0.133 | 1 |
| web | 315.86 | 518.09 | 0.159 | 1 |
| postgres | 0 | 0 | 0 | 0 |
| mysqld | 0 | 0 | 0 | 0 |
| claude | 0 | 0 | 0 | 0 |
| codex | 0 | 0 | 0 | 0 |
| shell | 8.86 | 9.2 | 0.003 | 17 |
| git | 0 | 0 | 0 | 0 |
| rg | 0 | 0 | 0 | 0 |
| python | 0 | 0 | 0 | 0 |
| soffice | 0 | 0 | 0 | 0 |
| chromium | 0 | 0 | 0 | 0 |
| other | 0 | 0 | 0 | 0 |
| system | 47.42 | 50.73 | 0.019 | 16 |

Web requests: document 1060, static 4113, rsc 210, other 2624, rsc_prefetch 6534

Bootstrap requests: browser 1183, ssr 6280

