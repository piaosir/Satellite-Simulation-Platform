// 标记层符号 / 序号徽标配色 / 地球站单色件 / 逐条样式列 —— 四件都是「2D 平面图与 3D 球体共用同一支画笔」
// 的东西，画错了两个视图会一起错，且都只有肉眼能看出来。这里用一张记账用的假 canvas 把笔画收下来量。
//
// 关键不变式：
//   ① 形状连同描边整个塞进 d×d 方框 —— 3D 那边是把这张贴图整体缩放上屏的，超出方框就是被裁掉；
//   ② 图钉的锚点是【针尖】、形体全在锚点上方，其余形状锚点是形心（上下各半）；
//   ③ symbolUp/symbolDown/texCenterY 三者对同一形状必须自洽 —— 2D 按前两个让位、3D 按第三个设 center；
//   ④ 透明度作用于整枚符号（描边一起淡），与文字标注那条口径一致；
//   ⑤ 序号徽标的配色可换，且【换了颜色就得真换】（3D 那边按签名缓存贴图，键漏了配色就会拿回旧图）；
//   ⑥ 地球站符号只此一枚（Noto 六色天线 + 深色套边），不着色也不换形状；
//   ⑦ 标记表格只管坐标：点标记 [经度,纬度]、地球站 [名称,经度,纬度]，末两列恒为经纬度（批量粘贴按此解析）。
import {
  MARK_SHAPES, MARK_SHAPE_KEYS, isMarkShape, MARK_TEX_FILL,
  paintMarkSymbol, symbolAnchorY, texCenterY, symbolUp, symbolDown
} from '../../../src/viz/markers/markSymbols.js'
import { paintNumBadge, BADGE_DEF } from '../../../src/viz/markers/numBadge.js'
import { stationSvg, STATION_CASE } from '../../../src/viz/stationSymbol.js'
import { ref } from 'vue'
import { useMarkerTable } from '../../../src/viz/markers/useMarkerTable.js'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; return }
  fail++
  console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`)
}

// ===== 记账用的假 2D 上下文：记下每一笔的落点（已过变换矩阵）与用色 =====
function mkCtx() {
  const m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }   // 当前变换
  const stack = []
  const pts = [], fills = [], strokes = []
  const put = (x, y) => pts.push([m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f])
  const ctx = {
    globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 0,
    lineJoin: '', lineCap: '', miterLimit: 0, font: '', textAlign: '', textBaseline: '',
    save() { stack.push({ ...m, ga: this.globalAlpha }) },
    restore() { const s = stack.pop(); if (s) { Object.assign(m, { a: s.a, b: s.b, c: s.c, d: s.d, e: s.e, f: s.f }); this.globalAlpha = s.ga } },
    translate(x, y) { m.e += m.a * x + m.c * y; m.f += m.b * x + m.d * y },
    rotate(t) {
      const cs = Math.cos(t), sn = Math.sin(t)
      const a = m.a * cs + m.c * sn, b = m.b * cs + m.d * sn
      const c = m.a * -sn + m.c * cs, d = m.b * -sn + m.d * cs
      m.a = a; m.b = b; m.c = c; m.d = d
    },
    beginPath() {}, closePath() {},
    moveTo(x, y) { put(x, y) },
    lineTo(x, y) { put(x, y) },
    rect(x, y, w, h) { put(x, y); put(x + w, y + h) },
    arc(x, y, r) { put(x - r, y - r); put(x + r, y + r) },
    quadraticCurveTo(cx, cy, x, y) { put(cx, cy); put(x, y) },
    fill() { fills.push({ style: this.fillStyle, alpha: this.globalAlpha }) },
    stroke() { strokes.push({ style: this.strokeStyle, alpha: this.globalAlpha, w: this.lineWidth }) },
    measureText(t) { return { width: String(t).length * 6 } },
    fillText() { fills.push({ style: this.fillStyle, alpha: this.globalAlpha, text: true }) },
    strokeText() { strokes.push({ style: this.strokeStyle, alpha: this.globalAlpha, text: true }) }
  }
  ctx._pts = pts; ctx._fills = fills; ctx._strokes = strokes
  return ctx
}
const bbox = (pts) => pts.reduce((r, [x, y]) => ({
  x0: Math.min(r.x0, x), y0: Math.min(r.y0, y), x1: Math.max(r.x1, x), y1: Math.max(r.y1, y)
}), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity })

// ===== ① / ② 每种形状都塞得进 d×d 方框，且锚点语义正确 =====
const D = 40, X = 100, Y = 200
for (const sp of MARK_SHAPES) {
  const ctx = mkCtx()
  paintMarkSymbol(ctx, X, Y, D, { shape: sp.k, fill: '#ffd24a', edge: 0.18, edgeColor: '#ffffff' })
  const b = bbox(ctx._pts)
  const drew = ctx._fills.length + ctx._strokes.length > 0
  ok(`${sp.k}：画了笔画`, drew)
  // 方框：图钉在锚点上方一整格，其余上下各半。贝塞尔控制点会略微外扩，留 0.12d 余量。
  const top = sp.k === 'pin' ? Y - D : Y - D / 2, bot = sp.k === 'pin' ? Y : Y + D / 2
  const tol = D * 0.12
  ok(`${sp.k}：横向不出框`, b.x0 >= X - D / 2 - tol && b.x1 <= X + D / 2 + tol, `${b.x0.toFixed(1)}~${b.x1.toFixed(1)}`)
  ok(`${sp.k}：纵向不出框`, b.y0 >= top - tol && b.y1 <= bot + tol, `${b.y0.toFixed(1)}~${b.y1.toFixed(1)}`)
}
// 图钉：形体整个在锚点【上方】（针尖那一点就是站址）
{
  const ctx = mkCtx()
  paintMarkSymbol(ctx, X, Y, D, { shape: 'pin', fill: '#ffd24a' })
  const b = bbox(ctx._pts)
  ok('图钉：形体不越过针尖（锚点即最低点）', b.y1 <= Y + 0.5, `y1=${b.y1.toFixed(2)}`)
  ok('图钉：形体确实在上方', b.y0 < Y - D * 0.5)
}

// ===== ③ 让位口径三者自洽 =====
for (const k of MARK_SHAPE_KEYS) {
  const up = symbolUp(k), dn = symbolDown(k)
  ok(`${k}：上下外沿合计一整格`, Math.abs(up + dn - 1) < 1e-9, `${up}+${dn}`)
  ok(`${k}：anchorY 与 up/down 一致`, Math.abs(symbolAnchorY(k) - dn) < 1e-9)
  // 3D 的 sprite.center.y 自底算：形心锚 0.5；针尖锚落在贴图里形状方框的底边
  const want = k === 'pin' ? 0.5 - MARK_TEX_FILL / 2 : 0.5
  ok(`${k}：texCenterY 对得上`, Math.abs(texCenterY(k) - want) < 1e-9, `${texCenterY(k)} vs ${want}`)
}
ok('形状键不重复', new Set(MARK_SHAPE_KEYS).size === MARK_SHAPE_KEYS.length)
ok('isMarkShape 认得几何件、不认天线件', isMarkShape('circle') && !isMarkShape('noto') && !isMarkShape('antenna'))

// ===== ④ 透明度作用于整枚符号（填充与描边一起淡）=====
{
  const ctx = mkCtx()
  paintMarkSymbol(ctx, X, Y, D, { shape: 'circle', fill: '#ffd24a', opacity: 0.4, edge: 0.2, edgeColor: '#ffffff' })
  ok('透明度：填充跟着淡', ctx._fills.every((f) => Math.abs(f.alpha - 0.4) < 1e-9), JSON.stringify(ctx._fills))
  ok('透明度：描边也跟着淡', ctx._strokes.length > 0 && ctx._strokes.every((f) => Math.abs(f.alpha - 0.4) < 1e-9))
  const c2 = mkCtx()
  paintMarkSymbol(c2, X, Y, D, { shape: 'cross', fill: '#ffd24a', opacity: 0.4, edge: 0.2, edgeColor: '#ffffff' })
  ok('透明度：十字两趟描边都淡', c2._strokes.length === 2 && c2._strokes.every((f) => Math.abs(f.alpha - 0.4) < 1e-9))
  const c3 = mkCtx()
  paintMarkSymbol(c3, X, Y, D, { shape: 'circle', fill: '#ffd24a', edge: 0 })
  ok('描边 0 = 不描边', c3._strokes.length === 0)
  const c4 = mkCtx()
  paintMarkSymbol(c4, X, Y, 0, { shape: 'circle', fill: '#ffd24a' })
  ok('直径 0 = 什么都不画', c4._fills.length === 0 && c4._strokes.length === 0)
}

// ===== ⑤ 序号徽标：配色可换，且换了就真换 =====
{
  const a = mkCtx(); paintNumBadge(a, X, Y, 24, '7', 'Arial')
  const b = mkCtx(); paintNumBadge(b, X, Y, 24, '7', 'Arial', { fill: '#00ff00', fillOpacity: 0.5, ring: '#123456', ink: '#abcdef' })
  const aFill = a._fills.map((f) => String(f.style)).join('|')
  const bFill = b._fills.map((f) => String(f.style)).join('|')
  ok('徽标：缺省走出厂配色', aFill.includes('255,210,74') && aFill.includes(BADGE_DEF.ink))
  ok('徽标：盘换色 + 换透明度', bFill.includes('rgba(0,255,0,0.5)'), bFill)
  ok('徽标：数字换色', bFill.includes('#abcdef'))
  ok('徽标：白圈换色', b._strokes.some((t) => String(t.style).includes('18,52,86')), JSON.stringify(b._strokes))
  ok('徽标：与默认配色画出来的确实不同', aFill !== bFill)
}

// ===== ⑥ 地球站符号 =====
{
  const color = stationSvg()
  ok('地球站：Noto 六色照旧', color.includes('#94D1E0') && color.includes('#82AEC0') && color.includes('#2F7889'))
  ok('地球站：带深色套边（浅底图上切得出轮廓）', color.includes(STATION_CASE))
  ok('地球站：fill="none" 的馈源杆没被填上色', color.includes('fill="none"'))
  ok('地球站：不吃形参（不着色也不换形状）', stationSvg('#ff0000') === color)
}

// ===== ⑦ 标记表格只管坐标：末两列恒为经纬度（批量粘贴按此约定解析）=====
{
  const points = ref([]), stations = ref([]), trajectories = ref([])
  let nid = 0
  const mk = useMarkerTable({ points, stations, trajectories, newId: () => 'm' + (++nid), sync: () => {} })
  ok('点标记列：只有经纬度两列', mk.PT_COLS.join(',') === 'lon,lat')
  ok('地球站列：名称 + 经纬度', mk.ST_COLS.join(',') === 'name,lon,lat')
  ok('航点列：只有经纬度两列', mk.WP_COLS.join(',') === 'lon,lat')
  mk.ptLayer.pasteAppend(['120\t30', '121\t31'].join('\n'))
  ok('点标记粘贴：两行都进来了，坐标落在末两列', points.value.length === 2 && points.value[0].lon === 120 && points.value[1].lat === 31)
  mk.stLayer.pasteAppend(['北京站', '116.4', '39.9'].join('\t'))
  ok('地球站粘贴：名称 + 坐标各就各位', stations.value.length === 1 && stations.value[0].name === '北京站' && stations.value[0].lon === 116.4 && stations.value[0].lat === 39.9)
}

// ===== ⑧ 线型表：侧栏给几档，两个渲染器就得认几档 =====
// 病灶（2026-09-01 修）：侧栏 DASH_OPTS 有四档，而 flatCoverage 的 DASH_2D 只写了 dash / dot ——
// 查不到时 `DASH_2D[x] || null` 静默当成实线。于是同一条线（聚焦卫星的轨道/轨迹/覆盖圈、航迹线）
// 选「点划线」时 3D 出点划、2D 出实线，两个视图两副样子，且不报任何错。
// 这类「少一档不报错、只是画错」的表必须由测试兜住，故在这里逐处对拍键集。
{
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
  // 取一段 `xxx = { ... }` 里的键名（键都是 solid/dash/dot/dashdot 这类裸标识符）
  const keysOf = (src, name) => {
    const m = new RegExp(name + '\\s*=\\s*\\{([^}]*)\\}').exec(src)
    return m ? [...m[1].matchAll(/(\w+)\s*:/g)].map((x) => x[1]) : null
  }
  const optKeys = (() => {
    const m = /DASH_OPTS\s*=\s*\[([\s\S]*?)\]/.exec(read('src/pages/ConstellationMap3D.vue'))
    return m ? [...m[1].matchAll(/\bk:\s*'([^']+)'/g)].map((x) => x[1]) : null
  })()
  const d2d = keysOf(read('src/viz/flatmap/flatCoverage.js'), 'DASH_2D')
  const d3d = keysOf(read('src/viz/globe3d/focusLanes.js'), 'DASH_SPEC')
  const dpx = keysOf(read('src/viz/geo/borderStyle.js'), 'DASH_PX')
  ok('线型档位表都读得到', !!(optKeys && d2d && d3d && dpx),
    `DASH_OPTS=${optKeys} DASH_2D=${d2d} DASH_SPEC=${d3d} DASH_PX=${dpx}`)
  // solid 不进这三张表（实线＝不设虚线数组），其余每一档三处都必须有
  const want = (optKeys || []).filter((k) => k !== 'solid')
  ok('侧栏线型至少四档（实线/虚线/点线/点划线）', want.length >= 3, `实得 ${want.join(',')}`)
  const miss2d = want.filter((k) => !d2d.includes(k))
  const miss3d = want.filter((k) => !d3d.includes(k))
  const misspx = want.filter((k) => !dpx.includes(k))
  ok('★ 2D 平面图认得侧栏给的每一档线型（少一档＝那一档静默画成实线）', miss2d.length === 0, `缺 ${miss2d.join(',')}`)
  ok('3D 球体认得侧栏给的每一档线型', miss3d.length === 0, `缺 ${miss3d.join(',')}`)
  ok('边界线线型表认得每一档', misspx.length === 0, `缺 ${misspx.join(',')}`)
  ok('2D 与 3D 的线型键集完全一致', d2d.slice().sort().join(',') === d3d.slice().sort().join(','),
    `2D=${d2d.join(',')} / 3D=${d3d.join(',')}`)
}

console.log(`markSymbols: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
