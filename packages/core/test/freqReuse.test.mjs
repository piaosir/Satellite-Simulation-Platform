// 多波束频率复用配色（波束合成的「频率计划 · 自动分配」）自测。运行：npm test
// 被测文件是渲染端 ESM（src/viz/grd/synth.js 的 colorFreqPlan），故本测试也是 .mjs。
//
// 关键不变式：
//   ① 判据是【复用距离】不是「挨着就行」：正六边形晶格上复用因子 N 的同色最小间距 D = √N·d
//      （d = 相邻波束中心距）。故 k 色着完之后，任意一对同色波束的间距都必须 ≥ 门限 0.95·D，
//      否则色数加上去了而 C/CCI 一点没变好 —— 这正是把原先固定的 1.18d 换掉的理由；
//   ①b √N 只对 Loeschian 数（i²+ij+j² = 3·4·7·9·12·13·16·19…）成立，其余色数取不到，
//      门限按【实际可达】给（reuseDist）—— 十色最远只到 √7，虚标成 √10 就是骗人；
//   ② 界面那七档 3 / 4 / 7 / 8 / 9 / 12 / 16 在理想蜂窝上必须【零冲突】排得开。七档取的是
//      【有效前沿】而非「凡复用因子都列」：同一可达间距上只留最省频率的那一档，单极化（奇数）
//      与双极化（偶数）各算各的 —— 故 8 在（4 频段×2 极化，2.65d，每波束 1/4 频段），
//      10 不在（同为 2.65d 却要切 5 段频率，被 8 支配）；
//   ③ k 色都要用上（不许退化成更少的色），且各色用量均衡 —— 否则某几段频率被过度装载；
//   ④ 排不开时不许假装排开：conflicts 如实计数（UI 据此报「该布局 k 色排不开」）。
import { colorFreqPlan, reuseDistFactor, reuseDist, beamSketchRing } from '../../../src/viz/grd/synth.js'
import { dirToAzEl } from '../../../src/viz/grd/coverage.js'
// 引擎侧的档位表（CJS）：两处档位必须同表，故在这里一并验
import ciCci from '../utils/interference/ciCci.js'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; return }
  fail++
  console.error('  ✗ ' + name + (extra != null ? '  → ' + extra : ''))
}
console.log('频率复用配色 自测')

// 正六角晶格：间距 d = 2r（相切），行距 d·√3/2，奇数行错开半格 —— 蜂窝布满出来的就是这个
function hexLattice(rows, cols, r = 0.5) {
  const d = 2 * r
  const out = []
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      out.push({ az: j * d + (i % 2 ? d / 2 : 0), el: -i * d * Math.sqrt(3) / 2, r })
    }
  }
  return out
}
const dist = (a, b) => Math.hypot(a.az - b.az, a.el - b.el)
// 同色对里最近的那一对（以 d 为单位）
function minSameColorDist(nodes, colors, d) {
  let m = Infinity
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (colors[i] === colors[j]) m = Math.min(m, dist(nodes[i], nodes[j]) / d)
    }
  }
  return m
}

/* ---------- ① 可达复用距离表：√k 只对 Loeschian 数成立 ---------- */
{
  // 数论事实（Loeschian 数 i²+ij+j²）：3/4/7/9/12/13/16/19 取得到理论上界 √k，其余取不到。
  // ★ 十色是最要紧的一条：它最远只能排到 √7 —— 与七色同一水平，多的三段频率不换来更远的隔离。
  //   界面据此如实标注；虚标成 √10 会让人以为十色比七色排得开。
  const want = { 3: 3, 4: 4, 7: 7, 9: 9, 12: 12, 13: 13, 16: 16, 19: 19, 5: 3, 6: 4, 8: 7, 10: 7, 11: 7, 14: 12, 15: 13, 17: 13, 18: 13, 20: 16 }
  for (const [k, n] of Object.entries(want)) {
    ok(`${k} 色可达间距 = √${n}`, Math.abs(reuseDist(+k) - Math.sqrt(n)) < 1e-9, `${reuseDist(+k).toFixed(4)} vs ${Math.sqrt(n).toFixed(4)}`)
  }
  // Hermite 界：指数 k 的子晶格最短向量绝不可能超过 √k·d —— 超了就是搜索范围漏了短向量
  for (let k = 2; k <= 24; k++) ok(`${k} 色不超理论上界`, reuseDist(k) <= Math.sqrt(k) + 1e-9, `${reuseDist(k)} > √${k}`)
  // 门限卡在可达距离之下一点点：理想图案仍排得开，比它更近的同色一律禁止
  for (const k of [3, 4, 7, 8, 9, 12, 16]) {
    ok(`${k} 色门限 < 可达距离`, reuseDistFactor(k) < reuseDist(k))
    ok(`${k} 色门限 = 0.95×可达`, Math.abs(reuseDistFactor(k) - reuseDist(k) * 0.95) < 1e-9)
  }
}

/* ---------- ② 理想蜂窝：界面上那六档都排得开，且同色间距达到各自的可达距离 ---------- */
{
  const r = 0.5, d = 2 * r
  const nodes = hexLattice(12, 12, r)          // 144 个波束，足够铺开十六色的图案
  for (const k of [3, 4, 7, 8, 9, 12, 16]) {
    const { colors, conflicts } = colorFreqPlan(nodes, k)
    const used = new Set(colors)
    const mind = minSameColorDist(nodes, colors, d)
    ok(`${k} 色：蜂窝上零冲突`, conflicts === 0, `conflicts=${conflicts}`)
    ok(`${k} 色：${k} 色全用上`, used.size === k, `用了 ${used.size} 色`)
    ok(`${k} 色：同色最小间距 = 可达的 ${reuseDist(k).toFixed(2)}d`, Math.abs(mind - reuseDist(k)) < 1e-6,
      `实测 ${mind.toFixed(3)}d`)
    // 各色用量均衡（最多与最少相差不超过 1/4 —— 144 个波束分 16 色，明显失衡就是算法退化了）
    const cnt = new Array(k).fill(0)
    colors.forEach((c) => { cnt[c]++ })
    const mx = Math.max(...cnt), mn = Math.min(...cnt)
    ok(`${k} 色：各色用量均衡`, mx - mn <= Math.max(2, Math.ceil(nodes.length / k / 4)), `${mn}~${mx}`)
  }
}

/* ---------- ③ 加色数换来的到底是什么（这条就是本次改判据的意义） ---------- */
{
  const r = 0.5, d = 2 * r
  const nodes = hexLattice(12, 12, r)
  const m = (k) => minSameColorDist(nodes, colorFreqPlan(nodes, k).colors, d)
  const m4 = m(4), m7 = m(7), m8 = m(8), m9 = m(9), m10 = m(10), m12 = m(12), m16 = m(16)
  // 复用距离之比 = √(16/4) = 2：色数翻两番，同色间距正好翻一倍
  ok('十六色的同色间距 = 四色的两倍', Math.abs(m16 / m4 - 2) < 0.02, `4色 ${m4.toFixed(2)}d · 16色 ${m16.toFixed(2)}d`)
  ok('七色 = √7·d', Math.abs(m7 - Math.sqrt(7)) < 0.02, `${m7.toFixed(3)}d`)
  ok('九色 = 3d', Math.abs(m9 - 3) < 0.02, `${m9.toFixed(3)}d`)
  ok('十二色 = √12·d', Math.abs(m12 - Math.sqrt(12)) < 0.02, `${m12.toFixed(3)}d`)
  // ★ 八色与七色同间距（8 取不到 √8）—— 八色的价值不在更远，而在【同样远却只切 4 段频率】：
  //   双极化下每波束拿 1/4 频段，七色只有 1/7。界面 title 必须这么写，不能虚标成 √8。
  ok('八色的同色间距 = 七色（不是 √8）', Math.abs(m8 - m7) < 1e-6 && m8 < Math.sqrt(8) - 0.15,
    `8色 ${m8.toFixed(3)}d · 7色 ${m7.toFixed(3)}d`)
  // ★ 十色同样是 2.65d，却要切 5 段频率 —— 被八色支配，故不进预设（上一轮撤掉它就是这个理由）。
  //   算法层仍得如实：有人程序化传 10 进来时不许虚标成 √10。这条钉住它。
  ok('十色的同色间距 = 七色（不是 √10）', Math.abs(m10 - m7) < 1e-6 && m10 < Math.sqrt(10) - 0.4,
    `10色 ${m10.toFixed(3)}d · 7色 ${m7.toFixed(3)}d`)
  // 两条极化线各自单调：每往上一档，同色间距确实变远（不出现「加了色数间距却没变」的虚档）
  const single = [m(3), m7, m9]
  const dual = [m4, m8, m12, m16]
  ok('单极化线 3/7/9 间距严格递增', single.every((v, i) => !i || v > single[i - 1] + 0.01), single.map((v) => v.toFixed(2)).join(' < '))
  ok('双极化线 4/8/12/16 间距严格递增', dual.every((v, i) => !i || v > dual[i - 1] + 0.01), dual.map((v) => v.toFixed(2)).join(' < '))
}

/* ---------- ④ 排不开时如实计数，不假装排开 ---------- */
{
  // 5 个波束挤在半径 0.6d 的小圈里（两两间距 ≤1.2d，全在四色门限 1.9d 之内），只给 4 色
  // → 鸽笼原理必有一对同色。这种「排不开」必须报出来，不能靠放宽判据装作排开了。
  const tight = []
  for (let i = 0; i < 5; i++) tight.push({ az: 0.6 * Math.cos(i * 2 * Math.PI / 5), el: 0.6 * Math.sin(i * 2 * Math.PI / 5), r: 0.5 })
  const t = colorFreqPlan(tight, 4)
  ok('挤成一团排不开 → conflicts > 0', t.conflicts > 0, `conflicts=${t.conflicts}`)
  ok('排不开也照样出满一份着色', t.colors.length === 5 && t.colors.every((c) => c >= 0 && c < 4))
  // 抖动过的晶格（识别不出严格晶格 → 回退贪心）：仍出满一份着色，冲突数如实可读
  let s = 7
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647
  const jit = []
  for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) {
    jit.push({ az: j + (i % 2 ? 0.5 : 0) + (rnd() - 0.5) * 0.5, el: -i * Math.sqrt(3) / 2 + (rnd() - 0.5) * 0.5, r: 0.5 })
  }
  const jr = colorFreqPlan(jit, 12)
  ok('抖动晶格：出满一份着色', jr.colors.length === 81 && jr.colors.every((c) => c >= 0 && c < 12))
  ok('抖动晶格：冲突如实计数（不是零）', jr.conflicts > 0, `conflicts=${jr.conflicts}`)
  // 边界：空布局 / 非法色数不抛异常
  ok('空布局 → 空结果', colorFreqPlan([], 4).colors.length === 0)
  ok('色数 < 2 → 空结果', colorFreqPlan(hexLattice(4, 4, 0.5), 1).colors.length === 0)
}

/* ---------- ④b 真实布局不会正好轴对齐：旋转 + 平移 + 缩放后仍认得出晶格 ---------- */
{
  const th = 23 * Math.PI / 180, S = 1.7, d0 = 1
  const base = hexLattice(9, 10, d0 / 2)
  const nodes = base.map((p) => ({
    az: (p.az * Math.cos(th) - p.el * Math.sin(th)) * S + 12.3,
    el: (p.az * Math.sin(th) + p.el * Math.cos(th)) * S - 4.5,
    r: p.r * S
  }))
  for (const k of [4, 7, 8, 9, 12, 16]) {
    const { colors, conflicts } = colorFreqPlan(nodes, k)
    const mind = minSameColorDist(nodes, colors, d0 * S)
    ok(`旋转缩放后 ${k} 色仍零冲突`, conflicts === 0, `conflicts=${conflicts}`)
    ok(`旋转缩放后 ${k} 色间距 = 可达距离`, Math.abs(mind - reuseDist(k)) < 0.02, `${mind.toFixed(3)}d`)
  }
}

/* ---------- ④c 不是复用因子的色数（5/6/11…）取不到 √k，但仍要排出图案、不能崩 ---------- */
{
  const nodes = hexLattice(8, 8, 0.5)
  for (const k of [5, 6, 11, 14]) {
    const { colors, conflicts } = colorFreqPlan(nodes, k)
    ok(`${k} 色：仍出满一份着色`, colors.length === nodes.length && colors.every((c) => c >= 0 && c < k))
    ok(`${k} 色：按可达距离排出图案（零冲突）`, conflicts === 0, `conflicts=${conflicts}`)
    ok(`${k} 色：可达距离 < √${k}`, reuseDist(k) < Math.sqrt(k) - 1e-9)
  }
}

/* ---------- ⑥ 界面预设 = 有效前沿：同一间距上只留最省频率的那一档 ---------- */
{
  // 引擎侧那份表（干扰分析 C/CCI 的复用色数下拉与波束合成的颜色数共用同一组档位）
  const PRESETS = ciCci.REUSE_PRESETS
  ok('引擎预设 = 3/4/7/8/9/12/16', JSON.stringify(PRESETS) === JSON.stringify([3, 4, 7, 8, 9, 12, 16]), JSON.stringify(PRESETS))
  // 有效前沿：同一条极化线上（奇数 = 单极化 · 偶数 = K 频段×2 极化），
  // 不许存在更小的同类档位达到同样甚至更远的间距 —— 否则那一档纯属多切频率
  for (const k of PRESETS) {
    const dominated = PRESETS.filter((j) => j < k && j % 2 === k % 2 && reuseDist(j) >= reuseDist(k) - 1e-9)
    ok(`${k} 色不被更小的同类档位支配`, dominated.length === 0, `被 ${dominated.join('/')} 支配`)
  }
  // 反例钉死：这几个都被更小的同类档位支配，故不该进预设
  for (const [bad, by] of [[10, 8], [6, 4], [14, 12], [11, 9], [18, 16]]) {
    ok(`${bad} 色被 ${by} 支配（故不列）`, by < bad && bad % 2 === by % 2 && reuseDist(bad) <= reuseDist(by) + 1e-9,
      `${reuseDist(bad).toFixed(3)} vs ${reuseDist(by).toFixed(3)}`)
  }
}

/* ---------- ⑤ 不规则布局（手工摆放）：不抛异常、色数用得下、同色不重叠 ---------- */
{
  const nodes = []
  for (let i = 0; i < 40; i++) nodes.push({ az: (i * 2.7) % 11, el: -((i * 1.9) % 9), r: 0.5 })
  const { colors, conflicts } = colorFreqPlan(nodes, 16)
  ok('不规则布局也出满一份着色', colors.length === 40 && colors.every((c) => c >= 0 && c < 16))
  ok('不规则布局的冲突数如实可读', Number.isFinite(conflicts) && conflicts >= 0)
}

/* ---------- ⑦ 配好的色必须画得出来：轮廓环恒为「单段闭环」，跨地平的边缘波束也要能填充 ---------- */
{
  // 渲染端的填充判据（useBeamSynth sketchSpec）：segs 恰一段、首尾重合、≥4 点 → 取 slice(0,-1) 作填充多边形。
  // 原先 beamSketchRing 把越地平的点整点剔除 → 环被切成两段开口弧 → 判据不成立 → 那只波束【只有轮廓没有填色】。
  // GEO 上离轴 ≳8.3°（仰角约几度的边缘波束）就会踩到；蜂窝布满铺到覆盖区边缘时成片出现。
  const satLon = 110.5, altKm = 35786
  const fillPoly = (segs) => {
    if (segs.length !== 1) return null
    const s = segs[0]
    if (s.length < 4) return null
    const a = s[0], z = s[s.length - 1]
    return (Math.abs(a[0] - z[0]) < 1e-9 && Math.abs(a[1] - z[1]) < 1e-9) ? s.slice(0, -1) : null
  }
  const ringAt = (lon, lat, th = 1) => beamSketchRing({ satLon, satLat: 0, altKm, lon, lat, thX: th, thY: th, rot: 0 })
  const offAxis = (lon, lat) => { const ae = dirToAzEl(satLon, 0, altKm, lon, lat); return Math.hypot(ae.az, ae.el) }

  // ★ 病例复现：离轴 8.3°~8.7°（可见地球的最外一圈）——这一带原先无一例外拿不到填充
  let edge = 0, edgeFill = 0
  for (let lat = -60; lat <= 60; lat += 5) {
    for (let lon = satLon - 84; lon <= satLon - 56; lon += 2) {
      if (!(offAxis(lon, lat) > 8.3)) continue
      edge++
      if (fillPoly(ringAt(lon, lat))) edgeFill++
    }
  }
  ok('边缘波束（离轴 >8.3°）取样到位', edge > 40, `只取到 ${edge} 个`)
  ok('边缘波束全部拿得到填充多边形', edge === edgeFill, `${edgeFill}/${edge}`)

  // 可见半球整片扫：只要画得出轮廓，就必须填得上色（轮廓与填充同生共死）
  let drawn = 0, noFill = 0
  for (let lat = -85; lat <= 85; lat += 2.5) {
    for (let lon = -180; lon < 180; lon += 2.5) {
      const segs = ringAt(lon, lat)
      if (!segs.length) continue
      drawn++
      if (!fillPoly(segs)) noFill++
    }
  }
  ok('全球扫：画得出轮廓 = 填得上色', noFill === 0, `${noFill}/${drawn} 只有轮廓没填色`)

  // 环不能因为贴地平就退化：仍是完整一圈（n+1 点），且经纬范围有限（不绕地球一圈）
  const r = ringAt(satLon - 76, 32)[0]
  const lons = r.map((q) => q[0]), lats = r.map((q) => q[1])
  ok('跨地平波束仍是完整一圈', r.length === 73, `${r.length} 点`)
  ok('跨地平波束的环不发散', Math.max(...lons) - Math.min(...lons) < 60 && Math.max(...lats) - Math.min(...lats) < 30,
    `lon 跨 ${(Math.max(...lons) - Math.min(...lons)).toFixed(1)}° · lat 跨 ${(Math.max(...lats) - Math.min(...lats)).toFixed(1)}°`)
  // 星下点的波束几何不受影响（回归护栏：改的是地平外的点，可见区一个点都不许动）
  const c = ringAt(satLon, 0)[0]
  ok('星下点波束仍居中对称', Math.abs((Math.min(...c.map((q) => q[0])) + Math.max(...c.map((q) => q[0]))) / 2 - satLon) < 1e-6)
}

console.log(`  ${pass} 通过, ${fail} 失败`)
if (fail) process.exit(1)
