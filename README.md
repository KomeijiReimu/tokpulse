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
- Completion records with TTFT, duration, avg/max/min speed, input, output,
  reasoning, cache read/write, and cost.
- Persistent session run time across turns and OpenCode restarts.
- History view via `/tps` or `Ctrl+Shift+T`.

Streaming token counts are estimated from UTF-8 bytes at **5.5 bytes/token**
by default (`bytesPerToken`). Exact OpenCode usage replaces those estimates
when a response completes.

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

If you install the npm package, put `@komeijireimu/tokpulse` in both config
files. OpenCode picks `./server` and `./tui` from the package exports; do not
append `/server` or `/tui` to the package name.

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
