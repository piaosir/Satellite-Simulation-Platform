#!/usr/bin/env node
// 应用场景仿真 · 模块符号构建脚本
//   node scripts/build-scene-symbols.mjs
//
// 读 node_modules 里的成品矢量图标（Tabler MIT / Lucide ISC），把用到的那几十个解析成
// 本平台符号系统的【命令数组】，生成 src/viz/scene/sceneSymbolData.js。
//
// ============ 为什么是「构建期转译」而不是运行时读 SVG ============
// ① 回放器不能改：符号要同时喂给 2D 导出（svgcanvas 不认 Path2D，只能逐段回放）与 3D 精灵
//    （必须同步画在 canvas 上，异步贴图在只渲有限几帧的出图路径里会整个不出现）。
//    这条架构在 vehicleSymbol.js / markSymbols.js 上已经踩实，符号换素材【只换数据来源】。
// ② 安装包里不带一个 SVG 字节：图标包只在 devDependencies，运行时只带这一份生成的数据文件。
// ③ 图标包升级不会静默改变已发布软件的图形：生成物进版本库，diff 可审。
//
// ============ 几何口径 ============
// 两个图标包都是 24 网格、stroke-width 2、round cap/join —— 同族，混用不会露馅。
// 本平台符号视框是 128（见 sceneSymbols.js SYM_VB），故缩放 128/24 = 16/3，
// 线宽 2 → 32/3 ≈ 10.667。缩放在【构建期】做完，运行时回放不再乘系数。
//
// ============ 路径转译 ============
// SVG 的 d 支持 M/L/H/V/C/S/Q/T/A/Z（大写绝对、小写相对），回放器只认 M/L/C/Q/Z。
// 故：相对 → 绝对；H/V → L；S/T 的隐含控制点显式算出；★A 椭圆弧 → 三次贝塞尔
// （每 ≤90° 一段，误差 < 0.03%，在 128 视框里远小于半个像素）。
// 圆 / 矩形 / 线 / 折线 / 多边形保留成对应图元（比转成路径更小、更准）。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SYMBOL_ICONS } from '../src/viz/scene/sceneSymbolMap.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const OUT = path.join(ROOT, 'src/viz/scene/sceneSymbolData.js')

const SRC = {
  // 前缀 → 目录。tabler 分 outline / filled 两套同名同形
  'tabler': path.join(ROOT, 'node_modules/@tabler/icons/icons/outline'),
  'tabler-filled': path.join(ROOT, 'node_modules/@tabler/icons/icons/filled'),
  'lucide': path.join(ROOT, 'node_modules/lucide-static/icons')
}

const VB = 128
const K = VB / 24                 // 16/3
const STROKE_W = 2 * K            // 32/3 ≈ 10.667

// ═══════════════════════════════════════════════════════════════════════════
// SVG 路径解析
// ═══════════════════════════════════════════════════════════════════════════

/** d 字符串 → [{ cmd, args:[] }]，数字用宽松扫描（SVG 允许 "1-2" "1.2.3" 这种省略分隔符的写法） */
function tokenize(d) {
  const out = []
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?)/g
  let m, cur = null
  while ((m = re.exec(d))) {
    if (m[1]) { cur = { cmd: m[1], args: [] }; out.push(cur) }
    else if (cur) cur.args.push(parseFloat(m[2]))
  }
  return out
}

/** 一段椭圆弧 → 若干段三次贝塞尔（端点参数化 → 中心参数化，见 SVG 1.1 附录 F.6） */
function arcToCubics(x1, y1, rx, ry, phiDeg, largeArc, sweep, x2, y2) {
  if (!(rx > 0) || !(ry > 0)) return [['L', x2, y2]]
  const phi = phiDeg * Math.PI / 180
  const cosP = Math.cos(phi), sinP = Math.sin(phi)
  // ① 端点差旋转到椭圆自身坐标系
  const dx2 = (x1 - x2) / 2, dy2 = (y1 - y2) / 2
  const x1p = cosP * dx2 + sinP * dy2
  const y1p = -sinP * dx2 + cosP * dy2
  // ② 半径过小时按 F.6.6 等比放大（否则下面开根号得负数）
  let rxa = Math.abs(rx), rya = Math.abs(ry)
  const lam = (x1p * x1p) / (rxa * rxa) + (y1p * y1p) / (rya * rya)
  if (lam > 1) { const s = Math.sqrt(lam); rxa *= s; rya *= s }
  // ③ 圆心
  const num = rxa * rxa * rya * rya - rxa * rxa * y1p * y1p - rya * rya * x1p * x1p
  const den = rxa * rxa * y1p * y1p + rya * rya * x1p * x1p
  let co = Math.sqrt(Math.max(0, num / den))
  if (largeArc === sweep) co = -co
  const cxp = co * rxa * y1p / rya
  const cyp = -co * rya * x1p / rxa
  const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2
  const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2
  // ④ 起始角与张角
  const ang = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy)
    let a = Math.acos(Math.min(1, Math.max(-1, len ? dot / len : 1)))
    if (ux * vy - uy * vx < 0) a = -a
    return a
  }
  const th1 = ang(1, 0, (x1p - cxp) / rxa, (y1p - cyp) / rya)
  let dth = ang((x1p - cxp) / rxa, (y1p - cyp) / rya, (-x1p - cxp) / rxa, (-y1p - cyp) / rya)
  if (!sweep && dth > 0) dth -= 2 * Math.PI
  else if (sweep && dth < 0) dth += 2 * Math.PI
  // ⑤ 每段 ≤ 90°：贝塞尔逼近圆弧的误差随张角迅速上升，90° 一段是通行折中
  const segs = Math.max(1, Math.ceil(Math.abs(dth) / (Math.PI / 2)))
  const delta = dth / segs
  const t = (4 / 3) * Math.tan(delta / 4)
  const out = []
  let th = th1
  for (let i = 0; i < segs; i++) {
    const c1 = Math.cos(th), s1 = Math.sin(th)
    const th2 = th + delta
    const c2 = Math.cos(th2), s2 = Math.sin(th2)
    const p1x = cx + rxa * cosP * c1 - rya * sinP * s1
    const p1y = cy + rxa * sinP * c1 + rya * cosP * s1
    const p2x = cx + rxa * cosP * c2 - rya * sinP * s2
    const p2y = cy + rxa * sinP * c2 + rya * cosP * s2
    const d1x = -rxa * cosP * s1 - rya * sinP * c1
    const d1y = -rxa * sinP * s1 + rya * cosP * c1
    const d2x = -rxa * cosP * s2 - rya * sinP * c2
    const d2y = -rxa * sinP * s2 + rya * cosP * c2
    out.push(['C', p1x + t * d1x, p1y + t * d1y, p2x - t * d2x, p2y - t * d2y, p2x, p2y])
    th = th2
  }
  return out
}

/** d 字符串 → 回放器认得的 ['path', ['M',…], …]（坐标已是原始 24 网格，缩放在最后统一做） */
function parsePath(d) {
  const toks = tokenize(d)
  const out = []
  let cx = 0, cy = 0, sx = 0, sy = 0     // 当前点 / 子路径起点
  let pcx = null, pcy = null             // 上一条三次曲线的第二控制点（S 用）
  let pqx = null, pqy = null             // 上一条二次曲线的控制点（T 用）
  for (const t of toks) {
    const C = t.cmd, up = C.toUpperCase(), rel = C !== up
    const a = t.args
    // 一条指令可带多组参数（"L 1 2 3 4" = 两条 L）；M 之后的重复组按 L 处理（SVG 规范）
    const step = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 }[up]
    if (up === 'Z') { out.push(['Z']); cx = sx; cy = sy; pcx = pcy = pqx = pqy = null; continue }
    for (let i = 0; i + step <= a.length || (step === 0); i += step) {
      const g = a.slice(i, i + step)
      if (up === 'M') {
        const x = rel ? cx + g[0] : g[0], y = rel ? cy + g[1] : g[1]
        if (i === 0) { out.push(['M', x, y]); sx = x; sy = y } else out.push(['L', x, y])
        cx = x; cy = y; pcx = pcy = pqx = pqy = null
      } else if (up === 'L') {
        const x = rel ? cx + g[0] : g[0], y = rel ? cy + g[1] : g[1]
        out.push(['L', x, y]); cx = x; cy = y; pcx = pcy = pqx = pqy = null
      } else if (up === 'H') {
        const x = rel ? cx + g[0] : g[0]
        out.push(['L', x, cy]); cx = x; pcx = pcy = pqx = pqy = null
      } else if (up === 'V') {
        const y = rel ? cy + g[0] : g[0]
        out.push(['L', cx, y]); cy = y; pcx = pcy = pqx = pqy = null
      } else if (up === 'C') {
        const p = rel ? [cx + g[0], cy + g[1], cx + g[2], cy + g[3], cx + g[4], cy + g[5]] : g
        out.push(['C', ...p]); pcx = p[2]; pcy = p[3]; cx = p[4]; cy = p[5]; pqx = pqy = null
      } else if (up === 'S') {
        // 隐含第一控制点 = 当前点关于上一条曲线第二控制点的反射（无上一条则取当前点）
        const r1x = pcx == null ? cx : 2 * cx - pcx, r1y = pcy == null ? cy : 2 * cy - pcy
        const p = rel ? [cx + g[0], cy + g[1], cx + g[2], cy + g[3]] : g
        out.push(['C', r1x, r1y, p[0], p[1], p[2], p[3]])
        pcx = p[0]; pcy = p[1]; cx = p[2]; cy = p[3]; pqx = pqy = null
      } else if (up === 'Q') {
        const p = rel ? [cx + g[0], cy + g[1], cx + g[2], cy + g[3]] : g
        out.push(['Q', ...p]); pqx = p[0]; pqy = p[1]; cx = p[2]; cy = p[3]; pcx = pcy = null
      } else if (up === 'T') {
        const q1x = pqx == null ? cx : 2 * cx - pqx, q1y = pqy == null ? cy : 2 * cy - pqy
        const p = rel ? [cx + g[0], cy + g[1]] : g
        out.push(['Q', q1x, q1y, p[0], p[1]])
        pqx = q1x; pqy = q1y; cx = p[0]; cy = p[1]; pcx = pcy = null
      } else if (up === 'A') {
        const ex = rel ? cx + g[5] : g[5], ey = rel ? cy + g[6] : g[6]
        out.push(...arcToCubics(cx, cy, g[0], g[1], g[2], !!g[3], !!g[4], ex, ey))
        cx = ex; cy = ey; pcx = pcy = pqx = pqy = null
      }
      if (step === 0) break
    }
  }
  return out
}

// ═══════════════════════════════════════════════════════════════════════════
// SVG 文件 → 图元数组
// ═══════════════════════════════════════════════════════════════════════════

const attrs = (tag) => {
  const o = {}
  const re = /([a-zA-Z-]+)\s*=\s*"([^"]*)"/g
  let m
  while ((m = re.exec(tag))) o[m[1]] = m[2]
  return o
}
const nums = (s) => String(s || '').trim().split(/[\s,]+/).filter((x) => x !== '').map(Number)

function parseSvg(file, filled) {
  const txt = fs.readFileSync(file, 'utf8')
  const parts = []
  const push = (d) => { parts.push({ d, s: filled ? 'fill' : 'stroke' }) }
  const re = /<(path|circle|rect|line|polyline|polygon|ellipse)\b([^>]*)\/?>/g
  let m
  while ((m = re.exec(txt))) {
    const el = m[1], A = attrs(m[2])
    // ★ Tabler 每张图开头有一条占位边框 <path stroke="none" d="M0 0h24v24H0z" fill="none" />，
    //   它只是给某些渲染器占满视框用的，画出来就是一个大方框把整个图标框住。
    if (A.stroke === 'none' && A.fill === 'none') continue
    if (el === 'path') { if (A.d) push(['path', ...parsePath(A.d)]) }
    else if (el === 'circle') push(['c', +A.cx || 0, +A.cy || 0, +A.r || 0])
    else if (el === 'ellipse') push(['e', +A.cx || 0, +A.cy || 0, +A.rx || 0, +A.ry || 0])
    else if (el === 'rect') push(['r', +A.x || 0, +A.y || 0, +A.width || 0, +A.height || 0, +A.rx || 0])
    else if (el === 'line') push(['l', +A.x1 || 0, +A.y1 || 0, +A.x2 || 0, +A.y2 || 0])
    else if (el === 'polyline') push(['l', ...nums(A.points)])
    else if (el === 'polygon') push(['p', ...nums(A.points)])
  }
  if (!parts.length) throw new Error(`[build-scene-symbols] ${file} 里没有解析出任何图元`)
  return parts
}

/** 24 网格 → 128 视框：所有坐标 ×K，线宽写成固定值 */
const rnd = (v) => Math.round(v * 100) / 100
function scalePrim(d) {
  const out = [d[0]]
  if (d[0] === 'path') {
    for (let i = 1; i < d.length; i++) {
      const c = d[i]
      out.push([c[0], ...c.slice(1).map((v) => rnd(v * K))])
    }
  } else {
    for (let i = 1; i < d.length; i++) out.push(rnd(d[i] * K))
  }
  return out
}

// ═══════════════════════════════════════════════════════════════════════════
// 生成
// ═══════════════════════════════════════════════════════════════════════════

const keys = [...SYMBOL_ICONS].sort()
const data = {}
for (const key of keys) {
  const i = key.indexOf(':')
  if (i < 0) throw new Error(`[build-scene-symbols] 图标名要带来源前缀：${key}`)
  const src = key.slice(0, i), name = key.slice(i + 1)
  const dir = SRC[src]
  if (!dir) throw new Error(`[build-scene-symbols] 未知图标来源：${src}（${key}）`)
  const file = path.join(dir, name + '.svg')
  if (!fs.existsSync(file)) throw new Error(`[build-scene-symbols] 图标不存在：${key} → ${file}`)
  data[key] = parseSvg(file, src === 'tabler-filled').map((p) => ({ d: scalePrim(p.d), s: p.s }))
}

const lines = []
lines.push('// 应用场景仿真 · 模块符号数据 —— 由 scripts/build-scene-symbols.mjs 生成，请勿手改。')
lines.push('//')
lines.push('// 来源：Tabler Icons（MIT，https://tabler.io/icons）与 Lucide（ISC，https://lucide.dev）。')
lines.push('// 两者都是 24 网格 / 2px 描边 / round cap-join，缩到本平台的 128 视框后线宽 32/3。')
lines.push('// 改符号 = 改 sceneSymbolMap.js 的映射，然后重跑 npm run build:symbols。')
lines.push('')
lines.push(`export const SYM_STROKE_W = ${rnd(STROKE_W)}`)
lines.push('')
lines.push('export const SYMBOL_DATA = {')
for (const key of keys) {
  const parts = data[key].map((p) => {
    const d = p.d[0] === 'path'
      ? `['path',${p.d.slice(1).map((c) => `['${c[0]}'${c.slice(1).length ? ',' + c.slice(1).join(',') : ''}]`).join(',')}]`
      : `['${p.d[0]}',${p.d.slice(1).join(',')}]`
    return `{d:${d},s:'${p.s}'}`
  })
  lines.push(`  '${key}': [${parts.join(',')}],`)
}
lines.push('}')
lines.push('')
lines.push('export default SYMBOL_DATA')
lines.push('')

fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
const bytes = fs.statSync(OUT).size
console.log(`[build-scene-symbols] ${keys.length} 个图标 → ${path.relative(ROOT, OUT)}（${(bytes / 1024).toFixed(1)} KB）`)
