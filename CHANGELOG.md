# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
