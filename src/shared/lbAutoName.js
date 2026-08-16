// 资源库条目「自动命名」（GEO / NGSO / 再生式三窗共用）。
//
// 条目名默认不是用户的负担：没起过名字的条目，名字就随它自己的关键参数走——
//   地球站  口径              （「6.2 m」——站型先由天线口径认出；功放不进名字，由列表摘要报）
//   卫星    所选星名           （天线树取星 / 星历检索 / 手动填的卫星名称）
//   载波    速率 · 调制 FEC    （「2048 kbps · QPSK 3/4」）
// 一旦用户自己改过名字（cfg.nameAuto = false），这套就此对该条目失效，参数再改也不动它的名字——
// 同一颗星常有多份转发器配置（「CS10R C12B」「CS10R C13B」），自定义的名字一律是真值。
// 把名字清空是「交还自动命名」的手势（见 LbLibrary 的名称输入框）。
//
// 判据用显式标志位而非猜名字：参数一变，旧名字与新自动名必然对不上，事后无从分辨「它本来是不是自动名」。
// 标志位随条目入库（library.json）；旧库没有这一位，按 legacyAutoFlag() 的历史默认名/同名推定一次。

import { anchoredRate } from './carrierRate.js'
import { fmtQty } from './adaptUnits.js'   // 显示单位自适应（W→mW、kbps→Mbps…），与结果列同一套档位表
import { byLang, isDefaultName } from './i18n/lang.js'   // 兜底名按平台语言出字（自动名是数据，呈现层翻不到）

const s = (v) => String(v == null ? '' : v).trim()

// 地球站：口径。2026-07-29 起功放不再进名字——同一种站型常换功放（6.2 m 站配 40 W / 400 W 都是同一副天线），
// 名字跟着功放变反倒认不出是哪个站；功放改由列表摘要报（见各窗口 esSummary）。
export function esAutoName(form) {
  const f = form || {}
  const d = s(f.antennaDiameter)
  return d ? d + ' m' : ''
}

// 旧版自动名「口径 · 功放」（功放键名 GSO/NGSO 为 paPowerW、再生式为 opPowerW，按 adaptUnits 换档）。
// 只用于旧库推定：没存过 nameAuto 的库里，名字还是这个形状的同样算「没起过名字」——
// 否则改规则那一刻，旧库里的自动名会被一次性钉成自定义名，此后再不跟参数走。
function esLegacyAutoName(form) {
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

// 卫星：
//   GSO          星名 · 频段 · 轨位（「CHINASAT 6D · Ku · 110.5°E」）
//   NGSO/再生式  星名（2026-08-15 起）——星历检索来的星名本就长（「STARLINK-31234」「QIANFAN-0123」），
//                再挂上频段与「h=1145 km i=53°」，列表里一条名字要折两行，反倒认不出是哪颗星；
//                频段与轨道改由列表摘要报（见各窗口 satLibSummary / satSummary）。
// 两者靠 ngsoSat（轨道来源态）分流：GSO 窗口的卫星条目没有这一项（见 LinkBudgetApp.makeSatConfig）。
// 星名：取星定轨（天线树 / 星历检索）时以所选星为准，其余取表单里的卫星名称；GSO 取星时
// SatellitePanel 已把 satelliteName 回填成节点星名，故同一条口径通吃三窗。
// 卫星名称字段的出厂默认值 'Satellite' 只是占位符，不算星名——星名是这一串的头，没有它就整条不成立：
// 返回空 → syncAutoNames 留着现名不动（「默认卫星」原样），等取到星再一起跟上来。
const SAT_NAME_PLACEHOLDER = 'Satellite'
function satOrbitText(f) {
  const pos = s(f.orbitPosition)
  if (pos) return pos + '°E'                       // GSO：定点轨位（负值＝西经，与全窗口同口径）
  const h = s(f.orbitAltitude), i = s(f.orbitInclination)
  return [h ? 'h=' + h + ' km' : '', i ? 'i=' + i + '°' : ''].filter(Boolean).join(' ')
}
function satName(cfg) {
  const c = cfg || {}, f = c.form || {}, ns = c.ngsoSat
  const picked = (ns && ns.mode && ns.mode !== 'manual' && ns.orbit) ? s(ns.name) : ''
  const nm = picked || s(f.satelliteName)
  return (!nm || nm === SAT_NAME_PLACEHOLDER) ? '' : nm
}
export function satAutoName(cfg) {
  const nm = satName(cfg)
  if (!nm) return ''
  if (cfg && cfg.ngsoSat) return nm                // NGSO / 再生式：只报星名
  const f = (cfg && cfg.form) || {}
  return [nm, s(f.frequencyBand), satOrbitText(f)].filter(Boolean).join(' · ')
}

// 旧版自动名「星名 · 频段 · 轨道」。只用于旧库推定：NGSO/再生式改规则（2026-08-15 星名单独成名）前
// 入库的自动名还是这个形状，同样算「没起过名字」，否则改规则那一刻它们会被一次性钉成自定义名。
// GSO 走的仍是这条，与 satAutoName 同值，推定结果不变。
function satLegacyAutoName(cfg) {
  const nm = satName(cfg)
  if (!nm) return ''
  const f = (cfg && cfg.form) || {}
  return [nm, s(f.frequencyBand), satOrbitText(f)].filter(Boolean).join(' · ')
}

// 各库的自动名算法 + 无参数可用时的兜底名 + 旧库默认名的形状（含 syncAutoNames 加的 ' 2' 重名后缀）
// 兜底名中英各备一份：它是纯界面语汇（不含任何参数），而自动名是数据、呈现层翻不到，只能生成时就出对语言。
// legacy 正则一并收进英文形状——英文模式下建的库回到中文模式，那些名字同样算「没起过名字」。
const KINDS = {
  es: { name: (c) => esAutoName(c.form), fallback: ['地球站', 'Earth Station'], legacy: /^(默认|站型|地球站|Earth Station)(\d+)?( \d+)*$/, legacyName: (c) => esLegacyAutoName(c.form) },
  carrier: { name: (c) => carrierAutoName(c.form), fallback: ['载波', 'Carrier'], legacy: /^(默认|配置|载波|基带|Carrier)(\d+)?( \d+)*$/ },
  sat: { name: (c) => satAutoName(c), fallback: ['卫星', 'Satellite'], legacy: /^(默认卫星|卫星|Satellite)(\d+)?( \d+)*$/, legacyName: (c) => satLegacyAutoName(c) }
}
const fallbackOf = (kind) => byLang(...KINDS[kind].fallback)

// —— 配置树与复制件的默认名（五个工作台共用一套词）——
// 与库条目的兜底名同一性质：它是界面语汇，却以【数据】的身份存进 configs.json、显示在树的
// 行内改名框（<input>）里，呈现层的 runtime.js 一概翻不到，只能生成时就出对语言。
export const newCfgName = (zh = '新配置') => byLang(zh, 'New Configuration')
export const newFolderName = () => byLang('新建文件夹', 'New Folder')
export const copyNameOf = (name) => byLang(name + ' 副本', name + ' Copy')

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
// 或者恰好就等于当前参数的自动名（含改规则前的旧版自动名形状，见 legacyName）——都说明它没被真正起过名字。
export function legacyAutoFlag(kind, cfg) {
  const k = KINDS[kind]
  if (!k || !cfg) return false
  const nm = s(cfg.name)
  if (!nm) return true
  return k.legacy.test(nm) || nm === autoNameOf(kind, cfg) || (!!k.legacyName && nm === s(k.legacyName(cfg)))
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
    // 算不出名字（如还没取星的卫星）：留着现名不动，只有新建的空名条目才落到兜底名。
    // 现名恰好就是【另一种语言下的】兜底名时同样重出——它不含任何参数信息，换语言要跟着换。
    const base = autoNameOf(kind, c) ||
      ((!s(c.name) || isDefaultName(c.name, ...KINDS[kind].fallback)) ? fallbackOf(kind) : '')
    if (!base) { taken.add(s(c.name)); continue }
    let nm = base
    for (let i = 2; taken.has(nm); i++) nm = base + ' ' + i
    taken.add(nm)
    if (c.name !== nm) c.name = nm
  }
}
