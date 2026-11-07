#!/usr/bin/env node
/**
 * Inspect the pi-opencode-session-pool state file.
 *
 * Usage:
 *   node scripts/inspect-pool.mjs            # human-readable
 *   node scripts/inspect-pool.mjs --json     # raw state
 *
 * Read-only: it never probes and never rewrites the file.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const statePath = process.env.PI_OCPOOL_STATE_PATH?.trim() ||
  join(homedir(), ".pi", "opencode-session-pool.json");

function age(ms) {
  if (ms < 1_000) return `${ms}ms ago`;
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
}

let raw;
try {
  raw = await readFile(statePath, "utf8");
} catch (error) {
  if (error?.code === "ENOENT") {
    console.log(`no pool yet: ${statePath}`);
    process.exit(0);
  }
  throw error;
}

if (process.argv.includes("--json")) {
  console.log(raw.trim());
  process.exit(0);
}

const state = JSON.parse(raw);
const now = Date.now();
const entries = [...(state.entries ?? [])].sort(
  (a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model) || a.upstreamMs - b.upstreamMs,
);

console.log(`state: ${statePath}`);
console.log(`entries: ${entries.length}   bindings: ${Object.keys(state.bindings ?? {}).length}\n`);

if (entries.length === 0) {
  console.log("(empty — the next pi session will probe fresh candidates)");
} else {
  const header = ["id", "provider/model", "upstream", "verified", "fail"];
  const rows = entries.map((entry) => [
    entry.id,
    `${entry.provider}/${entry.model}`,
    `${Math.round(entry.upstreamMs)}ms`,
    age(now - entry.verifiedAt),
    String(entry.failures ?? 0),
  ]);
  const widths = header.map((_, index) =>
    Math.max(header[index].length, ...rows.map((row) => row[index].length)),
  );
  const line = (cells) => cells.map((cell, index) => cell.padEnd(widths[index])).join("  ");
  console.log(line(header));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) console.log(line(row));
}

const bindings = Object.entries(state.bindings ?? {});
if (bindings.length > 0) {
  console.log(`\nbindings (pi session :: provider :: model -> id):`);
  for (const [key, binding] of bindings.sort((a, b) => b[1].lastSeenAt - a[1].lastSeenAt)) {
    const [session, provider, model] = key.split("::");
    console.log(
      `  ${session.slice(0, 8)}  ${provider}/${model} -> ${binding.routedId}  (seen ${age(now - binding.lastSeenAt)})`,
    );
  }
}
