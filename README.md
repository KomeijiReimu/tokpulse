# oc-tps

[简体中文](README.zh-CN.md)

`oc-tps` is an OpenCode plugin for monitoring token throughput and response
history. It has separate server and TUI entry points: the server records
response data, while the TUI shows live speed and historical aggregates.

The plugin targets **OpenCode v1.18.x**. The package engine declaration is
`>=1.18.0`.

## Features

- **Live token speed:** the TUI prompt shows a rolling 10-second `tok/s` rate
  while a response streams, along with generated tokens, TTFT, and elapsed
  time.
- **Estimated streaming counts:** streamed text is measured as UTF-8 bytes and
  estimated at the default rate of **5.5 bytes per token**. The rate can be
  changed with `bytesPerToken`.
- **Completion calibration:** when OpenCode provides exact completion usage,
  the saved output and reasoning samples are recalibrated to those exact
  totals. Stream estimates remain the fallback when exact fields are absent.
- **Response metrics:** history includes TTFT, duration, average/maximum/
  minimum speed, output tokens, reasoning tokens, input tokens, cache
  read/write tokens, and cost.
- **Session aggregation:** totals include child-agent sessions recursively
  through OpenCode's `Session.parentID` relationship.
- **History view:** run `/tps` or press `Ctrl+Shift+T` to open the current
  session's token history in the TUI.

## Install and build

From a local checkout:

```sh
npm install
npm run build
```

The build emits the JavaScript entry points `dist/server.js` and `dist/tui.js`
(as well as the supporting files under `dist/`). Build before configuring
OpenCode.

## OpenCode configuration

Enable both entries and use the same history settings in both files. For a
local checkout, replace `/absolute/path/to/your/checkout` with the checkout's
absolute path.

`opencode.json` (server entry):

```json
{
  "plugin": [
    [
      "file:///absolute/path/to/your/checkout/dist/server.js",
      {
        "historyPath": ".opencode/oc-tps/history.jsonl",
        "maxRecords": 1000,
        "bytesPerToken": 5.5
      }
    ]
  ]
}
```

`tui.json` (TUI entry):

```json
{
  "plugin": [
    [
      "file:///absolute/path/to/your/checkout/dist/tui.js",
      {
        "historyPath": ".opencode/oc-tps/history.jsonl",
        "maxRecords": 1000,
        "bytesPerToken": 5.5
      }
    ]
  ]
}
```

The two entries are independent. The server can continue recording history
when the TUI is not running, and the TUI reads the JSONL file to display live
and completed data. Do not point either configuration at the TypeScript source
files.

For an npm package installation, use the same package name `oc-tps` in both
configuration files. OpenCode selects the internal `./server` and `./tui`
exports according to the target; do not append `/server` or `/tui` to the
configured package name. This describes the package layout and does not claim
that a public npm release is available.

## History and options

The default history file is:

```text
.opencode/oc-tps/history.jsonl
```

The path is relative to the OpenCode worktree. If the worktree is `/`, the
project directory is used instead. The server and TUI should use the same path
when `historyPath` is overridden. History is stored as JSONL, with one record
per response message, and is pruned to the most recent **1,000 records by
default**.

| Option | Default | Description |
| --- | --- | --- |
| `historyPath` | `.opencode/oc-tps/history.jsonl` | Relative path under the worktree, or an absolute path. |
| `maxRecords` | `1000` | Positive number of response records to retain. |
| `bytesPerToken` | `5.5` | UTF-8 bytes per estimated token during streaming. |

## Tests and build

Run the test suite with:

```sh
npm test
```

Run the production build with:

```sh
npm run build
```
