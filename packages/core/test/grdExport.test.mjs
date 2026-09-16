// 天线方向图导出的内存口径自测。运行：npm test（或 node packages/core/test/grdExport.test.mjs）
//
// 起因：文件管理 → 天线方向图 → 导出 → GRASP GRD，对真实大件（实测 243 MB、94 波束 181×181）
// 渲染进程当场白屏，控制台留 FATAL ERROR: invalid array length。根因不是「文件太大」而是两处写法：
//   ① FileManager.toBytes 写成 Uint8Array.from(text, fn)：带 mapfn 的 %TypedArray%.from 对可迭代源
//      先走 IterableToList，把整份文本物化成【逐字符一个元素】的 JSArray —— 2.4 亿元素的 FixedArray，
//      堆涨到 1.4 GB 时 V8 直接 FATAL（已在 node 上逐字复现同一条错误）。
//   ② 重打包把封顶 2e6 点的公共网格先拼成一个一百多 MB 的整串再整份转字节。
// 修法：真实导入件的原样导出改由主进程按字节拷贝（原文不进渲染进程）；要重打包的合成件走分片。
// 本测试锁三件事：分片与整串逐字节相同、分片真的被切开、主进程那条「是不是合成件」的判据。
import { repackGrdCommonGrid, repackGrdCommonGridParts } from '../../../src/viz/grd/synth.js'
import { parseGrd } from '../../../src/viz/grd/parse.js'
import { createRequire } from 'module'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'

const require = createRequire(import.meta.url)
const createCoverage = require('../../../electron/services/coverage.js')

let pass = 0, fail = 0
const ok = (m, c, extra = '') => { if (c) { pass++; console.log('PASS  ' + m + (extra ? '  ' + extra : '')) } else { fail++; console.log('FAIL  ' + m + (extra ? '  ' + extra : '')) } }
const sha = (s) => crypto.createHash('sha256').update(Buffer.from(s, 'latin1')).digest('hex')

// 手搓一份「多 set 且各 set 窗口不同」的合成件（= 触发重打包的那种）。
// 每个 set 一个高斯包，中心落在各自窗口中心，窗口各自偏置 → sameGrid 为假。
function makeSynthGrd(nset, NX, NY, sameWindows = false) {
  const L = []
  L.push(' Far-field for analysis task No.     1 ')
  L.push(`SYNTHMETA ${JSON.stringify({ kind: 'gauss', satLon: 110.5, satLat: 0, altKm: 35786, theta3: 0.6, nBeams: nset })}`)
  L.push('++++')
  L.push('1')
  L.push(` ${nset} 3 2 6`)
  for (let s = 0; s < nset; s++) L.push('  0  0')
  const fexp = (v) => (v < 0 ? '-' : ' ') + Math.abs(v).toExponential(10).replace(/e([+-])(\d)$/, 'e$10$2')
  for (let s = 0; s < nset; s++) {
    const cx = sameWindows ? 0 : -2 + s * 1.5, cy = sameWindows ? 0 : 0.5 * s   // 各 set 各自的窗口中心
    const x0 = cx - 1.08, x1 = cx + 1.08, y0 = cy - 1.08, y1 = cy + 1.08
    L.push(` ${fexp(x0)} ${fexp(y0)} ${fexp(x1)} ${fexp(y1)}`)
    L.push(` ${NX} ${NY} 0`)
    for (let r = 0; r < NY; r++) {
      const y = y0 + (y1 - y0) * r / (NY - 1)
      for (let c = 0; c < NX; c++) {
        const x = x0 + (x1 - x0) * c / (NX - 1)
        const t2 = ((x - cx) ** 2 + (y - cy) ** 2) / (0.6 * 0.6)
        const amp = (1 + 0.3 * s) * Math.exp(-2.77 * t2)     // 各波束峰值不同 → 能验峰值守恒
        L.push(` ${fexp(amp)} ${fexp(0)} ${fexp(amp * 0.02)} ${fexp(0)}`)
      }
    }
  }
  return L.join('\r\n') + '\r\n'
}

// ───────── ① 分片拼起来与整串逐字节相同 ─────────
{
  const src = makeSynthGrd(3, 9, 9)
  const parts = repackGrdCommonGridParts(src)
  const whole = repackGrdCommonGrid(src)
  ok('① 分片全是字符串', parts.every((p) => typeof p === 'string'), `${parts.length} 片`)
  ok('① parts.join("") === repackGrdCommonGrid()', parts.join('') === whole, `${whole.length} 字符`)
  ok('① 重打包确实动了文件（本例三个窗口不同）', whole !== src)
  // 金标准：下面两个 sha256 是【改成分片之前】那版整串实现的输出（git HEAD cc6de80 的 synth.js 跑出来的）。
  // 分片只是把同一份字节分段吐出，改动后必须还落在同一个哈希上——否则导出的 .grd 变了，SATSOFT 那边就不是同一份图。
  ok('① 与改前整串实现逐字节相同（金标准哈希）',
    sha(whole) === '772e0657fcc6acd8a6f8083ca11b9b4d3245fa63ebc70b74476304f0cd98f7d9', sha(whole).slice(0, 16))
  const src2 = makeSynthGrd(4, 15, 11)
  ok('① 金标准哈希 · 4 波束 15×11',
    sha(repackGrdCommonGridParts(src2).join('')) === 'b8a919115a3969aceff4927f5741eadae298df99258bcef4b18a716a5df9fe3c')
  // 每行一个 rowsPerPart：片数 = 1(头) + 每 set(1 段网格行 + NN 片数据) + 1(收尾换行)
  const small = repackGrdCommonGridParts(src, { rowsPerPart: 1 })
  ok('① rowsPerPart 真的切开了', small.length > parts.length && small.join('') === whole, `${small.length} 片`)
  const big = repackGrdCommonGridParts(src, { rowsPerPart: 1e9 })
  ok('① rowsPerPart 放大也逐字节相同', big.join('') === whole)
}

// ───────── ② 不该动的原样返回（单 set / 已同网格），且是【原文本身】 ─────────
{
  const one = makeSynthGrd(1, 7, 7)
  ok('② 单 set 原样返回一片', repackGrdCommonGridParts(one).length === 1 && repackGrdCommonGridParts(one)[0] === one)
  // 已同网格（真实多波束/多频导入件就是这样）→ 一个字节都不许动
  const same = makeSynthGrd(3, 7, 7, true)
  const sg = parseGrd(same)
  ok('② 构造件确为同网格（前提成立）', sg.sets.every((s) => s.XS === sg.sets[0].XS && s.YS === sg.sets[0].YS && s.NX === sg.sets[0].NX))
  ok('② 已同网格原样返回一片', repackGrdCommonGridParts(same).length === 1 && repackGrdCommonGridParts(same)[0] === same)
  const nonGrasp = 'hello\nworld\n'
  ok('② 解析不了的文本原样返回一片', repackGrdCommonGridParts(nonGrasp).join('') === nonGrasp)
}

// ───────── ③ 重打包后仍是合法 GRASP，且峰值守恒、各 set 同一张网格 ─────────
{
  const src = makeSynthGrd(3, 11, 11)
  const before = parseGrd(src)
  const after = parseGrd(repackGrdCommonGridParts(src).join(''))
  ok('③ 波束数不变', after.nset === before.nset, `${after.nset}`)
  ok('③ 各 set 落到公共网格', after.sets.every((s) => s.XS === after.sets[0].XS && s.YS === after.sets[0].YS
    && s.XE === after.sets[0].XE && s.YE === after.sets[0].YE && s.NX === after.sets[0].NX && s.NY === after.sets[0].NY))
  const peakDb = (s) => 10 * Math.log10(s.peakLin)
  const worst = Math.max(...before.sets.map((s, i) => Math.abs(peakDb(s) - peakDb(after.sets[i]))))
  ok('③ 逐波束峰值守恒（< 0.01 dB）', worst < 0.01, `最大偏差 ${worst.toFixed(4)} dB`)
}

// ───────── ④ 主进程判「是不是合成件」：只读头 64KB，不碰正文 ─────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grdexp-'))
  const cov = createCoverage(dir, dir)
  const synth = makeSynthGrd(2, 5, 5)
  const plain = synth.replace(/^SYNTHMETA .*\r\n/m, '')
  fs.writeFileSync(path.join(dir, 'synth.grd'), synth, 'latin1')
  fs.writeFileSync(path.join(dir, 'plain.grd'), plain, 'latin1')
  ok('④ 合成件认出 SYNTHMETA', cov.exportSrc('synth.grd').synth === true)
  ok('④ 真实导入件不认', cov.exportSrc('plain.grd').synth === false)
  ok('④ 回的是绝对路径', path.isAbsolute(cov.exportSrc('plain.grd').path))
  let threw = ''
  try { cov.exportSrc('../../evil.grd') } catch (e) { threw = e.message }
  ok('④ 路径穿越被挡', /非法路径|ENOENT|no such file/i.test(threw), threw)
  let missing = ''
  try { cov.exportSrc('nope.grd') } catch (e) { missing = e.message }
  ok('④ 文件不在时抛错（上层给准话）', !!missing)
  // 只读头：正文再大也不该被读进来——用一个头部有 SYNTHMETA、正文塞 1 MB 垃圾的文件验判据只看头
  fs.writeFileSync(path.join(dir, 'big.grd'), synth + 'x'.repeat(1 << 20), 'latin1')
  ok('④ 大正文不影响判据', cov.exportSrc('big.grd').synth === true)
  // SYNTHMETA 出现在 64KB 之外 → 当真实导入件（合成件的表头只有几行，不会落到那么后面）
  fs.writeFileSync(path.join(dir, 'late.grd'), 'x'.repeat(70000) + '\r\n' + synth, 'latin1')
  ok('④ 64KB 之外的 SYNTHMETA 不算', cov.exportSrc('late.grd').synth === false)
  fs.rmSync(dir, { recursive: true, force: true })
}

// ───────── ⑤ latin1 逐字节：主进程 Buffer.from(s,'latin1') 与旧的逐字符取低 8 位等价 ─────────
{
  // 导出口径从「渲染端转字节 → IPC 传字节」改成「传字符串 + encoding:'latin1'」，两者必须逐字节相同。
  let s = ''
  for (let i = 0; i < 512; i++) s += String.fromCharCode(i)          // 含 >0xFF 的码位，验截断口径一致
  const oldWay = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) oldWay[i] = s.charCodeAt(i) & 0xff
  const newWay = Buffer.from(s, 'latin1')
  ok('⑤ latin1 与逐字符取低 8 位逐字节相同', Buffer.compare(Buffer.from(oldWay), newWay) === 0)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
