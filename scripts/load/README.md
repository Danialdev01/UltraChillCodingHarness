# Load testing

Tools for measuring UCCH under many users without billing anyone or
touching the network. The plan behind them is `documentation/solution.md`
§1; the numbers they produce go in `documentation/perf/`.

| File | What it is |
| --- | --- |
| `mock-openrouter.mjs` | An OpenRouter stand-in: streams answers at a set rate, serves the model catalogue and the key/credits endpoints |
| `fake-claude.mjs` | A `claude` CLI stand-in: answers the harness's probes and plays a turn in stream-json at a set rate, optionally holding the real CLI's memory |
| `fixtures/claude-text.jsonl` | The stream `fake-claude.mjs` replays, copied from `packages/providers/src/fixtures` |

## Pointing a container at the mocks

The server reads two variables:

- `OPENROUTER_BASE_URL`: where native turns stream from. Defaults to `https://openrouter.ai/api/v1`.
- `CLAUDE_BIN`: the Claude Code binary. Defaults to `claude` on `PATH`.

Mount this directory into the container, start the mock inside it and point both at it. With `--network none` nothing can reach the internet, so a completed turn proves the mocks answered it:

```bash
docker run -d --name ucch-load --network none \
  -v "$PWD/scripts/load:/load:ro" \
  -e ROOT_DOMAIN=localhost -e PUBLIC_SCHEME=http \
  -e DEFAULT_USER_EMAIL=load@example.com -e DEFAULT_USER_PASSWORD=load-password-123 \
  -e AGENT_ALLOW_HOST_SHELL=true \
  -e OPENROUTER_BASE_URL=http://127.0.0.1:4010/api/v1 \
  -e CLAUDE_BIN=/load/fake-claude.mjs \
  -e FAKE_CLAUDE_LENGTH=1500 -e FAKE_CLAUDE_RATE=60 -e FAKE_CLAUDE_RSS_MB=370 \
  ucch:load

docker exec -d -u node ucch-load node /load/mock-openrouter.mjs --length 1500 --rate 60
```

Each user still needs an OpenRouter key on their account for a native turn to start. Any string will do (`PUT /api/settings/openrouter` with `{"apiKey":"sk-or-v1-mock"}`); the seed script sets one for every user it creates.

## `mock-openrouter.mjs`

```
node scripts/load/mock-openrouter.mjs [--port 4010] [--host 127.0.0.1]
     [--rate 60] [--chunk 1] [--length 1500] [--latency 300]
```

- `--rate`: tokens per second.
- `--chunk`: tokens per SSE event. Real providers send 1–5.
- `--length`: tokens per answer.
- `--latency`: ms before the first token.

A request can override the stream with the `x-mock-rate`, `x-mock-chunk` and `x-mock-length` headers. Every answer is plain text, so a native turn is one model call. `GET /stats` reports requests, completions, active streams, tokens served and aborted streams.

## `fake-claude.mjs`

Options go on its command line or in the environment, because `CLAUDE_BIN` is a path and the harness supplies the rest of the argv:

| Flag | Environment | Default | |
| --- | --- | --- | --- |
| `--rate` | `FAKE_CLAUDE_RATE` | 60 | tokens a second |
| `--chunk` | `FAKE_CLAUDE_CHUNK` | 1 | tokens per text delta |
| `--length` | `FAKE_CLAUDE_LENGTH` | 1500 | tokens in the answer |
| `--rss-mb` | `FAKE_CLAUDE_RSS_MB` | 0 | memory to allocate and hold (the real CLI holds ~370 MB) |
| `--fixture` | `FAKE_CLAUDE_FIXTURE` | `fixtures/claude-text.jsonl` | the stream to replay |

To give flags instead, wrap it:

```bash
#!/bin/sh
exec node /load/fake-claude.mjs --rss-mb 370 "$@"
```

It names its process `claude`, so the resource sampler counts it as one (`resource_processes{group="claude"}` on `/metrics`). The stop button works: SIGINT ends the answer with the aborted result the real CLI prints.
