// GEO 通信星平台预设（2026-10-07，「简化完成」口径）：按平台给缺省外形，各型号只填差异（质量 / 翼展 / 板数 / 反射面配置）。
//
// ★ 平台缺省值（本体比例、单板尺寸、轭长、反射面口径、MLI 颜色）除注明有出处的几项外都是造型示意（ILL）：
//   有出处的：欧洲星 E3000 长板 3.915 × 2.28 m（ESA）、空间客车 4000 单板 3.66 × 2.22 m + 每翼「4 块 + 2 块侧板」（Engineering 2022）、
//   东方红四号本体 2360 × 2100 × 3600 mm（CAST）、东四增强型每翼 4 块 3.30 × 2.36 m（Engineering 2022）——这些在型号文件的 facts 里逐条记出处。
// ★ 坐标同 geokit：+Z 对地、+X 东、+Y 南，原点 = 平台结构盒中心。
//
// 导出：PLATFORMS（只读）、comsat(B, p)、reflSet(refl, h)

import { buildGeo, yokeForSpan, GEO_DEFAULTS } from './geokit.mjs'

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const fr = (o) => Object.freeze(o)

const GOLD = fr({ east: 'mli_gold', west: 'mli_gold', deck: 'mli_gold', aft: 'mli_gold', band: 'mli_gold' })
const GOLD_BLACK = fr({ east: 'mli_gold', west: 'mli_gold', deck: 'mli_gold', aft: 'mli_black', band: 'mli_black' })
const BLACK = fr({ east: 'mli_black', west: 'mli_black', deck: 'mli_black', aft: 'mli_black', band: 'mli_black' })
const SILVER = fr({ east: 'mli_silver', west: 'mli_silver', deck: 'mli_gold', aft: 'mli_black', band: 'mli_silver' })

/**
 * 平台缺省：bus [x, y, z]（结构盒全尺寸）、faces（各面 MLI）、wing（geoWings 参数缺省）、refl（缺省反射面配置，见 reflSet）、
 * ep（电推臂）、deployRad（可展开散热板，函数：h → 列表）、flap（ADCS 配平小翼：铰在倒数第二块板长边上，见 geokit.geoWings）。
 * 翼型按 2026-10-08 调研（eurostar_spacebus / ssl1300 / boeing_lm_ng_cast）：
 *   · 欧洲之星 E3000：3 / 4 / 5 块串联直翼（短板 3.050 × 2.28、长板 3.915 × 2.28 m，ESA），从不挂侧板；ADCS 小翼不在翼尖，
 *     铰在倒数第二块板的长边上、斜出阵面，多数星只有一翼有。
 *   · 空间客车 4000：Solarbus 翼族（TAS，CEAS 2007 图 1）W61 = 4 块串联 + 2 块侧板挂【第 2 块】（十字，外侧还有两块；2005–2010 硅电池
 *     C2 / C3 星）；B2 / B3 / C1 与 2012 后砷化镓星多为直翼——型号文件按星改。
 *   · 空间客车 Neo（HPSA 翼族，大板 2.2 × 4.2 m）：SES-17 / Astra 1P = 4 块 + 2 块侧板挂第 3 块；Konnect / Syracuse 4A 直翼 4 块。
 *   · 欧洲之星 Neo（刚性主列 + 半刚性侧板）：Hot Bird 13F / 13G = 4 块，第 2 块两侧各一、第 3 块单侧一块（两翼点对称）。
 */
export const PLATFORMS = fr({
  // SSL-1300：板沿翼展 ≈ 3.1 m（由 EchoStar 17 / Intelsat 20 / Jupiter 3 的在轨翼展 26.07 → 32.4 → 38.7 m 逐级多一块板反推）；
  // 直翼 3–4 块（≤ 10 kW 星）用短三角轭，十字翼（3 + 2 侧板挂第 2 块 / 4 + 2 挂第 3 块）用长单杆轭——型号文件按星给
  ssl1300: fr({ name: 'SSL-1300（Maxar 1300）', bus: [2.5, 2.7, 4.0], faces: SILVER, ttc: 'bicone', wing: fr({ panels: 4, along: 3.1, across: 2.4, yokeLen: 2.2 }), refl: fr({ E: [2.5], W: [2.5], deck: [1.4] }) }),
  // 601 / 601HP：Boeing 实况表一律「2 wings, each w/4 panels」、翼展 26.2 m
  b601hp: fr({ name: 'Boeing 601HP', bus: [2.3, 2.6, 3.2], faces: GOLD_BLACK, ttc: 'bicone', wing: fr({ panels: 4, along: 2.6, across: 2.2, yokeLen: 1.8 }), refl: fr({ E: [2.4], W: [2.4], deck: [1.2] }) }),
  b702hp: fr({ name: 'Boeing 702HP', bus: [2.6, 3.2, 4.0], faces: GOLD_BLACK, ttc: 'bicone', wing: fr({ panels: 5, along: 2.9, across: 2.6, yokeLen: 2.4 }), refl: fr({ E: [2.6], W: [2.6], deck: [1.5] }),
    deployRad: (h) => [{ z: h[2] - 0.35, w: 2.2, l: 1.3 }, { z: -h[2] + 0.4, w: 2.2, l: 1.3 }] }),
  b702mp: fr({ name: 'Boeing 702MP', bus: [2.6, 3.0, 3.9], faces: GOLD_BLACK, ttc: 'bicone', wing: fr({ panels: 4, along: 2.9, across: 2.6, yokeLen: 2.4 }), refl: fr({ E: [2.6], W: [2.6], deck: [1.5, 1.2] }),
    deployRad: (h) => [{ z: h[2] - 0.35, w: 2.2, l: 1.1 }] }),
  // 702SP：每翼 4 块（ABS-3A「two single-axis drive solar arrays fitted with four panels per wing」、SES-15 渲染）
  b702sp: fr({ name: 'Boeing 702SP', bus: [2.0, 2.4, 3.0], faces: GOLD_BLACK, ttc: 'bicone', wing: fr({ panels: 4, along: 2.4, across: 2.2, yokeLen: 1.6 }), refl: fr({ E: [2.2], W: [2.2], deck: [1.2] }), ep: fr({ aft: true }) }),
  e3000: fr({ name: 'Eurostar E3000', bus: [2.3, 2.9, 4.2], faces: GOLD, wing: fr({ panels: 4, along: 3.915, across: 2.28, yokeLen: 1.8 }), refl: fr({ E: [2.5], W: [2.5], deck: [1.4] }),
    flap: fr({ tilt: 30 }) }),
  e3000eor: fr({ name: 'Eurostar E3000EOR', bus: [2.3, 2.9, 4.2], faces: GOLD, wing: fr({ panels: 4, along: 3.915, across: 2.28, yokeLen: 1.8 }), refl: fr({ E: [2.5], W: [2.5], deck: [1.4] }),
    flap: fr({ tilt: 30 }), ep: true }),
  eneo: fr({ name: 'Eurostar Neo', bus: [2.5, 3.0, 4.4], faces: GOLD_BLACK, wing: fr({ panels: 4, along: 3.6, across: 2.5, yokeLen: 1.8, side: fr({ at: 1, half: [2] }) }), refl: fr({ E: [2.6], W: [2.6], deck: [1.5] }), ep: true,
    deployRad: (h) => [{ z: h[2] - 0.3, w: 2.2, l: 1.0 }] }),
  sb4000: fr({ name: 'Spacebus 4000', bus: [2.0, 2.2, 4.0], faces: BLACK, wing: fr({ panels: 4, along: 3.66, across: 2.22, yokeLen: 2.4, side: fr({ at: 1 }) }), refl: fr({ E: [2.4], W: [2.4], deck: [1.3] }) }),
  sbneo: fr({ name: 'Spacebus Neo', bus: [2.6, 2.8, 4.4], faces: BLACK, wing: fr({ panels: 4, along: 4.2, across: 2.2, yokeLen: 2.0, side: fr({}) }), refl: fr({ E: [2.6], W: [2.6], deck: [1.5] }), ep: true }),
  // A2100（AX / AXS / M）：每翼 5 块「宽板」（铰链线垂直翼轴、板宽大于板长，翼看着短而宽；AEHF / MUOS / JCSAT-9 渲染逐块数）
  a2100: fr({ name: 'Lockheed Martin A2100', bus: [2.4, 2.5, 3.4], faces: GOLD_BLACK, ttc: 'bicone', wing: fr({ panels: 5, along: 2.1, across: 2.6, yokeLen: 2.0 }), refl: fr({ E: [2.4], W: [2.4], deck: [1.3] }) }),
  // GEOStar-2：每翼 3 块（Thaicom 6 等渲染）；GEOStar-3 每翼 5 块由型号文件给
  geostar: fr({ name: 'Northrop Grumman GEOStar', bus: [1.8, 1.9, 2.6], faces: GOLD, ttc: 'bicone', wing: fr({ panels: 3, along: 2.2, across: 1.7, yokeLen: 1.0 }), refl: fr({ E: [2.0], W: [2.0] }) }),
  dfh4: fr({ name: '东方红四号（DFH-4）', bus: [2.36, 2.1, 3.6], faces: GOLD_BLACK, wing: fr({ panels: 3, along: 3.3, across: 2.36, yokeLen: 2.0 }), refl: fr({ E: [2.6], W: [2.6], deck: [1.4] }) }),
  dfh4e: fr({ name: '东方红四号增强型（DFH-4E）', bus: [2.36, 2.6, 4.2], faces: GOLD_BLACK, wing: fr({ panels: 4, along: 3.3, across: 2.36, yokeLen: 2.2 }), refl: fr({ E: [2.6, 2.4], W: [2.6, 2.4], deck: [1.5] }), ep: true })
})

/**
 * 紧凑反射面配置 → geokit 的侧挂 / 对地板参数。
 * refl = { E:[D…], W:[D…]（东 / 西侧，第 1 副贴壁、第 2 副外移叠放）, deck:[D…]（对地板中心塔，第 1 副朝南、第 2 副朝北、第 3/4 副朝东 / 西）,
 *          type?:'solid'|'grid', mat?（正面材质）, feedN?（侧挂馈源簇单元数，HTS 多波束给 19 / 37）, deckFeedN? }
 */
export function reflSet(refl, h) {
  const side = [], deck = []
  for (const [k, zh] of [['E', '东'], ['W', '西']]) {
    const L = refl[k] || []
    L.forEach((D, i) => {
      const prev = i > 0 ? L[i - 1] : 0
      side.push({ name: `refl_${k.toLowerCase()}${i + 1}`, title: `${zh}侧反射面${L.length > 1 ? ` ${i + 1}` : ''}`, side: k, D, type: refl.type || 'solid', mat: refl.mat,
        y: L.length > 1 ? (i === 0 ? -0.25 : 0.25) * h[1] : 0, out: i === 0 ? 0 : 0.42 * (D + prev), F: undefined,
        standoff: GEO_DEFAULTS.standoff + (i === 0 ? 0 : 0.3), feed: refl.feedN ? { n: refl.feedN } : undefined })
    })
  }
  const dirs = [[0, 1], [0, -1], [1, 0], [-1, 0]]
  ;(refl.deck || []).forEach((D, i) => {
    const [ux, uy] = dirs[i % 4]
    deck.push({ name: `refl_deck${i + 1}`, title: `对地板反射面${refl.deck.length > 1 ? ` ${i + 1}` : ''}`, D, at: [0, 0], u: [ux, uy, 0], mat: refl.mat, tower: i === 0,
      towerTop: i === 0 ? undefined : null, feed: refl.deckFeedN ? { n: refl.deckFeedN } : undefined })
  })
  return { side, deck }
}

/**
 * 按平台预设出整星。
 * p = { platform, bus?:[x,y,z], faces?, wing?（覆盖平台缺省，可给 span 让轭长按跨度反推）, span?（有出处的翼展）,
 *       refl?（覆盖平台缺省反射面，见 reflSet；false = 不画平台缺省反射面）, side? / deck? / mesh? / gimbals?（直接给 geokit 参数，追加）,
 *       ep?（true / false / epArms 参数）, deployRad?, flap?（false 关）, furniture?, extra?(B, body) }
 */
export function comsat(B, p) {
  const pf = PLATFORMS[p.platform]
  if (!pf) throw new Error(`geo-presets：未知平台「${p.platform}」`)
  const bus = p.bus || pf.bus
  const h = bus.map((v) => v / 2)
  const wing = { ...pf.wing, ...(p.wing || {}) }
  const flap = p.flap === false ? null : (p.flap || pf.flap || null)
  // ADCS 小翼铰在板的长边上（不在翼尖），不占翼展
  if (isNum(p.span)) wing.yokeLen = yokeForSpan(p.span, bus[1], wing.panels, wing.along, wing.gap)
  const rs = p.refl === false ? { side: [], deck: [] } : reflSet(p.refl || pf.refl, h)
  // 对地板多副塔馈共用一座塔：第一副带塔（缺省塔高），其余挂同一塔顶
  const deck = []
  let towerTop = null
  for (const d of rs.deck) {
    if (d.tower) {
      const f = 0.6 * d.D, near = 0.1
      towerTop = h[2] + GEO_DEFAULTS.skinOff + (f - (near * near) / (4 * f) + 0.15)
      deck.push({ ...d, tower: undefined, towerTop: undefined })
    } else deck.push({ ...d, towerTop, tower: false })
  }
  const ep = p.ep === undefined ? pf.ep : p.ep
  return buildGeo(B, {
    // 南北散热面不画热管压条（调研 components.md §9.1：OSR 片在轨看不出热管，压条是示意过度）
    bus: { x: bus[0], y: bus[1], z: bus[2], faces: { ...pf.faces, ...(p.faces || {}) }, ribs: 0, deployRad: p.deployRad || (pf.deployRad ? pf.deployRad(h) : undefined) },
    wings: { ...wing, flap: flap || undefined },
    side: [...rs.side, ...(p.side || [])],
    deck: [...deck, ...(p.deck || [])],
    mesh: p.mesh, gimbals: p.gimbals,
    ep: ep && ep.aft ? { arms: [1, -1].map((s) => ({ from: [s * 0.4, 0, -h[2] - 0.012], to: [s * 0.55, 0, -h[2] - 0.35], dir: [s * 0.25, 0, -1] })) } : ep,
    furniture: { ttc: pf.ttc, ...(p.furniture || {}) }, extra: p.extra
  })
}
