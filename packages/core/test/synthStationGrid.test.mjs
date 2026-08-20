// 站点栅生成自测（src/viz/grd/synth.js 的 buildStations 一路）。运行：npm test
// 被测文件是渲染端 ESM，故本测试自身也是 .mjs。
//
// 这份钉的是「站点栅怎么长出来」——SATSOFT 3.2.0 手册 §9.1 Station Grid Setup + §15 教程读数的逐条口径。
// 站点是【靶子】：合成图的形状由它决定（手册 §10.2 原话：pattern size and shape 由站点定，不由 beamlet 数定），
// 所以栅长错了，方向图就是错的，而且错得很像「对的」。四条不变式：
//   ① 密度＝站/成分波束宽，区内步距 = θ3/密度 → 密度翻倍，区内站点【变四倍】（手册 §9.1 明文）；
//   ② 边界站点落在【多边形自身的顶点】上，与密度【无关】——
//      教程 §15 读数反证：同一 CONUS 覆盖，密度 2→281 站、密度 4→501 站；
//      设边界 B、区内 I₂，则 B+I₂=281、B+4I₂=501 ⇒ I₂≈73、B≈208 恒定（≈CONUS 折线的顶点数）；
//   ③ 密度 0 ＝ 每个 Polygon 在质心生成【单站】（手册 §9.1 明文，用于一个 Polygon 一支衍射极限波束）；
//   ④ 界外抑制站是本引擎的附加档，缺省【关】——SATSOFT 生成栅时站点全为 Contour，Sidelobe 须手工指定（§10.2）。
//   ⑤ 站点数【无上限】（§1.1.2 p9：An unlimited number of beamlets and synthesis stations may be defined）——
//      密度加大就一路长下去，绝不静默封顶/抽稀；只有 ST_MAX=50万 的兜底会【抛错并报出数目】防渲染进程被打死。
// 另钉非法/缺省密度回落。
import { shapedStations, buildShapedGrd, theta3dbFromAperture } from '../../../src/viz/grd/synth.js'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}

const SAT = { satLon: 110.5, altKm: 35786 }
// 中国本土量级的覆盖折线（11 顶点）
const POLY = [[75, 40], [90, 45], [100, 48], [120, 50], [125, 45], [122, 38], [121, 31], [113, 22], [108, 21], [98, 24], [85, 35]]
const TH = theta3dbFromAperture(12, 1.5)          // θ3 ≈ 1.166°
const grid = (stGrid, polys = [POLY], theta3 = TH) => shapedStations({ ...SAT, polysPts: polys, theta3, stGrid })

// ==================== ① 密度语义：区内四倍律 ====================
{
  const a = grid({ dens: 1 }), b = grid({ dens: 2 }), c = grid({ dens: 4 }), d = grid({ dens: 8 })
  const r1 = b.counts.c0 / a.counts.c0, r2 = c.counts.c0 / b.counts.c0, r3 = d.counts.c0 / c.counts.c0
  ok('密度 1→2 区内站点 ≈×4', Math.abs(r2 - 4) < 0.6 || Math.abs(r1 - 4) < 1.2, `1→2 ${r1.toFixed(2)}× · 2→4 ${r2.toFixed(2)}×`)
  ok('密度 2→4 区内站点 ≈×4', Math.abs(r2 - 4) < 0.4, `${r2.toFixed(2)}×`)
  ok('密度 4→8 区内站点 ≈×4', Math.abs(r3 - 4) < 0.3, `${r3.toFixed(2)}×`)
  // 步距 = θ3/密度 ⇒ 三角栅每点占 0.866·(θ3/dens)²，反推面积在各档必须一致
  const area = (n, dn) => n * 0.866 * (TH / dn) * (TH / dn)
  const A2 = area(b.counts.c0, 2), A4 = area(c.counts.c0, 4), A8 = area(d.counts.c0, 8)
  ok('区内步距 = θ3/密度（各档反推面积一致）', Math.abs(A4 - A8) / A8 < 0.02 && Math.abs(A2 - A8) / A8 < 0.05, `${A2.toFixed(2)} / ${A4.toFixed(2)} / ${A8.toFixed(2)} deg²`)
}

// ==================== ② 边界站点 = 多边形顶点，与密度无关 ====================
{
  const counts = [1, 2, 3, 4, 8].map((d) => grid({ dens: d }).counts.c1)
  ok('边界站点数与密度无关', new Set(counts).size === 1, `dens 1/2/3/4/8 → ${counts.join('/')}`)
  ok('边界站点数 = 多边形顶点数', counts[0] === POLY.length, `${counts[0]} vs ${POLY.length} 顶点`)
  // 顶点加密一倍（每条边插中点）→ 边界站点跟着翻倍：形状分辨率由多边形决定，不由密度决定
  const dense = []
  for (let i = 0; i < POLY.length; i++) {
    const p = POLY[i], q = POLY[(i + 1) % POLY.length]
    dense.push(p, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2])
  }
  ok('多边形顶点加密 → 边界站点同步加密', grid({ dens: 2 }, [dense]).counts.c1 === dense.length, `${grid({ dens: 2 }, [dense]).counts.c1} vs ${dense.length}`)
  ok('Add Border Points 关 → 无边界站', grid({ dens: 2, border: false }).counts.c1 === 0)

  // ★ 教程 §15 的结构性读数：total(4) − total(2) = 3 × 区内(2)（边界项在差里被消掉）
  const t2 = grid({ dens: 2 }), t4 = grid({ dens: 4 })
  const lhs = t4.list.length - t2.list.length, rhs = 3 * t2.counts.c0
  ok('教程读数结构：t4 − t2 = 3×区内(2)', Math.abs(lhs - rhs) / rhs < 0.12, `${lhs} vs ${rhs}`)
}

// ==================== ③ 密度 0 = 每个 Polygon 质心单站 ====================
{
  const sq = [[100, 25], [105, 25], [105, 29], [100, 29]]
  const r = grid({ dens: 0, border: false }, [POLY, sq])
  ok('密度 0 → 每个 Polygon 一站', r.counts.c0 === 2, `c0=${r.counts.c0}`)
  ok('密度 0 时边界点仍受自己的开关管', grid({ dens: 0 }, [POLY, sq]).counts.c1 > 0)
  // 单站落在质心：方形的质心在几何中心，投影后仍应落在该多边形内
  const one = grid({ dens: 0, border: false }, [sq])
  ok('密度 0 的单站数 = 1', one.counts.c0 === 1 && one.list.length === 1)
}

// ==================== ④ 界外抑制站：缺省关（SATSOFT 生成时全 Contour） ====================
{
  // 预览一路恒不出抑制站（skipSup），故这里验的是【开关本身进得去引擎】：counts.c2 恒为 0，
  // 且开/关不影响区内与边界（抑制站不挤占别的名额）
  const off = grid({ dens: 2 }), on = grid({ dens: 2, sup: true })
  ok('缺省不生成界外抑制站', off.counts.c2 === 0)
  ok('抑制开关不改区内/边界站点', on.counts.c0 === off.counts.c0 && on.counts.c1 === off.counts.c1)
}

// ==================== ⑤ 栅类型 / 朝向 / 中心偏移 ====================
{
  const tri = grid({ dens: 2 }), rect = grid({ dens: 2, type: 'rect' })
  // 同步距下矩形栅每点占 c²、三角栅占 0.866c² → 三角栅点更多（约 1/0.866 = 1.15 倍）
  const ratio = tri.counts.c0 / rect.counts.c0
  ok('矩形栅比三角栅稀（≈0.866 倍点数）', ratio > 1.05 && ratio < 1.28, `${ratio.toFixed(3)}×`)
  const rot = grid({ dens: 2, rotDeg: 30 }), off = grid({ dens: 2, xOff: 0.3, yOff: -0.2 })
  ok('旋转改变站点位置', JSON.stringify(rot.list.map((s) => s.key)) !== JSON.stringify(tri.list.map((s) => s.key)))
  ok('中心偏移改变站点位置', JSON.stringify(off.list.map((s) => s.key)) !== JSON.stringify(tri.list.map((s) => s.key)))
  // 旋转/偏移只是挪栅，站点数不该跳变（同一覆盖区、同一步距）
  ok('旋转后站点数量级不变', Math.abs(rot.counts.c0 - tri.counts.c0) / tri.counts.c0 < 0.15, `${rot.counts.c0} vs ${tri.counts.c0}`)
  ok('偏移后站点数量级不变', Math.abs(off.counts.c0 - tri.counts.c0) / tri.counts.c0 < 0.15, `${off.counts.c0} vs ${tri.counts.c0}`)
}

// ==================== ⑥ 无上限：密度加大就一路长（旧版在 3500 站封顶，非 SATSOFT 口径） ====================
{
  // 站点数应严格随密度²增长，不出现平台段——旧版的面积地板 + 整数步长抽稀会在这里压成常数、甚至腰斩
  const ds = [8, 12, 16, 24, 32, 48]
  const seq = ds.map((d) => grid({ dens: d }).counts.c0)
  let mono = true, plateau = false
  for (let i = 1; i < seq.length; i++) {
    if (seq[i] <= seq[i - 1]) mono = false
    if (seq[i] < seq[i - 1] * 1.2) plateau = true      // 密度每档至少 ×1.2，说明没被封顶
  }
  ok('★ 密度加大站点数严格单调增', mono, seq.join(' → '))
  ok('★ 站点数不出现封顶平台段', !plateau, `dens ${ds.join('/')} → ${seq.join('/')}`)
  // 平方律：密度 ×2 → 站点 ×4，一直到远超旧版 3500 的量级
  const r = grid({ dens: 32 }).counts.c0 / grid({ dens: 16 }).counts.c0
  ok('★ 一万站以上仍守平方律', Math.abs(r - 4) < 0.2 && grid({ dens: 32 }).counts.c0 > 3500 * 3, `${r.toFixed(2)}× · dens32=${grid({ dens: 32 }).counts.c0} 站`)

  // 兜底：超 ST_MAX 时【生成】路当场抛错并把数目带出来，绝不静默抽稀
  let threw = null
  try {
    buildShapedGrd({ ...SAT, polysPts: [POLY], mode: 'physical', effPct: 55, theta3: TH, apDm: 1.5, fSimGHz: 12, stGrid: { dens: 4000 } })
  } catch (e) { threw = e }
  ok('超兜底当场抛错（生成路）', !!threw && /超出可算范围/.test(threw.message), threw ? threw.message.slice(0, 44) : '未抛')
  ok('抛错带出实际数目 err.stCount', !!threw && threw.stCount > 500000, threw ? `stCount=${threw.stCount}` : '—')
  // 预览路不许因此炸帧：吞掉抛错、把数目回给面板读数（黄方块清空、角标显示「约 N 站·超上限」）
  const pv = grid({ dens: 4000 })
  ok('预览路吞掉抛错并回报数目', pv !== null && pv.list.length === 0 && pv.over > 500000, pv ? `over=${pv.over}` : 'null')
}

// ==================== ⑦ 缺省与非法输入 ====================
{
  const base = grid({ dens: 2 }).counts.c0
  ok('缺参数 → 回落缺省密度 2', grid(null).counts.c0 === base)
  ok('NaN → 回落缺省密度 2', grid({ dens: NaN }).counts.c0 === base)
  ok('负密度 → 回落缺省密度 2', grid({ dens: -3 }).counts.c0 === base)
  ok('未知栅类型 → 三角栅', grid({ dens: 2, type: 'hex' }).counts.c0 === base)
  ok('高密度不再被旧的 8 档闸门打回缺省', grid({ dens: 12 }).counts.c0 > base * 4, `dens12=${grid({ dens: 12 }).counts.c0} vs dens2=${base}`)
  ok('密度 0 不被当成非法', grid({ dens: 0, border: false }).counts.c0 === 1)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
