# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.4] - 2026-11-11

### Fixed

- OpenCode's 2026-11-11 gateway change made `PI_OCPOOL_REQUIRE_GATEWAY_ID=1`
  reject healthy probes: fast responses now return `chatcmpl-…` and plain body
  ids as well as `gw-…`. Classification now uses `server-timing` only, and the
  gateway-id check defaults to off.
- Synchronous probe budgets no longer delay turns. Both
  `PI_OCPOOL_STARTUP_BUDGET_MS` and `PI_OCPOOL_REQUEST_BUDGET_MS` default to
  `0`; `session_start` takes a fresh spare and kicks a background refresh
  instead of probing. Previously a healthy-but-misclassified gateway spent
  6 s at startup plus 4 s on the request path before the real request left pi,
  which showed up as ~11.9 s TTFT.
- A failed synchronous acquisition now enters a
  `PI_OCPOOL_PROBE_COOLDOWN_MS` (default 60 s) cooldown, so an opted-in
  non-zero budget cannot be charged on every turn.
- A zero-budget bind no longer drops a stale spare after a synthetic probe
  timeout; stale spares are left for the background refresh.

### Added

- `scripts/diagnose-routing.ts` (`npm run pool:diagnose`) probes the real
  gateway, reports same-id latency/body-id spread to detect loss of sticky
  routing, and exits non-zero when the configured classifier rejects a fast
  response.

## [0.1.3] - 2026-11-07

### Changed

- README: the install section now sits at the top of both language versions and
  points at the published npm package
  (`pi install npm:@mscststs/pi-opencode-session-pool`) and the real GitHub
  repository (`pi install git:github.com/mscststs/pi-opencode-session-pool`)
  instead of a `<you>` placeholder.

## [0.1.2] - 2026-11-07

### Fixed

- Two pi processes could take the same spare when they started at the same
  moment. `take()` now re-checks the spare inside a cross-process lock file and
  falls back to probing when another process won.
- `PoolStore.mutate()` holds `${statePath}.lock` across its read-modify-write,
  so concurrent writers merge instead of losing updates. The lock is reclaimed
  after 10 s (crashed process) and never blocks routing for more than 3 s.

## [0.1.0] - 2026-11-07

### Added

- `x-opencode-session` routing pool built on exactly three operations:
  **probe** a candidate, **take** a spare for a conversation, **refill** the
  pool in the background. Ids are never recycled.
- Per-`piSessionId::provider::model` bindings persisted to
  `~/.pi/opencode-session-pool.json`, so resumed conversations keep their routed
  id and OpenCode's prompt cache, and an id is never handed to a second
  conversation.
- Automatic retirement when `server-timing` shows a degraded upstream, an
  immediate retirement on HTTP 429, and a fresh acquisition on the next request.
- Background refresh that re-verifies stale spares and tops the pool up to
  `PI_OCPOOL_SIZE`.
- `PI_OCPOOL_REFILL_DELAY_MS` for eager refill after a take.
- Atomic, merge-on-write state storage that tolerates multiple pi processes and
  quarantines corrupt files instead of failing.
- `scripts/inspect-pool.mjs` (read-only state dump) and `scripts/live-check.ts`
  (real-gateway probe / pool seeding).
- 55 unit tests covering classification, storage, acquisition, leasing,
  quarantine, refresh, budgets, rate limiting and extension wiring.
