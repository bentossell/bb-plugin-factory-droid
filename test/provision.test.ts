import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AGENT_ID,
  entryMatchesCurrent,
  findManagedAgent,
  hasLegacyEntry,
  managedAgentEntry,
  parseCustomAgentsSetting,
  removeLegacyEntry,
  resolveDroidBinary,
  serializeCustomAgentsSetting,
  upsertManagedAgent,
} from "../lib/provision.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "factory-droid-plugin-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const droid = join(bin, "droid");
  writeFileSync(droid, "#!/bin/sh\nexit 0\n");
  chmodSync(droid, 0o755);
  return { root, droid, configPath: join(root, "config.json") };
}

// Mirrors provider-acp's permissionCli rule: every listed mode needs >= 1 flag.
function permissionCliIsAccepted(permissionCli: Record<string, unknown>): boolean {
  return Object.entries(permissionCli).every(
    ([key, value]) =>
      key === "insertAfterArgs" ||
      (Array.isArray(value) && value.length > 0 && value.every((flag) => typeof flag === "string" && flag.length > 0)),
  );
}

test("resolves Droid from PATH", () => {
  const { root, droid } = fixture();
  assert.equal(resolveDroidBinary({ PATH: join(root, "bin") }, root, "linux"), droid);
});

test("managed entry uses native ACP model discovery and reasoning", () => {
  const entry = managedAgentEntry("/tmp/droid");
  assert.deepEqual(entry.args, ["exec", "--output-format", "acp"]);
  assert.equal("modelCli" in entry, false);
  assert.equal("logo" in entry, false);
  assert.deepEqual(entry.permissionCli, {
    workspaceWrite: ["--auto", "medium"],
    full: ["--auto", "high"],
  });
  assert.deepEqual(entry.nativeReasoning, {
    configId: "reasoning_effort",
    supportedLevels: ["none", "low", "medium", "high", "xhigh", "max"],
    levelValues: { none: "off" },
    defaultLevel: "high",
  });
});

test("managed entry never lists a permission mode with zero flags", () => {
  const entry = managedAgentEntry("/tmp/droid");
  assert.equal(permissionCliIsAccepted(entry.permissionCli as Record<string, unknown>), true);
  assert.equal(permissionCliIsAccepted({ readonly: [] }), false);
});

test("parses the customAgents setting and refuses to clobber user edits", () => {
  assert.deepEqual(parseCustomAgentsSetting(undefined), []);
  assert.deepEqual(parseCustomAgentsSetting(""), []);
  assert.deepEqual(parseCustomAgentsSetting("  \n"), []);
  assert.deepEqual(parseCustomAgentsSetting('[{"id":"other"}]'), [{ id: "other" }]);
  assert.throws(() => parseCustomAgentsSetting("{broken"), /not valid JSON/);
  assert.throws(() => parseCustomAgentsSetting('{"id":"x"}'), /must be a JSON array/);
  assert.throws(() => parseCustomAgentsSetting(42), /not a string/);
});

test("serializes an empty list back to the setting default", () => {
  assert.equal(serializeCustomAgentsSetting([]), "");
  assert.deepEqual(JSON.parse(serializeCustomAgentsSetting([{ id: "a" }])), [{ id: "a" }]);
});

test("upsert adds the managed agent next to other agents and is idempotent", () => {
  const { droid } = fixture();
  const other = { id: "other", displayName: "Other", command: "other" };
  const first = upsertManagedAgent([other], droid);
  assert.equal(first.changed, true);
  assert.equal(first.agents.length, 2);
  assert.deepEqual(first.agents[0], other);
  assert.equal(findManagedAgent(first.agents)?.command, droid);
  const second = upsertManagedAgent(first.agents, droid);
  assert.equal(second.changed, false);
  assert.deepEqual(second.agents, first.agents);
});

test("upsert repairs managed fields while preserving unknown fields", () => {
  const { droid } = fixture();
  const stale = {
    id: AGENT_ID,
    displayName: "Old",
    command: "old",
    note: "keep",
    permissionCli: { readonly: [], workspaceWrite: ["--auto", "medium"], full: ["--auto", "high"] },
  };
  const result = upsertManagedAgent([stale], droid);
  assert.equal(result.changed, true);
  const entry = findManagedAgent(result.agents)!;
  assert.equal(entry.displayName, "Factory Droid");
  assert.equal(entry.command, droid);
  assert.equal(entry.note, "keep");
  assert.deepEqual(entry.permissionCli, { workspaceWrite: ["--auto", "medium"], full: ["--auto", "high"] });
});

test("entryMatchesCurrent detects stale managed fields", () => {
  const { droid } = fixture();
  assert.equal(entryMatchesCurrent(undefined, droid), false);
  const current = managedAgentEntry(droid);
  assert.equal(entryMatchesCurrent(current, droid), true);
  assert.equal(entryMatchesCurrent({ ...current, command: "/elsewhere/droid" }, droid), false);
  const withEmptyReadonly = {
    ...current,
    permissionCli: { readonly: [], ...(current.permissionCli as Record<string, unknown>) },
  };
  assert.equal(entryMatchesCurrent(withEmptyReadonly, droid), false);
  const missingPermissionCli = { ...current };
  delete missingPermissionCli.permissionCli;
  assert.equal(entryMatchesCurrent(missingPermissionCli, droid), false);
});

test("legacy entry is removed from config.json without touching other config", () => {
  const { configPath } = fixture();
  writeFileSync(
    configPath,
    JSON.stringify({
      config: { BB_LOG_LEVEL: "debug" },
      customAcpAgents: [
        { id: "other", displayName: "Other", command: "other" },
        { id: AGENT_ID, displayName: "Factory Droid", command: "/old/droid", permissionCli: { readonly: [] } },
      ],
    }),
  );
  assert.equal(hasLegacyEntry(configPath), true);
  assert.equal(removeLegacyEntry(configPath), true);
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(config.config.BB_LOG_LEVEL, "debug");
  assert.deepEqual(config.customAcpAgents, [{ id: "other", displayName: "Other", command: "other" }]);
  assert.equal(hasLegacyEntry(configPath), false);
  assert.equal(removeLegacyEntry(configPath), false);
});

test("legacy removal drops an emptied customAcpAgents array", () => {
  const { configPath } = fixture();
  writeFileSync(configPath, JSON.stringify({ customAcpAgents: [{ id: AGENT_ID, command: "/old/droid" }] }));
  assert.equal(removeLegacyEntry(configPath), true);
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {});
});

test("legacy removal is a no-op when config.json is absent or has no entry", () => {
  const { configPath } = fixture();
  assert.equal(hasLegacyEntry(configPath), false);
  assert.equal(removeLegacyEntry(configPath), false);
  writeFileSync(configPath, JSON.stringify({ config: {} }));
  assert.equal(removeLegacyEntry(configPath), false);
});

test("refuses to rewrite malformed config", () => {
  const { configPath } = fixture();
  writeFileSync(configPath, "{broken");
  assert.equal(hasLegacyEntry(configPath), false);
  assert.throws(() => removeLegacyEntry(configPath));
  assert.equal(readFileSync(configPath, "utf8"), "{broken");
});
