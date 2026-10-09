# Token Pulse

[English](README.md)

Token Pulse 是 OpenCode 的会话总量、缓存和任务时间插件。它提供两个彼此独立的
入口：server 负责记录完成用量和活动时间，TUI 负责显示这些总量。

需要 **OpenCode 1.18 或更高版本**。

## 功能

- 侧栏 Token Pulse 显示当前会话总量，包含 input、output、reasoning、
  cache read/write 和 cost，并递归计入子 agent。
- 会话有效工作时间会跨多轮对话、跨 OpenCode 重启累计。
- 用 `/tps` 或 `Ctrl+Shift+T` 打开历史视图。
- 用 `/tps-details`、命令面板中的 **Token Pulse details** 或 `Ctrl+Shift+Y`
  打开会话详情。

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
        "historyPath": ".tokpulse/history.jsonl",
        "maxRecords": 1000
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
        "historyPath": ".tokpulse/history.jsonl",
        "maxRecords": 1000
      }
    ]
  ]
}
```

即使 TUI 没开，server 也会继续记历史。TUI 读取同一套 JSONL 来显示已完成的
用量和活动时间。

使用已发布的 npm 包时，把上面的文件 URL 分别替换为：`opencode.json` 中的
`@komeijireimu/tokpulse/server` 和 `tui.json` 中的 `@komeijireimu/tokpulse/tui`。

## 会话总量与任务时间

总量包含 input、output、reasoning、cache read、cache write 和 cost。
侧栏总量计入有效的子 agent。展开 Token Pulse 可以分开查看当前会话自身的用量
和其子孙会话。

Magic Context 的 historian、dreamer 等维护任务及其后代，不计入 token、费用、
调用次数和任务耗时，也不进入用户 agent 列表。用户会话内的维护摘要只按消息排除，
该会话的其余内容继续统计。旧数据无法核实来源或缺少可安全撤销的原始贡献时，
保留原累计值，不猜测扣账。

任务耗时取用户任务及其有效子 agent 活跃区间的并集，并行工作只计一次。
所有有效工作结束后，耗时停止增长；维护任务不会延长它。

用 `/tps-details`、命令面板中的 **Token Pulse details** 或默认的 `Ctrl+Shift+Y`
打开详情。窗口包含打开时的当前会话及已识别的全部子孙 agent，可选择各 agent
查看其自身用量、缓存和任务时间，并查看整棵会话树的独立汇总。按 `Esc` 或 `Ctrl+C` 关闭。
`/tps` 和 `Ctrl+Shift+T` 仍用于打开历史视图。

在 `tui.json` 的插件配置选项中自定义详情快捷键：

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

`ctrl+shift+y,<leader>y` 由 OpenCode 按配置解析。将 `oc-tps.details` 设为 `"none"`
或 `false` 可禁用快捷键，slash 命令和命令面板入口仍可使用。此设置放在插件 options
内部，不放在顶层 `keybinds` 中。

## 历史记录与配置项

默认历史文件相对于 OpenCode worktree：

```text
.tokpulse/history.jsonl
```

活动时间和累计总量分别记在同目录的 `runs.jsonl` 和 `totals.json`。如果覆盖
`historyPath`，server 和 TUI 要用同一个路径。历史是 JSONL，每条完成的响应对应
一条记录，默认保留最近 **1000 条**。

使用默认路径启动时，Token Pulse 会将 `.opencode/oc-tps/` 中的旧 `history.jsonl`、
`runs.jsonl` 和 `totals.json` 复制到 `.tokpulse/`，保留原文件，且不覆盖目标位置
已有的数据。自定义路径不会自动迁移。如果配置显式使用旧路径，请同时修改 server
和 TUI 插件选项中的 `historyPath`，然后重启 OpenCode。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `historyPath` | `.tokpulse/history.jsonl` | worktree 下的相对路径，也可以是绝对路径。 |
| `runsPath` | 与 `historyPath` 同目录的 `runs.jsonl` | 活动账本路径。 |
| `maxRecords` | `1000` | 保留的响应记录数。 |

对于 Git 仓库，建议将项目本地账本排除在版本控制之外。可以在全局 `AGENTS.md`
中加入以下可复用规则：

```text
对于 Git 仓库，将项目下的 .tokpulse/ 目录加入 .gitignore。
```

在项目的 `.gitignore` 中加入这一目录行：

```gitignore
.tokpulse/
```

## 开发

```sh
bun test
bun run build
```

## 许可证

[GNU Affero General Public License v3.0 或更高版本](LICENSE)
