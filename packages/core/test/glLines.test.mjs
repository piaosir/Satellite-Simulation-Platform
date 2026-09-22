// 2D 平面图「线」的 GPU 后端（src/viz/flatmap/glLines.js）：打包器与着色器口径的不变量。运行：npm test
//
// 为什么要有这一份：等值线 / 聚焦星轨迹从 Canvas2D 逐帧描边改成 GPU 实例化线段后，画面「对不对」
// 全押在打包器上 —— 经度解缠、链上累计距离（虚线相位）、按透明度分桶的实例顺序、花样表 —— 这些
// 都是纯 JS，Node 里就能钉住；着色器那半边只钉源码里的几条判据（圆帽 SDF、hairline 透明度、premultiplied）。
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createLinePacker, parseColor, REC_BYTES, DASH_MAX, VERT_SRC, FRAG_SRC } from '../../../src/viz/flatmap/glLines.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
let pass = 0
const ok = (c, m) => { assert.ok(c, m); pass++ }
const near = (a, b, eps, m) => ok(Math.abs(a - b) <= eps, `${m}: ${a} vs ${b}`)
const REC_F = REC_BYTES / 4
const rec = (packed, i) => { const f = new Float32Array(packed.buf, i * REC_BYTES, 8), u = new Uint8Array(packed.buf, i * REC_BYTES + 32, 4); return { x0: f[0], y0: f[1], x1: f[2], y1: f[3], d0: f[4], w: f[5], dash: f[6], scale: f[7], rgb: [u[0], u[1], u[2]] } }

// ---- ① 等距圆柱：跨 ±180° 的折线按段就近解缠，段起点归一到 [−180, 180)，不累出 ±360 以外的坐标 ----
{
  const pk = createLinePacker({ period: 360 })
  pk.style({ color: '#e8c074', width: 1.6, dash: null, alpha: 1 })
  // 一条向东绕地球一圈半的「轨迹」：经度 170 → −170 → −150 → … 每步 +20°，共 27 步 = 540°
  const pts = []
  for (let i = 0; i <= 27; i++) pts.push({ lon: ((170 + 20 * i + 180) % 360 + 360) % 360 - 180, lat: 10 })
  pk.polyline(pts, false)
  const p = pk.finish()
  ok(p.n === 27, '27 段')
  for (let i = 0; i < p.n; i++) {
    const r = rec(p, i)
    ok(r.x0 >= -180 && r.x0 < 180, `段 ${i} 起点归一 ${r.x0}`)
    near(r.x1 - r.x0, 20, 1e-4, `段 ${i} 就近解缠 +20°`)
  }
  near(rec(p, 0).x0, 170, 1e-6, '首段起点 170')
  near(rec(p, 0).x1, 190, 1e-6, '首段终点解缠到 190（不是 −170）')
  near(rec(p, 1).x0, -170, 1e-6, '次段起点再归一到 −170')
  ok(p.xMin >= -180 && p.xMax <= 360, `跨度有界 [${p.xMin}, ${p.xMax}]`)
  // 链上累计距离：第 i 段的 d0 = 20·i（纬度不变，世界距离就是经度差）
  for (let i = 0; i < p.n; i++) near(rec(p, i).d0, 20 * i, 1e-3, `段 ${i} 累计距离`)
}

// ---- ② 累计距离按世界平面的欧氏距离走（3-4-5），零长段跳过，NaN 断链且不接回 ----
{
  const pk = createLinePacker({ period: 360 })
  pk.style({ color: '#fff', width: 1, dash: [7, 5], alpha: 1 })
  pk.polyline([[0, 0], [3, 4], [3, 4], [6, 8], [NaN, 0], [10, 10], [13, 14]], false)
  const p = pk.finish()
  ok(p.n === 3, `零长段与坏点都不出段：${p.n}`)
  near(rec(p, 0).d0, 0, 1e-9, '首段 d0 = 0'); near(rec(p, 1).d0, 5, 1e-6, '次段 d0 = 5')
  near(rec(p, 2).d0, 0, 1e-9, 'NaN 之后新链从 0 起')
  near(rec(p, 2).x0, 10, 1e-9, '新链起点 (10,10)')
}

// ---- ③ 按透明度分桶：同透明度连续存放、桶按首次出现排序；趟区间覆盖全部实例 ----
{
  const pk = createLinePacker({ period: 360 })
  pk.style({ color: '#b8e6fa', width: 1.6, dash: [7, 5], alpha: 1 }); pk.polyline([[0, 0], [1, 0], [2, 0]], false)   // 2 段 α=1
  pk.style({ color: '#e8c074', width: 1.6, dash: null, alpha: 0.5 }); pk.polyline([[0, 1], [1, 1]], false)          // 1 段 α=.5
  pk.style({ color: '#b8e6fa', width: 1.6, dash: [7, 5], alpha: 1 }); pk.polyline([[0, 2], [1, 2], [2, 2], [3, 2]], false)   // 3 段 α=1
  pk.style({ color: '#ffffff', width: 1, dash: null, alpha: 0.5 }); pk.polyline([[0, 3], [1, 3]], false)            // 1 段 α=.5
  const p = pk.finish()
  ok(p.n === 7, '共 7 段')
  assert.deepStrictEqual(p.passes.map((q) => [q.alpha, q.off, q.n]), [[1, 0, 5], [0.5, 5, 2]]); pass++
  ok(rec(p, 4).y0 === 2 && rec(p, 5).y0 === 1 && rec(p, 6).y0 === 3, '桶内保持插入顺序、桶按首次出现排序')
  ok(rec(p, 0).rgb.join() === '184,230,250' && rec(p, 5).rgb.join() === '232,192,116', '颜色逐实例')
  ok(rec(p, 0).dash === 1 && rec(p, 5).dash === 0 && rec(p, 2).dash === 1, '花样 id：同样的 [7,5] 同一个 id，实线 0')
  assert.deepStrictEqual(p.dashes[1], [7, 5]); pass++
}

// ---- ④ 花样表：奇数长度按 Canvas 规则重复一遍；超过容量退回实线（而不是抛错） ----
{
  const pk = createLinePacker({ period: 0 })
  pk.style({ color: '#fff', width: 1, dash: [3], alpha: 1 }); pk.polyline([[0, 0], [1, 0]], false)
  for (let i = 0; i < DASH_MAX + 2; i++) { pk.style({ color: '#fff', width: 1, dash: [10 + i, 2], alpha: 1 }); pk.polyline([[0, i + 1], [1, i + 1]], false) }
  const p = pk.finish()
  assert.deepStrictEqual(p.dashes[1], [3, 3]); pass++
  ok(p.dashes.length === DASH_MAX, `花样表封顶 ${DASH_MAX}`)
  ok(rec(p, p.n - 1).dash === 0, '溢出的花样退回实线')
}

// ---- ⑤ 投影档（period=0）：不解缠、closePath 补最后一段回起点 ----
{
  const pk = createLinePacker({ period: 0 })
  pk.style({ color: 'rgba(255,255,255,0.9)', width: 1.2, dash: null, alpha: 0.9 })
  pk.moveTo(100, 0); pk.lineTo(-100, 0); pk.lineTo(-100, 50); pk.closePath()
  const p = pk.finish()
  ok(p.n === 3, '三段（含闭合段）')
  near(rec(p, 0).x1 - rec(p, 0).x0, -200, 1e-9, '投影档不解缠：−200 原样')
  near(rec(p, 2).x1, 100, 1e-9, '闭合段回到起点')
  near(p.passes[0].alpha, 0.9, 1e-9, '透明度来自样式')
}

// ---- ⑥ 颜色解析 ----
{
  assert.deepStrictEqual(parseColor('#e8c074'), [232, 192, 116, 1])
  assert.deepStrictEqual(parseColor('#fff'), [255, 255, 255, 1])
  assert.deepStrictEqual(parseColor('rgba(255,255,255,0.9)'), [255, 255, 255, 0.9])
  assert.deepStrictEqual(parseColor('rgb(1, 2, 3)'), [1, 2, 3, 1])
  assert.deepStrictEqual(parseColor('#00000080'), [0, 0, 0, 128 / 255])
  pass += 5
}

// ---- ⑦ 着色器源码里的几条判据（改了这里就得改测试） ----
{
  ok(/length\(vec2\(da \+ ext, q\)\) - vHalf/.test(FRAG_SRC), '片元：到胶囊的有符号距离 = 沿线差（越端 + 虚线空档）与横向差合成 → 圆帽 / 圆接头')
  ok(/fragColor = vec4\(vColor \* cov, cov\)/.test(FRAG_SRC), '片元：premultipliedAlpha 输出')
  ok(/float hf = max\(wDev, 1\.0\) \* 0\.5/.test(VERT_SRC) && /vAlpha = min\(wDev, 1\.0\)/.test(VERT_SRC), '顶点：亚像素细线按 1 px 画、用宽度折透明度（Skia hairline 口径）')
  ok(/vS0 = aPar\.x \* uK \* uDpr/.test(VERT_SRC) && /vDashScale = aPar\.w \* uDpr/.test(VERT_SRC), '顶点：虚线周期是屏幕像素（累计世界距离 × k × dpr；花样 × 倍率 × dpr）')
  ok(/float x0 = aSeg\.x - uLon0;\s*x0 -= 360\.0 \* floor\(x0 \/ 360\.0\)/.test(VERT_SRC) && /90\.0 - aSeg\.y/.test(VERT_SRC), '顶点：等距圆柱 x = (lon − LON0) mod 360、y = 90 − lat（与 Canvas2D 路同一式子）')
  ok(/if \(x1 > 360\.0\) off = -360\.0;\s*else if \(x1 < 0\.0\) off = 360\.0;/.test(VERT_SRC) && /gl\.drawArraysInstanced\(gl\.TRIANGLE_STRIP, 0, 10, pass\.n\)/.test(readFileSync(join(ROOT, 'src', 'viz', 'flatmap', 'glLines.js'), 'utf8')), '顶点：接缝副本只给跨出世界矩形的段（10 顶点三角带，不画三份环绕副本）')
  // flatCoverage 的两处分叉都把导出（compat / exporting）挡在 GPU 路之外，且线程序挂在 glField 的同一上下文上
  const FLAT = readFileSync(join(ROOT, 'src', 'viz', 'flatmap', 'flatCoverage.js'), 'utf8')
  ok(/const lnOk = \(\) => !compat && !exporting && !!glLines\(\)/.test(FLAT), 'flatCoverage：线的 GPU 路闸门含 !compat && !exporting')
  ok(/setSelGeom\(g\) \{[^\n]*dlDirty = true/.test(FLAT) && /setFocusStyle\(s\) \{[^\n]*dlDirty = true/.test(FLAT) && /setGeom\(g\) \{[^\n]*dlDirty = true/.test(FLAT) && /setSatLayer\(spec\) \{[^\n]*dlDirty = true/.test(FLAT), 'flatCoverage：数据线四个入口都置 dlDirty')
  const GLF = readFileSync(join(ROOT, 'src', 'viz', 'flatmap', 'glField.js'), 'utf8')
  ok(/lines\(\) \{/.test(GLF) && /gll = null/.test(GLF), 'glField：线程序挂在同一上下文上，上下文丢失即作废')
}

console.log(`glLines.test: ${pass} 条通过`)
