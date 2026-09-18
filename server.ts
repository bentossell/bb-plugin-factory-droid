// Registers Factory Droid as an ACP provider in bb.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ACP_PLUGIN_ID,
  assertDroidExecutable,
  CUSTOM_AGENTS_SETTING,
  entryMatchesCurrent,
  findManagedAgent,
  hasLegacyEntry,
  parseCustomAgentsSetting,
  PROVIDER_ID,
  removeLegacyEntry,
  resolveDroidBinary,
  serializeCustomAgentsSetting,
  upsertManagedAgent,
  type CustomAgent,
} from "./lib/provision.js";

const REGISTRATION_TIMEOUT_MS = 8_000;
const SELF_HEAL_ATTEMPTS = 6;
const SELF_HEAL_RETRY_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  async function configPath(): Promise<string> {
    let dataDir = process.env.BB_DATA_DIR ?? join(homedir(), ".bb");
    try {
      const config = await bb.sdk.system.config();
      if (typeof config.dataDir === "string" && config.dataDir.length > 0) dataDir = config.dataDir;
    } catch (error) {
      bb.log.warn(`Could not read bb data directory from SDK: ${String(error)}`);
    }
    return join(dataDir, "config.json");
  }

  async function readCustomAgents(): Promise<CustomAgent[]> {
    const settings = await bb.sdk.plugins.getSettings({ pluginId: ACP_PLUGIN_ID });
    return parseCustomAgentsSetting(settings.values[CUSTOM_AGENTS_SETTING]);
  }

  async function writeCustomAgents(agents: CustomAgent[]): Promise<void> {
    // provider-acp validates the value with its own schema and re-registers
    // its agents as soon as the setting changes; an invalid entry is rejected
    // here instead of being dropped silently at startup.
    await bb.sdk.plugins.updateSettings({
      pluginId: ACP_PLUGIN_ID,
      values: { [CUSTOM_AGENTS_SETTING]: serializeCustomAgentsSetting(agents) },
    });
  }

  async function providerRegistered(): Promise<boolean> {
    const providers = await bb.sdk.providers.list();
    return providers.some((provider: { id?: string }) => provider.id === PROVIDER_ID);
  }

  async function waitForProvider(): Promise<boolean> {
    const deadline = Date.now() + REGISTRATION_TIMEOUT_MS;
    while (true) {
      if (await providerRegistered()) return true;
      if (Date.now() >= deadline) return false;
      await sleep(250);
    }
  }

  async function reloadConfig(): Promise<boolean> {
    try {
      const response = await fetch(`${bb.server.loopbackBaseUrl}/api/v1/system/config/reload`, {
        method: "POST",
      });
      return response.ok;
    } catch (error) {
      bb.log.warn(`Could not reload bb config: ${String(error)}`);
      return false;
    }
  }

  // Writes the managed agent into provider-acp's customAgents setting and
  // removes the deprecated config.json entry from earlier releases.
  async function provision(droidBinary: string): Promise<{ changed: boolean; messages: string[] }> {
    assertDroidExecutable(droidBinary);
    const messages: string[] = [];
    const upsert = upsertManagedAgent(await readCustomAgents(), droidBinary);
    if (upsert.changed) await writeCustomAgents(upsert.agents);
    messages.push(upsert.message);

    let legacyRemoved = false;
    const path = await configPath();
    if (hasLegacyEntry(path)) {
      legacyRemoved = removeLegacyEntry(path);
      if (legacyRemoved) {
        const reloaded = await reloadConfig();
        messages.push(
          `removed deprecated customAcpAgents entry from ${path}; config reload ${reloaded ? "ok" : "failed"}`,
        );
      }
    }
    return { changed: upsert.changed || legacyRemoved, messages };
  }

  // Repair silently when the managed entry is missing, stale, or points at a
  // droid binary that has moved (for example after a Homebrew upgrade). Never
  // blocks plugin load, and never writes when droid is not installed.
  // provider-acp may still be starting when this plugin loads, so its settings
  // can be briefly unavailable; retry a few times before giving up.
  async function selfHeal(): Promise<void> {
    const droidBinary = resolveDroidBinary(process.env);
    if (!droidBinary) return;
    for (let attempt = 1; attempt <= SELF_HEAL_ATTEMPTS; attempt += 1) {
      try {
        const stored = findManagedAgent(await readCustomAgents());
        if (entryMatchesCurrent(stored, droidBinary) && !hasLegacyEntry(await configPath())) return;
        const result = await provision(droidBinary);
        if (result.changed) {
          const registered = await waitForProvider();
          bb.log.info(
            `self-repair: ${result.messages.join("; ")}; provider ${registered ? "registered" : "not yet registered"}`,
          );
        }
        return;
      } catch (error) {
        if (attempt === SELF_HEAL_ATTEMPTS) {
          bb.log.warn(`self-repair skipped: ${String(error)}`);
          return;
        }
        await sleep(SELF_HEAL_RETRY_MS);
      }
    }
  }
  void selfHeal();

  async function statusLines(): Promise<string[]> {
    const droidBinary = resolveDroidBinary(process.env);
    const lines = [`Droid CLI: ${droidBinary ?? "NOT FOUND"}`];
    let stored: CustomAgent | undefined;
    try {
      stored = findManagedAgent(await readCustomAgents());
      lines.push(`${ACP_PLUGIN_ID} ${CUSTOM_AGENTS_SETTING} entry: ${stored ? "present" : "missing"}`);
    } catch (error) {
      lines.push(`${ACP_PLUGIN_ID} ${CUSTOM_AGENTS_SETTING} entry: unknown (${String(error)})`);
    }
    try {
      lines.push(`bb provider ${PROVIDER_ID}: ${(await providerRegistered()) ? "registered" : "NOT registered"}`);
    } catch (error) {
      lines.push(`bb provider ${PROVIDER_ID}: unknown (${String(error)})`);
    }
    if (stored && droidBinary && !entryMatchesCurrent(stored, droidBinary)) {
      lines.push(
        stored.command === droidBinary
          ? "stale entry: managed fields differ from this plugin version; rerun setup"
          : `path drift: entry points at ${String(stored.command)}; rerun setup`,
      );
    }
    if (hasLegacyEntry(await configPath())) {
      lines.push("deprecated customAcpAgents entry still present in config.json; rerun setup to remove it");
    }
    return lines;
  }

  bb.cli.register({
    name: "factory-droid",
    summary: "Install and inspect the Factory Droid ACP provider integration.",
    commands: [
      {
        name: "setup",
        summary: "Register Factory Droid as a bb provider",
        usage: "factory-droid setup",
      },
      {
        name: "status",
        summary: "Check the Droid CLI, the provider-acp setting, and provider registration",
        usage: "factory-droid status",
      },
    ],
    async run(argv) {
      const command = argv[0] ?? "setup";
      if (command === "status") {
        return { exitCode: 0, stdout: `${(await statusLines()).join("\n")}\n` };
      }
      if (command !== "setup") {
        return {
          exitCode: 2,
          stderr: `Unknown subcommand "${command}". Use "bb factory-droid setup" or "bb factory-droid status".\n`,
        };
      }

      const droidBinary = resolveDroidBinary(process.env);
      if (!droidBinary) {
        return {
          exitCode: 1,
          stderr:
            "Factory Droid CLI was not found. Install it from https://docs.factory.ai/droid-cli/quickstart, then run `bb factory-droid setup` again.\n",
        };
      }
      try {
        const result = await provision(droidBinary);
        const messages = [...result.messages];
        if (!result.changed) messages.push("configuration is already up to date");
        const registered = await waitForProvider();
        messages.push(
          registered
            ? `bb provider ${PROVIDER_ID}: registered`
            : `WARNING: bb provider ${PROVIDER_ID} is not registered yet; check \`bb plugin logs ${ACP_PLUGIN_ID}\``,
        );
        messages.push(`Factory authentication is handled by Droid; run \`${droidBinary}\` once to sign in if needed.`);
        return { exitCode: registered ? 0 : 1, stdout: `${messages.join("\n")}\n` };
      } catch (error) {
        bb.log.error(`Factory Droid setup failed: ${String(error)}`);
        return { exitCode: 1, stderr: `Factory Droid setup failed: ${String(error)}\n` };
      }
    },
  });
}
