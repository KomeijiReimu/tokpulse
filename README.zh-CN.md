# oc-tps

[English](README.md)

`oc-tps` 是一个用于 OpenCode 的 token 吞吐量和响应历史插件。项目提供
彼此独立的 server 与 TUI 两个入口：server 负责记录响应数据，TUI 负责
显示实时速度和历史聚合结果。

插件面向 **OpenCode v1.18.x**，package.json 中声明的引擎要求为
`>=1.18.0`。

## 功能

- **实时 token 速度：** 响应流式生成时，TUI 提示区显示 rolling 10 秒
  `tok/s` 速度，以及已生成 token 数、TTFT 和耗时。
- **流式阶段估算：** 流式文本按 UTF-8 字节数统计，默认按 **5.5 个
  UTF-8 bytes/token** 估算；可通过 `bytesPerToken` 修改。
- **完成后校准：** OpenCode 提供精确 completion usage 时，保存的 output
  和 reasoning 样本会按精确总数重新校准；缺少精确字段时使用流式估算
  作为回退。
- **响应指标：** 历史记录包含 TTFT、耗时、速度 avg/max/min、output
  token、reasoning token、input token、cache read/write token 和 cost。
- **Session 聚合：** 通过 OpenCode 的 `Session.parentID` 关系递归统计
  子 agent session。
- **历史视图：** 执行 `/tps` 或按下 `Ctrl+Shift+T`，在 TUI 中打开当前
  session 的 token 历史。

## 安装与构建

在本地项目目录执行：

```sh
npm install
npm run build
```

构建会生成 `dist/server.js` 和 `dist/tui.js` 两个 JavaScript 入口，
并生成 `dist/` 下的其他支持文件。配置 OpenCode 前请先完成构建。

## OpenCode 配置

请同时启用两个入口，并在两个文件中使用相同的历史配置。对于本地项目，
将 `/absolute/path/to/your/checkout` 替换为项目的绝对路径。

`opencode.json`（server 入口）：

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

`tui.json`（TUI 入口）：

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

两个入口彼此独立。即使 TUI 没有运行，server 仍可继续记录历史；TUI
会读取 JSONL 文件来显示实时数据和已完成响应。不要将配置指向 TypeScript
源文件。

如果通过 npm 包安装，请在两个配置文件中使用同一个包名 `oc-tps`。
OpenCode 会根据目标自动选择包内部的 `./server` 和 `./tui` 导出入口，配置
时不要在包名后追加 `/server` 或 `/tui`。这里仅说明包的入口布局，不声称
该包已经发布到公共 npm registry。

## 历史记录与配置项

默认历史文件为：

```text
.opencode/oc-tps/history.jsonl
```

该路径相对于 OpenCode worktree；当 worktree 为 `/` 时，改用项目目录。
如果覆盖 `historyPath`，server 和 TUI 应使用同一个路径。历史以 JSONL
保存，每条响应消息对应一条记录；默认会裁剪为最近的 **最多 1000 条记录**。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `historyPath` | `.opencode/oc-tps/history.jsonl` | worktree 下的相对路径，也可以是绝对路径。 |
| `maxRecords` | `1000` | 要保留的响应记录数，必须为正数。 |
| `bytesPerToken` | `5.5` | 流式阶段每个估算 token 对应的 UTF-8 字节数。 |

## 测试与构建

运行测试：

```sh
npm test
```

运行生产构建：

```sh
npm run build
```
