#!/usr/bin/env node
/**
 * file-verify.mjs — 文件完整性校验：空洞扫描 + 多哈希 + 分段定位
 *
 * ── 解决什么问题 ─────────────────────────────────────────────
 * 断点续传 / 预分配写的文件，会出现「大小对了但内容是零」。
 * 典型成因是「先 truncate(总长) 再分段填充」—— 文件系统分配了长度，
 * 但实际数据只写了前一段，后面全是全零洞。
 * **只看文件大小会以为下载完成，实际拿到的是个稀疏文件。**
 *
 * 本工具不看大小，直接读全文件找全零块，把这个问题暴露出来。
 *
 * ── 四步检查 ─────────────────────────────────────────────────
 *   1. 空洞扫描    逐块读全文，标出全零区间（相邻块自动合并）
 *   2. 类型识别    按魔术字节判断 RAR5/RAR4/ZIP/7z/MP3 等
 *   3. 完整哈希    MD5 / SHA1 / SHA256（流式，不占内存）
 *   4. 分段哈希    大文件每 100MB 一段，用于定位损坏区间
 *
 * ── 用法 ─────────────────────────────────────────────────────
 *   node file-verify.mjs "<文件路径>" [期望字节数] [期望MD5]
 *
 *   期望字节数 / 期望MD5 可选；给了就比对并给出 ✅/❌ 结论。
 *
 * ── 退出码 ───────────────────────────────────────────────────
 *   0  校验完成（有无空洞都会跑完）
 *   1  文件不存在或未给路径
 *
 * ── 依赖 ─────────────────────────────────────────────────────
 *   零依赖。只用 Node 内置模块，Node ≥ 18。
 *
 *   权威归档校验建议再用 7-Zip 复核：
 *     7z t "<文件>" [-p密码]
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const F = process.argv[2];
const TOTAL = Number(process.argv[3]) || 0;
const WANT_MD5 = (process.argv[4] || '').toLowerCase();

if (!F) {
  console.error('用法: node file-verify.mjs "<文件路径>" [期望字节数] [期望MD5]');
  process.exit(1);
}
if (!fs.existsSync(F)) {
  console.error(`✗ 文件不存在: ${F}`);
  process.exit(1);
}

const st = fs.statSync(F);
console.log(`文件: ${F}`);
console.log(`大小: ${st.size}${TOTAL ? ` / ${TOTAL}  ${st.size === TOTAL ? 'OK' : '不符'}` : ''}`);

// ══════════════════════════════════════════════════════════════
// 1) 全文空洞扫描
//    逐块读，全零块记区间；读到连续全零时向后延伸并合并为一段。
// ══════════════════════════════════════════════════════════════
const fd = fs.openSync(F, 'r');
const BS = 1 << 16;                       // 64 KB
const buf = Buffer.alloc(BS);
let off = 0;
const holes = [];
while (off < st.size) {
  const n = fs.readSync(fd, buf, 0, Math.min(BS, st.size - off), off);
  if (n <= 0) break;
  if (buf.subarray(0, n).every(b => b === 0)) {
    holes.push([off, off + n]);
    // 向后合并相邻全零块，避免输出几百条碎片区间
    while (off + n < st.size) {
      const m = fs.readSync(fd, buf, 0, Math.min(BS, st.size - (off + n)), off + n);
      if (m <= 0 || !buf.subarray(0, m).every(b => b === 0)) break;
      holes[holes.length - 1][1] = off + n + m;
      off += m;
    }
  }
  off += n;
}
fs.closeSync(fd);

console.log(`\n全零块: ${holes.length} 段`);
for (const [a, b] of holes.slice(0, 20)) {
  console.log(`   ${(a / 1048576).toFixed(3)} – ${(b / 1048576).toFixed(3)} MB  (${((b - a) / 1048576).toFixed(3)} MB)`);
}
if (holes.length > 20) console.log(`   … 另有 ${holes.length - 20} 段`);
if (holes.length) {
  const tot = holes.reduce((s, [a, b]) => s + (b - a), 0);
  console.log(`   空洞合计 ${(tot / 1048576).toFixed(2)} MB  (${(tot * 100 / st.size).toFixed(1)}% of file)`);
} else {
  console.log('   ✅ 无全零洞');
}

// ══════════════════════════════════════════════════════════════
// 2) 类型识别 + 归档尾部校验
// ══════════════════════════════════════════════════════════════
const fdH = fs.openSync(F, 'r');
const head = Buffer.alloc(16);
fs.readSync(fdH, head, 0, 16, 0);
fs.closeSync(fdH);
const hex8 = head.subarray(0, 8).toString('hex');
const isRar5 = hex8 === '526172211a070100';
const isRar4 = hex8.startsWith('526172211a0700');
const isZip = hex8.startsWith('504b0304');
const is7z = hex8.startsWith('377abcaf271c');
const isMp3 = head.subarray(0, 3).toString() === 'ID3';

console.log('\n=== 文件类型 / 归档校验 ===');
console.log(`  头 16 字节: ${head.toString('hex')}`);
console.log(`  识别: ${isRar5 ? 'RAR5' : isRar4 ? 'RAR4' : isZip ? 'ZIP' : is7z ? '7z' : isMp3 ? 'MP3(ID3)' : '未知/非归档'}`);

if (isRar5 && st.size > (1 << 20)) {
  // RAR5 的 end-of-archive 块 (type=5) 在文件末尾；找到它说明结构完整。
  const tail = Buffer.alloc(1 << 20);
  const fd2 = fs.openSync(F, 'r');
  fs.readSync(fd2, tail, 0, tail.length, st.size - tail.length);
  fs.closeSync(fd2);
  let endFound = -1;
  for (let i = 0; i < tail.length - 6; i++) if (tail[i + 4] === 0x03 && tail[i + 5] === 0x05) endFound = i;
  console.log(`  尾部 end-of-archive(type=5): ${endFound >= 0 ? `找到 @${st.size - tail.length + endFound} ✅` : '未找到 ⚠️（可能截断，或需完整解析）'}`);
} else if (st.size <= (1 << 20)) {
  console.log('  (文件较小，跳过尾部扫描)');
}
console.log('  提示: 权威归档校验请用 7z t "<文件>" [-p密码]');

// ══════════════════════════════════════════════════════════════
// 3) 完整哈希（流式，内存占用恒定）
// ══════════════════════════════════════════════════════════════
console.log('\n=== 哈希 ===');
const digests = {};
for (const alg of ['md5', 'sha1', 'sha256']) {
  const h = createHash(alg);
  for await (const c of fs.createReadStream(F)) h.update(c);
  digests[alg] = h.digest('hex');
  console.log(`  ${alg.padEnd(7)} ${digests[alg]}`);
}
if (WANT_MD5) {
  console.log(digests.md5 === WANT_MD5 ? '  ✅ MD5 与传入期望一致' : '  ❌ MD5 与传入期望不符');
}
console.log('  提示: 部分网盘取链 URL 里的 chk=<hex32>-<size> 是它们内部的校验 token，');
console.log('        与该文件的真实 MD5 并不相符 —— 不要拿它当哈希比对。');

// ══════════════════════════════════════════════════════════════
// 4) 分段哈希（大文件定位损坏区间）
//    整文件哈希不一致时，用它二分缩小范围。
// ══════════════════════════════════════════════════════════════
if (st.size > (64 << 20)) {
  console.log('\n=== 分段 MD5（每 100MB，定位损坏区间用）===');
  const fd3 = fs.openSync(F, 'r');
  const b2 = Buffer.alloc(1 << 20);
  const SEG = 100 * 1048576;
  let seg = 0;
  for (let base = 0; base < st.size; base += SEG, seg++) {
    const end = Math.min(base + SEG, st.size);
    const h = createHash('md5');
    let pos = base;
    while (pos < end) {
      const n = fs.readSync(fd3, b2, 0, Math.min(b2.length, end - pos), pos);
      if (n <= 0) break;
      h.update(b2.subarray(0, n));
      pos += n;
    }
    console.log(`  #${String(seg).padStart(2)}  ${(base / 1048576).toFixed(0).padStart(5)}–${(end / 1048576).toFixed(0).padStart(5)} MB  ${h.digest('hex')}`);
  }
  fs.closeSync(fd3);
}
