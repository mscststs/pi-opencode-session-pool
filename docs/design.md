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

## 3. Model: probe, take, refill

There are exactly three operations and no recycling.

```
probe:   randomUUID() -> 1-token request -> if fast: push to entries (spare)
take:    pop the best fresh spare -> binding[key] = id     (entries shrinks)
refill:  while fresh spares < PI_OCPOOL_SIZE: probe -> push to entries
```

Invariants:

1. `entries` holds only **unowned** ids (spares).
2. Every `bindings[*].routedId` is absent from `entries`.
3. An id is never handed to a second conversation. When a conversation ends its
   id is **retired**, not returned.

Why no recycling: a routed id is also a prompt-cache key. Handing a used id to a
different conversation can only miss the cache, and if an old conversation is
resumed after its id was reassigned, both would share one upstream shard — the
exact interference the extension exists to prevent. Retiring is cheap (ids are
random UUIDs); the only cost is one probe per new conversation, which is what
`refill` is for.

## 4. State file

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
      "createdAt": 1794041200000
    }
  ],
  "bindings": {
    "01a1b54b-…::opencode-go::deepseek-v4.1-flash": {
      "routedId": "7d1a90c4-…",
      "provider": "opencode-go",
      "model": "deepseek-v4.1-flash",
      "boundAt": 1794044811000,
      "lastSeenAt": 1794044811000,
      "upstreamMs": 1020,
      "verifiedAt": 1794044811000,
      "failures": 0
    }
  }
}
```

- `entries` are spares: verified, unowned, ready to be taken.
- `bindings` are the conversation → owned id map. The binding carries the id's
  measurements because the id is no longer in `entries`. The key starts with
  pi's session id, so `--continue`/resume keeps the routed id (and OpenCode's
  prompt cache) across restarts.
- No secrets and no base URLs are persisted; probe targets are re-resolved from
  the live model registry, so rotating credentials or changing a provider base
  URL never leaves stale endpoints behind.
- Writes are atomic (`write temp` + `rename`) and re-read the file before
  changing it, so multiple pi processes merge instead of clobbering each other.
  Mutations inside one process are serialized through a promise chain.
- A corrupt file is renamed to `<path>.corrupt-<epoch>` and treated as empty.
- `PI_OCPOOL_MAX_BINDINGS` caps the binding table; the oldest idle bindings are
  dropped first.

## 5. Acquisition algorithm

```
acquire(key, target, budgetMs):
  if bindings[key] exists for this provider+model and is alive:
      touch(lastSeenAt) and return its routedId        # resumed conversation

  spare = best fresh spare for provider+model           # verified within TTL
  if spare: take(spare) and return spare.id            # no probe

  spare = best stale spare
  if spare:                                            # verify before use
      result = probe(spare.id, budget)
      if result.fast: take(spare) and return spare.id
      drop spare
      if result is unauthorized/rejected/overloaded: return undefined

  deadline = now + budgetMs
  while now < deadline:
      wait until (minProbeIntervalMs and any 429 backoff) elapse
      if inside a 429 backoff that outlives the deadline: stop probing
      result = probe(randomUUID(), deadline - now)
      if result.fast: bind(id) and return id           # never enters the pool
      if result.unauthorized / rejected: stop probing
      if result.overloaded: back off for retryAfterMs
      if remaining < MIN_PROBE_BUDGET_MS (1.5 s): stop probing
  return undefined            # caller keeps pi's id
```

`take()` removes the spare from `entries` in the same mutation that writes the
binding, so a crash can never leave an id in both places.

Concurrency details:

- A per-key in-flight promise dedupes concurrent binds (session start and the
  first request can race).
- Probe spacing (`PI_OCPOOL_MIN_PROBE_INTERVAL_MS`) and 429 `retry-after`
  backoff keep probe traffic gentle.
- Budgets are enforced twice: before each probe and as the probe's own abort
  timeout, so a 40 s slow shard cannot blow the budget.
- A probe is never started with less than 1.5 s of budget left: a healthy shard
  answers in 0.8–2.0 s, so a shorter timeout would discard a good id.
- `Retry-After` is never ignored. If the gateway's backoff window outlives the
  budget, acquisition stops and pi's session id is used for that request.

## 6. Ownership and retirement

A binding stays valid while `now - lastSeenAt <= PI_OCPOOL_LEASE_TTL_MS` and
`failures < PI_OCPOOL_QUARANTINE_FAILURES`. `lastSeenAt` is refreshed by

- each `bind()` (at most one write per 30 s), and
- every real response (`observe()`), which is free because the binding is
  already loaded.

Retirement happens on three events:

| Event | Effect |
| --- | --- |
| idle longer than the lease TTL | refresh prunes the binding |
| `upstream;dur >= quarantineMs` (8 s) or HTTP 429 | binding deleted immediately |
| `quarantineFailures` (2) strikes at `degradeMs` (6 s) | binding deleted |

A retired id is gone: it is not re-added to `entries`, and a later conversation
cannot receive it.

## 7. Observation and quarantine

`after_provider_response` feeds every real response back into the binding:

- `upstream;dur < degradeMs` (default 6 s): reset `failures`, refresh
  `upstreamMs`/`verifiedAt` (persisted at most every 5 s).
- `upstream;dur >= degradeMs`: one strike.
- `upstream;dur >= quarantineMs` (default 8 s) or HTTP 429: retire immediately.
- `failures >= quarantineFailures`: retire on the next strike.

`degradeMs` is deliberately higher than the probe ceiling (`maxUpstreamMs`,
2.5 s): a real request also pays prompt prefill, so a healthy id on a long
conversation can report 3–5 s. Only a clearly pathological value earns a
strike, and only the 10–43 s failure mode is ejected outright.

The hook does not await `observe()`: `after_provider_response` runs before the
stream body is consumed, and blocking there would delay the very first token we
are trying to protect.

## 8. Background refresh

Every `PI_OCPOOL_REFRESH_INTERVAL_MS` (default 5 min), plus
`PI_OCPOOL_REFILL_DELAY_MS` (default 15 s) after a spare is taken:

1. prune expired/idle bindings (`pruneState`);
2. re-verify **stale spares only** — pruning the id when it is no longer fast,
   refreshing `verifiedAt` when it is;
3. probe new spares until each provider+model has `PI_OCPOOL_SIZE` fresh
   spares.

Ids owned by a live conversation are never re-probed: that conversation's real
traffic validates them for free. At most `2 × size` probes run per cycle.

The refresh timer is created on `session_start` and `unref()`'d so it never
keeps the process alive. It is deliberately *not* fired at startup: `bind()`
already acquires what the current conversation needs.

## 9. Failure modes

| Failure | Behaviour |
| --- | --- |
| No OpenCode credentials | `resolveTarget` returns `undefined`; header untouched |
| Non-OpenCode provider or non-`openai-completions` API | Model is ignored entirely |
| State file missing | Treated as an empty pool; probes fill it |
| State file corrupt | Renamed to `.corrupt-<epoch>`; treated as empty |
| State file unwritable | Routing continues from memory; only durability is lost |
| All probes time out | `bind()` returns `undefined`; pi's session id is used |
| 401/403/400 | Probing stops for that target to avoid hammering a rejected key |
| 429 overloaded | Honours `retry-after-ms`/`Retry-After`; never probes inside that window |
| Model registry throws | Caught in the hook; the request proceeds untouched |
| Extension reload | Manager is a `globalThis` singleton, so the pool and timers survive |
| Two pi processes | Atomic, merge-on-write state file keeps pools consistent |

## 10. Why not a local HTTP shim?

A shim in front of `opencode.ai` would work for any client, but it hides the
`server-timing` header from pi, adds a second TLS hop, and needs its own port,
supervision and auth handling. The extension hook is the smaller, more reliable
surface: it observes the real response headers and only rewrites one header.

## 11. Tuning guidance

- `PI_OCPOOL_SIZE` is the number of **spares**, not a concurrency cap: each
  conversation takes one out of the pool, and refill puts a new one back.
  With `size = 1` the next conversation is still served instantly as long as it
  starts more than `refillDelayMs` later; two conversations starting together
  both need a probe. Raise it if you open sessions in bursts.
- Raise `PI_OCPOOL_REFILL_DELAY_MS` if refill probes compete with your first
  request; lower it if you start conversations back to back.
- Lower `PI_OCPOOL_TTL_MS` only if the gateway reshuffles upstreams often;
  re-verification is cheap but not free.
- `PI_OCPOOL_STARTUP_BUDGET_MS=0` makes startup instant and defers binding to
  the first request (`PI_OCPOOL_REQUEST_BUDGET_MS`).
- `PI_OCPOOL_REQUIRE_GATEWAY_ID=0` relaxes classification to latency only, which
  is useful if OpenCode renames its response id prefixes.
- Raise `PI_OCPOOL_DEGRADE_MS` if you routinely work with very large contexts
  (where several seconds of prefill is normal); lower it if you want the pool
  to react to milder degradation.
