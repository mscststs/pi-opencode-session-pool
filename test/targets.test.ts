import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bindingKey,
  chatCompletionsUrl,
  isOpenCodeModel,
  resolveTarget,
  supportsProbing,
  targetKey,
} from "../lib/targets.ts";

const opencodeGo = {
  id: "deepseek-v4.1-flash",
  provider: "opencode-go",
  api: "openai-completions",
  baseUrl: "https://opencode.ai/inference/go/openai/v1",
};

test("detects OpenCode by provider id", () => {
  assert.equal(isOpenCodeModel({ provider: "opencode", baseUrl: "https://example.com" }), true);
  assert.equal(isOpenCodeModel(opencodeGo), true);
  assert.equal(isOpenCodeModel({ provider: "OPENCODE-Go", baseUrl: "" }), true);
  assert.equal(isOpenCodeModel({ provider: "anthropic", baseUrl: "https://api.anthropic.com" }), false);
});

test("detects OpenCode by base URL host even when the provider is custom", () => {
  assert.equal(
    isOpenCodeModel({ provider: "my-relay", baseUrl: "https://opencode.ai/inference/v1" }),
    true,
  );
  assert.equal(isOpenCodeModel({ provider: "my-relay", baseUrl: "https://opencode.ai.evil.test" }), false);
  assert.equal(isOpenCodeModel({ provider: "my-relay", baseUrl: "not a url" }), false);
});

test("only openai-completions models are probeable", () => {
  assert.equal(supportsProbing(opencodeGo), true);
  assert.equal(supportsProbing({ ...opencodeGo, api: "anthropic-messages" }), false);
  assert.equal(supportsProbing({ ...opencodeGo, api: "google-generative-ai" }), false);
  assert.equal(
    supportsProbing({ ...opencodeGo, provider: "other", baseUrl: "https://api.example.com/v1" }),
    false,
  );
});

test("builds chat-completions URLs from every baseUrl shape", () => {
  assert.equal(
    chatCompletionsUrl("https://opencode.ai/inference/go/openai/v1"),
    "https://opencode.ai/inference/go/openai/v1/chat/completions",
  );
  assert.equal(
    chatCompletionsUrl("https://opencode.ai/inference/go/openai/v1/"),
    "https://opencode.ai/inference/go/openai/v1/chat/completions",
  );
  assert.equal(
    chatCompletionsUrl("https://opencode.ai/inference/openai/v1/chat/completions"),
    "https://opencode.ai/inference/openai/v1/chat/completions",
  );
  assert.equal(chatCompletionsUrl("https://host/v1?x=1#frag"), "https://host/v1/chat/completions");
  assert.equal(chatCompletionsUrl(undefined), undefined);
  assert.equal(chatCompletionsUrl("nope"), undefined);
});

test("resolveTarget requires an api key and a supported transport", () => {
  assert.deepEqual(resolveTarget(opencodeGo, { apiKey: "sk-test" }), {
    provider: "opencode-go",
    model: "deepseek-v4.1-flash",
    url: "https://opencode.ai/inference/go/openai/v1/chat/completions",
    apiKey: "sk-test",
    headers: undefined,
  });
  assert.equal(resolveTarget(opencodeGo, {}), undefined);
  assert.equal(resolveTarget({ ...opencodeGo, api: "anthropic-messages" }, { apiKey: "k" }), undefined);
});

test("binding keys are scoped per conversation and model", () => {
  assert.equal(
    bindingKey("session-1", "opencode-go", "deepseek-v4.1-flash"),
    "session-1::opencode-go::deepseek-v4.1-flash",
  );
  assert.notEqual(
    bindingKey("session-1", "opencode-go", "a"),
    bindingKey("session-1", "opencode-go", "b"),
  );
  assert.notEqual(
    bindingKey("session-1", "opencode-go", "a"),
    bindingKey("session-2", "opencode-go", "a"),
  );
  assert.equal(targetKey("opencode-go", "a"), "opencode-go::a");
});
