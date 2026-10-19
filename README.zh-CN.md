# Token Pulse

[English](README.md)

Token Pulse 是 OpenCode 的会话总量、缓存和任务时间插件。它提供两个彼此独立的
入口：server 负责记录完成用量和活动时间，TUI 负责显示这些总量。

需要 **OpenCode V2，2.0.27 或更高版本**。

## 功能

- 侧栏 Token Pulse 显示当前会话总量，包含 input、output、reasoning、
  cache read/write 和 cost，并递归计入子 agent。
  插件位于侧栏可滚动列表的内部末尾，不占用列表外侧的固定底部。
- 会话有效工作时间会跨多轮对话、跨 OpenCode 重启累计。
- 用 `/tps` 或 `Ctrl+Shift+T` 打开历史视图。
- 用 `/tps-details`、命令面板中的 **Token Pulse details** 或 `Ctrl+Shift+Y`
  打开会话详情。

## 安装

```sh
bun install --frozen-lockfile
bun run build
```

构建会生成 `dist/server.js` 和 `dist/tui.js`。
V2 请按下方配置加载构建后的 `dist` 目录。

## OpenCode 配置

### OpenCode V2

在 `opencode.json(c)` 中添加构建后的 `dist` 目录。OpenCode 会自动加载 server
入口和包的 `./tui` 入口。把绝对路径换成你的项目目录。

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

使用支持 V2 的已发布版本时，将 `package` 换成 `@komeijireimu/tokpulse`。
包的 TUI 会自动加载，再将它加入 `cli.json` 会重复启用。

即使 TUI 没开，server 也会继续记历史。TUI 读取同一套 JSONL 来显示已完成的
用量和活动时间。

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
纯维护任务的耗时为零。混合任务只扣除可确认的维护活动区间，重叠的正常工作仍计时。

用 `/tps-details`、命令面板中的 **Token Pulse details** 或默认的 `Ctrl+Shift+Y`
打开详情。窗口包含打开时的当前会话及已识别的全部子孙 agent，可选择各 agent
查看其自身用量和缓存，并查看整棵会话树的独立汇总。按 `Esc` 或 `Ctrl+C` 关闭。
`/tps` 和 `Ctrl+Shift+T` 仍用于打开历史视图。

在包的插件配置选项中自定义详情快捷键：

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

`ctrl+shift+y,<leader>y` 由 OpenCode 按配置解析。将 `oc-tps.details` 设为 `"none"`
或 `false` 可禁用快捷键，slash 命令和命令面板入口仍可使用。此设置放在插件 options
内部，不放在顶层 `keybinds` 中。

## 历史记录与配置项

默认历史文件相对于当前项目工作目录：

```text
.tokpulse/history.jsonl
```

活动时间和累计总量分别记在同目录的 `runs.jsonl` 和 `totals.json`。如果覆盖
`historyPath`，server 和 TUI 要用同一个路径。历史是 JSONL，每条完成的响应对应
一条记录，默认保留最近 **1000 条**。

账本恢复和写入仅由 server 执行，打开 TUI 只会读取数据。排他锁防止两个后台同时
写入同一账本；锁元数据位于账本目录旁的 `.tokpulse-writer-locks/`，后台运行时
不要删除它。

已成功写入的事实会保留到前台关闭、进程重启之后。未能写入的事实无法在原进程
退出后恢复；突然断电和不可靠的网络文件系统不在此恢复保证内。历史缺失的开始
时间不会凭猜测补写。

使用默认路径启动时，Token Pulse 会将 `.opencode/oc-tps/` 中的旧 `history.jsonl`、
`runs.jsonl` 和 `totals.json` 复制到 `.tokpulse/`，保留原文件，且不覆盖目标位置
已有的数据。自定义路径不会自动迁移。如果配置显式使用旧路径，请同时修改 server
和 TUI 插件选项中的 `historyPath`，然后重启 OpenCode。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `historyPath` | `.tokpulse/history.jsonl` | 项目工作目录下的相对路径，也可以是绝对路径。 |
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
