# pi-opencode-session-pool

A pi extension that pins every OpenCode request in a conversation to a
**pre-verified fast-routing `x-opencode-session` id**.

OpenCode's gateway hashes that header onto an upstream shard and keeps the
mapping sticky. Roughly half of all freshly generated ids land on an overloaded
relay whose `server-timing` reports `upstream;dur` of 10-43 s instead of ~1 s —
and a slow conversation stays slow for its whole life. pi generates a fresh
random id per conversation, so every new session is a coin flip.

This extension verifies ids before they are used, keeps the fast ones in a
durable pool, and rewrites the header right before the request leaves the
process.

```
before:   new pi session -> random uuid -> 50% chance of a 30s first token
after:    new pi session -> pooled fast id -> ~1s first token
```

## Measured evidence

Taken on 2026-11-07 against `https://opencode.ai/inference/go/openai/v1` with
`deepseek-v4.1-flash`, over the same network path (a proven-clean proxy), using
the same request:

| session id | request 1 | request 2 | request 3 | response `id` |
| --- | ---: | ---: | ---: | --- |
| `stk-75a69…` | 1 874 ms | 2 136 ms | 1 728 ms | `gw-…` |
| `stk-c03ad…` | 1 616 ms | 1 967 ms | 3 034 ms | `gw-…` |
| `stk-bd381…` | 2 320 ms | 1 554 ms | 1 718 ms | `gw-…` |
| `stk-80b39…` | **41 640 ms** | **40 570 ms** | **32 247 ms** | `chatcmpl-…` |
| `stk-f9a5e…` | **43 287 ms** | **40 952 ms** | **33 514 ms** | `chatcmpl-…` |
| `stk-2f3bf…` | **34 427 ms** | **38 305 ms** | **25 536 ms** | `chatcmpl-…` |

Re-checked 12 minutes later, the same ids were still in the same bucket, so the
mapping is deterministic and long-lived. The decisive signal is the response
header, not the network:

```
server-timing: gateway;dur=10, upstream;dur=1447, total;dur=1498
```

`gateway;dur` never exceeded 50 ms in normal operation: the latency is entirely
`upstream`. A fast id also returns a body `id` starting with `gw-`; a slow id
returns `chatcmpl-…`. Both signals are used to classify a probe.

## How it works

| Phase | Hook | What happens |
| --- | --- | --- |
| Start | `session_start` | Bind the conversation to a pooled id (bounded by `PI_OCPOOL_STARTUP_BUDGET_MS`). |
| Request | `before_provider_headers` | Override `x-opencode-session`; lazily bind if the model changed mid-conversation. |
| Response | `after_provider_response` | Read `server-timing`; refresh stats, quarantine ids that turn slow. |
| Background | interval timer | Re-verify stale ids and top the pool up to `PI_OCPOOL_SIZE`. |
| Shutdown | `session_shutdown` | Stop the timer on `quit` (reloads keep the warm process-level pool). |

Acquisition, in order:

1. **Sticky binding** — `piSessionId :: provider :: model` already maps to a
   usable id. Zero probes; a resumed conversation also keeps its prompt cache.
2. **Pooled id** — a fresh, unleased entry for the same provider+model. Zero
   probes; the id is leased to this conversation so two live sessions never
   share one routed shard.
3. **Probe** — sequentially generate ids and send one 1-token request each until
   one is fast, within the caller's time budget. Roughly 50% of candidates are
   fast, so this usually costs 1-2 requests and ~1-3 s, once per conversation.
4. **Give up** — no fast id within the budget: the header is left untouched and
   behaviour is exactly as before the extension existed.

Everything degrades safely: missing credentials, a corrupt state file, a
network error, a rate limit or a 20 s stall all fall back to pi's own id and
never throw into the request path. If the pool file cannot be written, routing
still works from memory.

## Install

```bash
# local checkout (loaded in place, no copy)
pi install ./repo/pi-opencode-session-pool

# or from git / npm once published
pi install git:github.com/<you>/pi-opencode-session-pool@v0.1.0
```

`pi list` shows it; `/reload` picks up changes without restarting.

## Configuration

All settings are environment variables (same convention as the sibling
`pi-provider-gzip` extension).

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_OCPOOL` | `1` | Master switch. `0` disables the extension entirely. |
| `PI_OCPOOL_SIZE` | `3` | Verified-fast ids kept per provider+model (`1`-`16`). |
| `PI_OCPOOL_TTL_MS` | `1800000` | Re-verify pooled ids older than this. |
| `PI_OCPOOL_MAX_UPSTREAM_MS` | `2500` | Probe ceiling that still counts as "fast". |
| `PI_OCPOOL_PROBE_TIMEOUT_MS` | `10000` | Abort one probe after this; slow ids take much longer. |
| `PI_OCPOOL_STARTUP_BUDGET_MS` | `6000` | Max time `session_start` may spend binding. `0` = never block. |
| `PI_OCPOOL_REQUEST_BUDGET_MS` | `4000` | Max time the first request may spend binding. |
| `PI_OCPOOL_REFRESH_INTERVAL_MS` | `300000` | Background refresh cadence. `0` disables the timer. |
| `PI_OCPOOL_MIN_PROBE_INTERVAL_MS` | `750` | Minimum spacing between probes. |
| `PI_OCPOOL_LEASE_TTL_MS` | `28800000` | Idle time after which a binding releases its id. |
| `PI_OCPOOL_QUARANTINE_FAILURES` | `2` | Degraded real requests before an id is evicted. |
| `PI_OCPOOL_DEGRADE_MS` | `6000` | Real-request upstream latency that counts as one strike. |
| `PI_OCPOOL_QUARANTINE_MS` | `8000` | One-shot latency that evicts immediately. |
| `PI_OCPOOL_MAX_BINDINGS` | `256` | Cap on persisted bindings. |
| `PI_OCPOOL_REQUIRE_GATEWAY_ID` | `1` | Require the response `id` to start with `gw-`. |
| `PI_OCPOOL_STATE_PATH` | `~/.pi/opencode-session-pool.json` | State file location. |
| `PI_OCPOOL_DEBUG` | `0` | Verbose stderr logging of bind/probe/evict decisions. |

Example:

```bash
PI_OCPOOL_DEBUG=1 PI_OCPOOL_SIZE=4 pi -e ./repo/pi-opencode-session-pool
```

## Inspecting and seeding

These live in the package's `scripts/` directory (run them from a source
checkout after `npm install`):

```bash
npm run pool:inspect          # pretty-print the state file (read-only)
npm run pool:live             # probe 2 real candidates and print timings
npm run pool:live -- --seed   # probe and append the fast ids to the pool
```

`pool:live` uses `OPENCODE_API_KEY` or the `opencode` entry in
`~/.pi/agent/auth.json`.

## Scope and limitations

- Only models on the `openai-completions` transport are routed. OpenCode's
  `anthropic-messages` / `google-generative-ai` models are untouched, because
  only the OpenAI-completions transport exposes request headers and
  `server-timing` to extensions.
- A fast classic-model route can still be slow for a different model: entries
  are scoped per provider+model.
- The pool cannot make a healthy route faster; it only avoids the broken one.
  If every upstream shard is slow, probes fail and pi's own id is used.
- Probes are real (1-token) requests. The defaults keep them well under 10 per
  hour per model; raise `PI_OCPOOL_SIZE` or lower `PI_OCPOOL_TTL_MS` only if you
  understand the extra traffic. OpenCode monitors traffic for abuse, so avoid
  aggressive best-of-N probing.

## Development

```bash
npm install
npm run check        # typecheck + 56 unit tests
npm run pool:live    # optional: real gateway smoke test
```

See [`docs/design.md`](docs/design.md) for the state file schema, algorithms
and failure modes, and [`CHANGELOG.md`](CHANGELOG.md) for the history.

## License

MIT
