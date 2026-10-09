# Token Pulse

[简体中文](README.zh-CN.md)

Token Pulse is an OpenCode plugin for session totals, cache, and task time.
It ships two independent entry points: the server records completed usage and
activity, and the TUI shows those totals.

It requires **OpenCode 1.18 or later**.

## Features

- Session totals in the sidebar Token Pulse block, including input, output,
  reasoning, cache read/write, and cost, with recursive child-agent sessions.
- Persistent task time across turns and OpenCode restarts.
- History view via `/tps` or `Ctrl+Shift+T`.
- Session details via `/tps-details`, **Token Pulse details** in the command
  palette, or `Ctrl+Shift+Y`.

## Install

```sh
bun install
bun run build
```

The build writes `dist/server.js` and `dist/tui.js`. Configure OpenCode against
those files, not the TypeScript sources.

## OpenCode configuration

Enable both entries and keep the history settings the same. Replace the
absolute path with your checkout.

`opencode.json` (server):

```json
{
  "plugin": [
    [
      "file:///absolute/path/to/tokpulse/dist/server.js",
      {
        "historyPath": ".tokpulse/history.jsonl",
        "maxRecords": 1000
      }
    ]
  ]
}
```

`tui.json` (TUI):

```json
{
  "plugin": [
    [
      "file:///absolute/path/to/tokpulse/dist/tui.js",
      {
        "historyPath": ".tokpulse/history.jsonl",
        "maxRecords": 1000
      }
    ]
  ]
}
```

The server keeps recording even if the TUI is not running. The TUI reads the
same JSONL files for completed usage and activity.

For the published npm package, use `@komeijireimu/tokpulse/server` in
`opencode.json` and `@komeijireimu/tokpulse/tui` in `tui.json` in place of the
file URLs above.

## Session totals and task time

Totals include input, output, reasoning, cache read, cache write, and cost.
The sidebar total includes eligible child-agent sessions. Expand Token Pulse
to see the current session's own usage separately from its descendants.

Magic Context maintenance runs, including historian, dreamer and their descendants,
are excluded from token, cost, call, and task-time statistics and from agent
views. Maintenance summaries inside a user session are excluded per message;
the rest of that session remains counted. Historical data without verifiable
source information or the original contribution needed for safe reversal is
retained rather than deducted by guesswork.

Task time is the union of active intervals for the user task and its eligible
child agents, so parallel work is counted once. It stops increasing when all
eligible work has ended; maintenance work cannot extend it.

Open details with `/tps-details`, **Token Pulse details** in the command palette,
or the default `Ctrl+Shift+Y`. The view covers the session where it was opened and
its known descendant agents. Select an agent to inspect its own usage, cache, and
task time; a separate summary covers the entire tree. Press `Esc` or `Ctrl+C` to close.
`/tps` and `Ctrl+Shift+T` open history.

Customize the details shortcut in the TUI plugin's tuple options:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    [
      "@komeijireimu/tokpulse/tui",
      {
        "keybinds": {
          "oc-tps.details": "ctrl+shift+y,<leader>y"
        }
      }
    ]
  ]
}
```

OpenCode parses `ctrl+shift+y,<leader>y` as configured. Set `oc-tps.details` to
`"none"` or `false` to disable the shortcut; the slash command and palette entry
remain available. Keep this setting inside the plugin options, not the top-level
`keybinds` object.

## History and options

Default history file, relative to the OpenCode worktree:

```text
.tokpulse/history.jsonl
```

Activity timing and cumulative totals are stored beside it as `runs.jsonl` and
`totals.json`. If `historyPath` is overridden, use the same path in both configs.
History is JSONL, one record per completed response, kept to the most recent
**1,000 records** by default.

On startup with the default path, Token Pulse copies the old `history.jsonl`,
`runs.jsonl`, and `totals.json` from `.opencode/oc-tps/` into `.tokpulse/`, keeping
the originals and never overwriting existing destination data. Custom paths are
not automatically migrated. If your configs explicitly use the old path, update
`historyPath` in both the server and TUI plugin options, then restart OpenCode.

| Option | Default | Description |
| --- | --- | --- |
| `historyPath` | `.tokpulse/history.jsonl` | Relative path under the worktree, or an absolute path. |
| `runsPath` | same directory as `historyPath`, file `runs.jsonl` | Activity ledger path. |
| `maxRecords` | `1000` | Number of response records to keep. |

For Git repositories, keep project-local ledgers out of version control. You can
add this reusable rule to your global `AGENTS.md`:

```text
In Git repositories, add the project's .tokpulse/ directory to .gitignore.
```

Add this directory line to the project's `.gitignore`:

```gitignore
.tokpulse/
```

## Development

```sh
bun test
bun run build
```

## License

[GNU Affero General Public License v3.0 or later](LICENSE)
