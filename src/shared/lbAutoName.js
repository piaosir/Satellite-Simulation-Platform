// 资源库条目「自动命名」（GEO / NGSO / 再生式三窗共用）。
//
// 条目名默认不是用户的负担：没起过名字的条目，名字就随它自己的关键参数走——
//   地球站  口径 · 功放       （「6.2 m · 40 W」，与列表摘要同口径，这两项最能一眼认出一种站型）
//   卫星    所选星名           （天线树取星 / 星历检索 / 手动填的卫星名称）
//   载波    速率 · 调制 FEC    （「2048 kbps · QPSK 3/4」）
// 一旦用户自己改过名字（cfg.nameAuto = false），这套就此对该条目失效，参数再改也不动它的名字——
// 同一颗星常有多份转发器配置（「CS10R C12B」「CS10R C13B」），自定义的名字一律是真值。
// 把名字清空是「交还自动命名」的手势（见 LbLibrary 的名称输入框）。
//
// 判据用显式标志位而非猜名字：参数一变，旧名字与新自动名必然对不上，事后无从分辨「它本来是不是自动名」。
// 标志位随条目入库（library.json）；旧库没有这一位，按 legacyAutoFlag() 的历史默认名/同名推定一次。

import { anchoredRate } from './carrierRate.js'
import { fmtQty } from './adaptUnits.js'   // 显示单位自适应（W→mW/kW、kbps→Mbps…），与结果列同一套档位表

const s = (v) => String(v == null ? '' : v).trim()

// 地球站：口径 · 功放（功放键名 GSO/NGSO 为 paPowerW、再生式为 opPowerW）。
// 功放按数值大小换档（0.2 W → 200 mW、1200 W → 1.2 kW），与结果列同一套 adaptUnits 档位表。
export function esAutoName(form) {
  const f = form || {}
  const d = s(f.antennaDiameter)
  const p = s(f.paPowerW) || s(f.opPowerW)
  return [d ? d + ' m' : '', p ? fmtQty(p, 'W') : ''].filter(Boolean).join(' · ')
}

// 载波：速率 · 调制 FEC。速率报的是用户自己按的那一档——信息速率/码片速率/符号率/载波带宽是同一条
// 换算链的四个视角（见 shared/carrierRate.js），改哪个哪个就成锚点，名字就报哪个：改带宽报「1638.4 kHz」、
// 改符号率报「1365.333 ksps」。不做单位自适应（kbps→Mbps）——名字里的数字要与他填进去的那个对得上。
export function carrierAutoName(form) {
  const f = form || {}
  const rate = anchoredRate(f).text
  const mod = [s(f.modulation), s(f.fec)].filter(Boolean).join(' ')
  return [rate, mod].filter(Boolean).join(' · ')
}

// 卫星：星名 · 频段 · 轨道（GSO 报轨位「110.5°E」，NGSO/再生式报高度倾角「h=8000 km i=45°」——
// 按表单里有哪个字段自然分流，一个卫星配置本来就只可能是其中一种）。
// 星名：取星定轨（天线树 / 星历检索）时以所选星为准，其余取表单里的卫星名称；GSO 窗口无 ngsoSat，
// 取星时 SatellitePanel 已把 satelliteName 回填成节点星名，故同一条口径通吃三窗。
// 卫星名称字段的出厂默认值 'Satellite' 只是占位符，不算星名——星名是这一串的头，没有它就整条不成立：
// 返回空 → syncAutoNames 留着现名不动（「默认卫星」原样），等取到星再一起跟上来。
const SAT_NAME_PLACEHOLDER = 'Satellite'
function satOrbitText(f) {
  const pos = s(f.orbitPosition)
  if (pos) return pos + '°E'                       // GSO：定点轨位（负值＝西经，与全窗口同口径）
  const h = s(f.orbitAltitude), i = s(f.orbitInclination)
  return [h ? 'h=' + h + ' km' : '', i ? 'i=' + i + '°' : ''].filter(Boolean).join(' ')
}
export function satAutoName(cfg) {
  const c = cfg || {}, f = c.form || {}, ns = c.ngsoSat
  const picked = (ns && ns.mode && ns.mode !== 'manual' && ns.orbit) ? s(ns.name) : ''
  const nm = picked || s(f.satelliteName)
  if (!nm || nm === SAT_NAME_PLACEHOLDER) return ''
  return [nm, s(f.frequencyBand), satOrbitText(f)].filter(Boolean).join(' · ')
}

// 各库的自动名算法 + 无参数可用时的兜底名 + 旧库默认名的形状（含 syncAutoNames 加的 ' 2' 重名后缀）
const KINDS = {
  es: { name: (c) => esAutoName(c.form), fallback: '地球站', legacy: /^(默认|站型|地球站)(\d+)?( \d+)*$/ },
  carrier: { name: (c) => carrierAutoName(c.form), fallback: '载波', legacy: /^(默认|配置|载波|基带)(\d+)?( \d+)*$/ },
  sat: { name: (c) => satAutoName(c), fallback: '卫星', legacy: /^(默认卫星|卫星)(\d+)?( \d+)*$/ }
}

// 单条自动名（不含重名后缀）；算不出来返回 ''
export const autoNameOf = (kind, cfg) => {
  const k = KINDS[kind]
  return (k && cfg) ? s(k.name(cfg)) : ''
}

// 这条条目此刻的名字是不是自动生成的 —— 列表摘要据此避开与名字重影的那几项。
// 光看 nameAuto 不够：还没取星的卫星虽然标着「自动」，名字里其实什么参数都没有（留着旧名不动），
// 那些参数得照常由摘要来报。
export const isAutoNamed = (kind, cfg) => !!(cfg && cfg.nameAuto && autoNameOf(kind, cfg))

// 旧库条目（没存过 nameAuto）的一次性推定：名字还是历史默认名（「站型2」「默认」…），
// 或者恰好就等于当前参数的自动名 —— 两种都说明它没被真正起过名字。
export function legacyAutoFlag(kind, cfg) {
  const k = KINDS[kind]
  if (!k || !cfg) return false
  const nm = s(cfg.name)
  if (!nm) return true
  return k.legacy.test(nm) || nm === autoNameOf(kind, cfg)
}

// 入库/载入时定标志位：存过的以存的为准，没存过的按历史默认名推定
export const adoptAutoFlag = (kind, raw) =>
  (raw && typeof raw.nameAuto === 'boolean') ? raw.nameAuto : legacyAutoFlag(kind, raw)

// 新建/内置条目定标志位：与载入旧库同一把尺子——空名与「站型2」这类占位名归自动，
// 内置库里那几个起好了的名字（「关口站 6.2m」）归自定义，不会被自动名冲掉。
export function withAutoFlag(cfg, kind) {
  cfg.nameAuto = legacyAutoFlag(kind, cfg)
  return cfg
}

// 全库刷名：只动 nameAuto === true 的条目，重名自动加序号（自定义名先占位，自动名让着它）。
// 每次从头重算，故与调用次数无关（幂等）——深监听里反复跑不会累积后缀。
export function syncAutoNames(arr, kind) {
  if (!Array.isArray(arr) || !KINDS[kind]) return
  const taken = new Set()
  for (const c of arr) if (c && c.nameAuto !== true) taken.add(s(c.name))
  for (const c of arr) {
    if (!c || c.nameAuto !== true) continue
    // 算不出名字（如还没取星的卫星）：留着现名不动，只有新建的空名条目才落到兜底名
    const base = autoNameOf(kind, c) || (s(c.name) ? '' : KINDS[kind].fallback)
    if (!base) { taken.add(s(c.name)); continue }
    let nm = base
    for (let i = 2; taken.has(nm); i++) nm = base + ' ' + i
    taken.add(nm)
    if (c.name !== nm) c.name = nm
  }
}
