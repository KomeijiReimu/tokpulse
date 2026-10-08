# Token Pulse

[English](README.md)

Token Pulse 是 OpenCode 的 token 速度、会话总量和响应历史插件。它提供两个
彼此独立的入口：server 负责记录响应和活动时间，TUI 负责显示实时速度和会话
聚合。

需要 **OpenCode 1.18 或更高版本**。

## 功能

- 流式生成时，输入框旁显示实时 `tok/s`、已生成 token、TTFT 和耗时。
- 侧栏 Token Pulse 显示当前会话总量，并递归计入子 agent。
- 额外显示当前会话自身 agent 的加权平均 TPS，排除子 agent。
- 完成后的记录包含 TTFT、耗时、速度 avg/max/min、input、output、
  reasoning、cache read/write 和 cost。
- 会话有效工作时间会跨多轮对话、跨 OpenCode 重启累计。
- 用 `/tps` 或 `Ctrl+Shift+T` 打开历史视图。
- 用 `/tps-details`、命令面板中的 **Token Pulse details** 或 `Ctrl+Shift+Y`
  打开会话速度详情。

流式阶段按 UTF-8 字节估算，默认 **5.5 bytes/token**（`bytesPerToken`）。
响应结束且 OpenCode 给出精确 usage 时，会用精确值替换用量估算。
实时速度及峰值、谷值仍按字节到达窗口估算。

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

使用已发布的 npm 包时，把上面的文件 URL 分别替换为：`opencode.json` 中的
`@komeijireimu/tokpulse/server` 和 `tui.json` 中的 `@komeijireimu/tokpulse/tui`。

## 速度与会话详情

主速度指标是**生成 TPS**，计入 output 和可观测的 reasoning。`~` 表示宿主观测的
估算值：事件到达时间无法揭示服务商内部的精确生成速度。完成后的测量需要
**两个不同到达批次**，且完整内容观测与最终响应一致。**100–999ms** 的短观测，
在每次到达都有可信单调时钟证据时，也可作为低置信估算计入均速。
单批到达或极短突发不足以计算生成 TPS。
首批 token 按各类别的观测字节占比和最终 usage 估算后排除，因此区间 token 数始终
是估算值。重试污染、中断或内容观测不完整的响应没有可用生成 TPS。

- **主会话均速**：使用当前会话自身的累计生成测量，排除子 agent。展开 Token Pulse
  可查看该均速及覆盖情况。
- **紧凑速度**：使用包含用户任务子孙 agent 的累计生成测量，与包含子 agent 的用量总计一致。
- **响应吞吐量**：单独按完整响应耗时计算，包含 TTFT，也可能包含工具等待时间。
  生成 TPS 缺失时显示 `--`，不以响应吞吐量代替。

累计生成 TPS 按**区间估算 token 总和 / 测量秒数总和**计算，保存在历史文件同目录的
`totals.json` 中，历史记录裁剪后仍会保留。覆盖情况（coverage）显示合格响应数及其
**完整生成用量**，与区间 token 估算分开。已保存的合格测量在重启和历史裁剪后继续
保留。旧历史无法补齐缺失的生成观测。

实时速度和历史峰值仍需要至少 **1 秒**的观察时长和**两个不同时间点**的观测。
等待首内容与已有内容的预热状态分开显示；响应完成后，显示最后结果或不可测原因，
不再维持实时生成状态。

Magic Context 的 historian、dreamer 等维护任务及其后代，不计入 token、费用、调用次数、
速度和任务耗时，也不进入用户 agent 列表。用户会话内的维护摘要只按消息排除，
该会话的其余内容继续统计。旧数据无法核实来源或缺少可安全撤销的原始贡献时，
保留原累计值，不猜测扣账。

任务耗时取用户任务及其有效子 agent 活跃区间的并集，并行工作只计一次。
所有有效工作结束后，耗时停止增长；维护任务不会延长它。

用 `/tps-details`、命令面板中的 **Token Pulse details** 或默认的 `Ctrl+Shift+Y`
打开详情。窗口包含打开时的当前会话及已识别的全部子孙 agent，可选择各 agent
查看其自身用量和平均速度，并查看整棵会话树的独立汇总。按 `Esc` 或 `Ctrl+C` 关闭。
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
