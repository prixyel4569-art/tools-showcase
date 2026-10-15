#!/usr/bin/env node
/**
 * dailyuploads-fast.mjs — 免费网盘「突发式限速 CDN」多线程 + 断点续传下载器
 *
 * 针对的站点类型：DailyUploads 及同类的「免费档 + 服务端强制等待 + 突发式 CDN」网盘。
 *
 * ── 核心结论（全部实测得出）────────────────────────────────────
 *   · 免费下载流程第 4 步 POST op=download2 会**直接返回文件流本身**
 *     （content-disposition: attachment + application/octet-stream），
 *     此时响应的最终 URL 就是 CDN 直链。
 *     ⚠️ 若用 await res.text() 读它，等于把整个文件缓冲进内存 —— 看起来像卡死。
 *
 *   · CDN 支持 Range（HTTP 206 + content-range），所以断点续传可靠。
 *
 *   · **CDN 是「突发式」限速**：连接刚建立时快，数秒后骤降。
 *     => 小块 + 适量并发，让每次连接都吃在突发窗口内。
 *        实测：8MB×4 = 243 KB/s   而   2MB×4 = 800 KB/s
 *        单连接持续下载只有 23~250 KB/s。
 *
 *   · 并发别超 6：超了会吃 HTTP 503（速率/并发限制），需要长退避。
 *
 * ── 用法 ──────────────────────────────────────────────────────
 *   node dailyuploads-fast.mjs "<分享URL>" [选项]
 *
 *   --out DIR       输出目录（默认 ./downloads）
 *   --workers N     并发线程数（默认 4，建议 2~6）
 *   --chunk N       分块大小 MB（默认 2 —— 小块吃突发窗口）
 *   --url FILE      复用已保存的 CDN 直链（跳过约 30s 握手）
 *   --step N        进度打印间隔百分比（默认 20）
 *
 *   中断后重跑同一条命令即自动续传（状态存在 .<文件名>.state.json）。
 *
 * ── 退出码 ────────────────────────────────────────────────────
 *   0  全部块完成
 *   1  未给 URL
 *   2  拿不到文件大小
 *   3  仍有块未完成（重跑续传）
 *
 * ── 依赖 ──────────────────────────────────────────────────────
 *   零依赖。只用 Node 内置模块（需要内置 fetch），Node ≥ 18。
 *   7-Zip 可选：完成后自动做归档完整性校验，没装就跳过。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i === -1 ? d : (argv[i + 1]?.startsWith('--') ? true : argv[i + 1]);
};
const PAGE = argv.find(a => a.startsWith('http'));
if (!PAGE) {
  console.error('用法: node dailyuploads-fast.mjs "<分享URL>" [--out DIR] [--workers 4] [--chunk 2] [--url FILE] [--step 20]');
  process.exit(1);
}
const OUT = path.resolve(String(arg('out', './downloads')));
const WORKERS = Math.max(1, Number(arg('workers', 4)));
const CHUNK_MB = Number(arg('chunk', 2));
const STEP = Number(arg('step', 20));
const URLFILE = arg('url', '');
fs.mkdirSync(OUT, { recursive: true });

const ORIGIN = new URL(PAGE).origin;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/** 从 HTML 里抽出 <Form> 内所有 input 的 name/value（免费下载流程靠它带参数） */
const fld = h => {
  const o = {};
  const form = (h.match(/<Form[^>]*>([\s\S]*?)<\/Form>/i) || [, ''])[1];
  for (const m of form.matchAll(/<input[^>]*name=["']([^"']+)["'][^>]*>/gi)) {
    o[m[1]] = (m[0].match(/value=["']([^"']*)["']/) || [])[1] ?? '';
  }
  return o;
};
/** 去标签 + 压空白，用于从 HTML 里正则捞提示文本 */
const plain = h => h
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ');

// ══════════════════════════════════════════════════════════════
// 阶段一：拿到 CDN 直链
// ══════════════════════════════════════════════════════════════
const jar = new Map();
const ch = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
const absorb = r => {
  for (const c of (r.headers.getSetCookie?.() ?? [])) {
    const kv = c.split(';')[0];
    const i = kv.indexOf('=');
    if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
};
const H = e => ({
  'User-Agent': UA, Accept: 'text/html,*/*', Origin: ORIGIN, Referer: PAGE,
  ...(ch() ? { Cookie: ch() } : {}), ...(e || {}),
});

async function resolve() {
  // 复用已保存直链：用 Range 探测第一字节，206 说明还有效
  if (URLFILE && fs.existsSync(URLFILE)) {
    const u = fs.readFileSync(URLFILE, 'utf8').trim();
    if (/^https?:\/\//.test(u)) {
      const t = await fetch(u, { headers: { 'User-Agent': UA, Range: 'bytes=0-63' } });
      if (t.status === 206) { log('复用已保存直链'); t.body?.cancel(); return u; }
      log('已保存直链已失效，重新握手');
    }
  }
  log('走握手流程（约 30s）...');

  const r1 = await fetch(PAGE, { headers: H() });
  absorb(r1);
  const t1 = await r1.text();

  const r2 = await fetch(PAGE, {
    method: 'POST',
    headers: H({ 'Content-Type': 'application/x-www-form-urlencoded' }),
    body: new URLSearchParams({ ...fld(t1), op: 'download1', method_free: 'Free Download' }).toString(),
  });
  absorb(r2);
  const t2 = await r2.text();

  // 服务端强制等待：秒数从页面文本里读出来，自适应重试（不要写死 25/28）
  let wait = 28;
  for (let a = 1; a <= 5; a++) {
    await sleep(wait * 1000);
    const r3 = await fetch(PAGE, {
      method: 'POST',
      headers: H({ 'Content-Type': 'application/x-www-form-urlencoded' }),
      body: new URLSearchParams({ ...fld(t2), op: 'download2', method_free: 'Free Download' }).toString(),
    });
    const cd = r3.headers.get('content-disposition') || '';
    // ⚠️ 这里不是 JSON 响应 —— 它就是文件流，r3.url 即 CDN 直链
    if (/attachment/i.test(cd)) {
      const u = r3.url;
      r3.body?.cancel();
      return u;
    }
    const t = await r3.text();
    const need = plain(t).match(/have to wait\s+(\d+)\s*seconds?/i);
    if (need) { wait = Number(need[1]) + 5; log(`  服务端要求等 ${need[1]}s`); continue; }
    throw new Error('未拿到文件流: ' + plain(t).slice(0, 160));
  }
  throw new Error('握手失败');
}

const DL = await resolve();
log(`直链: ${DL.slice(0, 110)}`);
if (URLFILE) fs.writeFileSync(URLFILE, DL);

// ══════════════════════════════════════════════════════════════
// 阶段二：探测大小
// ══════════════════════════════════════════════════════════════
const probe = await fetch(DL, { headers: { 'User-Agent': UA, Referer: PAGE, Range: 'bytes=0-0' } });
const cr = probe.headers.get('content-range') || '';
probe.body?.cancel();
const TOTAL = Number((cr.match(/\/(\d+)/) || [])[1] || 0);
if (!TOTAL) { console.error('拿不到文件大小'); process.exit(2); }

const NAME = decodeURIComponent((DL.split('/').pop() || 'download.bin').split('?')[0]);
const DEST = path.join(OUT, NAME);
const STATE = path.join(OUT, `.${NAME}.state.json`);
const CHUNK = Math.round(CHUNK_MB * 1048576);
const NCHUNK = Math.ceil(TOTAL / CHUNK);
const chunkLen = i => Math.min(CHUNK, TOTAL - i * CHUNK);
log(`目标 ${NAME}  ${(TOTAL / 1048576).toFixed(2)} MB  ${NCHUNK} 块 × ${CHUNK_MB}MB  ${WORKERS} 线程`);

// ══════════════════════════════════════════════════════════════
// 阶段三：断点续传状态
//   状态文件记 done[] + total；total 变了就丢弃重来（避免串文件）。
// ══════════════════════════════════════════════════════════════
let state = { done: [], url: DL };
if (fs.existsSync(STATE)) {
  try {
    const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    if (s.total === TOTAL) { state = s; log(`断点续传：已有 ${s.done.length}/${NCHUNK} 块`); }
  } catch { /* 状态损坏则重来 */ }
}
state.total = TOTAL;
const doneSet = new Set(state.done);

// 预分配满长度：稀疏写各块，写完的空洞由 file-verify.mjs 之类工具能查出来
let fd;
try {
  fd = await fsp.open(DEST, 'r+');
  const st = await fd.stat();
  if (st.size !== TOTAL) await fd.truncate(TOTAL);
} catch {
  fd = await fsp.open(DEST, 'w+');
  await fd.truncate(TOTAL);
}

// ══════════════════════════════════════════════════════════════
// 阶段四：进度上报（瞬时 + 均速 + ETA）
// ══════════════════════════════════════════════════════════════
const initial = state.done.reduce((a, i) => a + chunkLen(i), 0);
let bytesDone = initial;
const marks = new Set();
const T0 = Date.now();
let lastT = Date.now(), lastB = initial;
function report(final = false) {
  const pct = bytesDone * 100 / TOTAL;
  const b = Math.floor(pct / STEP) * STEP;
  if (final || (b > 0 && pct >= b && !marks.has(b))) {
    if (b > 0) marks.add(b);
    const now = Date.now();
    const inst = (bytesDone - lastB) / Math.max(0.001, (now - lastT) / 1000);
    const avg = (bytesDone - initial) / Math.max(0.001, (now - T0) / 1000);
    const eta = avg > 0 ? (TOTAL - bytesDone) / avg : 0;
    lastB = bytesDone; lastT = now;
    log(`【${final ? 100 : b}%】 ${(bytesDone / 1048576).toFixed(1)}/${(TOTAL / 1048576).toFixed(1)} MB  瞬时 ${(inst / 1048576).toFixed(2)} MB/s  均速 ${(avg / 1048576).toFixed(2)} MB/s  ETA ${Math.floor(eta / 60)}m${Math.floor(eta % 60)}s`);
  }
}

// ══════════════════════════════════════════════════════════════
// 阶段五：分块并发下载
//
// ⚠️ 关键坑：不能在 `for await (const c of r.body)` 里 `await fd.write()`。
//    那会暂停 body 流；若 socket 恰好在此刻结束，undici 会抛：
//      AssertionError: assert(!this.paused)  at Parser.finish
//    所以改用同步写 fs.writeSync（磁盘写很快，几个线程下不是瓶颈）。
// ══════════════════════════════════════════════════════════════
const FD = fd.fd;
let cursor = 0, errors = 0;

async function worker(wid) {
  while (true) {
    const idx = cursor++;
    if (idx >= NCHUNK) return;
    if (doneSet.has(idx)) continue;
    const start = idx * CHUNK, len = chunkLen(idx), end = start + len - 1;
    let ok = false, got = 0;
    for (let att = 1; att <= 5 && !ok; att++) {
      got = 0;
      try {
        const r = await fetch(DL, { headers: { 'User-Agent': UA, Referer: PAGE, Range: `bytes=${start}-${end}` } });
        if (r.status !== 206) throw new Error('HTTP ' + r.status);
        for await (const c of r.body) {
          const buf = Buffer.from(c);
          fs.writeSync(FD, buf, 0, buf.length, start + got);   // 同步写，不暂停流
          got += buf.length;
          bytesDone += buf.length;
          report();
        }
        if (got !== len) throw new Error(`块${idx} 不完整 ${got}/${len}`);
        ok = true;
      } catch (e) {
        bytesDone -= got;                       // 回退进度计数，避免虚高
        // 503 / 429 = CDN 并发或速率限制，退避要长；其它错误短退避
        const isThrottle = /503|429/.test(e.message);
        if (att === 5) { errors++; log(`  W${wid} 块${idx} 放弃: ${e.message}`); }
        else await sleep(isThrottle ? 2500 * att : 600 * att);
      }
    }
    if (ok) {
      doneSet.add(idx);
      state.done = [...doneSet];
      fs.writeFileSync(STATE, JSON.stringify(state));   // 每块落盘，断电可续
    }
  }
}

log('开始多线程下载...');
await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i + 1)));
report(true);
await fd.close();

// ══════════════════════════════════════════════════════════════
// 阶段六：收尾 + 可选归档校验
// ══════════════════════════════════════════════════════════════
const sz = (await fsp.stat(DEST)).size;
const dt = (Date.now() - T0) / 1000;
log(`完成 ${(sz / 1048576).toFixed(2)} MB  用时 ${Math.floor(dt / 60)}m${Math.floor(dt % 60)}s  平均 ${(sz / 1048576 / dt).toFixed(2)} MB/s  失败块 ${errors}`);

if (doneSet.size === NCHUNK) {
  log('✅ 全部块完成，清理状态文件');
  fs.rmSync(STATE, { force: true });

  // 7-Zip 可选：装了就顺手校验归档完整性
  const SEVENZ = process.env.SEVENZ || [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
    '/usr/bin/7z', '/usr/local/bin/7z',
  ].find(p => { try { return fs.existsSync(p); } catch { return false; } });

  if (SEVENZ) {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(SEVENZ, ['t', DEST], { encoding: 'utf8' });
    const ok = /Everything is Ok/i.test((r.stdout || '') + (r.stderr || ''));
    log(ok ? '✅ 7-Zip 完整性校验通过' : '⚠️ 7-Zip 校验未通过');
  } else {
    log('（未找到 7-Zip，跳过归档校验；可用 SEVENZ 环境变量指定路径）');
  }
  log(`输出: ${DEST}`);
  process.exit(0);
} else {
  log(`❌ 仍有 ${NCHUNK - doneSet.size} 块未完成，重跑本命令自动续传`);
  log(`输出: ${DEST}`);
  process.exit(3);
}
