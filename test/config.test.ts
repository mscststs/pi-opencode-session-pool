import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_DEGRADE_MS,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_MAX_UPSTREAM_MS,
  DEFAULT_MIN_PROBE_INTERVAL_MS,
  DEFAULT_POOL_SIZE,
  DEFAULT_PROBE_COOLDOWN_MS,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_QUARANTINE_FAILURES,
  DEFAULT_REFILL_DELAY_MS,
  DEFAULT_REQUIRE_GATEWAY_ID,
  DEFAULT_REFRESH_INTERVAL_MS,
  DEFAULT_REQUEST_BUDGET_MS,
  DEFAULT_STARTUP_BUDGET_MS,
  DEFAULT_TTL_MS,
  readConfig,
} from "../lib/config.ts";

test("defaults: enabled, three ids, short probe timeout", () => {
  const config = readConfig({}, "/home/tester");
  assert.equal(config.enabled, true);
  assert.equal(config.size, DEFAULT_POOL_SIZE);
  assert.equal(config.ttlMs, DEFAULT_TTL_MS);
  assert.equal(config.maxUpstreamMs, DEFAULT_MAX_UPSTREAM_MS);
  assert.equal(config.probeTimeoutMs, DEFAULT_PROBE_TIMEOUT_MS);
  assert.equal(config.startupBudgetMs, DEFAULT_STARTUP_BUDGET_MS);
  assert.equal(config.requestBudgetMs, DEFAULT_REQUEST_BUDGET_MS);
  assert.equal(config.probeCooldownMs, DEFAULT_PROBE_COOLDOWN_MS);
  assert.equal(config.refreshIntervalMs, DEFAULT_REFRESH_INTERVAL_MS);
  assert.equal(config.minProbeIntervalMs, DEFAULT_MIN_PROBE_INTERVAL_MS);
  assert.equal(config.leaseTtlMs, DEFAULT_LEASE_TTL_MS);
  assert.equal(config.quarantineFailures, DEFAULT_QUARANTINE_FAILURES);
  assert.equal(config.degradeMs, DEFAULT_DEGRADE_MS);
  assert.equal(config.refillDelayMs, DEFAULT_REFILL_DELAY_MS);
  assert.equal(config.requireGatewayId, DEFAULT_REQUIRE_GATEWAY_ID);
  assert.equal(config.debug, false);
  assert.equal(config.statePath, "/home/tester/.pi/opencode-session-pool.json");
});

test("PI_OCPOOL=0 is the single master switch", () => {
  assert.equal(readConfig({ PI_OCPOOL: "0" }).enabled, false);
  assert.equal(readConfig({ PI_OCPOOL: "false" }).enabled, false);
  assert.equal(readConfig({ PI_OCPOOL: "no" }).enabled, false);
  assert.equal(readConfig({ PI_OCPOOL: "1" }).enabled, true);
  assert.equal(readConfig({}).enabled, true);
});

test("numeric options are parsed, clamped and validated", () => {
  assert.equal(readConfig({ PI_OCPOOL_SIZE: "5" }).size, 5);
  assert.equal(readConfig({ PI_OCPOOL_SIZE: "0" }).size, 1);
  assert.equal(readConfig({ PI_OCPOOL_SIZE: "999" }).size, 16);
  assert.equal(readConfig({ PI_OCPOOL_SIZE: "nope" }).size, DEFAULT_POOL_SIZE);

  assert.equal(readConfig({ PI_OCPOOL_MAX_UPSTREAM_MS: "nope" }).maxUpstreamMs, DEFAULT_MAX_UPSTREAM_MS);
  assert.equal(readConfig({ PI_OCPOOL_MAX_UPSTREAM_MS: "10" }).maxUpstreamMs, 250);

  assert.equal(readConfig({ PI_OCPOOL_PROBE_TIMEOUT_MS: "10" }).probeTimeoutMs, 500);

  assert.equal(readConfig({ PI_OCPOOL_STARTUP_BUDGET_MS: "-5" }).startupBudgetMs, 0);
  assert.equal(readConfig({ PI_OCPOOL_REQUEST_BUDGET_MS: "-5" }).requestBudgetMs, 0);
  assert.equal(readConfig({ PI_OCPOOL_PROBE_COOLDOWN_MS: "-5" }).probeCooldownMs, 0);
  assert.equal(readConfig({ PI_OCPOOL_PROBE_COOLDOWN_MS: "5000" }).probeCooldownMs, 5000);
  assert.equal(readConfig({ PI_OCPOOL_REFRESH_INTERVAL_MS: "0" }).refreshIntervalMs, 0);
  assert.equal(readConfig({ PI_OCPOOL_REFILL_DELAY_MS: "0" }).refillDelayMs, 0);
  assert.equal(readConfig({ PI_OCPOOL_REFILL_DELAY_MS: "-5" }).refillDelayMs, 0);

  assert.equal(readConfig({ PI_OCPOOL_QUARANTINE_FAILURES: "0" }).quarantineFailures, 1);
  assert.equal(readConfig({ PI_OCPOOL_QUARANTINE_FAILURES: "99" }).quarantineFailures, 10);
  assert.equal(readConfig({ PI_OCPOOL_DEGRADE_MS: "7000" }).degradeMs, 7000);
  assert.equal(readConfig({ PI_OCPOOL_DEGRADE_MS: "1" }).degradeMs, 1000);
  assert.equal(readConfig({ PI_OCPOOL_MAX_BINDINGS: "1" }).maxBindings, 8);

  assert.equal(readConfig({ PI_OCPOOL_TTL_MS: "1" }).ttlMs, 60_000);
  assert.equal(readConfig({ PI_OCPOOL_LEASE_TTL_MS: "1" }).leaseTtlMs, 60_000);
});

test("switches and paths", () => {
  assert.equal(readConfig({ PI_OCPOOL_REQUIRE_GATEWAY_ID: "0" }).requireGatewayId, false);
  assert.equal(readConfig({ PI_OCPOOL_REQUIRE_GATEWAY_ID: "1" }).requireGatewayId, true);
  assert.equal(readConfig({ PI_OCPOOL_DEBUG: "1" }).debug, true);
  assert.equal(readConfig({ PI_OCPOOL_DEBUG: "yes" }).debug, false);
  assert.equal(readConfig({ PI_OCPOOL_STATE_PATH: "  " }, "/h").statePath, "/h/.pi/opencode-session-pool.json");
  assert.equal(readConfig({ PI_OCPOOL_STATE_PATH: "/tmp/pool.json" }).statePath, "/tmp/pool.json");
});
