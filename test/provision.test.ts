import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import test from "node:test";
import {
  AGENT_ID,
  inspectInstallation,
  managedAgentEntry,
  provisionInstallation,
  resolveDroidBinary,
} from "../lib/provision.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "factory-droid-plugin-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const droid = join(bin, "droid");
  writeFileSync(droid, "#!/bin/sh\nexit 0\n");
  chmodSync(droid, 0o755);
  return {
    root,
    droid,
    paths: {
      dataDir: root,
      configPath: join(root, "config.json"),
      logoPath: join(root, "logos", "factory-droid.svg"),
    },
  };
}

test("resolves Droid from PATH", () => {
  const { root, droid } = fixture();
  assert.equal(resolveDroidBinary({ PATH: join(root, "bin") }, root, "linux"), droid);
});

test("managed entry uses native ACP model discovery and reasoning", () => {
  const entry = managedAgentEntry("/tmp/droid");
  assert.deepEqual(entry.args, ["exec", "--output-format", "acp"]);
  assert.equal("modelCli" in entry, false);
  assert.deepEqual(entry.permissionCli, {
    readonly: [],
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

test("inspectInstallation reports the configured command", () => {
  const { droid, paths } = fixture();
  assert.equal(inspectInstallation(paths).configured, false);
  provisionInstallation(paths, droid);
  const installation = inspectInstallation(paths);
  assert.equal(installation.configured, true);
  assert.equal(installation.command, droid);
});

test("provisions without clobbering other config and is idempotent", () => {
  const { droid, paths } = fixture();
  writeFileSync(paths.configPath, JSON.stringify({
    config: { BB_LOG_LEVEL: "debug" },
    customAcpAgents: [{ id: "other", displayName: "Other", command: "other" }],
  }));
  const first = provisionInstallation(paths, droid);
  assert.equal(first.changed, true);
  const config = JSON.parse(readFileSync(paths.configPath, "utf8"));
  assert.equal(config.config.BB_LOG_LEVEL, "debug");
  assert.equal(config.customAcpAgents.length, 2);
  assert.equal(config.customAcpAgents[1].id, AGENT_ID);
  assert.equal(config.customAcpAgents[1].command, droid);
  assert.equal(inspectInstallation(paths).configured, true);
  const second = provisionInstallation(paths, droid);
  assert.equal(second.changed, false);
});

test("repairs managed fields while preserving unknown fields", () => {
  const { droid, paths } = fixture();
  writeFileSync(paths.configPath, JSON.stringify({
    customAcpAgents: [{ id: AGENT_ID, displayName: "Old", command: "old", note: "keep" }],
  }));
  provisionInstallation(paths, droid);
  const entry = JSON.parse(readFileSync(paths.configPath, "utf8")).customAcpAgents[0];
  assert.equal(entry.displayName, "Factory Droid");
  assert.equal(entry.command, droid);
  assert.equal(entry.note, "keep");
});

test("refuses to overwrite malformed config", () => {
  const { droid, paths } = fixture();
  writeFileSync(paths.configPath, "{broken");
  assert.throws(() => provisionInstallation(paths, droid));
  assert.equal(readFileSync(paths.configPath, "utf8"), "{broken");
});
