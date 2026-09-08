# Token Pulse

[English](README.md)

Token Pulse 是 OpenCode 的 token 速度、会话总量和响应历史插件。它提供两个
彼此独立的入口：server 负责记录响应和活动时间，TUI 负责显示实时速度和会话
聚合。

需要 **OpenCode 1.18 或更高版本**。

## 功能

- 流式生成时，输入框旁显示实时 `tok/s`、已生成 token、TTFT 和耗时。
- 侧栏 Token Pulse 显示当前会话总量，并递归计入子 agent。
- 完成后的记录包含 TTFT、耗时、速度 avg/max/min、input、output、
  reasoning、cache read/write 和 cost。
- 会话有效工作时间会跨多轮对话、跨 OpenCode 重启累计。
- 用 `/tps` 或 `Ctrl+Shift+T` 打开历史视图。

流式阶段按 UTF-8 字节估算，默认 **5.5 bytes/token**（`bytesPerToken`）。
响应结束且 OpenCode 给出精确 usage 时，会用精确值替换估算。

## 安装

```sh
bun install
bun run build
```

构建会生成 `dist/server.js` 和 `dist/tui.js`。请把 OpenCode 配到这两个
文件，不要指向 TypeScript 源码。

## OpenCode 配置

两个入口都要启用，并且历史配置保持一致。把绝对路径换成你的项目目录。

`opencode.json`（server）：

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

`tui.json`（TUI）：

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

即使 TUI 没开，server 也会继续记历史。TUI 读取同一套 JSONL 来显示实时
和已完成数据。

如果通过 npm 包安装，两个配置文件都写 `@komeijireimu/tokpulse`。OpenCode
会按导出选择 `./server` 和 `./tui`，不要在包名后面再加 `/server` 或
`/tui`。

## 历史记录与配置项

默认历史文件相对于 OpenCode worktree：

```text
.opencode/oc-tps/history.jsonl
```

活动时间记在同目录的 `runs.jsonl`。如果覆盖 `historyPath`，server 和 TUI
要用同一个路径。历史是 JSONL，每条完成的响应对应一条记录，默认保留最近
**1000 条**。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `historyPath` | `.opencode/oc-tps/history.jsonl` | worktree 下的相对路径，也可以是绝对路径。 |
| `runsPath` | 与 `historyPath` 同目录的 `runs.jsonl` | 活动账本路径。 |
| `maxRecords` | `1000` | 保留的响应记录数。 |
| `bytesPerToken` | `5.5` | 流式阶段每个估算 token 对应的 UTF-8 字节数。 |

## 开发

```sh
bun test
bun run build
```

## 许可证

[GNU Affero General Public License v3.0 或更高版本](LICENSE)
