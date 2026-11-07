import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyProbe,
  createProber,
  extractBodyId,
  parseRetryAfter,
  parseServerTiming,
  timingFromHeaders,
} from "../lib/probe.ts";
import type { ProbeTarget } from "../lib/types.ts";

const config = { probeTimeoutMs: 1_000, maxUpstreamMs: 2_500, requireGatewayId: true };

const target: ProbeTarget = {
  provider: "opencode-go",
  model: "deepseek-v4.1-flash",
  url: "https://opencode.ai/inference/go/openai/v1/chat/completions",
  apiKey: "sk-test",
  headers: { "x-custom": "1" },
};

test("parses server-timing durations in any order", () => {
  assert.deepEqual(parseServerTiming("gateway;dur=10, upstream;dur=1447, total;dur=1498"), {
    gatewayMs: 10,
    upstreamMs: 1447,
    totalMs: 1498,
  });
  assert.deepEqual(parseServerTiming("upstream;dur=1.5"), { upstreamMs: 1.5 });
  assert.deepEqual(parseServerTiming("cache;desc=\"hit\";dur=3"), {});
  assert.deepEqual(parseServerTiming("gateway;dur=abc, upstream"), {});
  assert.deepEqual(parseServerTiming(undefined), {});
  assert.deepEqual(parseServerTiming(""), {});
  assert.deepEqual(timingFromHeaders({ "server-timing": "upstream;dur=900" }), { upstreamMs: 900 });
});

test("parses retry-after in milliseconds, seconds and HTTP dates", () => {
  assert.equal(parseRetryAfter({ "retry-after-ms": "2303" }), 2303);
  assert.equal(parseRetryAfter({ "retry-after": "3" }), 3000);
  assert.equal(parseRetryAfter({}), undefined);
  assert.equal(parseRetryAfter({ "retry-after": "garbage" }), undefined);
  const now = Date.now();
  assert.ok((parseRetryAfter({ "retry-after": new Date(now + 5_000).toUTCString() }) ?? 0) > 3_000);
});

test("extracts the response id from JSON and from a truncated body", () => {
  assert.equal(extractBodyId('{"id":"gw-fcb97948d36-b11396","object":"chat.completion"}'), "gw-fcb97948d36-b11396");
  assert.equal(extractBodyId('data: {"id":"chatcmpl-1"'), "chatcmpl-1");
  assert.equal(extractBodyId('{"error":{"type":"server_error"}}'), undefined);
  assert.equal(extractBodyId("not json"), undefined);
});

test("classifies fast and slow upstreams", () => {
  const fast = classifyProbe(
    {
      status: 200,
      serverTiming: "gateway;dur=10, upstream;dur=941, total;dur=980",
      bodyId: "gw-fcb97948d36-b11396",
      wallMs: 1_200,
    },
    config,
  );
  assert.equal(fast.fast, true);
  assert.equal(fast.reason, "fast");
  assert.equal(fast.upstreamMs, 941);

  const slow = classifyProbe(
    {
      status: 200,
      serverTiming: "gateway;dur=12, upstream;dur=41077, total;dur=41090",
      bodyId: "chatcmpl-7e97fba06",
      wallMs: 41_500,
    },
    config,
  );
  assert.equal(slow.fast, false);
  assert.equal(slow.reason, "slow");

  const boundary = classifyProbe(
    { status: 200, serverTiming: "upstream;dur=2500", bodyId: "gw-1", wallMs: 2_600 },
    config,
  );
  assert.equal(boundary.fast, true);

  const justOver = classifyProbe(
    { status: 200, serverTiming: "upstream;dur=2501", bodyId: "gw-1", wallMs: 2_600 },
    config,
  );
  assert.equal(justOver.fast, false);
});

test("falls back to wall time when server-timing is missing", () => {
  const fast = classifyProbe({ status: 200, serverTiming: null, bodyId: "gw-1", wallMs: 900 }, config);
  assert.equal(fast.fast, true);
  assert.equal(fast.upstreamMs, 900);

  const slow = classifyProbe({ status: 200, serverTiming: null, bodyId: "gw-1", wallMs: 12_000 }, config);
  assert.equal(slow.fast, false);
  assert.equal(slow.reason, "slow");
});

test("rejects ids that did not land on an OpenCode gateway worker", () => {
  const result = classifyProbe(
    { status: 200, serverTiming: "upstream;dur=900", bodyId: "chatcmpl-1", wallMs: 1_000 },
    config,
  );
  assert.equal(result.fast, false);
  assert.equal(result.reason, "gateway-id-mismatch");

  const relaxed = classifyProbe(
    { status: 200, serverTiming: "upstream;dur=900", bodyId: "chatcmpl-1", wallMs: 1_000 },
    { ...config, requireGatewayId: false },
  );
  assert.equal(relaxed.fast, true);
});

test("surfaces HTTP failures as non-fast reasons", () => {
  assert.equal(classifyProbe({ status: 429, serverTiming: null, wallMs: 200, retryAfterMs: 2_300 }, config).reason, "overloaded");
  assert.equal(classifyProbe({ status: 401, serverTiming: null, wallMs: 200 }, config).reason, "unauthorized");
  assert.equal(classifyProbe({ status: 403, serverTiming: null, wallMs: 200 }, config).reason, "unauthorized");
  assert.equal(classifyProbe({ status: 500, serverTiming: null, wallMs: 200 }, config).reason, "http-error");
  assert.equal(classifyProbe({ status: 302, serverTiming: null, wallMs: 200 }, config).reason, "rejected");
});

test("sends the probe the way OpenCode expects and reports fast", async () => {
  let captured: { url: unknown; init: RequestInit | undefined } | undefined;
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    captured = { url, init };
    return new Response(JSON.stringify({ id: "gw-abc-1" }), {
      status: 200,
      headers: { "server-timing": "gateway;dur=8, upstream;dur=900, total;dur=930" },
    });
  }) as typeof fetch;

  const prober = createProber({ config, fetchImpl });
  const result = await prober.probe("candidate-1", target);

  assert.equal(result.fast, true);
  assert.equal(result.upstreamMs, 900);
  assert.equal(result.bodyId, "gw-abc-1");

  const headers = new Headers(captured?.init?.headers);
  assert.equal(headers.get("x-opencode-session"), "candidate-1");
  assert.equal(headers.get("x-opencode-client"), "pi");
  assert.equal(headers.get("authorization"), "Bearer sk-test");
  assert.equal(headers.get("x-custom"), "1");
  assert.match(String(headers.get("user-agent")), /^pi-opencode-session-pool\//);

  const body = JSON.parse(String(captured?.init?.body));
  assert.equal(body.model, "deepseek-v4.1-flash");
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 1);
});

test("reports timeouts instead of hanging", async () => {
  const hanging = ((_url: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    })) as typeof fetch;

  const prober = createProber({ config: { ...config, probeTimeoutMs: 40 }, fetchImpl: hanging });
  const result = await prober.probe("candidate-2", target, 40);
  assert.equal(result.fast, false);
  assert.equal(result.reason, "timeout");
  assert.equal(result.status, 0);
});

test("reports network failures without throwing", async () => {
  const failing = (async () => {
    throw new Error("ECONNRESET");
  }) as typeof fetch;
  const prober = createProber({ config, fetchImpl: failing });
  const result = await prober.probe("candidate-3", target);
  assert.equal(result.fast, false);
  assert.equal(result.reason, "network-error");
});

test("surfaces overload with retry-after", async () => {
  const fetchImpl = (async () =>
    new Response('{"error":{"type":"server_error","message":"[overloaded]"}}', {
      status: 429,
      headers: { "retry-after-ms": "2303", "server-timing": "gateway;dur=2254, upstream;dur=454" },
    })) as typeof fetch;
  const prober = createProber({ config, fetchImpl });
  const result = await prober.probe("candidate-4", target);
  assert.equal(result.fast, false);
  assert.equal(result.reason, "overloaded");
  assert.equal(result.retryAfterMs, 2303);
});
