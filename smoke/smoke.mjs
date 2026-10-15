#!/usr/bin/env node
/**
 * smoke.mjs — 行为冒烟测试框架（配置驱动）
 *
 * ── 解决什么问题 ─────────────────────────────────────────────
 * 「语法通过」经常被当成「能跑」。
 * 一个脚本 `node --check` 通过，完全可能一执行就崩：变量在声明前使用、
 * 路径自定位写错、默认参数指向已删除的目录……
 * 这些只有**真的跑一遍**才发现得了。
 *
 * 本框架把「跑一遍」变成可重复的检查：定义每个工具的安全调用方式 + 期望退出码，
 * 一条命令验证整批工具还能不能起来。
 *
 * ── 五类用例（tier）─────────────────────────────────────────
 *   run      无参数直接跑，断言退出码           （只读、零参数安全）
 *   args     带指定参数跑，断言退出码           （零参数有副作用时用这个）
 *   usage    无参数应「干净地失败」             （非 0 退出 + 有用法提示 + 不崩）
 *   syntax   只做语法检查，**永不执行**         （会联网 / 写盘 / 崩溃的工具）
 *   analyze  只读分析器，可放宽超时
 *
 * ── 用法 ─────────────────────────────────────────────────────
 *   node smoke.mjs [--config FILE] [--fast] [--verbose] [--json]
 *
 *   --config FILE   配置路径（默认同目录 smoke.config.json）
 *   --fast          跳过 analyze 层（耗时最久的一组）
 *   --verbose       打印每个用例的输出摘要
 *   --json          机器可读输出
 *
 * ── 退出码 ───────────────────────────────────────────────────
 *   0  无 FAIL      1  有 FAIL      2  配置缺失/无法解析
 *
 * ── 铁律：绝不执行会联网或写盘的工具 ────────────────────────
 *   每个用例进哪一层，必须先**实测**过它的零参数行为再决定。
 *   已见过太多「零参数就直接开始下载」的脚本 —— 这种一律只做 syntax。
 *
 * ── 依赖 ─────────────────────────────────────────────────────
 *   零依赖。只用 Node 内置模块，Node ≥ 18。
 *   跨平台：Windows / Linux / macOS。
 */
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARGS = process.argv.slice(2);
const optVal = (n, d) => { const i = ARGS.indexOf(n); return i === -1 ? d : ARGS[i + 1]; };
const OPT = {
  config: optVal('--config', path.join(HERE, 'smoke.config.json')),
  fast: ARGS.includes('--fast'),
  verbose: ARGS.includes('--verbose'),
  json: ARGS.includes('--json'),
};

// ══════════════════════════════════════════════════════════════
// 加载配置
// ══════════════════════════════════════════════════════════════
if (!fs.existsSync(OPT.config)) {
  console.error(`✗ 找不到配置: ${OPT.config}`);
  console.error(`  复制一份模板开始: smoke.config.example.json → smoke.config.json`);
  process.exit(2);
}
let CFG;
try {
  CFG = JSON.parse(fs.readFileSync(OPT.config, 'utf8'));
} catch (e) {
  console.error(`✗ 配置解析失败: ${e.message}`);
  process.exit(2);
}

const ROOT = path.resolve(path.dirname(OPT.config), CFG.root || '.');
const T = CFG.tiers || {};
const DEFAULT_TIMEOUT = Number(CFG.timeoutMs) || 60000;
const MARKER = String(CFG.allowMarker || 'smoke-allow');

// ══════════════════════════════════════════════════════════════
// 结果收集
// ══════════════════════════════════════════════════════════════
const R = [];
const add = (level, name, msg) => R.push({ level, name, msg });
const pass = (n, m) => add('PASS', n, m);
const fail = (n, m) => add('FAIL', n, m);
const warn = (n, m) => add('WARN', n, m);

// Windows 崩溃会返回 NTSTATUS 异常码（如 0xC0000409），不是正常退出码
const CRASH_MIN = 0xC0000000;
const isCrash = s => s === null || s === undefined || s < 0 || s >= CRASH_MIN;
const hex = s => (s >= 0 && s < 0x100000000 ? '0x' + s.toString(16).toUpperCase() : String(s));

function run(rel, args = [], timeout = DEFAULT_TIMEOUT) {
  const abs = path.resolve(ROOT, rel);
  if (!fs.existsSync(abs)) return { missing: true };
  const r = spawnSync(process.execPath, [abs, ...args], {
    cwd: ROOT, timeout, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  return {
    status: r.status,
    timeout: !!(r.error && r.error.code === 'ETIMEDOUT'),
    out: ((r.stdout || '') + (r.stderr || '')).trim(),
  };
}

/** 行内豁免标记：行尾写 `<marker>: <rule>` 即跳过该行的 staleRef 命中 */
const lineAllowed = (ln, rule) =>
  new RegExp(`${MARKER}\\s*:\\s*[^\\n]*\\b${rule}\\b`, 'i').test(ln);

const t0 = Date.now();

// ══════════════════════════════════════════════════════════════
// tier: run —— 无参数直接跑
// ══════════════════════════════════════════════════════════════
for (const c of (T.run || [])) {
  const r = run(c.path, c.args || []);
  if (r.missing) { fail(c.path, '文件不存在'); continue; }
  if (r.timeout) { fail(c.path, `超时 — ${c.note || ''}`); continue; }
  if (isCrash(r.status)) { fail(c.path, `崩溃 ${hex(r.status)} — ${c.note || ''}`); continue; }
  const exp = c.expect ?? [0];
  if (!exp.includes(r.status)) { fail(c.path, `退出码 ${r.status}，期望 ${exp.join('/')} — ${c.note || ''}`); continue; }
  if (!r.out) { fail(c.path, `无任何输出 — ${c.note || ''}`); continue; }
  pass(c.path, `exit=${r.status} — ${c.note || ''}`);
  if (OPT.verbose) console.log(`  · ${c.path}\n    ${r.out.split('\n')[0].slice(0, 120)}`);
}

// ══════════════════════════════════════════════════════════════
// tier: args —— 带安全参数跑（零参数会有副作用时用这个）
// ══════════════════════════════════════════════════════════════
for (const c of (T.args || [])) {
  const r = run(c.path, c.args || []);
  if (r.missing) { fail(c.path, '文件不存在'); continue; }
  if (r.timeout) { fail(c.path, `超时 (${(c.args || []).join(' ') || '无参数'})`); continue; }
  if (isCrash(r.status)) { fail(c.path, `崩溃 ${hex(r.status)} — ${c.note || ''}`); continue; }
  const exp = c.expect ?? [0];
  if (!exp.includes(r.status)) { fail(c.path, `exit=${r.status}，期望 ${exp.join('/')} — ${c.note || ''}`); continue; }
  pass(c.path, `exit=${r.status} (${(c.args || []).join(' ') || '无参数'}) — ${c.note || ''}`);
  if (OPT.verbose) console.log(`  · ${c.path}\n    ${r.out.split('\n').filter(Boolean)[0]?.slice(0, 120) ?? ''}`);
}

// ══════════════════════════════════════════════════════════════
// tier: usage —— 无参数应干净失败（非 0 + 有提示 + 不崩）
//   这一层价值很高：它同时验证「拒绝执行」和「提示可读」两件事。
// ══════════════════════════════════════════════════════════════
for (const c of (T.usage || [])) {
  const r = run(c.path, []);
  if (r.missing) { fail(c.path, '文件不存在'); continue; }
  if (r.timeout) { fail(c.path, '超时 — 无参数不应挂起'); continue; }
  if (isCrash(r.status)) { fail(c.path, `崩溃 ${hex(r.status)} — 应打印用法后干净退出`); continue; }
  if (r.status === 0) { fail(c.path, '无参数却 exit 0 — 应拒绝执行并提示用法'); continue; }
  const hint = c.hint || '用法';
  if (!r.out.includes(hint)) {
    warn(c.path, `exit=${r.status} 但没有 "${hint}" 提示，可能不是用法错误: ${r.out.slice(0, 100)}`);
    continue;
  }
  pass(c.path, `exit=${r.status}，干净失败并提示用法`);
}

// ══════════════════════════════════════════════════════════════
// tier: syntax —— 只做语法检查，永不执行
// ══════════════════════════════════════════════════════════════
const KNOWN = CFG.knownBroken || {};
for (const c of (T.syntax || [])) {
  const abs = path.resolve(ROOT, c.path);
  if (!fs.existsSync(abs)) { fail(c.path, '文件不存在'); continue; }
  try {
    execFileSync(process.execPath, ['--check', abs], { stdio: 'pipe' });
  } catch (e) {
    fail(c.path, `语法错误: ${String(e.stderr || e.message).split('\n')[0].slice(0, 120)}`);
    continue;
  }
  if (KNOWN[c.path]) warn(`${c.path} [仅语法]`, `已知损坏，未执行 — ${KNOWN[c.path]}`);
  else pass(`${c.path} [仅语法]`, `跳过执行：${c.why || '有联网/写盘副作用'}`);
}

// ══════════════════════════════════════════════════════════════
// tier: analyze —— 只读分析器
// ══════════════════════════════════════════════════════════════
if (OPT.fast) {
  add('SKIP', 'analyze', `--fast：跳过 ${(T.analyze || []).length} 个分析器`);
} else {
  for (const c of (T.analyze || [])) {
    const r = run(c.path, c.args || [], c.timeout || 120000);
    if (r.missing) { fail(c.path, '文件不存在'); continue; }
    if (r.timeout) { fail(c.path, `超时（>${(c.timeout || 120000) / 1000}s）`); continue; }
    if (isCrash(r.status)) { fail(c.path, `崩溃 ${hex(r.status)}`); continue; }
    if (r.status !== 0) { fail(c.path, `exit=${r.status}；只读分析器应成功退出`); continue; }
    pass(c.path, `exit=0，输出 ${r.out.length} 字节`);
  }
}

// ══════════════════════════════════════════════════════════════
// 已知损坏登记表反查 —— 修好后若忘了删登记，这里会提醒
// ══════════════════════════════════════════════════════════════
for (const [rel, why] of Object.entries(KNOWN)) {
  if (!fs.existsSync(path.resolve(ROOT, rel))) {
    warn(rel, '登记为已知损坏，但文件不存在了 — 请更新登记表');
  } else {
    warn(rel, `登记为已知损坏，未做行为测试 — ${why}`);
  }
}

// ══════════════════════════════════════════════════════════════
// 过期路径扫描 —— 代码里引用了已不存在的目录 = 运行必失败
//   只扫代码，不扫 .md（文档说明历史路径是合理的）。
//   代码注释里确需提及，行尾加 `<marker>: <rule>` 豁免。
// ══════════════════════════════════════════════════════════════
for (const s of (CFG.staleRefs || [])) {
  const rule = s.rule || s.pattern;
  let re;
  try { re = new RegExp(s.pattern, 'gi'); } catch { warn('staleRefs', `正则非法，已跳过: ${s.pattern}`); continue; }
  const skipExt = new Set(s.skipExt || ['.md']);
  const found = [];
  const walk = d => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === '.git' || e.name === 'node_modules' || e.name === '__pycache__') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (skipExt.has(path.extname(e.name).toLowerCase())) continue;
      let txt;
      try { txt = fs.readFileSync(full, 'utf8'); } catch { continue; }
      if (txt.includes('\0')) continue;
      let n = 0;
      for (const ln of txt.split(/\r?\n/)) {
        if (lineAllowed(ln, rule)) continue;
        n += (ln.match(re) || []).length;
      }
      if (n) found.push([path.relative(ROOT, full).split(path.sep).join('/'), n]);
    }
  };
  walk(ROOT);
  if (found.length) {
    for (const [f, n] of found) {
      const msg = `${n} 处命中 /${s.pattern}/ — ${s.why || '该路径可能已不存在'}`;
      if (KNOWN[f]) warn(`${f} [过期路径]`, `${msg}（已在已知损坏表登记）`);
      else fail(`${f} [过期路径]`, msg);
    }
  } else {
    pass(`stale-refs/${rule}`, `无过期路径引用`);
  }
}

// ══════════════════════════════════════════════════════════════
// 外部依赖存在性
// ══════════════════════════════════════════════════════════════
for (const d of (CFG.depends || [])) {
  if (!d.path) continue;
  const exists = fs.existsSync(d.path);
  if (exists) pass('depends', `存在: ${d.path} — ${d.note || ''}`);
  else if (d.required) fail('depends', `缺失（必需）: ${d.path} — ${d.note || ''}`);
  else warn('depends', `缺失（可选）: ${d.path} — ${d.note || ''}`);
}

// ══════════════════════════════════════════════════════════════
// 输出
// ══════════════════════════════════════════════════════════════
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
const nFail = R.filter(r => r.level === 'FAIL').length;
const nWarn = R.filter(r => r.level === 'WARN').length;
const nPass = R.filter(r => r.level === 'PASS').length;

if (OPT.json) {
  console.log(JSON.stringify({
    root: ROOT, config: OPT.config, ts: new Date().toISOString(),
    elapsed_s: Number(elapsed),
    summary: { fail: nFail, warn: nWarn, pass: nPass },
    known_broken: KNOWN,
    results: R,
  }, null, 2));
} else {
  const icon = { FAIL: '✗', WARN: '!', PASS: '✓', SKIP: '-' };
  for (const lvl of ['FAIL', 'WARN', 'PASS', 'SKIP']) {
    const rows = R.filter(r => r.level === lvl);
    if (!rows.length) continue;
    console.log(`\n── ${lvl} (${rows.length}) ${'─'.repeat(Math.max(0, 44 - lvl.length))}`);
    for (const r of rows) console.log(` ${icon[lvl]} [${r.name}] ${r.msg}`);
  }
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`FAIL ${nFail}  |  WARN ${nWarn}  |  PASS ${nPass}   (${elapsed}s)`);
  console.log(nFail
    ? '结果: 失败 — 有工具跑不起来。'
    : (nWarn ? '结果: 通过（有告警，见上）。' : '结果: 全部通过。'));
}

process.exitCode = nFail ? 1 : 0;
