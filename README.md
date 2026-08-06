# bb-plugin-factory-droid

Use [Factory Droid](https://docs.factory.ai/) as a first-class agent provider in bb.
The plugin registers Droid's native [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) server as `acp-factory-droid`, including Droid's live model catalog and reasoning controls.

## Requirements

- bb 0.35 or newer
- Factory Droid CLI with ACP support (tested with 0.186.0)
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

`setup` is safe to rerun. It locates the Droid executable, writes the provider logo, merges only the managed `customAcpAgents` entry into bb's `config.json`, and reloads bb's runtime configuration.

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

The bb plugin SDK does not currently register providers directly. This plugin uses bb's supported `customAcpAgents` configuration:

```json
{
  "id": "factory-droid",
  "displayName": "Factory Droid",
  "command": "/absolute/path/to/droid",
  "args": ["exec", "--output-format", "acp"]
}
```

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
- **Provider not registered** — rerun `bb factory-droid setup`, restart bb if the config reload warning appears, then run `bb factory-droid status`.
- **Authentication prompt** — run `droid` in a terminal and sign in, or configure `FACTORY_API_KEY` using Factory's documentation. Secrets are not written into bb's plaintext config.
- **Older Droid version** — update with `droid update`; `--output-format acp` may be intentionally hidden from `droid exec --help` even when supported.

## License

MIT
