# Token Pulse

[English](README.md)

Token Pulse 在 OpenCode 侧栏显示会话 token 用量、缓存命中率、费用和任务耗时。

需要 **OpenCode V2，2.0.27 或更高版本**。

## 功能

- 查看当前会话及子 agent 的用量。
- 实时跟踪后台任务耗时，重启后保留已记录的统计。
- 浏览响应历史和会话树详情。

## 安装

使用 Git 和 Bun 从源码构建：

```sh
git clone https://github.com/KomeijiReimu/tokpulse.git
cd tokpulse
bun install --frozen-lockfile
bun run build
```

在 `opencode.json` 或 `opencode.jsonc` 的 `plugins` 中加入仓库的绝对路径：

```json
{
  "plugins": [
    {
      "package": "/absolute/path/to/tokpulse"
    }
  ]
}
```

在要工作的项目中启动 OpenCode，统计采集与 **Token Pulse** 侧栏会一并加载。

## 使用

展开 **Token Pulse**，可分别查看当前会话自身和子孙会话的用量。

| 视图 | 命令 | 默认快捷键 |
| --- | --- | --- |
| 响应历史 | `/tps` | `Ctrl+Shift+T` |
| 会话及子 agent 详情 | `/tps-details` | `Ctrl+Shift+Y` |

也可从命令面板选择 **Token Pulse details** 打开详情。选择一个 agent 查看其用量，
或查看整棵会话树的汇总。按 `Esc` 或 `Ctrl+C` 关闭。

### 统计说明

侧栏 `total` 包含未缓存输入、缓存读写、输出和推理 token。`cache` 百分比是缓存
命中率：缓存读取量占未缓存输入、缓存读取和缓存写入总量的比例。详情中可查看
各项 token 数和费用。

任务耗时覆盖当前会话及有效子 agent 的活跃时段，重叠的并行工作只计一次。
所有有效工作结束后停止计时。耗时根据已记录的活动计算，缺失的历史时段无法补算。

已识别的 Magic Context 维护任务（如 historian、dreamer）及其后代不计入用量和耗时。
用户会话中的维护摘要只排除对应消息，其余会话内容继续统计。

## 数据保存

默认运行数据保存在会话所属目录的 `.tokpulse/` 中，响应历史文件为
`.tokpulse/data/history.jsonl`。`maxRecords` 控制历史明细的保留条数，长期累计
独立保存，历史裁剪后继续保留。

会话或子 agent 移动后，插件会联合读取新旧目录的数据。**请保留原目录中的
`.tokpulse/`**，以便继续查看已记录的用量和任务耗时。

升级时会自动迁移默认位置的旧数据，并清理旧的根目录锁文件夹。自定义数据路径
继续沿用原配置。

将 `.tokpulse/` 写入 `.git/info/exclude` 可仅在本地忽略；写入 `.gitignore` 则可
随仓库共享该规则。

在全局或项目的 `AGENTS.md` 中加入以下规则，可让 agent 维护忽略项：

```text
在 Git 仓库中忽略 Token Pulse 的本地运行目录 .tokpulse/。
共享忽略规则写入 .gitignore；仅本地生效的规则写入 .git/info/exclude。
仓库内使用自定义数据路径时，也忽略对应的数据文件和写入锁目录。
```

## 配置项

在插件项的 `options` 对象中设置：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `historyPath` | `.tokpulse/data/history.jsonl` | 相对于各会话目录的历史文件路径，也可使用绝对路径。 |
| `runsPath` | 历史文件同目录的 `runs.jsonl` | 活动时间数据路径。 |
| `maxRecords` | `1000` | 历史明细保留条数。 |

例如，以下 `options` 自定义详情快捷键：

```json
{
  "keybinds": {
    "oc-tps.details": "ctrl+shift+y,<leader>y"
  }
}
```

将 `keybinds.oc-tps.details` 设为 `false` 或 `"none"` 可关闭该快捷键，仍可用命令
打开详情。

## 开发

```sh
bun test --timeout 30000
```

许可证：[AGPL-3.0-or-later](LICENSE)。
