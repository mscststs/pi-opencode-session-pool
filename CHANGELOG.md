# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-07

### Added

- `x-opencode-session` routing pool: verifies candidate session ids with
  1-token probes and pins each conversation to a fast upstream.
- Sticky, per-`piSessionId::provider::model` bindings persisted to
  `~/.pi/opencode-session-pool.json`, so resumed conversations keep their routed
  id and OpenCode's prompt cache.
- Leasing so concurrent conversations never share one upstream shard.
- Automatic quarantine when `server-timing` shows a degraded upstream, an
  immediate eviction on HTTP 429, and rebinding on the next request.
- Background refresh that re-verifies stale ids and tops the pool up to
  `PI_OCPOOL_SIZE`.
- Atomic, merge-on-write state storage that tolerates multiple pi processes and
  quarantines corrupt files instead of failing.
- `scripts/inspect-pool.mjs` (read-only state dump) and `scripts/live-check.ts`
  (real-gateway probe / pool seeding).
- 55 unit tests covering classification, storage, acquisition, leasing,
  quarantine, refresh, budgets, rate limiting and extension wiring.
