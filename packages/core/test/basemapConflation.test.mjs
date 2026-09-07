// 50m 底图「贴合」后的数据不变量（scripts/conflate-basemap.mjs 的产物）。运行：npm test
//
// 为什么要有这一份：50m 的三份来源（map_units / breakaway_disputed_areas / boundary_lines_land）各自抽稀，再加
// backfill 从 10m 搬进来的单元，叠加面边界与宿主的国界「几乎重合却不共享弧」。屏上就是发丝般的透镜 sliver
// （中国视角下藏南东端三截碎线头）、沿国界多出一条平行线加悬空线头（中不争议区）、中立视角麦克马洪线上的勾勾
// （自带线与派生边界差 0.06°–0.12°）。2026-09 用户截图里那些「50m 下的小错误」全是这一类。
// 贴合脚本把它们改成共享弧；这里钉住结果，重建底图（build → backfill）忘了跑 conflate 时当场红。
//
// 派生规则与 povResolver.resolvedLines 同一口径（在这里复刻一遍，因为 povResolver 只静态载 10m，
// 50m 档在 Node 里换不了档 —— 见 ensureDetail 的注释）。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { FROZEN } from '../../../src/viz/geo/frozen.js'
import { normOwner, POV_FILES, POV_SOLID } from '../../../src/viz/geo/povList.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
const T = JSON.parse(readFileSync(join(ROOT, 'src', 'viz', 'globe3d', 'data', 'basemap-50m.json'), 'utf8'))

let pass = 0, fail = 0
const ok = (name, cond, note) => {
  if (cond) { pass++; console.log('PASS  ' + name + (note ? '  (' + note + ')' : '')) }
  else { fail++; console.log('FAIL  ' + name + (note ? '  — ' + note : '')) }
}

// ---------- 解码 ----------
const [sx, sy] = T.transform.scale, [tx, ty] = T.transform.translate
const arcs = T.arcs.map((a) => { let x = 0, y = 0; return a.map((d) => { x += d[0]; y += d[1]; return [x * sx + tx, y * sy + ty] }) })
const units = T.objects.units.geometries
const props = new Map(units.map((g) => [g.properties.u, g.properties]))
const key = (p) => p[0].toFixed(5) + ',' + p[1].toFixed(5)
const len = (a) => { let s = 0; for (let i = 1; i < a.length; i++) s += Math.hypot(a[i][0] - a[i - 1][0], a[i][1] - a[i - 1][1]); return s }
const segDist = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1]; const L2 = dx * dx + dy * dy || 1e-12; let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2; t = Math.max(0, Math.min(1, t)); return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy) }
const gap = (A, B) => { let m = 0; for (const p of A) { let d = Infinity; for (let i = 1; i < B.length; i++) d = Math.min(d, segDist(p, B[i - 1], B[i])); m = Math.max(m, d) } return m }

// 归属解算（povResolver.ownerOf 同一口径：FROZEN ?? 视角表 ?? own0，'none' 落宿主）
function ownerFn(povId) {
  const pov = POV_FILES[povId]
  const raw = (u) => FROZEN[u] || normOwner(pov.own[u]) || (props.get(u) ? normOwner(props.get(u).own0) : null)
  return (u) => { let c = u; for (let i = 0; i < 8; i++) { const o = raw(c); if (o !== 'none') return o || null; const p = props.get(c); if (!p) return null; if (!p.host) return normOwner(p.own0) || null; c = p.host } return null }
}
// 某视角下会画出来的弧及其类别（resolvedLines 的派生规则 + lineCls 顶替 + POV_SOLID 升格）
function drawn(povId) {
  const ownerOf = ownerFn(povId), solid = POV_SOLID[povId] || null
  const out = []
  for (const k in T.adj) {
    const pr = T.adj[k]
    const oa = pr[0] ? ownerOf(pr[0]) : null, ob = pr[1] ? ownerOf(pr[1]) : null
    if (!oa && !ob) continue
    let cls
    if (!oa || !ob) cls = 'coast'
    else if (oa === 'disputed' || ob === 'disputed') cls = 'indefinite'
    else if (oa !== ob) cls = 'admin0'
    else continue
    if (cls !== 'coast' && T.lineCls[k]) cls = T.lineCls[k]
    if (cls === 'indefinite' && solid && (oa === solid || ob === solid)) cls = 'admin0'
    out.push({ k: +k, cls, pr, oa, ob })
  }
  return out
}
const isCN = (povId, k) => { const o = ownerFn(povId); return (T.adj[k] || []).some((u) => u && o(u) === 'CHN') }

// ---------- ① 贴合步骤没被漏掉 ----------
ok('① 50m 底图带 meta.conflated（build → backfill → conflate 三步都跑了）', !!(T.meta && T.meta.conflated && T.meta.backfilled),
  T.meta && T.meta.conflated ? `贴合 ${T.meta.conflated.subst} 条 · 自带线 ${T.meta.conflated.lineSubst} 条` : '缺 meta.conflated')

// ---------- ② 涉华边界上没有透镜 sliver ----------
// 同端点的一对弧、两弧间距 < 0.01°、至少一侧挨着争议单元 —— 原生数据里藏南东端（IN-ARP|IND ↔ IND|CHN）三对、
// 控制线（IN-PK-KAS|PK-GB ↔ PAK|IND）三对就是这么来的：中国视角下两侧都要画国界，屏上就是小眼睛、碎线头。
{
  const byEnds = new Map()
  for (const k in T.adj) { const a = arcs[+k]; if (a.length < 2) continue; const e = [key(a[0]), key(a[a.length - 1])].sort().join('|'); let l = byEnds.get(e); if (!l) byEnds.set(e, l = []); l.push(+k) }
  const lens = [], lensCN = []
  for (const [, l] of byEnds) {
    if (l.length < 2) continue
    for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) {
      const A = arcs[l[i]], B = arcs[l[j]]
      const disp = [...T.adj[l[i]], ...T.adj[l[j]]].some((u) => u && props.get(u) && props.get(u).dispute)
      if (!disp) continue
      const g = Math.max(gap(A, B), gap(B, A))
      if (g >= 0.01) continue
      const rec = `arc#${l[i]} ${JSON.stringify(T.adj[l[i]])} ↔ arc#${l[j]} ${JSON.stringify(T.adj[l[j]])} 间距 ${g.toFixed(4)}°`
      lens.push(rec)
      if (isCN('CN', l[i]) || isCN('CN', l[j])) lensCN.push(rec)
    }
  }
  ok('② 涉华的争议透镜 sliver（同端点弧对、间距 < 0.01°）为 0', lensCN.length === 0, lensCN.length ? '\n      ' + lensCN.join('\n      ') : '全球剩 ' + lens.length + ' 对（顿巴斯 / 北塞浦路斯 / 约旦河西岸的原生小块，非涉华）')
  // 非涉华的残留是原生数据里薄块地的两条边，间距真有几十米那种；数量只许降不许升
  ok('②b 全球争议透镜 sliver 不多于 5 对', lens.length <= 5, lens.length + ' 对' + (lens.length > 5 ? '\n      ' + lens.join('\n      ') : ''))
}

// ---------- ③ 涉华边界没有悬空线头 ----------
// 某条被画出来的弧，端点没有别的被画弧相接 → 屏上是一截松脱的线头。回填单元（中不争议区 / 卡拉帕尼）的
// 10m 几何原本整个浮在 50m 弧网之外，两头都悬空；贴合之后应当一个不剩。
// 中不争议区东段那个鼓包（lon 90.35–90.48）是最难的一处：50m 的国界从它里面穿过（NE 自己两份数据打架），
// 鼓包外侧边贴上去环会自交、脚本按规则放弃；穿鼓包那一截国界两头都接在鼓包节点上、大半段落在鼓包里，
// 由脚本的 E 阶段把它 adj 里的 BTN 换成 BT-CN-NW —— 中国视角两侧同属溶解、中立视角照旧是国界。这里一并钉住。
for (const povId of ['CN', 'ISO']) {
  const list = drawn(povId)
  const ends = new Map()
  for (const d of list) { const a = arcs[d.k]; for (const p of [a[0], a[a.length - 1]]) ends.set(key(p), (ends.get(key(p)) || 0) + 1) }
  const dang = list.filter((d) => {
    if (d.cls === 'coast') return false
    const a = arcs[d.k]
    if (key(a[0]) === key(a[a.length - 1])) return false
    return [a[0], a[a.length - 1]].some((p) => ends.get(key(p)) === 1)
  })
  const cn = dang.filter((d) => isCN(povId, d.k))
  ok(`③ ${povId} 视角 · 涉华被画弧无悬空线头`, cn.length === 0,
    (cn.length ? '\n      ' + cn.map((d) => `arc#${d.k} ${d.cls} ${JSON.stringify(d.pr)} (${d.oa}|${d.ob}) len=${len(arcs[d.k]).toFixed(3)}`).join('\n      ') : `全球 ${dang.length} 条（均非涉华：毛里塔尼亚 / 阿尔及利亚一段与黎凡特的原生数据问题）`))
}

// ---------- ④ 麦克马洪线整条同一线型 ----------
// 10m 里它整条是 indefinite（NE 自带线覆盖全程）；50m 的自带线有缺口，贴合脚本按「同一对单元之间多数线型」补齐。
// 判据：IN-ARP|CHN 之间的每一条弧都带 lineCls=indefinite；中立视角下整条虚线、中国视角下（POV_SOLID）整条实线国界。
{
  const ks = Object.keys(T.adj).filter((k) => T.adj[k].includes('IN-ARP') && T.adj[k].includes('CHN'))
  const miss = ks.filter((k) => T.lineCls[k] !== 'indefinite')
  ok('④ 藏南北界（IN-ARP|CHN）每一条弧都是 indefinite', ks.length > 5 && miss.length === 0, `${ks.length} 条弧` + (miss.length ? '，缺分类：' + miss.map((k) => '#' + k).join(' ') : ''))
  // 自带几何的未定界线不该再有落在藏南一带的（都并进派生弧了）
  const stray = T.objects.lines.geometries.filter((g) => g.properties.cls === 'indefinite').flatMap((g) => (g.type === 'LineString' ? [g.arcs] : g.arcs)).filter((list) => list.some((e) => { const a = arcs[e < 0 ? ~e : e]; return a.some((p) => p[0] > 91 && p[0] < 98 && p[1] > 27 && p[1] < 30) }))
  ok('④b 藏南一带没有残留的自带未定界线段（曾是中立视角下国界旁的勾勾）', stray.length === 0, stray.length + ' 段')
}

// ---------- ⑤ 贴合没有把面弄坏 ----------
// 每个环闭合、无重复顶点；争议叠加面的每条弧都有 adj；没有弧被两个以上基础单元引用（构建脚本同一校验）
{
  const useB = new Map()
  let openRings = 0, dupRings = 0
  for (const g of units) {
    const polys = g.type === 'Polygon' ? [g.arcs] : g.arcs
    for (const poly of polys) for (const ring of poly) {
      const xy = []
      for (const e of ring) { const A = e < 0 ? [...arcs[~e]].reverse() : arcs[e]; for (let k = xy.length ? 1 : 0; k < A.length; k++) xy.push(A[k]) }
      if (xy.length < 4 || key(xy[0]) !== key(xy[xy.length - 1])) openRings++
      const seen = new Set(); for (let i = 0; i < xy.length - 1; i++) { const k = key(xy[i]); if (seen.has(k)) { dupRings++; break } seen.add(k) }
      if (!g.properties.dispute) for (const e of ring) { const a = e < 0 ? ~e : e; let s = useB.get(a); if (!s) useB.set(a, s = new Set()); s.add(g.properties.u) }
    }
  }
  // 基线（贴合前的原始 50m）：未闭合环 6 个（JQI / NE-B27 / JP-SEN / NE-B80 / NE-B63 / NE-B64 的两三点退化小环，
  // NE 原生数据的账）、含重复顶点的环 2 个（ESB / NE-B79 自触的环）。贴合只许不增加。
  ok('⑤ 未闭合环不多于原始数据的 6 个', openRings <= 6, openRings + ' 个未闭合')
  ok('⑤b 含重复顶点（8 字形 / 折返）的环不多于原始数据的 2 个', dupRings <= 2, dupRings + ' 个')
  const over = [...useB].filter(([, s]) => s.size > 2)
  ok('⑤c 没有弧被三个以上基础单元引用', over.length === 0, over.length + ' 条')
}

console.log('\n' + (fail ? 'FAILED ' : 'OK ') + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
