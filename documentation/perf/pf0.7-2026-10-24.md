# Load run: PF0.7 acceptance

2026-10-24T15:51:17.812Z · 50 users · 10 min · http://127.0.0.1:3397

Roles: native 11, watch 9, git 15, terminal 15

## Client

| Measure | n | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| ack_ms:subscribe:project | 1000 | 0.94 | 1.76 | 3.06 | 4.93 |
| ack_ms:subscribe:terminal | 15 | 0.27 | 4.07 | 4.07 | 4.07 |
| ack_ms:subscribe:thread | 50 | 3.03 | 6.43 | 9.29 | 9.29 |
| ack_ms:subscribe:user | 50 | 0.31 | 0.74 | 1.51 | 1.51 |
| ack_ms:subscribe:workspace | 50 | 0.87 | 1.76 | 2.46 | 2.46 |
| ack_ms:terminal.close | 15 | 5 | 7.21 | 7.21 | 7.21 |
| ack_ms:terminal.create | 15 | 4.43 | 6.35 | 6.35 | 6.35 |
| ack_ms:terminal.input | 43913 | 0.69 | 1.77 | 4.24 | 47.86 |
| ack_ms:thread.create | 40 | 8.31 | 12.82 | 12.98 | 12.98 |
| ack_ms:thread.send | 79 | 12.76 | 43.01 | 53.52 | 53.52 |
| bootstrap_ms | 1030 | 14.76 | 19.14 | 32.24 | 53.05 |
| document_ttfb_ms | 1030 | 12.27 | 28.3 | 43.7 | 55.46 |
| git_branches_ms | 157 | 20.51 | 36.31 | 56.7 | 57.81 |
| git_log_ms | 157 | 32.22 | 39.82 | 56.1 | 57.44 |
| git_refresh_ms | 157 | 33.26 | 40.73 | 58.66 | 59.27 |
| git_status_ms | 157 | 32.9 | 40.69 | 58.64 | 59.21 |
| keystroke_echo_ms | 42849 | 1.19 | 3.04 | 7.48 | 48.13 |
| rsc_prefetch_ms | 5150 | 46.16 | 82.56 | 123.95 | 176.77 |
| turn_bytes | 79 | 496577 | 523432 | 529288 | 529288 |
| turn_delta_frames | 79 | 1500 | 1500 | 1500 | 1500 |
| turn_first_token_ms | 79 | 354.29 | 386.98 | 399.51 | 399.51 |
| turn_frames | 79 | 1549 | 1577 | 1618 | 1618 |
| turn_ms | 79 | 25371.48 | 25411.78 | 25442.12 | 25442.12 |

## Errors

None.

## Server (/metrics)

- Event-loop delay p99 per scrape: p50 11.49 ms, max 14.23 ms
- Event-loop utilisation: mean 0.14, max 0.24
- API RSS: mean 186.86 MB, max 193.06 MB; heap used max 58.95 MB
- Engine wait p50/p99: 0.5 / 0.99 ms; process p50/p99: 0.5 / 0.99 ms
- cgroup memory: max 999.01 MB; OOM kills 0
- WebSocket connections max 50; subscriptions by topic (max): user 50, workspace 50, project 1000, thread 50, terminal 15
- Watched projects max 20

| Group | RSS mean MB | RSS max MB | CPU cores | peak processes |
| --- | --- | --- | --- | --- |
| server | 131.42 | 137.82 | 0.174 | 1 |
| web | 304.94 | 505.37 | 0.205 | 1 |
| postgres | 0 | 0 | 0 | 0 |
| mysqld | 0 | 0 | 0 | 0 |
| claude | 0 | 0 | 0 | 0 |
| codex | 0 | 0 | 0 | 0 |
| shell | 8.72 | 9.19 | 0.004 | 18 |
| git | 0 | 0 | 0 | 0 |
| rg | 0 | 0 | 0 | 0 |
| python | 0 | 0 | 0 | 0 |
| soffice | 0 | 0 | 0 | 0 |
| chromium | 0 | 0 | 0 | 0 |
| other | 0 | 0 | 0 | 0 |
| system | 16.38 | 17.65 | 0.016 | 13 |

Web requests: document 1030, rsc_prefetch 5150, static 0, other 0, rsc 0

Bootstrap requests: browser 1130, ssr 6180

