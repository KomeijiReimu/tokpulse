# Token Pulse

[简体中文](README.zh-CN.md)

Token Pulse is an OpenCode plugin for live token speed, session totals, and
response history. It ships two independent entry points: the server records
responses and activity, and the TUI renders live speed plus session aggregates.

It requires **OpenCode 1.18 or later**.

## Features

- Live `tok/s` in the prompt while a response streams, with generated tokens,
  TTFT, and elapsed time.
- Session totals in the sidebar Token Pulse block, including recursive
  child-agent sessions.
- Additional weighted average TPS for the current session's own agent,
  excluding child agents.
- Completion records with TTFT, duration, avg/max/min speed, input, output,
  reasoning, cache read/write, and cost.
- Persistent session run time across turns and OpenCode restarts.
- History view via `/tps` or `Ctrl+Shift+T`.
- Session speed details via `/tps-details`, **Token Pulse details** in the
  command palette, or `Ctrl+Shift+Y`.

Streaming token counts are estimated from UTF-8 bytes at **5.5 bytes/token**
by default (`bytesPerToken`). When OpenCode provides usage at completion, those
values replace the corresponding usage estimates. Live and peak/minimum speeds
remain byte-based arrival estimates.

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
        "historyPath": ".opencode/oc-tps/history.jsonl",
        "maxRecords": 1000,
        "bytesPerToken": 5.5
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
        "historyPath": ".opencode/oc-tps/history.jsonl",
        "maxRecords": 1000,
        "bytesPerToken": 5.5
      }
    ]
  ]
}
```

The server keeps recording even if the TUI is not running. The TUI reads the
same JSONL files for live and completed data.

For the published npm package, use `@komeijireimu/tokpulse/server` in
`opencode.json` and `@komeijireimu/tokpulse/tui` in `tui.json` in place of the
file URLs above.

## Speed and session details

The primary speed is **generation TPS**, including output and observable reasoning.
`~` marks a host-observed estimate: event arrival timing cannot reveal the
provider's exact internal generation speed. A completed measurement needs at least
**1 second** between the first and last nonempty deltas and **two distinct arrival
batches**, with complete content observations matching the final response.
Tokens in the first batch are excluded using each category's share of observed
bytes and its final usage; this interval token count is always an estimate.
Retry-contaminated, interrupted, or incomplete observations have no generation TPS.

- **Main average** uses the current session's own cumulative generation measurements,
  excluding child agents. Expand Token Pulse to see this average and its coverage.
- **Compact speed** uses cumulative generation measurements including descendant
  agents, matching the inclusive usage totals.
- **Response throughput** is separate: it uses the full response duration,
  including TTFT and possibly tool wait time. It never substitutes for generation
  TPS; missing generation measurements display `--`.

Cumulative generation TPS is **total estimated interval tokens / total measured
seconds**, persisted in `totals.json` beside history and retained after history
trimming. Coverage reports qualified responses and their **full generated usage**,
not just the interval token estimates. Speed measurements start fresh with this
observation basis; existing token, cost, call, and response-throughput totals are
retained. Older history cannot supply the missing generation observations.

Live speed estimates token arrivals. It needs at least **1 second** and **two
distinct observation timestamps**; until then, the display shows `WARMUP`.

Open details with `/tps-details`, **Token Pulse details** in the command palette,
or the default `Ctrl+Shift+Y`. The view covers the session where it was opened and
its known descendant agents. Select an agent to inspect its own usage and averages;
a separate summary covers the entire tree. Press `Esc` or `Ctrl+C` to close.
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
.opencode/oc-tps/history.jsonl
```

Activity timing is stored beside it as `runs.jsonl`. If `historyPath` is
overridden, use the same path in both configs. History is JSONL, one record
per completed response, kept to the most recent **1,000 records** by default.

| Option | Default | Description |
| --- | --- | --- |
| `historyPath` | `.opencode/oc-tps/history.jsonl` | Relative path under the worktree, or an absolute path. |
| `runsPath` | same directory as `historyPath`, file `runs.jsonl` | Activity ledger path. |
| `maxRecords` | `1000` | Number of response records to keep. |
| `bytesPerToken` | `5.5` | UTF-8 bytes per estimated token while streaming. |

## Development

```sh
bun test
bun run build
```

## License

[GNU Affero General Public License v3.0 or later](LICENSE)
