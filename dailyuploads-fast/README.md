# dailyuploads-fast — 突发式限速 CDN 多线程下载器

针对「**免费档 + 服务端强制等待 + 突发式 CDN**」这一类网盘的下载器。

> 本包按 DailyUploads 的免费下载流程实现。同类站点（流程结构相同：
> 页面表单 → `op=download1` → 等待 → `op=download2` 返回文件流）可作参考。

## 核心结论（全部实测得出）

### 1. 第 4 步返回的是文件流本身，不是 JSON

`op=download2` 的响应带 `content-disposition: attachment`，
**响应体就是文件内容**，而响应的最终 URL（`res.url`）就是 CDN 直链。

**坑**：如果用 `await res.text()` 去读它，等于把整个文件缓冲进内存
—— 表现为"卡住不动"，几百 MB 的文件会直接把内存吃满。

正确做法是只看响应头拿到直链，然后 `res.body.cancel()` 把流丢掉：

```js
const cd = r3.headers.get('content-disposition') || '';
if (/attachment/i.test(cd)) {
  const url = r3.url;       // ← 这就是 CDN 直链
  r3.body?.cancel();        // ← 丢掉响应体，别读
  return url;
}
```

### 2. CDN 是「突发式」限速 —— 这是最关键的一点

连接**刚建立时快，数秒后骤降**。所以"一条连接猛拉"是完全错误的策略。

正确做法是**小块 + 适量并发**，让每次连接都吃在突发窗口内：

| 配置 | 实测速度 |
|---|---|
| 单连接持续下载 | 23 ~ 250 KB/s |
| 8 MB × 4 线程 | 243 KB/s |
| **2 MB × 4 线程** | **800 KB/s** |

**块越小越快**（在合理范围内）。这是反直觉的 —— 通常以为大块减少开销更好，
但在这里，块小意味着连接更频繁地重建，每次重建都重新吃一次突发窗口。

### 3. 并发别超 6

超过会吃 `HTTP 503`（速率/并发限制），需要长退避（代码里用 `2500ms × 尝试次数`）。

### 4. 服务端等待秒数必须从页面读，不能写死

页面上的倒计时 JS 只是 UI。真正的等待是**服务端强制**的。
秒数要从响应文本里正则捞出来，然后自适应重试：

```js
const need = plain(t).match(/have to wait\s+(\d+)\s*seconds?/i);
if (need) { wait = Number(need[1]) + 5; continue; }
```

写死一个值（比如 25）会在站点调整后直接失效。

### 5. undici 的一个真坑：`for await` 里不能 `await write`

```js
// ❌ 会崩
for await (const c of r.body) {
  await fd.write(c);        // 暂停 body 流
}
// AssertionError: assert(!this.paused)  at Parser.finish
```

原因：`await` 会暂停 body 流；如果 socket 恰好在此刻结束，
undici 内部状态断言失败。改成**同步写**即可：

```js
// ✅
for await (const c of r.body) {
  const buf = Buffer.from(c);
  fs.writeSync(FD, buf, 0, buf.length, start + got);
}
```

磁盘写很快，几个线程下不构成瓶颈。

## 用法

```powershell
node dailyuploads-fast.mjs "<分享URL>" [选项]
```

| 选项 | 默认 | 说明 |
|---|---|---|
| `--out DIR` | `./downloads` | 输出目录 |
| `--workers N` | `4` | 并发线程数（建议 2~6） |
| `--chunk N` | `2` | 分块大小 MB（**小块吃突发窗口**） |
| `--url FILE` | — | 复用已保存的 CDN 直链，跳过约 30s 握手 |
| `--step N` | `20` | 进度打印间隔百分比 |

```powershell
# 先试小并发摸一下站点当前状态
node dailyuploads-fast.mjs "https://<分享页URL>" --out .\downloads --workers 2 --chunk 2

# 稳定后加到 4~6
node dailyuploads-fast.mjs "https://<分享页URL>" --out .\downloads --workers 6 --chunk 2

# 中断后重跑同一条命令 → 自动续传
```

## 断点续传怎么实现的

- 状态文件 `.<文件名>.state.json` 记录已完成块的索引 + 文件总长
- **每完成一块就落盘**（不是退出时才写），断电也能续
- 若检测到 `total` 变了（换了文件），丢弃旧状态，避免串文件
- 目标文件预先 `truncate` 到全长，各块用 `fs.writeSync(fd, buf, 0, len, offset)` 定点写

> ⚠️ 因为用了预分配，**下载中/异常退出的文件会是稀疏文件（大小对但含全零洞）**。
> 用同包的 `file-verify.mjs` 复查，或直接看它的空洞扫描结果。

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 全部块完成（已清理状态文件） |
| 1 | 未给 URL |
| 2 | 拿不到文件大小 |
| 3 | 仍有块未完成 → **重跑同命令续传** |

## 收尾校验

全部块完成后，若本机装了 7-Zip 会自动跑一次归档完整性校验。
7-Zip 路径可用 `SEVENZ` 环境变量指定：

```powershell
$env:SEVENZ = 'D:\tools\7z.exe'
```

没装就跳过（不影响下载结果）。

## 边界与合规

- 工具只实现**免费档的正常下载流程**，不绕过付费、不破解验证
- 是否允许批量/自动化下载，取决于目标站点的服务条款 —— **自行确认**
- 服务端等待是它的规则，本工具只是**如实遵守并自适应重试**，没有跳过

## 依赖

零依赖。只用 `node:fs` / `node:fs/promises` / `node:path`（+ 可选 `node:child_process` 调 7-Zip）。
需要内置 `fetch`，Node ≥ 18。
