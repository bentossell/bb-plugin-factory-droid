// Registers Factory Droid as an ACP provider in bb.
import type { BbPluginApi } from "@bb/plugin-sdk";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  entryMatchesCurrent,
  inspectInstallation,
  provisionInstallation,
  PROVIDER_ID,
  resolveDroidBinary,
  type ProvisionPaths,
} from "./lib/provision.js";

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  // Repair silently when the managed entry is missing or points at a droid
  // binary that has moved (for example after a Homebrew upgrade). Never blocks
  // plugin load, and never writes when droid is not installed.
  async function selfHeal(): Promise<void> {
    try {
      const droidBinary = resolveDroidBinary(process.env);
      if (!droidBinary) return;
      const installation = inspectInstallation(await paths());
      if (entryMatchesCurrent(installation.entry, droidBinary)) return;
      const result = provisionInstallation(await paths(), droidBinary);
      if (result.changed) {
        const reloaded = await reloadConfig();
        bb.log.info(
          `self-repair: ${result.messages.join("; ")}; reload ${reloaded ? "ok" : "failed"}`,
        );
      }
    } catch (error) {
      bb.log.warn(`self-repair skipped: ${String(error)}`);
    }
  }
  void selfHeal();

  async function resolveDataDir(): Promise<string> {
    try {
      const config = await bb.sdk.system.config();
      if (typeof config.dataDir === "string" && config.dataDir.length > 0) {
        return config.dataDir;
      }
    } catch (error) {
      bb.log.warn(`Could not read bb data directory from SDK: ${String(error)}`);
    }
    return process.env.BB_DATA_DIR ?? join(homedir(), ".bb");
  }

  async function paths(): Promise<ProvisionPaths> {
    const dataDir = await resolveDataDir();
    return {
      dataDir,
      configPath: join(dataDir, "config.json"),
      logoPath: join(dataDir, "logos", "factory-droid.svg"),
    };
  }

  async function reloadConfig(): Promise<boolean> {
    try {
      const response = await fetch(
        `${bb.server.loopbackBaseUrl}/api/v1/system/config/reload`,
        { method: "POST" },
      );
      return response.ok;
    } catch (error) {
      bb.log.warn(`Could not reload bb config: ${String(error)}`);
      return false;
    }
  }

  async function statusLines(): Promise<string[]> {
    const resolvedPaths = await paths();
    const installation = inspectInstallation(resolvedPaths);
    const droidBinary = resolveDroidBinary(process.env);
    const lines = [
      `Droid CLI: ${droidBinary ?? "NOT FOUND"}`,
      `config entry: ${installation.configured ? "present" : "missing"}`,
      `logo: ${existsSync(resolvedPaths.logoPath) ? "present" : "missing"}`,
    ];
    try {
      const providers = await bb.sdk.providers.list();
      lines.push(
        `bb provider ${PROVIDER_ID}: ${providers.some((provider: { id?: string }) => provider.id === PROVIDER_ID) ? "registered" : "NOT registered"}`,
      );
    } catch (error) {
      lines.push(`bb provider ${PROVIDER_ID}: unknown (${String(error)})`);
    }
    if (installation.configured && droidBinary && installation.command !== droidBinary) {
      lines.push(`path drift: config points at ${installation.command}; reload bb or rerun setup`);
    }
    if (installation.error) lines.push(`config error: ${installation.error}`);
    return lines;
  }

  bb.cli.register({
    name: "factory-droid",
    summary: "Install and inspect the Factory Droid ACP provider integration.",
    commands: [
      {
        name: "setup",
        summary: "Register Factory Droid as a bb provider and reload bb config",
        usage: "factory-droid setup",
      },
      {
        name: "status",
        summary: "Check the Droid CLI, bb config, assets, and provider registration",
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
        const result = provisionInstallation(await paths(), droidBinary);
        const messages = [...result.messages];
        if (result.changed) {
          const reloaded = await reloadConfig();
          messages.push(
            reloaded
              ? "reloaded running bb server config"
              : "WARNING: config was written but the server reload failed; restart bb and check status",
          );
        } else {
          messages.push("configuration is already up to date");
        }
        messages.push(`Factory authentication is handled by Droid; run \`${droidBinary}\` once to sign in if needed.`);
        return { exitCode: 0, stdout: `${messages.join("\n")}\n` };
      } catch (error) {
        bb.log.error(`Factory Droid setup failed: ${String(error)}`);
        return { exitCode: 1, stderr: `Factory Droid setup failed: ${String(error)}\n` };
      }
    },
  });
}
