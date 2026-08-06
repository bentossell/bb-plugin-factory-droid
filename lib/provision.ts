import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { homedir } from "node:os";

export const AGENT_ID = "factory-droid";
export const PROVIDER_ID = `acp-${AGENT_ID}`;

export interface ProvisionPaths {
  dataDir: string;
  configPath: string;
  logoPath: string;
}

interface CustomAgent extends Record<string, unknown> {
  id?: unknown;
}

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="Factory Droid">
  <rect width="256" height="256" rx="56" fill="#101114"/>
  <path fill="#fff" d="M57 50h142v36H97v27h83v35H97v58H57V50Z"/>
  <path fill="#9cff57" d="M180 113h19v93h-58v-35h39v-58Z"/>
</svg>
`;

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveDroidBinary(
  env: NodeJS.ProcessEnv,
  home = homedir(),
  platform = process.platform,
): string | null {
  const names = platform === "win32" ? ["droid.exe", "droid.cmd", "droid"] : ["droid"];
  const searchDirectories = (env.PATH ?? "").split(delimiter).filter(Boolean);
  searchDirectories.push(join(home, ".local", "bin"), join(home, ".factory", "bin"));
  if (platform === "darwin") {
    searchDirectories.push("/opt/homebrew/bin", "/usr/local/bin");
  }
  for (const directory of [...new Set(searchDirectories)]) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function readConfig(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${configPath} must contain a JSON object; refusing to overwrite it`);
  }
  return parsed as Record<string, unknown>;
}

function writeAtomic(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.factory-droid-${process.pid}.tmp`;
  try {
    writeFileSync(temporary, content, "utf8");
    if (mode !== undefined) chmodSync(temporary, mode);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function writeIfChanged(path: string, content: string): boolean {
  if (existsSync(path) && readFileSync(path, "utf8") === content) return false;
  writeAtomic(path, content);
  return true;
}

export function managedAgentEntry(droidBinary: string): Record<string, unknown> {
  return {
    id: AGENT_ID,
    displayName: "Factory Droid",
    command: droidBinary,
    args: ["exec", "--output-format", "acp"],
    logo: "logos/factory-droid.svg",
    nativeReasoning: {
      configId: "reasoning_effort",
      supportedLevels: ["none", "low", "medium", "high", "xhigh", "max"],
      levelValues: { none: "off" },
      defaultLevel: "high",
    },
  };
}

export function provisionInstallation(
  paths: ProvisionPaths,
  droidBinary: string,
): { changed: boolean; messages: string[] } {
  if (!isExecutable(droidBinary)) throw new Error(`Droid CLI is not executable: ${droidBinary}`);
  mkdirSync(paths.dataDir, { recursive: true });
  const logoChanged = writeIfChanged(paths.logoPath, LOGO);

  const config = readConfig(paths.configPath);
  const agents: CustomAgent[] = Array.isArray(config.customAcpAgents)
    ? [...(config.customAcpAgents as CustomAgent[])]
    : [];
  const entry = managedAgentEntry(droidBinary);
  const index = agents.findIndex((agent) => agent?.id === AGENT_ID);
  let configChanged = false;
  let configMessage: string;
  if (index < 0) {
    agents.push(entry);
    configChanged = true;
    configMessage = `added custom ACP agent ${AGENT_ID} (${PROVIDER_ID})`;
  } else {
    const updated = { ...agents[index], ...entry };
    configChanged = JSON.stringify(updated) !== JSON.stringify(agents[index]);
    agents[index] = updated;
    configMessage = configChanged
      ? `updated custom ACP agent ${AGENT_ID}`
      : `custom ACP agent ${AGENT_ID} already up to date`;
  }
  if (configChanged) {
    config.customAcpAgents = agents;
    writeAtomic(paths.configPath, `${JSON.stringify(config, null, "\t")}\n`);
  }
  return {
    changed: logoChanged || configChanged,
    messages: [
      logoChanged ? `wrote ${paths.logoPath}` : `logo already up to date at ${paths.logoPath}`,
      configMessage,
    ],
  };
}

export function inspectInstallation(paths: ProvisionPaths): {
  configured: boolean;
  error?: string;
} {
  try {
    const config = readConfig(paths.configPath);
    const configured = Array.isArray(config.customAcpAgents)
      && (config.customAcpAgents as CustomAgent[]).some((agent) => agent?.id === AGENT_ID);
    return { configured };
  } catch (error) {
    return { configured: false, error: String(error) };
  }
}
