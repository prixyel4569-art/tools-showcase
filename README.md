# tools-showcase

三个**只用 Node 内置模块**的独立小工具：零依赖、开箱即跑、互不依赖，可以单独取用。

本项目旨在解决三类在实际使用中反复出现、却缺少顺手工具的问题：
**文件"假完整"**（断点续传或预分配写出的文件，大小正确但内容全是零）、
**免费网盘 CDN 的突发式限速**（连接建立后的头几秒很快，随后骤降，常规下载器跑不出速度）、
以及**"语法通过"被当成"能跑"**（脚本 `node --check` 通过，一执行却崩，且缺少可重复的检查手段）。

通过三个彼此独立、可单独取用的工具——稀疏文件检测、突发窗口多线程下载器、行为冒烟测试框架——
把这三类检查变成"一条命令就能重复执行"的固定流程；降低了三类风险：
把损坏的下载结果当成完好归档使用、把本可拿到的带宽白白浪费掉、
以及把未经运行验证的脚本带进后续流程。

## 工具一览

| 目录 | 工具 | 一句话功能 |
|---|---|---|
| `file-verify/` | `file-verify.mjs` | 文件完整性校验：**找出"大小对了但内容是零"的稀疏文件** |
| `dailyuploads-fast/` | `dailyuploads-fast.mjs` | 免费网盘「突发式限速 CDN」多线程 + 断点续传下载器 |
| `smoke/` | `smoke.mjs` | 行为冒烟测试框架：验证一批脚本**还跑不跑得起来** |

## 快速开始

环境：**Node.js ≥ 18**（需要内置 `fetch`，实测 v24）。不需要 `npm install`。

```powershell
# 校验一个文件（含空洞扫描 + 三种哈希）
node .\file-verify\file-verify.mjs "D:\某文件.zip" 12345678

# 下载（中断后重跑同一条命令即自动续传）
node .\dailyuploads-fast\dailyuploads-fast.mjs "https://<分享页URL>" --out .\downloads --workers 4 --chunk 2

# 冒烟测试本包
cd .\smoke
node .\smoke.mjs
```

每个工具目录下都有一个 `deploy.ps1`，用来做该工具的部署自检
（**只读**：检查 Node 版本、语法，以及一次安全的功能调用，不会改文件也不会联网）：

```powershell
.\file-verify\deploy.ps1
.\dailyuploads-fast\deploy.ps1
.\smoke\deploy.ps1
```

## 三个工具各自解决什么

### 1. `file-verify.mjs` —— 发现"假完整"

断点续传/预分配写的文件会出现**大小正确但内容全是零**。
成因通常是「先 `truncate(总长)` 再分段填充」：文件系统分配了长度，实际只写了前一段。
**只看文件大小会以为下载完成，实际拿到的是个稀疏文件。**

本工具不看大小，直接读全文找全零块。额外输出文件类型识别、MD5/SHA1/SHA256、
大文件分段哈希（用于定位损坏区间）。

### 2. `dailyuploads-fast.mjs` —— 吃突发窗口

这类免费网盘的 CDN 是**突发式限速**：连接刚建立时快，数秒后骤降。
所以「一条连接猛拉」是错的，正确做法是**小块 + 适量并发**，让每次连接都吃在突发窗口内。

实测对比：`8MB×4 = 243 KB/s` 而 `2MB×4 = 800 KB/s`；单连接持续下载只有 23~250 KB/s。

### 3. `smoke.mjs` —— 把"跑一遍"变成可重复的检查

「语法通过」经常被当成「能跑」。一个脚本 `node --check` 通过，
完全可能一执行就崩（变量在声明前使用、路径自定位写错、默认参数指向已删除目录）。

本框架把每个工具的安全调用方式 + 期望退出码写成配置，一条命令验证整批工具。

## 环境要求

| 组件 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 18 | 需要内置 `fetch`；实测 v24 |
| 7-Zip | 可选 | 归档完整性校验（`dailyuploads-fast` 收尾时调用）。用 `SEVENZ` 环境变量指定路径 |

跨平台：Windows / Linux / macOS。

## 网络行为

| 工具 | 是否联网 |
|---|---|
| `file-verify` | 不联网，只读本地文件 |
| `smoke` | 不联网，只执行本地脚本 |
| `dailyuploads-fast` | 只连接你显式传入的那个 URL，不上传任何本地数据 |


## English

**What it is** — three independent, dependency-free tools for Node.js (≥ 18):
verify that files are *actually* intact, download from burst-throttled CDNs
efficiently, and check that a batch of scripts still *runs* (not merely compiles).
No `npm install`; only Node built-ins.

| Tool | Problem it solves |
|---|---|
| `file-verify.mjs` | Downloads that only *look* complete: the byte count matches, but the content is all zeros (sparse files left by resume/preallocation). It reads the whole file instead of trusting its size, and reports file type, MD5/SHA1/SHA256, plus per-segment hashes to locate a damaged range. |
| `dailyuploads-fast.mjs` | CDNs that burst: fast for the first few seconds, then throttle hard, so a single long-lived connection is the wrong shape. It downloads small chunks with modest concurrency (measured: 2 MB × 4 ≈ 800 KB/s vs 8 MB × 4 ≈ 243 KB/s) and resumes automatically when re-run. |
| `smoke.mjs` | "It passes `node --check`" mistaken for "it runs". A configured batch of scripts is executed with their safe arguments and expected exit codes, turning a one-off manual check into a repeatable one. |

Each tool ships a `deploy.ps1` self-check (read-only: Node version, syntax, one
safe invocation). All tools are cross-platform.

**Network behavior** — `file-verify` and `smoke` never touch the network;
`dailyuploads-fast` connects only to the URL you pass it, and uploads nothing.

## License

MIT — see [LICENSE](LICENSE).
