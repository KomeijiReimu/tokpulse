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
values replace the corresponding token estimates.

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

The session-only averages use **total generated tokens / total measured seconds**
across covered completed responses. Generated tokens include output and reasoning;
child-agent responses are excluded. The accumulated token and time sums persist
in `totals.json` beside the history file and survive history trimming.

- **Generation average** estimates throughput over measured generation intervals.
- **Response average** uses the full response duration, including TTFT and
  possibly tool wait time.

Coverage shows the responses and tokens with measurements. Older data may lack
the timing needed for one or both averages, so historical coverage can be partial.
An average is unavailable when there is no usable measurement.

Live speed estimates token arrivals. It needs at least **1 second** and **two
distinct observation timestamps**; until then, the display shows `WARMUP`.

Open details with `/tps-details`, **Token Pulse details** in the command palette,
or the default `Ctrl+Shift+Y`. The view captures the current session's scope when
opened. Press `Esc` or `Ctrl+C` to close. `/tps` and `Ctrl+Shift+T` open history.

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
