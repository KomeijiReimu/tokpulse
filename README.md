# Token Pulse

[简体中文](README.zh-CN.md)

Token Pulse shows session token usage, cache hit rate, cost, and task time in
OpenCode's sidebar.

Requires **OpenCode V2, 2.0.27 or later**.

## Features

- View usage for the current session and its child agents.
- Track background task time and retain recorded statistics across restarts.
- Browse response history and inspect session-tree details.

## Install

Build from source with Git and Bun:

```sh
git clone https://github.com/KomeijiReimu/tokpulse.git
cd tokpulse
bun install --frozen-lockfile
bun run build
```

Add the checkout's absolute path to `plugins` in `opencode.json` or
`opencode.jsonc`:

```json
{
  "plugins": [
    {
      "package": "/absolute/path/to/tokpulse"
    }
  ]
}
```

Start OpenCode in your working project. OpenCode loads the usage collector and
the **Token Pulse** sidebar together.

## Usage

Expand **Token Pulse** to compare the current session's own usage with its
descendants.

| View | Command | Default shortcut |
| --- | --- | --- |
| Response history | `/tps` | `Ctrl+Shift+T` |
| Session and child-agent details | `/tps-details` | `Ctrl+Shift+Y` |

Details are also available through **Token Pulse details** in the command
palette. Select an agent to inspect its usage, or use the tree summary for the
combined total. Press `Esc` or `Ctrl+C` to close.

### Understanding the metrics

The sidebar `total` combines uncached input, cache reads/writes, output, and
reasoning tokens. The `cache` percentage is the cache hit rate: cache reads
divided by the sum of uncached input, cache reads, and cache writes. Details show
the individual token counts and cost.

Task time covers the active intervals of the session and its eligible child
agents. Overlapping parallel work counts once, and the clock stops when all
eligible work ends. Timing uses recorded activity; missing historical intervals
cannot be reconstructed.

Identified Magic Context maintenance sessions, such as historian and dreamer,
and their descendants are excluded from usage and time. For a maintenance
summary inside a user session, filtering applies to that message; the rest of
the session remains counted.

## Data

Default runtime data is stored under `.tokpulse/` in the session's directory.
Response history is `.tokpulse/data/history.jsonl`; `maxRecords` controls how
many history entries are kept. Cumulative totals are saved separately and
continue across history pruning.

When a session or child agent moves, Token Pulse reads its old and new data
together. **Keep the previous directories' `.tokpulse/` folders** so their
recorded usage and task time remain available.

Upgrades automatically migrate the default legacy data and remove the obsolete
root-level lock directory. Custom data paths retain their configured locations.

Ignore `.tokpulse/` through `.git/info/exclude` for a local rule, or `.gitignore`
to share the rule with the repository.

To have an agent maintain these exclusions, add this rule to your global or
project `AGENTS.md`:

```text
In Git repositories, ignore Token Pulse's local runtime directory .tokpulse/.
Use .gitignore for shared rules or .git/info/exclude for local-only rules.
For custom data paths inside the repository, also ignore the data files and writer-lock directories.
```

## Options

Set options in the plugin entry's `options` object:

| Option | Default | Description |
| --- | --- | --- |
| `historyPath` | `.tokpulse/data/history.jsonl` | History path, relative to each session directory or absolute. |
| `runsPath` | `runs.jsonl` beside the history file | Activity data path. |
| `maxRecords` | `1000` | Number of response-history entries to retain. |

For example, this `options` value customizes the details shortcut:

```json
{
  "keybinds": {
    "oc-tps.details": "ctrl+shift+y,<leader>y"
  }
}
```

Set `keybinds.oc-tps.details` to `false` or `"none"` to disable that shortcut.
The details command remains available.

## Development

```sh
bun test --timeout 30000
```

License: [AGPL-3.0-or-later](LICENSE).
