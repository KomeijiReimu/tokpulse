# Token Pulse

[简体中文](README.zh-CN.md)

Token Pulse is an OpenCode plugin for session totals, cache, and task time.
It ships two independent entry points: the server records completed usage and
activity, and the TUI shows those totals.

Requires **OpenCode V2, 2.0.27 or later**.

## Features

- Session totals in the sidebar Token Pulse block, including input, output,
  reasoning, cache read/write, and cost, with recursive child-agent sessions.
  The block sits at the end of the sidebar's scrollable list, not in a fixed footer.
- Persistent task time across turns and OpenCode restarts.
- History view via `/tps` or `Ctrl+Shift+T`.
- Session details via `/tps-details`, **Token Pulse details** in the command
  palette, or `Ctrl+Shift+Y`.

## Install

```sh
bun install --frozen-lockfile
bun run build
```

The build writes `dist/server.js` and `dist/tui.js`.
Configure V2 against the built `dist` directory.

## OpenCode configuration

### OpenCode V2

Add the built `dist` directory to `opencode.json(c)`. OpenCode loads the server
entry and its `./tui` entry automatically. Replace the absolute path with your
checkout.

```json
{
  "plugins": [
    {
      "package": "/absolute/path/to/tokpulse/dist",
      "options": {
        "historyPath": ".tokpulse/history.jsonl",
        "maxRecords": 1000
      }
    }
  ]
}
```

For a published package version with V2 support, use `@komeijireimu/tokpulse` as
the `package` value. The package's TUI loads automatically; adding it again to
`cli.json` would enable a duplicate entry.

The server keeps recording even if the TUI is not running. The TUI reads the
same JSONL files for completed usage and activity.

## Session totals and task time

Totals include input, output, reasoning, cache read, cache write, and cost.
The sidebar total includes eligible child-agent sessions. Expand Token Pulse
to see the current session's own usage separately from its descendants.

The collapsed sidebar's `cache` percentage is the cache hit rate:
cache read divided by the sum of uncached input, cache read, and cache write.
Session details show the cache read and write token counts separately.

Magic Context maintenance runs, including historian, dreamer and their descendants,
are excluded from token, cost, call, and task-time statistics and from agent
views. Maintenance summaries inside a user session are excluded per message;
the rest of that session remains counted. Historical data without verifiable
source information or the original contribution needed for safe reversal is
retained rather than deducted by guesswork.

Task time is the union of active intervals for the user task and its eligible
child agents, so parallel work is counted once. It stops increasing when all
eligible work has ended; maintenance work cannot extend it.
Maintenance-only runs add no time. In mixed runs, only identified maintenance
intervals are excluded; overlapping user work remains counted.

Open details with `/tps-details`, **Token Pulse details** in the command palette,
or the default `Ctrl+Shift+Y`. The view covers the session where it was opened and
its known descendant agents. Select an agent to inspect its own usage and cache;
a separate summary covers the entire tree. Press `Esc` or `Ctrl+C` to close.
`/tps` and `Ctrl+Shift+T` open history.

Customize the details shortcut in the package's plugin options:

```json
{
  "plugins": [
    {
      "package": "/absolute/path/to/tokpulse/dist",
      "options": {
        "keybinds": {
          "oc-tps.details": "ctrl+shift+y,<leader>y"
        }
      }
    }
  ]
}
```

OpenCode parses `ctrl+shift+y,<leader>y` as configured. Set `oc-tps.details` to
`"none"` or `false` to disable the shortcut; the slash command and palette entry
remain available. Keep this setting inside the plugin options, not the top-level
`keybinds` object.

## History and options

Default history file, relative to the session's directory:

```text
.tokpulse/history.jsonl
```

Activity timing and cumulative totals are stored beside it as `runs.jsonl` and
`totals.json`. Separate server and TUI entries must use the same `historyPath`.
History is JSONL, one record per completed response, kept to the most recent
**1,000 records** by default.

Opening a session from another directory uses that session's ledger directory.
When a session or child agent moves, Token Pulse uses OpenCode's recorded move
history to read its previous and current ledgers together. Responses are counted
once and overlapping activity intervals are unioned, preserving accumulated
usage and task time when moving or reopening the session.
The TUI also uses live execution events to update task time for background child
sessions working in another directory.

Relative `historyPath` values resolve under each recorded directory; absolute
paths stay fixed and shared ledger paths are counted once. Browsing only reads existing
ledgers. Keep previous ledger directories available: unavailable sources are
reported as incomplete while successfully loaded data remains visible.
If a historical child session no longer exists in OpenCode, its missing metadata
is reported separately. Already loaded statistics stay visible, and discovery
continues for other sessions.

The server owns ledger recovery and writes; opening the TUI only reads them.
It also creates `.tokpulse-writer-locks/` beside the ledger directory (in the
project root with default paths). Its SQLite lock files prevent two backends
from writing the same ledger. Do not remove it while the server is running.

Successfully written facts survive closing the frontend and restarting the
process. Facts that could not be written cannot be recovered after that process
exits. Sudden power loss and unreliable network filesystems are outside this
recovery guarantee. Missing historical start times are not guessed or filled in.

On startup with the default path, Token Pulse copies the old `history.jsonl`,
`runs.jsonl`, and `totals.json` from `.opencode/oc-tps/` into `.tokpulse/`, keeping
the originals and never overwriting existing destination data. Custom paths are
not automatically migrated. If your configs explicitly use the old path, update
`historyPath` in both the server and TUI plugin options, then restart OpenCode.

| Option | Default | Description |
| --- | --- | --- |
| `historyPath` | `.tokpulse/history.jsonl` | Relative path under the session directory, or an absolute path. |
| `runsPath` | same directory as `historyPath`, file `runs.jsonl` | Activity ledger path. |
| `maxRecords` | `1000` | Number of response records to keep. |

For Git repositories, keep project-local ledger and writer-lock directories out
of version control. You can add this reusable rule to your global `AGENTS.md`:

```text
In Git repositories, ignore Token Pulse's local .tokpulse/ and
.tokpulse-writer-locks/ directories, .tokpulse-migrate-*/ staging directories,
and any retained legacy data in .opencode/oc-tps/.
```

Add these directory lines to the project's `.gitignore`:

```gitignore
.tokpulse/
.tokpulse-writer-locks/
.tokpulse-migrate-*/
.opencode/oc-tps/
```

The first two rules also cover temporary ledger writes, corrupt-ledger backups,
and SQLite lock files. Migration staging directories are normally removed after
migration, but can remain after abrupt process termination. The legacy directory
contains data retained from older versions. For custom ledger paths inside the
repository, also ignore those files or their dedicated data directories and the
adjacent `.tokpulse-writer-locks/` directory.

## Development

```sh
bun test
bun run build
```

## License

[GNU Affero General Public License v3.0 or later](LICENSE)
