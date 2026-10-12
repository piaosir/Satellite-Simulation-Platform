// 2D 平面图「底图线」GPU 路（src/viz/flatmap/glBaseLines.js）：按视口挑块的不变量。运行：npm test
//
// 为什么要有这一份：底图线（经纬网 / 行政区界 / 五类边界线 / 岛链）从静态快照里的 Canvas2D 描边改成每帧 GPU 现画后，
// 每帧只画与视口相交的块。裁剪【漏一块】就是画面上少一截国界 —— 这是唯一会伤正确性的环节，而它是纯 JS，
// 这里按着色器的同一个式子（x = (lon − LON0) mod 360、跨出世界矩形的段补一份 ±360 接缝副本、y = 90 − lat）
// 逐实例算出落点，穷举随机折线 × 随机视口 × 随机切口，断言「落进视口的实例一个不漏」。
// 另钉几条接线口径：导出闸门、拖着转闸门、快照里不再烘线、合成次序。
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createLinePacker, REC_BYTES } from '../../../src/viz/flatmap/glLines.js'
import { buildChunks, visibleRanges, shiftStrips, CHUNK_REC_F } from '../../../src/viz/flatmap/glBaseLines.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
let pass = 0
const ok = (c, m) => { assert.ok(c, m); pass++ }

ok(CHUNK_REC_F === REC_BYTES / 4, '块扫描的步长与打包记录同宽（40 B = 10 个 float）')

// 可复现的伪随机（不依赖 Math.random，失败可重放）
let seed = 20261013
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }

const f32 = (p) => new Float32Array(p.buf, 0, p.n * CHUNK_REC_F)
// 着色器的落点：等距圆柱实例 → 世界平面里的 1～2 份线段（主副本 + 必要时的接缝副本）
function worldSegs(f, i, period, lon0) {
  const o = i * CHUNK_REC_F
  if (!period) return [[f[o], f[o + 1], f[o + 2], f[o + 3]]]
  let x0 = f[o] - lon0
  x0 -= 360 * Math.floor(x0 / 360)
  const x1 = x0 + (f[o + 2] - f[o])
  const out = [[x0, 90 - f[o + 1], x1, 90 - f[o + 3]]]
  if (x1 > 360) out.push([x0 - 360, 90 - f[o + 1], x1 - 360, 90 - f[o + 3]])
  else if (x1 < 0) out.push([x0 + 360, 90 - f[o + 1], x1 + 360, 90 - f[o + 3]])
  return out
}
const segHits = (s, v) => Math.max(s[0], s[2]) >= v.x0 && Math.min(s[0], s[2]) <= v.x1 && Math.max(s[1], s[3]) >= v.y0 && Math.min(s[1], s[3]) <= v.y1
const covered = (ranges) => { const set = new Set(); for (const r of ranges) for (let i = r.off; i < r.off + r.n; i++) set.add(i); return set }

// ---- ① 切块：满 maxN 另起；包围盒超 maxSpan 另起；区间首尾相接、不重不漏 ----
{
  const pk = createLinePacker({ period: 0 })
  pk.style({ color: '#5f86a3', width: 0.7, alpha: 1 })
  for (let i = 0; i < 50; i++) { pk.moveTo(i * 2, 10); pk.lineTo(i * 2 + 1, 10.5); pk.end() }   // 50 段，横向铺 100 单位
  const p = pk.finish()
  const ch = buildChunks(f32(p), p.n, 0, 8, 1000)
  ok(ch.length === 7, '50 段 / 每块 ≤ 8 → 7 块 (' + ch.length + ')')
  let at = 0
  for (const c of ch) { ok(c.off === at && c.n > 0 && c.n <= 8, `块区间首尾相接 off=${c.off}`); at += c.n }
  ok(at === p.n, '块区间覆盖全部实例')
  const ch2 = buildChunks(f32(p), p.n, 0, 1024, 10)
  ok(ch2.every((c) => c.x1 - c.x0 <= 10 + 1e-9), '包围盒横向不超 maxSpan')
  ok(ch2.length >= 9, '按跨度切 → 至少 9 块 (' + ch2.length + ')')
  ok(Math.abs(ch[0].x0 - 0) < 1e-6 && Math.abs(ch[0].x1 - 15) < 1e-6 && Math.abs(ch[0].y0 - 10) < 1e-6 && Math.abs(ch[0].y1 - 10.5) < 1e-6, '首块包围盒 [0,15]×[10,10.5]')
}

// ---- ② 等距圆柱：跨 ±180° 的折线在块内就近解缠，包围盒是一段连续经度（不是撑满 360°）----
{
  const pk = createLinePacker({ period: 360 })
  pk.style({ color: '#5f86a3', width: 0.7, alpha: 1 })
  pk.polyline([[170, 0], [175, 1], [-179, 2], [-172, 3]], false)
  const p = pk.finish()
  const ch = buildChunks(f32(p), p.n, 360)
  ok(ch.length === 1, '跨日界线的短折线一块')
  ok(ch[0].x1 - ch[0].x0 < 20, '块的经度跨度连续（' + (ch[0].x1 - ch[0].x0).toFixed(1) + '°），不因 ±180 撑成 360')
  // 切口 LON0=−30：日界线在世界 x=210 处；视口 [200, 230] 应命中，[0, 100] 不命中
  ok(visibleRanges(ch, { period: 360, lon0: -30, x0: 200, x1: 230, y0: 80, y1: 95 }).ranges.length === 1, '视口压在日界线上：命中')
  ok(visibleRanges(ch, { period: 360, lon0: -30, x0: 0, x1: 100, y0: 0, y1: 180 }).ranges.length === 0, '视口在别处：不画')
  // 切口正好落在日界线上（LON0=−180 → 日界线 = 世界 x 0 / 360 两条边）：靠接缝副本，两边都得命中
  ok(visibleRanges(ch, { period: 360, lon0: -180, x0: 350, x1: 360, y0: 80, y1: 95 }).ranges.length === 1, '切口在日界线：右边缘命中')
  ok(visibleRanges(ch, { period: 360, lon0: -180, x0: 0, x1: 10, y0: 80, y1: 95 }).ranges.length === 1, '切口在日界线：左边缘（接缝副本）命中')
  ok(visibleRanges(ch, { period: 360, lon0: -180, x0: 0, x1: 10, y0: 0, y1: 50 }).ranges.length === 0, '纬向不沾：不画')
}

// ---- ③ 相邻的可见块并成一段；box 是可见部分的并 ----
{
  const ch = [{ off: 0, n: 4, x0: 0, x1: 1, y0: 0, y1: 1 }, { off: 4, n: 4, x0: 2, x1: 3, y0: 0, y1: 1 }, { off: 8, n: 4, x0: 50, x1: 51, y0: 0, y1: 1 }, { off: 12, n: 4, x0: 4, x1: 5, y0: 0, y1: 1 }]
  const r = visibleRanges(ch, { period: 0, x0: 0, x1: 10, y0: 0, y1: 10 })
  ok(r.ranges.length === 2 && r.ranges[0].off === 0 && r.ranges[0].n === 8 && r.ranges[1].off === 12 && r.ranges[1].n === 4, '相邻并段、隔开的另起')
  ok(r.box && r.box.x0 === 0 && r.box.x1 === 5 && r.box.y0 === 0 && r.box.y1 === 1, 'box = 可见块并集（裁到视口）')
  ok(visibleRanges(ch, { period: 0, x0: 100, x1: 110, y0: 0, y1: 10 }).box === null, '全不可见 → box 为 null')
  ok(visibleRanges([{ off: 0, n: 3, x0: -200, x1: 400, y0: 10, y1: 20 }], { period: 360, lon0: 0, x0: 90, x1: 91, y0: 0, y1: 180 }).ranges.length === 1, '经度跨度 ≥ 360 的块：横向恒可见')
}

// ---- ④ 穷举：随机折线 × 随机视口 × 随机切口，落进视口的实例一个不漏（等距圆柱 / 平面两种口径）----
{
  let checked = 0, inView = 0, drawn = 0
  for (let trial = 0; trial < 160; trial++) {
    const period = trial % 2 ? 0 : 360
    const pk = createLinePacker({ period })
    pk.style({ color: '#5f86a3', width: 0.7, alpha: 1 })
    const nPoly = 3 + Math.floor(rnd() * 25)
    for (let q = 0; q < nPoly; q++) {
      // 随机游走折线：经度可跨日界线、可绕一圈；纬度夹在 ±89；平面口径下当平面坐标用
      let x = period ? rnd() * 360 - 180 : rnd() * 360, y = rnd() * 170 - 85
      const pts = [[x, y]]
      const m = 2 + Math.floor(rnd() * 300), step = 0.05 + rnd() * (rnd() < 0.2 ? 15 : 1.5)
      for (let i = 0; i < m; i++) {
        x += (rnd() - 0.45) * step * 2; y = Math.max(-89, Math.min(89, y + (rnd() - 0.5) * step))
        pts.push([period ? (((x + 180) % 360) + 360) % 360 - 180 : x, y])
      }
      pk.polyline(pts, rnd() < 0.3)
    }
    const p = pk.finish()
    const f = f32(p)
    const ch = buildChunks(f, p.n, period, 1 + Math.floor(rnd() * 600), 1 + rnd() * 40)
    for (let vv = 0; vv < 12; vv++) {
      const lon0 = rnd() * 360 - 180
      const w = 0.5 + rnd() * (rnd() < 0.3 ? 400 : 40), h = 0.5 + rnd() * (rnd() < 0.3 ? 200 : 30)
      const x0 = rnd() * 420 - 30, y0 = rnd() * 200 - 10
      const v = { period, lon0, x0, x1: x0 + w, y0, y1: y0 + h }
      const set = covered(visibleRanges(ch, v).ranges)
      for (let i = 0; i < p.n; i++) {
        checked++
        if (!worldSegs(f, i, period, lon0).some((s) => segHits(s, v))) continue
        inView++
        assert.ok(set.has(i), `第 ${trial} 组 / 视口 ${vv}：实例 ${i} 落在视口里却被裁掉（period=${period} lon0=${lon0.toFixed(3)}）`)
      }
      drawn += set.size
    }
  }
  ok(inView > 1000, '穷举真有大量落进视口的实例被检查到（' + inView + ' / ' + checked + '）')
  ok(drawn < checked, '裁剪确实省掉了一部分（画了 ' + drawn + ' / ' + checked + '）')
  pass++
}

// ---- ⑤ 平移补条带：露出来的那一圈 = 互不重叠的矩形之并，恰好覆盖「挪位后没有源像素」的那些像素 ----
{
  let n = 0
  for (let t = 0; t < 400; t++) {
    const W = 8 + Math.floor(rnd() * 40), H = 6 + Math.floor(rnd() * 30)
    const dx = Math.floor(rnd() * (W + 6)) - Math.floor((W + 6) / 2), dy = Math.floor(rnd() * (H + 6)) - Math.floor((H + 6) / 2)
    const rs = shiftStrips(dx, dy, W, H, 1)
    if (Math.abs(dx) >= W || Math.abs(dy) >= H) { assert.ok(rs === null, `位移超画布 (${dx},${dy}) → null`); continue }
    const hit = new Uint8Array(W * H)
    for (const r of rs) {
      assert.ok(r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0 && r.x + r.w <= W && r.y + r.h <= H, `矩形在画布内 ${JSON.stringify(r)}`)
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) { assert.ok(!hit[y * W + x], `(${dx},${dy}) 条带重叠于 (${x},${y})`); hit[y * W + x] = 1 }
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const sx = x - dx, sy = y - dy, exposed = sx < 0 || sy < 0 || sx >= W || sy >= H   // 挪位拷贝：目标 (x,y) 取源 (x−dx, y−dy)
      assert.ok(!!hit[y * W + x] === exposed, `(${dx},${dy}) 像素 (${x},${y}) 露出=${exposed} 条带=${!!hit[y * W + x]}`)
    }
    n++
  }
  ok(n > 300, '随机 ' + n + ' 组位移：条带互不重叠、不出画布、恰好覆盖露出区')
  ok(shiftStrips(0, 0, 100, 80).length === 0, '没动 → 不补')
  ok(shiftStrips(70, 0, 100, 80, 0.6) === null, '露出超过六成 → 整张重画（null）')
  ok(shiftStrips(12, -5, 100, 80).length === 2, '斜向平移 → 一竖一横两条')
}

// ---- ⑥ 接线口径（改了这里就得改测试）----
{
  const FLAT = readFileSync(join(ROOT, 'src', 'viz', 'flatmap', 'flatCoverage.js'), 'utf8')
  const GLF = readFileSync(join(ROOT, 'src', 'viz', 'flatmap', 'glField.js'), 'utf8')
  const seg = (src, from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from) + 1))
  ok(/const baseOn = \(\) => glBaseOn && !baseFail && \(PJ\.identity \|\| !rotLive\) && lnOk\(\)/.test(FLAT), '闸门：屏上 + WebGL2（lnOk 含 !compat && !exporting）、投影档拖着转退回老路')
  // 导出整条路一行不碰 GPU：exportRender 仍是 drawAboveContent → drawLinesContent 的 Canvas2D 描边
  const exp = seg(FLAT, 'exportRender(targetCtx, opts) {', 'destroy() {')
  ok(/drawAboveContent\(rx, ry, rw, rh\)/.test(exp) && !/drawBaseLines/.test(exp), '导出：仍走 drawAboveContent（Canvas2D 描边），不经 GPU 底图线')
  ok(/function drawAboveContent\(rx, ry, rw, rh\) \{ drawLinesContent\(rx, ry, rw, rh\); drawTextContent\(rx, ry, rw, rh\) \}/.test(FLAT), 'drawAboveContent 原样：线 + 文字')
  // 快照：三条重建路径（条带 / 带余量 / 全图）里的 drawLinesContent 都挂在 linesIn 上；背板同理
  const rs = seg(FLAT, 'function renderStaticLayers() {', 'function stripPlan(')
  const linesCalls = rs.match(/drawLinesContent\(rx, ry, rw, rh\)/g) || []
  const guarded = rs.match(/if \(linesIn\) drawLinesContent\(rx, ry, rw, rh\)|if \(linesIn\) \{[\s\S]{0,400}?drawLinesContent\(rx, ry, rw, rh\)/g) || []
  ok(linesCalls.length === 3 && guarded.length === 3, '快照三条路径的底图线都只在 linesIn 时烘（' + guarded.length + '/' + linesCalls.length + '）')
  ok(/const linesIn = !baseOn\(\)/.test(rs) && /snapBaseGl = !linesIn/.test(rs), '快照记下自己是不是按 GPU 路烘的')
  ok(/if \(linesIn\) drawLinesContent\(rx, ry, rw, rh\)/.test(seg(FLAT, 'function ensureBackplate() {', 'function pickFallback(')), '全图背板：GPU 路下不烘线')
  // draw：开关一变整份重烘；GPU 线画在回退快照的文字之前；画不出来当帧 Canvas2D 现画补上
  const dr = seg(FLAT, '  function draw() {', '  // ---- 缩放进度')
  ok(/if \(snapBaseGl !== null && snapBaseGl !== bOn\) invalidateStatic\(\)/.test(dr), 'draw：GPU 路开关变了就作废快照')
  const iLine = dr.indexOf('if (bOn && !drawBaseLines())'), iFbAbove = dr.indexOf('blitSnap(fb.f.above, fb.pl)'), iText = dr.indexOf('blitSnap(textCanvas, plText)')
  ok(iLine > 0 && iLine < iFbAbove && iFbAbove < iText, 'draw：GPU 底图线 → 回退快照文字 → 文字层（文字压线）')
  ok(/drawLinesContent\(rx, ry, rw, rh\)/.test(dr.slice(iLine, iFbAbove)), 'draw：GPU 当场画不出来 → 这一帧 Canvas2D 现画')
  ok(/if \(!bOn\) blitSnap\(aboveCanvas, pl\)/.test(dr), 'draw：GPU 路下不再贴 above 快照（线不在里面）')
  ok(/const textDirect = bOn && !!pl && pl\.scaled/.test(dr), 'draw：只有缩放（快照按比例贴）时文字才按当前视图现画')
  // glField：底图线合成层挂在同一上下文上，上下文丢失即作废
  ok(/baseLines\(\) \{/.test(GLF) && /glb = null/.test(GLF), 'glField：底图线合成层挂在同一上下文上、随上下文作废')
}

console.log(`glBaseLines.test: ${pass} 条通过`)
