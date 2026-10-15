# smoke — 行为冒烟测试框架（配置驱动）

**验证一批脚本"还跑不跑得起来"。**

## 它解决什么问题

「语法通过」经常被当成「能跑」。但一个脚本 `node --check` 通过，完全可能一执行就崩：

- 变量在声明前使用（`const` 的 TDZ）
- 路径自定位写错（`URL.pathname` 在 Windows + 非 ASCII 路径下没解码）
- 默认参数指向已删除的目录
- 零参数时直接开始下载（！）

**这些只有真的跑一遍才发现得了。**

本框架把「跑一遍」变成可重复的检查：给每个工具定义**安全的调用方式 + 期望退出码**，
一条命令验证整批工具。

## 五类用例（tier）

| tier | 做什么 | 用在什么工具上 |
|---|---|---|
| `run` | 无参数（或指定参数）直接跑，断言退出码 | 只读、零参数安全的工具 |
| `args` | 带指定参数跑，断言退出码 | 零参数有副作用，必须带参数的 |
| `usage` | 无参数应**干净地失败**：非 0 退出 + 有用法提示 + 不崩 | 需要参数的 CLI |
| `syntax` | 只做 `node --check`，**永不执行** | 会联网 / 写盘 / 崩溃的工具 |
| `analyze` | 只读分析器，可放宽超时（`--fast` 可跳过） | 扫描器、审计脚本 |

`usage` 这一层的价值容易被低估 —— 它同时验证两件事：
**该拒绝的时候拒绝了**，以及**提示信息是可读的**。

## 用法

```powershell
node smoke.mjs [--config FILE] [--fast] [--verbose] [--json]
```

| 参数 | 说明 |
|---|---|
| `--config FILE` | 配置路径（默认同目录 `smoke.config.json`） |
| `--fast` | 跳过 `analyze` 层（最耗时的一组） |
| `--verbose` | 打印每个用例的输出摘要 |
| `--json` | 机器可读输出（含 `known_broken` 与逐条结果） |

退出码：`0` 无 FAIL ／ `1` 有 FAIL ／ `2` 配置缺失或无法解析

## 铁律：绝不执行会联网或写盘的工具

`tiers.syntax` 里的用例**只做语法检查**。这不是保守，是踩出来的 ——
实测见过这些零参数行为：

| 工具类型 | 零参数行为 |
|---|---|
| 下载器 | **直接开始下载** |
| 搜索工具 | 发起网络搜索 |
| API 客户端 | 发真实 HTTP 请求 |
| 安装脚本 | **真的执行安装** |

**所以：每个用例进哪一层，必须先实测过它的零参数行为再决定。**

## 配置格式

完整可用的例子见同目录 `smoke.config.json`。字段说明：

```jsonc
{
  "root": "..",                 // 被测项目的根，相对配置文件所在目录
  "timeoutMs": 60000,           // 默认超时
  "allowMarker": "smoke-allow", // 过期路径扫描的行内豁免标记名

  "tiers": {
    "run":     [ { "path": "a.mjs", "args": [], "expect": [0], "note": "只读" } ],
    "args":    [ { "path": "b.mjs", "args": ["--check"], "expect": [0,1] } ],
    "usage":   [ { "path": "c.mjs", "hint": "用法" } ],
    "syntax":  [ { "path": "d.mjs", "why": "有 URL 时会联网写盘" } ],
    "analyze": [ { "path": "e.mjs", "timeout": 120000 } ]
  },

  "knownBroken": {
    "path/to/broken.mjs": "为什么坏、修好请删掉这条"
  },

  "depends": [
    { "path": "C:\\Program Files\\7-Zip\\7z.exe", "note": "可选", "required": false }
  ],

  "staleRefs": [
    { "rule": "old-dir", "pattern": "E:\\\\old-project", "why": "示例：已废弃的目录前缀", "skipExt": [".md"] }
  ]
}
```

### `knownBroken` 的用法

**修好之前**把文件登记进去 —— 它会以 WARN 出现在报告里，**不会假装通过**。
**修好之后必须删掉登记**，否则它就成了永久挡箭牌；框架会反查并提醒你。

### `staleRefs` 的用法

扫描代码里引用了**已不存在路径**的地方（这类引用一运行就失败）。
只扫代码不扫 `.md` —— 文档说明历史路径是合理的。

代码注释里确需提及历史路径时，行尾加豁免标记（默认 `smoke-allow`）：

```js
// 历史路径 E:\old-project 已迁移到这里    smoke-allow: old-dir
```

## 已知损坏登记 vs 过期路径：为什么要区分

- **语法检查通过了，但行为可能还是坏的** → 归 `knownBroken`
- **代码里还引用着已删除的目录** → 会直接被 `staleRefs` 抓出来

两者都会报 WARN/FAIL，都不会静默通过。

## 边界

- 本框架**不判断工具的功能对不对**，只判断它能不能正常启动、正常失败、不崩
- `tiers.usage` 的 `hint` 匹配是子串匹配，改动提示文案后要同步
- Windows 上崩溃会返回 NTSTATUS 码（如 `0xC0000409`），框架会识别为崩溃而非正常退出

## 依赖

零依赖。只用 `node:child_process` / `node:fs` / `node:path` / `node:url`。Node ≥ 18。
