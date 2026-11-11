# pi-opencode-session-pool

A pi extension that pins every OpenCode request in a conversation to a
**pre-verified `x-opencode-session` id** — and, since the 2026-11-11 gateway
change, never lets routing verification add latency to a turn.

It was built for the 2026-11-07 gateway, which hashed that header onto an
upstream shard and kept the mapping sticky: roughly half of all fresh ids landed
on an overloaded relay whose `server-timing` reported `upstream;dur` of 10-43 s
instead of ~1 s, and a slow conversation stayed slow for its whole life.

On **2026-11-11** OpenCode changed the gateway: one conversation's requests are
now load-balanced across workers, and fast responses no longer start with `gw-`.
The extension keeps working as an opportunistic pool, but probing is off the
request path by default. See [Gateway changes](#gateway-changes-2026-11-11).

## Install

```bash
# from npm
pi install npm:@mscststs/pi-opencode-session-pool

# or from git
pi install git:github.com/mscststs/pi-opencode-session-pool

# try it for one run without adding it to settings
pi -e npm:@mscststs/pi-opencode-session-pool
```

- npm: <https://www.npmjs.com/package/@mscststs/pi-opencode-session-pool>
- source: <https://github.com/mscststs/pi-opencode-session-pool>

From a source checkout, `pi install ~/repo/pi-opencode-session-pool` loads it in
place instead (no copy). `pi list` shows the package; `/reload` picks up changes
without restarting.

This extension verifies ids before they are used, keeps the fast ones in a
durable pool, and rewrites the header right before the request leaves the
process.

```
2026-11-07: new pi session -> random uuid     -> ~50% chance of a slow shard
           extension       -> a verified spare -> ~1s first token
2026-11-11: gateway load-balances every request; the extension keeps all
            verification in the background, so a failed lookup costs 0 ms
            instead of the 4-6 s synchronous probe budget it used to.
```

## Measured evidence

### 2026-11-07: sticky shards

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
`upstream`. Back then a fast id also returned a body `id` starting with `gw-`
and a slow id returned `chatcmpl-…`; that prefix heuristic is now retired.

### Gateway changes (2026-11-11)

Re-measured on 2026-11-11 against the same URL and model:

| check | observation |
| --- | --- |
| same id, 5 probes | `1 435`–`5 138 ms`; body ids changed on every request (`chatcmpl-…`) |
| same id, another 4 probes | `3 574`–`6 309 ms`; four different `gw-<worker>-…` ids |
| fresh ids | `388 ms`–`7 098 ms`; fast hits returned `chatcmpl-…` **and** plain hex ids |
| nine probes with the legacy classifier | all nine healthy `448`–`1 585 ms` responses rejected as `gateway-id-mismatch` |
| one `pi -p` run with the old defaults | **6 s** startup probe budget + **4 s** request probe budget before the real request (10.36 s total) |

That last row is the 11.9 s TTFT: the gateway was healthy, the extension kept
rejecting fast candidates by body-id prefix, and then re-probed on the request
path until the budget ran out. The pool could not know it had succeeded because
the classifier was looking at the wrong signal.

The fix: classify by `server-timing` only, and make both synchronous probe
budgets `0` by default. A background refresh still fills the pool. An id is now
evidence of latency *at probe time*, not a guarantee of a sticky shard.

Run the diagnostic against the live gateway:

```bash
npm run pool:diagnose
PI_OCPOOL_REQUIRE_GATEWAY_ID=1 npm run pool:diagnose   # reproduce the old false rejections
```

It exits non-zero if a response that was actually fast is rejected by the
configured classifier.

## How it works

| Phase | Hook | What happens |
| --- | --- | --- |
| Start | `session_start` | Take a fresh spare if one exists, then kick a background refresh. Zero probes by default. |
| Request | `before_provider_headers` | Override `x-opencode-session` from the binding or a fresh spare; never probe synchronously by default. |
| Response | `after_provider_response` | Read `server-timing`; refresh the binding, retire the id when it turns slow. |
| Background | timers + `session_start` | Refill spares after a take (`PI_OCPOOL_REFILL_DELAY_MS`) and every `PI_OCPOOL_REFRESH_INTERVAL_MS`; re-verify stale spares. Never blocks a turn. |
| Shutdown | `session_shutdown` | Stop the timer on `quit` (reloads keep the warm process-level pool). |

The pool has exactly three operations — **probe**, **take**, **refill** — and no
recycling:

| Operation | When | Effect |
| --- | --- | --- |
| probe | pool is empty, or a spare is stale | 1-token request; if fast, the id becomes a spare |
| take | a conversation starts | the spare leaves the pool and belongs to that conversation for good |
| refill | after a take, and every `PI_OCPOOL_REFRESH_INTERVAL_MS` | grows the spare set back to `PI_OCPOOL_SIZE` |

Acquisition, in order:

1. **Resumed conversation** — `piSessionId :: provider :: model` already owns an
   id. Zero probes, and the prompt cache stays warm.
2. **Take a fresh spare** — an id verified within `PI_OCPOOL_TTL_MS`. Zero
   probes. It is removed from the pool.
3. **Verify a stale spare** — only when a synchronous probe budget is available
   (opt-in): that exact id is probed before use; if it is still fast it is taken,
   if not it is discarded. A zero budget leaves stale spares for the background
   refresh instead of dropping them.
4. **Probe** — only when a synchronous probe budget is available (opt-in):
   sequentially generate ids and send one 1-token request each until one is fast.
5. **Give up** — no fast id within the budget: the header is left untouched and
   the turn pays no latency. A 60 s cooldown stops a failed synchronous
   acquisition from being retried on every turn.

An id is **never handed to a second conversation**. When a conversation is gone
(idle for `PI_OCPOOL_LEASE_TTL_MS`, or its routed upstream degraded), the id is
retired; the only way back into the pool is a fresh probe. That keeps the
invariant "one conversation, one routed id" — two sessions can never share an
upstream shard or a prompt-cache slot.

Everything degrades safely: missing credentials, a corrupt state file, a
network error, a rate limit or a 20 s stall all fall back to pi's own id and
never throw into the request path. Since the default probe budgets are `0`, a
gateway that is slow or unreachable costs nothing on the request path. If the
pool file cannot be written, routing still works from memory.

## Configuration

All settings are environment variables (same convention as the sibling
`pi-provider-gzip` extension).

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_OCPOOL` | `1` | Master switch. `0` disables the extension entirely. |
| `PI_OCPOOL_SIZE` | `3` | Verified-fast **spare** ids kept per provider+model (`1`-`16`). |
| `PI_OCPOOL_TTL_MS` | `1800000` | Re-verify spare ids older than this. |
| `PI_OCPOOL_MAX_UPSTREAM_MS` | `2500` | Probe ceiling that still counts as "fast". |
| `PI_OCPOOL_PROBE_TIMEOUT_MS` | `10000` | Abort one probe after this; slow ids take much longer. |
| `PI_OCPOOL_STARTUP_BUDGET_MS` | `0` | Max time `session_start` may spend probing. `0` = never block. |
| `PI_OCPOOL_REQUEST_BUDGET_MS` | `0` | Max time a request may spend probing. `0` = never block. |
| `PI_OCPOOL_PROBE_COOLDOWN_MS` | `60000` | Retry delay after a failed synchronous acquisition. |
| `PI_OCPOOL_REFRESH_INTERVAL_MS` | `300000` | Background refresh cadence. `0` disables the timer. |
| `PI_OCPOOL_REFILL_DELAY_MS` | `15000` | Delay before refilling after a spare is taken; `0` disables eager refill. |
| `PI_OCPOOL_MIN_PROBE_INTERVAL_MS` | `750` | Minimum spacing between probes. |
| `PI_OCPOOL_LEASE_TTL_MS` | `28800000` | Idle time after which a conversation's id is retired (never returns to the pool). |
| `PI_OCPOOL_QUARANTINE_FAILURES` | `2` | Degraded real requests before an id is retired. |
| `PI_OCPOOL_DEGRADE_MS` | `6000` | Real-request upstream latency that counts as one strike. |
| `PI_OCPOOL_QUARANTINE_MS` | `8000` | One-shot latency that retires the id immediately. |
| `PI_OCPOOL_MAX_BINDINGS` | `256` | Cap on persisted bindings. |
| `PI_OCPOOL_REQUIRE_GATEWAY_ID` | `0` | Legacy: require the response `id` to start with `gw-`. |
| `PI_OCPOOL_STATE_PATH` | `~/.pi/opencode-session-pool.json` | State file location. |
| `PI_OCPOOL_DEBUG` | `0` | Verbose stderr logging of take/probe/refill/retire decisions. |

Example:

```bash
PI_OCPOOL_DEBUG=1 PI_OCPOOL_SIZE=4 pi -e ~/repo/pi-opencode-session-pool
```

## Inspecting and seeding

These live in the package's `scripts/` directory (run them from a source
checkout after `npm install`):

```bash
npm run pool:inspect          # spares + owned ids, read-only
npm run pool:live             # probe 2 real candidates and print timings
npm run pool:live -- --seed   # probe and add the fast ids as spares
npm run pool:diagnose         # check routing stickiness + classifier false rejects
```

The state file holds two disjoint sets: `entries` (verified spares waiting to be
taken) and `bindings` (one owned id per conversation). An id moves from the
first to the second exactly once, and is retired when the conversation ends.

`pool:live` uses `OPENCODE_API_KEY` or the `opencode` entry in
`~/.pi/agent/auth.json`.

## Scope and limitations

- Only models on the `openai-completions` transport are routed. OpenCode's
  `anthropic-messages` / `google-generative-ai` models are untouched, because
  only the OpenAI-completions transport exposes request headers and
  `server-timing` to extensions.
- A fast classic-model route can still be slow for a different model: entries
  are scoped per provider+model.
- Since 2026-11-11 the gateway load-balances each request instead of keeping a
  conversation on one shard. No id can guarantee a fast route, so the pool is
  opportunistic: it reuses an id that was fast when probed, and otherwise stays
  out of the way. The value is now "don't add latency", not "pin a fast shard".
- The pool cannot make a healthy route faster; it only avoids the broken one.
  If every upstream is slow, probes fail and pi's own id is used.
- Probes are real (1-token) requests: roughly one per new conversation (to
  replace the spare it took), plus at most `2 × PI_OCPOOL_SIZE` per refresh
  cycle (about six per hour per model at the defaults, and none while every
  spare is fresh). OpenCode
  monitors traffic for abuse, so avoid aggressive best-of-N probing: raise
  `PI_OCPOOL_SIZE` or lower `PI_OCPOOL_TTL_MS` only if you understand the extra
  traffic.

## Development

```bash
npm install
npm run check         # typecheck + unit tests
npm run pool:live     # optional: real gateway smoke test
npm run pool:diagnose # optional: real gateway routing/stickiness diagnosis
```

See [`docs/design.md`](docs/design.md) for the state file schema, algorithms
and failure modes, and [`CHANGELOG.md`](CHANGELOG.md) for the history.

## License

MIT
