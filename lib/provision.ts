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
// The builtin bb plugin that owns ACP providers and the "customAgents" setting.
export const ACP_PLUGIN_ID = "provider-acp";
export const CUSTOM_AGENTS_SETTING = "customAgents";

export interface CustomAgent extends Record<string, unknown> {
  id?: unknown;
}

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

export function assertDroidExecutable(droidBinary: string): void {
  if (!isExecutable(droidBinary)) throw new Error(`Droid CLI is not executable: ${droidBinary}`);
}

// bb permission modes map to droid exec autonomy tiers:
// - "accept-edits"/"auto" keep workspace sandboxing -> --auto medium
// - "full" bypasses approvals -> --auto high (droid keeps its hard safety checks)
// - read-only contexts send no flags because droid exec defaults to read-only.
//   There is deliberately no "readonly" key: bb's permissionCli schema requires
//   at least one flag per listed mode and drops the whole agent otherwise.
//
// The entry must satisfy provider-acp's strict customAgents schema, so it
// carries no "logo"; app.tsx supplies the provider icon instead.
export function managedAgentEntry(droidBinary: string): CustomAgent {
  return {
    id: AGENT_ID,
    displayName: "Factory Droid",
    command: droidBinary,
    args: ["exec", "--output-format", "acp"],
    permissionCli: {
      workspaceWrite: ["--auto", "medium"],
      full: ["--auto", "high"],
    },
    nativeReasoning: {
      configId: "reasoning_effort",
      supportedLevels: ["none", "low", "medium", "high", "xhigh", "max"],
      levelValues: { none: "off" },
      defaultLevel: "high",
    },
  };
}

// Parses provider-acp's "customAgents" setting. An empty setting is an empty
// list; anything that is not a JSON array is the user's own edit and must not
// be overwritten, so it is an error.
export function parseCustomAgentsSetting(value: unknown): CustomAgent[] {
  if (value === undefined || value === null) return [];
  if (typeof value !== "string") {
    throw new Error(`${ACP_PLUGIN_ID} setting "${CUSTOM_AGENTS_SETTING}" is not a string`);
  }
  if (value.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `${ACP_PLUGIN_ID} setting "${CUSTOM_AGENTS_SETTING}" is not valid JSON; fix it in bb settings first: ${String(error)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${ACP_PLUGIN_ID} setting "${CUSTOM_AGENTS_SETTING}" must be a JSON array`);
  }
  return parsed as CustomAgent[];
}

export function serializeCustomAgentsSetting(agents: CustomAgent[]): string {
  return agents.length === 0 ? "" : JSON.stringify(agents, null, 2);
}

export function findManagedAgent(agents: CustomAgent[]): CustomAgent | undefined {
  return agents.find((agent) => agent?.id === AGENT_ID);
}

// Adds or refreshes the managed entry and leaves every other agent untouched.
export function upsertManagedAgent(
  agents: CustomAgent[],
  droidBinary: string,
): { agents: CustomAgent[]; changed: boolean; message: string } {
  const entry = managedAgentEntry(droidBinary);
  const next = [...agents];
  const index = next.findIndex((agent) => agent?.id === AGENT_ID);
  if (index < 0) {
    next.push(entry);
    return { agents: next, changed: true, message: `added custom ACP agent ${AGENT_ID} (${PROVIDER_ID})` };
  }
  const updated = { ...next[index], ...entry };
  const changed = JSON.stringify(updated) !== JSON.stringify(next[index]);
  next[index] = updated;
  return {
    agents: next,
    changed,
    message: changed
      ? `updated custom ACP agent ${AGENT_ID}`
      : `custom ACP agent ${AGENT_ID} already up to date`,
  };
}

// True when every managed field in the stored entry already matches the
// current shape, so self-repair has nothing to do.
export function entryMatchesCurrent(
  stored: CustomAgent | undefined,
  droidBinary: string,
): boolean {
  if (!stored) return false;
  const expected = managedAgentEntry(droidBinary);
  return Object.keys(expected).every(
    (key) => JSON.stringify(stored[key]) === JSON.stringify(expected[key]),
  );
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

export function hasLegacyEntry(configPath: string): boolean {
  try {
    const config = readConfig(configPath);
    return Array.isArray(config.customAcpAgents) && findManagedAgent(config.customAcpAgents as CustomAgent[]) !== undefined;
  } catch {
    return false;
  }
}

// Earlier releases wrote the agent into the deprecated customAcpAgents array
// in config.json. bb's config validator rejects that shape now, so the entry
// is removed once the setting owns it. Other agents in the array are kept.
export function removeLegacyEntry(configPath: string): boolean {
  const config = readConfig(configPath);
  if (!Array.isArray(config.customAcpAgents)) return false;
  const agents = config.customAcpAgents as CustomAgent[];
  const remaining = agents.filter((agent) => agent?.id !== AGENT_ID);
  if (remaining.length === agents.length) return false;
  if (remaining.length === 0) {
    delete config.customAcpAgents;
  } else {
    config.customAcpAgents = remaining;
  }
  writeAtomic(configPath, `${JSON.stringify(config, null, "\t")}\n`);
  return true;
}
