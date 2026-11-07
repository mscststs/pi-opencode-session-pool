# Design

This document describes why the extension exists, how it decides, and how it
degrades. The README covers usage; this covers the internals.

## 1. The problem, precisely

OpenCode's inference gateway (`opencode.ai/inference/...`) accepts an
`x-opencode-session` header. Their docs ask every agent client to send a stable
id per conversation so the gateway can "optimize routing and prompt caching".
In practice the gateway hashes that id onto one of a small number of upstream
shards:

- **gateway-native workers** — answer in ~0.8–2.0 s, response `id` starts with
  `gw-<worker>-<seq>`.
- **an overloaded relay** — answers in 10–43 s, response `id` starts with
  `chatcmpl-…`, and under load returns `429` with
  `{"message":"Upstream request failed: [overloaded] the server is overloaded; retry shortly"}`.

The mapping is sticky and deterministic. The extension was built after measuring
8 fresh ids × 3 requests each: within a session the spread was tiny, across
sessions the ratio was ~20×, and the same ids were still in the same bucket
12 minutes later. See the table in the README.

Because pi generates a random session id per conversation, every new
conversation has roughly a 50% chance of landing on the slow shard. The fix is
not a network tweak — a direct connection (bypassing the proxy entirely) showed
the same 22–23 s stalls — but choosing the routing key.

## 2. The two observable signals

Every gateway response carries:

```
server-timing: gateway;dur=10, upstream;dur=1447, total;dur=1498
Cf-Placement: remote-IAD          # constant in our measurements
x-opencode-log-id: 01a1b567-…
x-zen-model: deepseek-v4.1-flash
```

- `gateway;dur` is the gateway's own processing time (8–142 ms observed).
- `upstream;dur` is the model backend time, and it is the whole story.
- The body `id` prefix distinguishes `gw-*` (fast worker) from `chatcmpl-*`
  (overloaded relay).

A probe classifies on `upstream;dur <= PI_OCPOOL_MAX_UPSTREAM_MS` and, by
default, also requires `id` to start with `gw-`. If a proxy strips
`server-timing`, wall-clock time is used instead.

Probe requests are ordinary 1-token completions (`max_tokens: 1`, prompt `OK`).
They measure the same first-token latency the real request will see and they
also warm the routed path.

## 3. State file

`$PI_OCPOOL_STATE_PATH` (default `~/.pi/opencode-session-pool.json`):

```json
{
  "version": 1,
  "entries": [
    {
      "id": "3f0c6b1e-…",
      "provider": "opencode-go",
      "model": "deepseek-v4.1-flash",
      "upstreamMs": 941,
      "verifiedAt": 1794044810123,
      "createdAt": 1794041200000,
      "failures": 0
    }
  ],
  "bindings": {
    "01a1b54b-…::opencode-go::deepseek-v4.1-flash": {
      "routedId": "3f0c6b1e-…",
      "provider": "opencode-go",
      "model": "deepseek-v4.1-flash",
      "boundAt": 1794044811000,
      "lastSeenAt": 1794044811000
    }
  }
}
```

- No secrets and no base URLs are persisted; probe targets are re-resolved from
  the live model registry, so rotating credentials or changing a provider base
  URL never leaves stale endpoints behind.
- `entries` are verified ids, scoped per provider+model.
- `bindings` are the sticky conversation → id map. The key starts with pi's
  session id, so `--continue`/resume keeps the routed id (and OpenCode's prompt
  cache) across restarts.
- Writes are atomic (`write temp` + `rename`) and re-read the file before
  changing it, so multiple pi processes merge instead of clobbering each other.
  Mutations inside one process are serialized through a promise chain.
- A corrupt file is renamed to `<path>.corrupt-<epoch>` and treated as empty.

## 4. Acquisition algorithm

```
acquire(key, target, budgetMs):
  state = load()
  if binding[key] exists for this provider+model:
      if entry is usable (age <= leaseTtl, failures < threshold):
          touch(lastSeenAt) and return binding.routedId
      else: delete binding + drop entry and continue

  entry = freshest unleased entry for provider+model  (age <= ttl)
  if entry: bind(key, entry); return entry.id

  deadline = now + budgetMs
  while now < deadline:
      wait until (minProbeIntervalMs and any 429 backoff) elapse
      id = randomUUID()
      result = probe(id, target, deadline - now)
      if result.fast: add entry, bind(key, id); return id
      if result.unauthorized / rejected: stop probing
      if result.overloaded: back off for retryAfterMs
  return undefined            # caller keeps pi's id
```

Concurrency details:

- A per-key in-flight promise dedupes concurrent binds (session start and the
  first request can race).
- Probe spacing (`PI_OCPOOL_MIN_PROBE_INTERVAL_MS`) and 429 `retry-after`
  backoff keep probe traffic gentle. `waitForProbeSlot` never sleeps past the
  caller's deadline.
- Budgets are enforced twice: before each probe and as the probe's own abort
  timeout, so a 40 s slow shard cannot blow the budget.

## 5. Leasing

Two live conversations sharing one routed id would share one upstream shard and
thrash the prompt cache. An entry is "leased" while a binding for a *different*
conversation references it and was touched within `PI_OCPOOL_LEASE_TTL_MS`.

- `pickPooled` skips leased ids; with `PI_OCPOOL_SIZE=3` three conversations can
  run concurrently without probing.
- When all pooled ids are leased, the next conversation probes a new candidate
  instead of stealing one.
- A crashed pi process releases its ids after the lease TTL, so a hard kill does
  not permanently shrink the pool.
- `lastSeenAt` is refreshed on every `bind()` but persisted at most every 30 s
  to avoid a write per request.

## 6. Observation and quarantine

`after_provider_response` feeds every real response back:

- `upstream;dur < degradeMs` (default 6 s): reset `failures`, refresh
  `upstreamMs`/`verifiedAt` (persisted at most every 5 s).
- `upstream;dur >= degradeMs`: one strike.
- `upstream;dur >= quarantineMs` (default 8 s) or HTTP 429: immediate eviction.
- `failures >= quarantineFailures`: eviction on the next strike.

`degradeMs` is deliberately higher than the probe ceiling (`maxUpstreamMs`,
2.5 s): a real request also pays prompt prefill, so a healthy id on a long
conversation can report 3-5 s. Only a clearly pathological value earns a
strike, and only the 10-43 s failure mode is ejected outright.

Eviction drops the entry and every binding that referenced it. The next request
in that conversation is unbound, so `before_provider_headers` binds again — from
the pool if another fast id exists, otherwise by probing. The hook does not
await `observe()`: `after_provider_response` runs before the stream body is
consumed, and blocking there would delay the very first token we are trying to
protect.

## 7. Background refresh

`PI_OCPOOL_REFRESH_INTERVAL_MS` (default 5 min) re-verifies stale entries
(`age > ttl`, keeping the same id when it is still fast — cheaper and better for
prompt cache) and tops each model's pool up to `PI_OCPOOL_SIZE`. At most
`2 × size` probes run per cycle.

The timer is created on `session_start` and `unref()`'d so it never keeps the
process alive. It is deliberately *not* fired at startup: `bind()` already fills
the slot the current conversation needs, and a burst of probes would compete
with the first request for the rate limit.

## 8. Failure modes

| Failure | Behaviour |
| --- | --- |
| No OpenCode credentials | `resolveTarget` returns `undefined`; header untouched |
| Non-OpenCode provider or non-`openai-completions` API | Model is ignored entirely |
| State file missing | Treated as an empty pool; probes fill it |
| State file corrupt | Renamed to `.corrupt-<epoch>`; treated as empty |
| State file unwritable | Routing continues from memory; only durability is lost |
| All probes time out | `bind()` returns `undefined`; pi's session id is used |
| 401/403/400 | Probing stops for that target to avoid hammering a rejected key |
| 429 | Honours `retry-after-ms`/`Retry-After`, then retries inside the budget |
| Model registry throws | Caught in the hook; the request proceeds untouched |
| Extension reload | Manager is a `globalThis` singleton, so the pool and timer survive |
| Two pi processes | Atomic, merge-on-write state file keeps pools consistent |

## 9. Why not a local HTTP shim?

A shim in front of `opencode.ai` would work for any client, but it hides the
`server-timing` header from pi, adds a second TLS hop, and needs its own port,
supervision and auth handling. The extension hook is the smaller, more reliable
surface: it observes the real response headers and only rewrites one header.

## 10. Tuning guidance

- Raise `PI_OCPOOL_SIZE` if you routinely run more than two concurrent pi
  sessions against OpenCode; each additional slot costs at most one probe per
  refresh cycle.
- Lower `PI_OCPOOL_TTL_MS` only if the gateway reshuffles upstreams often;
  re-verification is cheap but not free.
- `PI_OCPOOL_STARTUP_BUDGET_MS=0` makes startup instant and defers binding to
  the first request (`PI_OCPOOL_REQUEST_BUDGET_MS`).
- `PI_OCPOOL_REQUIRE_GATEWAY_ID=0` relaxes classification to latency only, which
  is useful if OpenCode renames its response id prefixes.
- Raise `PI_OCPOOL_DEGRADE_MS` if you routinely work with very large contexts
  (where several seconds of prefill is normal); lower it if you want the pool
  to react to milder degradation.
