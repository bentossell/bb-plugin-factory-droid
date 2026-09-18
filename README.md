# bb-plugin-factory-droid

Use [Factory Droid](https://docs.factory.ai/) as a first-class agent provider in bb.
The plugin registers Droid's native [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) server as `acp-factory-droid`, including Droid's live model catalog and reasoning controls.

## Requirements

- bb 0.41 or newer
- Factory Droid CLI with ACP support (tested with 0.186.0 through 0.221.0)
- A Factory account, or `FACTORY_API_KEY` already available to Droid

Install Droid using the [Factory quickstart](https://docs.factory.ai/droid-cli/quickstart):

```bash
curl -fsSL https://app.factory.ai/cli | sh
```

Run `droid` once to complete Factory's browser sign-in flow. Authentication remains owned by Droid; this plugin never stores or copies Factory credentials.

## Install

```bash
bb plugin install ./bb-plugin-factory-droid
bb factory-droid setup
```

`setup` is safe to rerun. It locates the Droid executable, adds the managed agent to the `customAgents` setting of bb's builtin `provider-acp` plugin, and waits until bb reports the provider as registered. Other agents in that setting are left alone.

On every bb start the plugin also self-repairs: if the managed entry is missing, has an outdated shape, or points at a droid binary that has since moved (for example after a Homebrew upgrade), it rewrites the setting automatically. Nothing is written when droid is not installed.

Versions before 0.2.1 wrote the agent into the deprecated `customAcpAgents` array in `config.json`. Current bb rejects that shape, so `setup` (and self-repair) move the entry into the setting and remove the old one.

bb's permission mode picker controls droid's autonomy tiers:

| bb mode | droid flag |
| --- | --- |
| accept-edits / auto | `--auto medium` |
| full | `--auto high` |
| read-only contexts | none (droid exec defaults to read-only) |

Verify the complete integration:

```bash
bb factory-droid status
bb provider list
bb provider models acp-factory-droid
```

Start a thread from the bb UI by selecting **Factory Droid**, or from the CLI:

```bash
bb thread spawn \
  --provider acp-factory-droid \
  --model claude-sonnet-4-6 \
  --prompt "Inspect this project and summarize its architecture."
```

## How it works

The bb plugin SDK does not currently register providers directly. This plugin writes an entry into the `customAgents` setting of bb's builtin `provider-acp` plugin (`bb plugin config provider-acp`):

```json
{
  "id": "factory-droid",
  "displayName": "Factory Droid",
  "command": "/absolute/path/to/droid",
  "args": ["exec", "--output-format", "acp"],
  "permissionCli": {
    "workspaceWrite": ["--auto", "medium"],
    "full": ["--auto", "high"]
  }
}
```

`permissionCli` lists no `readonly` entry on purpose: bb requires at least one flag for every listed mode and drops the whole agent otherwise, and `droid exec` is read-only by default.

Droid advertises its model catalog, modes, authentication methods, and session options over ACP. The plugin deliberately does **not** scrape `droid --help` or duplicate a hard-coded model list. Droid permission requests continue through bb's normal approval UI.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

Path installs load TypeScript directly. The build command creates a distributable `dist/` bundle for npm/git packaging.

## Troubleshooting

- **Droid CLI: NOT FOUND** — install Droid or ensure it is executable on `PATH`; setup also checks `~/.local/bin/droid`, `~/.factory/bin/droid`, Homebrew paths, and `/usr/local/bin`.
- **Provider not registered** — rerun `bb factory-droid setup` and read `bb plugin logs provider-acp`; it names the field that failed validation. Then run `bb factory-droid status`.
- **Authentication prompt** — run `droid` in a terminal and sign in, or configure `FACTORY_API_KEY` using Factory's documentation. Secrets are not written into bb's plaintext config.
- **Older Droid version** — update with `droid update`; `--output-format acp` may be intentionally hidden from `droid exec --help` even when supported.

## License

MIT
