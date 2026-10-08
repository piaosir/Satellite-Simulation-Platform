// 星座精模的自动匹配：卫星名（CelesTrak GP 的 OBJECT_NAME，平台内置星历与在线拉取都是这套写法）/ NORAD 号 → 型号。
//
// 名称规律（2026-09-25 按随包星历快照 resources/omm 逐组核过，研究稿逐条出处）：
//   星链   STARLINK-1xxx / 2xxx = v1.0（NORAD ≥ 45720 为 2020-06 起的 VisorSat 遮阳板批次，之前 128 颗无遮阳板；无号时按遮阳板——在轨多数）；
//          3000–29999 = v1.5（STARLINK-3005 是带激光的极轨试验星，GCAT 记 v1.0 级质量，外形按 v1.5）；
//          30000–32999 = V2 Mini；≥ 33000 = V2 Mini 优化版（2025 年起量产，SpaceX：轻 22 %）；带「[DTC]」= 直连手机版
//          （快照：v1.0 600、v1.5 2570、V2 Mini 7299（其中 ≥33000 的 4734）、DTC 639 颗）
//   一网   ONEWEB-0xxx（在轨全部为第一代 Arrow 构型）
//   GPS    GPS BIIR-n / BIIRM-n / BIIF-n / BIII-n；BIII-9 起带 NASA 激光角反射器（ILRS）
//   北斗   BEIDOU-3 Mn：研制单位 / 构型逐颗查表（BEIDOU3_MEO；CSNO 天线文件 + IGS 元数据按 NORAD 逐星对上）；
//          ★ 名称括号里的 PRN 在 2026-04 北斗换号后已过时，只认 M 后的序号与 NORAD 号，不认 PRN
//          BEIDOU-3 IGSO-n / Gn；BEIDOU-2 Mn、IGSO-n（同一光压组、外形相同）/ Gn；BEIDOU-3S：M1S / M2S / IGSO-2S 为五院、IGSO-1S 为微小卫星院
//   伽利略 GSAT01xx = IOV、GSAT02xx = FOC（★ 印度通信星叫 GSAT-30 / GSAT 30，带连字符或空格，不会误中）
//   格洛纳斯 COSMOS nnnn (7xx) = GLONASS-M；(7xxK)：703K / 704K 为 K2，其余为 K1（GLONASS 信息分析中心 2026-09-24 星座表）；
//          只认带括号编号或 group = glonass（COSMOS 是俄罗斯各类军星的通名）；glonass 组里无编号的新星（如 COSMOS 2620）按 K1
//   铱星   IRIDIUM ≥ 100 = Iridium NEXT（< 100 为已基本离轨的一代，不配精模）
//   全球星 GLOBALSTAR M065–M072 = 一代在轨备份（2007 年发射）、M073–M097 = 二代、≥ M098 = 补网星（2026）
//   O3b    O3B MPOWER Fn = mPOWER；O3B PFM / FMn = 第一代
//   Kuiper KUIPER-nnnnn = 量产星
// ★ 只返回 FLEET_MATCH_IDS 里的型号（与 fleet/index.mjs 的注册表逐一对应，单测核对）：规则指向尚未建模的型号时宁可落空。

import { normalizeName } from './nameNorm.mjs'

/** matchFleet 可能返回的全部型号（= 注册表 FLEET_IDS；在这里再列一遍是为了本文件不 import 几何模块，autoMatch 背得轻）。 */
export const FLEET_MATCH_IDS = Object.freeze([
  'starlink-v1', 'starlink-v1-visor', 'starlink-v15', 'starlink-v2mini', 'starlink-v2mini-opt', 'starlink-v2mini-dtc',
  'oneweb-gen1', 'kuiper',
  'gps-iir', 'gps-iirm', 'gps-iif', 'gps-iii', 'gps-iii-lra',
  'beidou3-meo-cast', 'beidou3-meo-cast-sar', 'beidou3-meo-secm-a', 'beidou3-meo-secm-b', 'beidou3-igso', 'beidou3-geo', 'beidou2-geo', 'beidou2-igso',
  'galileo-foc', 'galileo-iov', 'glonass-m', 'glonass-k1', 'glonass-k2',
  'iridium-next', 'globalstar-2', 'globalstar-1', 'globalstar-2r', 'o3b-gen1', 'o3b-mpower',
  // GEO 名星（2026-10-07）
  'viasat-1', 'viasat-2', 'viasat-3', 'jupiter-3', 'echostar-19', 'echostar-17', 'sky-muster', 'ka-sat', 'konnect', 'konnect-vhts', 'ses-17',
  'intelsat-epic-702mp', 'intelsat-32e', 'intelsat-40e', 'asiasat-4', 'asiasat-5', 'asiasat-6', 'asiasat-8', 'asiasat-9', 'astra-2e', 'astra-1p',
  'hotbird-13f', 'ses-14', 'ses-15', 'intelsat-9', 'thaicom-4', 'turksat-5a', 'turksat-5b', 'mev', 'dfh4', 'dfh4e',
  'inmarsat-4', 'alphasat', 'inmarsat-5', 'inmarsat-gx5', 'inmarsat-6', 'thuraya-2', 'thuraya-4', 'terrestar', 'skyterra-1', 'muos',
  'goes-r', 'goes-u', 'msg', 'mtg-i', 'mtg-s', 'himawari',
  'skynet-5', 'wgs', 'aehf', 'sbirs-geo', 'luch-5', 'edrs-c', 'syracuse-4a', 'syracuse-4b'
])
const OK = new Set(FLEET_MATCH_IDS)

/**
 * 北斗三号 MEO：M 序号 → 型号（五院 / 五院带搜救载荷 / 微小卫星院 A 型 / B 型）。
 * 研究稿：微小卫星院 M7–M12、M15、M16（A 型）与 M21、M22、M25、M27（B 型），其余五院；搜救载荷：五院 M13 / M14 / M23 / M24
 * （CSNO 搜救 ICD 列出 M13 / M14 / M23 / M24 与 M21 / M22——后两颗属微小卫星院 B 型，搜救天线几何未公开，外形按 B 型）。
 */
export const BEIDOU3_MEO = Object.freeze({
  1: 'cast', 2: 'cast', 3: 'cast', 4: 'cast', 5: 'cast', 6: 'cast',
  7: 'secm-a', 8: 'secm-a', 9: 'secm-a', 10: 'secm-a', 11: 'secm-a', 12: 'secm-a',
  13: 'cast-sar', 14: 'cast-sar', 15: 'secm-a', 16: 'secm-a', 17: 'cast', 18: 'cast', 19: 'cast', 20: 'cast',
  21: 'secm-b', 22: 'secm-b', 23: 'cast-sar', 24: 'cast-sar', 25: 'secm-b', 26: 'cast', 27: 'secm-b', 28: 'cast'
})
/** 北斗 NORAD 号 → 型号（名称不规范时兜底；数据同研究稿 satelliteIndex）。 */
const BEIDOU_NORAD = (() => {
  const t = {}
  const put = (id, list) => { for (const n of list) t[n] = id }
  put('beidou2-geo', [37210, 38091, 38953, 41586, 44231])
  put('beidou2-igso', [36828, 37256, 37384, 37763, 37948, 41434, 43539, 38250, 38251, 38775])
  put('beidou3-geo', [43683, 45344, 45807, 56564])
  put('beidou3-igso', [44204, 44337, 44709, 40938])
  put('beidou3-meo-cast', [43001, 43002, 43208, 43207, 43581, 43582, 43706, 43707, 44864, 44865, 58655, 58654, 40749, 40748])
  put('beidou3-meo-cast-sar', [43622, 43623, 44543, 44542])
  put('beidou3-meo-secm-a', [43107, 43108, 43245, 43246, 43603, 43602, 43648, 43647, 40549])
  put('beidou3-meo-secm-b', [44794, 44793, 61186, 61187])
  return Object.freeze(t)
})()
/** GLONASS-K 系列编号（名称括号里的 7xxK）→ 'k1' | 'k2'（IAC 2026-09-24 星座表：703K / 704K 为 K2）。 */
export const GLONASS_K_VARIANT = Object.freeze({ '702': 'k1', '703': 'k2', '704': 'k2', '705': 'k1', '706': 'k1', '707': 'k1', '708': 'k1', '713': 'k1' })

/**
 * GEO 名星（2026-10-07）：CelesTrak 名称 → 型号，[正则, 型号 id, 规则键]，按序首中即返回。
 * ★ 口径（用户）：只收国外星 + 亚洲卫星 + 东方红四号 / 四号增强型【平台】的出口星；国内具体星（中星 / 亚太 / 天链 / 天通 / 风云……）不配，
 *   照旧落 GEO 缺省（单测 ⑥ 守着）。名称写法按随包快照 resources/omm/csv_geo 逐颗核过（如「INTELSAT 32E (IS-32E)」「WGS F1 (USA 195)」）。
 */
export const GEO_RULES = Object.freeze([
  // —— 高通量
  [/^VIASAT-1$/, 'viasat-1', 'viasat-1'],
  [/^VIASAT-2$/, 'viasat-2', 'viasat-2'],
  [/^VIASAT-3\b/, 'viasat-3', 'viasat-3'],
  [/^(JUPITER 3|ECHOSTAR 24)\b/, 'jupiter-3', 'jupiter-3'],
  [/^ECHOSTAR 19$/, 'echostar-19', 'echostar-19'],
  [/^ECHOSTAR 17$/, 'echostar-17', 'echostar-17'],
  [/^SKY MUSTER\b/, 'sky-muster', 'sky-muster'],
  [/^EUTELSAT KA-SAT\b/, 'ka-sat', 'ka-sat'],
  [/^EUTELSAT KONNECT VHTS$/, 'konnect-vhts', 'konnect-vhts'],
  [/^EUTELSAT KONNECT$/, 'konnect', 'konnect'],
  [/^SES-17$/, 'ses-17', 'ses-17'],
  [/^INTELSAT (33E|35E|37E)\b/, 'intelsat-epic-702mp', 'intelsat-epic-702mp'],
  [/^INTELSAT 32E\b/, 'intelsat-32e', 'intelsat-32e'],
  [/^INTELSAT 40E\b/, 'intelsat-40e', 'intelsat-40e'],
  // —— 固定 / 直播、亚洲卫星
  [/^INTELSAT 90\d\b/, 'intelsat-9', 'intelsat-9'],
  [/^ASIASAT 4$/, 'asiasat-4', 'asiasat-4'],
  [/^ASIASAT [57]$/, 'asiasat-5', 'asiasat-5'],
  [/^ASIASAT 6$/, 'asiasat-6', 'asiasat-6'],
  [/^ASIASAT 8\b/, 'asiasat-8', 'asiasat-8'],
  [/^ASIASAT 9$/, 'asiasat-9', 'asiasat-9'],
  [/^ASTRA 2[EFG]$/, 'astra-2e', 'astra-2e'],
  [/^ASTRA 1P\b/, 'astra-1p', 'astra-1p'],
  [/^EUTELSAT HOTBIRD 13[FG]$/, 'hotbird-13f', 'hotbird-13f'],
  [/^SES-14$/, 'ses-14', 'ses-14'],
  [/^SES-15$/, 'ses-15', 'ses-15'],
  [/^(THAICOM 4|IPSTAR)\b/, 'thaicom-4', 'thaicom-4'],
  [/^TURKSAT 5A$/, 'turksat-5a', 'turksat-5a'],
  [/^TURKSAT 5B$/, 'turksat-5b', 'turksat-5b'],
  [/^MEV-[12]$/, 'mev', 'mev'],
  // —— 东方红四号 / 四号增强型平台（只配出口星）
  [/^(BELINTERSAT-1|LAOSAT 1|TKSAT-1|NIGCOMSAT 1R|ALCOMSAT 1)\b/, 'dfh4', 'dfh4'],
  [/^PAKSAT-MM1$/, 'dfh4e', 'dfh4e'],
  // —— 移动通信
  [/^INMARSAT 5-F\d$/, 'inmarsat-5', 'inmarsat-5'],
  [/^INMARSAT GX5$/, 'inmarsat-gx5', 'inmarsat-gx5'],
  [/^INMARSAT 6-F\d$/, 'inmarsat-6', 'inmarsat-6'],
  [/^THURAYA-[23]$/, 'thuraya-2', 'thuraya-2'],
  [/^THURAYA-4\b/, 'thuraya-4', 'thuraya-4'],
  [/^(TERRESTAR-1|ECHOSTAR 21)$/, 'terrestar', 'terrestar'],
  [/^SKYTERRA 1$/, 'skyterra-1', 'skyterra-1'],
  [/^MUOS-\d$/, 'muos', 'muos'],
  // —— 气象
  [/^GOES[ -]?(16|17|18)$/, 'goes-r', 'goes-r'],
  [/^GOES[ -]?19$/, 'goes-u', 'goes-u'],
  [/^METEOSAT-(9|10|11)\b/, 'msg', 'msg'],
  [/^(METEOSAT-12\b|MTG-I\d)/, 'mtg-i', 'mtg-i'],
  [/^MTG-S\d/, 'mtg-s', 'mtg-s'],
  [/^HIMAWARI-[89]$/, 'himawari', 'himawari'],
  // —— 移动通信
  [/^INMARSAT 4-F[1-3]$/, 'inmarsat-4', 'inmarsat-4'],
  [/^ALPHASAT$/, 'alphasat', 'alphasat'],
  // —— 军用 / 中继
  [/^SKYNET 5[A-D]$/, 'skynet-5', 'skynet-5'],
  [/^WGS (F\d+|\d+)\b/, 'wgs', 'wgs'],
  [/^AEHF-\d\b/, 'aehf', 'aehf'],
  [/^SBIRS GEO-\d\b/, 'sbirs-geo', 'sbirs-geo'],
  [/^LUCH-5[ABV]$/, 'luch-5', 'luch-5'],
  [/^EDRS-C$/, 'edrs-c', 'edrs-c'],
  [/^SYRACUSE 4A$/, 'syracuse-4a', 'syracuse-4a'],
  [/^SYRACUSE 4B$/, 'syracuse-4b', 'syracuse-4b']
].map(Object.freeze))

const P = (id, rule) => (OK.has(id) ? { id: `param:${id}`, rule } : null)

/**
 * @param {{name?:string, group?:string, noradId?:number|string}} sat
 * @returns {{id:string, rule:string}|null}
 */
export function matchFleet(sat) {
  const s = sat || {}
  const name = normalizeName(s.name)
  const group = String(s.group ?? '').toLowerCase()
  const norad = Number(s.noradId)
  let m

  // —— 星链
  if ((m = /^STARLINK-(\d+)(\s*\[DTC\])?$/.exec(name))) {
    const n = Number(m[1])
    if (m[2]) return P('starlink-v2mini-dtc', 'fleet:starlink-dtc')
    if (n >= 33000) return P('starlink-v2mini-opt', 'fleet:starlink-v2mini-opt')
    if (n >= 30000) return P('starlink-v2mini', 'fleet:starlink-v2mini')
    if (n >= 3000) return P('starlink-v15', 'fleet:starlink-v1.5')
    if (Number.isFinite(norad) && norad > 0 && norad < 45720) return P('starlink-v1', 'fleet:starlink-v1.0')
    return P('starlink-v1-visor', 'fleet:starlink-v1.0-visor')
  }
  if (/^STARLINK\b/.test(name) && /\[DTC\]/.test(name)) return P('starlink-v2mini-dtc', 'fleet:starlink-dtc')
  if (/^STARLINK\b/.test(name) || group === 'starlink') return P('starlink-v2mini', 'fleet:starlink')

  // —— 一网 / Kuiper
  if (/^ONEWEB\b/.test(name) || group === 'oneweb') return P('oneweb-gen1', 'fleet:oneweb')
  if (/^KUIPER\b/.test(name) || group === 'kuiper') return P('kuiper', 'fleet:kuiper')

  // —— GPS
  if ((m = /^GPS B(IIRM|IIR|IIF|IIIF|III)-(\d+)\b/.exec(name))) {
    const b = m[1], n = Number(m[2])
    if (b === 'IIRM') return P('gps-iirm', 'fleet:gps-iirm')
    if (b === 'IIR') return P('gps-iir', 'fleet:gps-iir')
    if (b === 'IIF') return P('gps-iif', 'fleet:gps-iif')
    return n >= 9 ? P('gps-iii-lra', 'fleet:gps-iii-lra') : P('gps-iii', 'fleet:gps-iii')
  }

  // —— 北斗（NORAD 优先，名称其次）
  if (Number.isFinite(norad) && Object.hasOwn(BEIDOU_NORAD, norad)) return P(BEIDOU_NORAD[norad], 'fleet:beidou-norad')
  if ((m = /^BEIDOU-3S (M\dS|IGSO-(\d)S)\b/.exec(name))) return P(m[2] === '1' ? 'beidou3-meo-secm-a' : (m[2] ? 'beidou3-igso' : 'beidou3-meo-cast'), 'fleet:beidou-3s')
  if ((m = /^BEIDOU-3 M(\d+)\b/.exec(name))) {
    const k = BEIDOU3_MEO[Number(m[1])] || 'cast'
    return P(`beidou3-meo-${k}`, `fleet:beidou3-meo-${k}`)
  }
  if (/^BEIDOU-3 IGSO/.test(name)) return P('beidou3-igso', 'fleet:beidou3-igso')
  if (/^BEIDOU-3 G\d/.test(name)) return P('beidou3-geo', 'fleet:beidou3-geo')
  if (/^BEIDOU-2 G\d/.test(name)) return P('beidou2-geo', 'fleet:beidou2-geo')
  if (/^BEIDOU-2 (IGSO|M)/.test(name)) return P('beidou2-igso', 'fleet:beidou2-igso-meo')

  // —— 伽利略
  if (/^GSAT01\d\d\b/.test(name)) return P('galileo-iov', 'fleet:galileo-iov')
  if (/^GSAT0[2-9]\d\d\b/.test(name) || (group === 'galileo' && /^GSAT0/.test(name))) return P('galileo-foc', 'fleet:galileo-foc')

  // —— 格洛纳斯
  if ((m = /^COSMOS \d+ \((\d{3})(K)?\)$/.exec(name))) {
    if (m[2]) return GLONASS_K_VARIANT[m[1]] === 'k2' ? P('glonass-k2', 'fleet:glonass-k2') : P('glonass-k1', 'fleet:glonass-k1')
    if (m[1].startsWith('7')) return P('glonass-m', 'fleet:glonass-m')
  }
  if (group === 'glonass' && /^COSMOS\b/.test(name)) return P('glonass-k1', 'fleet:glonass-group')

  // —— 铱星
  if ((m = /^IRIDIUM (\d+)\b/.exec(name)) && Number(m[1]) >= 100) return P('iridium-next', 'fleet:iridium-next')

  // —— 全球星
  if ((m = /^GLOBALSTAR M(\d+)\b/.exec(name))) {
    const n = Number(m[1])
    if (n >= 98) return P('globalstar-2r', 'fleet:globalstar-2r')
    if (n <= 72) return P('globalstar-1', 'fleet:globalstar-1')
    return P('globalstar-2', 'fleet:globalstar-2')
  }

  // —— O3b
  if (/^O3B MPOWER\b/.test(name)) return P('o3b-mpower', 'fleet:o3b-mpower')
  if (/^O3B (PFM|FM\d+)\b/.test(name)) return P('o3b-gen1', 'fleet:o3b')

  // —— GEO 名星（逐颗 / 逐系列；表见 GEO_RULES）
  for (const [re, id, key] of GEO_RULES) if (re.test(name)) return P(id, `fleet:${key}`)

  return null
}
