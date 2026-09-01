// 载波速率换算链（信息速率 / 码片速率 / 符号率 / 载波带宽）—— 载波面板与资源库自动命名共用一份口径。
// 链与引擎 linkCalculator.js 完全一致：
//   infoRate → carrierRate(÷fec÷rs) → chipRate(×m，码片速率) → symbolRate(÷调制因子) → carrierBW(×滚降)
//
// 四者是同一条链上的四个视角，真正入库的只有 infoRate；用户最近编辑的那一个是「锚点」（form.rateAnchor），
// 调制/FEC/扩频/滚降变化时按锚点反解 infoRate，使锚点字段保持用户定下的值不动（见 BasebandPanel）。
// 锚点随配置入库（不再是面板的局部态）：切走再回来、下次开软件，用户按的还是自己那个口径——
// 条目自动命名也据此报（改带宽就报带宽、改符号率就报符号率，见 lbAutoName.carrierAutoName）。

import { fmtQty } from './adaptUnits.js'   // 显示单位自适应（kbps→Mbps/Gbps、kHz→MHz/GHz…），与结果列同一套档位表

// ===== 调制方式：族 + 星座阶数 M ⇄ 名字 ⇄ 调制因子（bit/符号）=====
// ★ 本段是 packages/core/utils/modulation.js 的【渲染端手写副本】——那边是 CJS、只在主进程跑，
//   而载波面板要在渲染端实时算符号率/带宽，走 IPC 问一次因子不现实。两份必须逐值一致，
//   packages/core/test/modulation.test.mjs 拿同一张名字表逐条对拍，改一处必须改另一处。
export const MOD_FACTORS = { BPSK: 1, QPSK: 2, '8PSK': 3, '8QAM': 3, '16QAM': 4, '16APSK': 4, '32APSK': 5, '64QAM': 6, '64APSK': 6, '128APSK': 7, '256APSK': 8 }
export const MOD_FAMILIES = [
  { key: 'psk', label: 'M-PSK', suffix: 'PSK' },
  { key: 'apsk', label: 'M-APSK', suffix: 'APSK' },
  { key: 'qam', label: 'M-QAM', suffix: 'QAM' }
]
export const ORDER_MIN = 2, ORDER_MAX = 4096
export function isValidOrder(m) {
  const n = Number(m)
  return Number.isInteger(n) && n >= ORDER_MIN && n <= ORDER_MAX && (n & (n - 1)) === 0
}
export function ordersOf(familyKey) {
  const out = []
  for (let m = ORDER_MIN; m <= (familyKey === 'qam' ? 4096 : 1024); m *= 2) {
    if (familyKey === 'apsk' && m < 16) continue   // APSK 环状星座从 16 起
    if (familyKey === 'qam' && m < 4) continue     // 2QAM 不存在
    out.push(m)
  }
  return out
}
export const isValidOrderFor = (familyKey, m) => isValidOrder(m) && ordersOf(familyKey).indexOf(Number(m)) > -1
export function composeModulation(familyKey, order) {
  const fam = MOD_FAMILIES.find((f) => f.key === familyKey)
  if (!fam || !isValidOrderFor(familyKey, order)) return ''
  const m = Number(order)
  if (fam.key === 'psk') { if (m === 2) return 'BPSK'; if (m === 4) return 'QPSK' }
  return String(m) + fam.suffix
}
const NAME_RE = /^(\d+)\s*(APSK|QAM|PSK)$/i
export function parseModulation(name) {
  const s = String(name == null ? '' : name).trim()
  if (!s) return null
  const up = s.toUpperCase()
  if (up === 'BPSK') return { family: 'psk', order: 2, factor: 1 }
  if (up === 'QPSK') return { family: 'psk', order: 4, factor: 2 }
  const m = NAME_RE.exec(up)
  if (!m) return null
  const order = Number(m[1])
  const fam = MOD_FAMILIES.find((f) => f.suffix === m[2].toUpperCase())
  // ★ 阶数按族收紧（APSK 从 16 起、QAM 从 4 起）：全平台只有一种「合法调制方式」的口径
  if (!fam || !isValidOrderFor(fam.key, order)) return null
  return { family: fam.key, order, factor: Math.round(Math.log2(order)) }
}
// ★ 查不到返回 null 而不是回落到 2：「不知道」和「等于 QPSK」是两件事，兜底交给调用方
export function modFactorOf(name) {
  const s = String(name == null ? '' : name).trim()
  if (!s) return null
  if (MOD_FACTORS[s] != null) return MOD_FACTORS[s]
  const up = s.toUpperCase()
  for (const k of Object.keys(MOD_FACTORS)) if (k.toUpperCase() === up) return MOD_FACTORS[k]
  const p = parseModulation(s)
  return p ? p.factor : null
}
export const isKnownModulation = (name) => modFactorOf(name) != null
// 下拉选项：内置项在前（顺序照 core 的 MODULATION_OPTIONS），extra 里能解析又不重复的补在后面
export const BUILTIN_MODULATIONS = ['BPSK', 'QPSK', '8PSK', '8QAM', '16QAM', '16APSK', '32APSK', '64QAM', '64APSK', '128APSK', '256APSK']
export function modulationOptions(extra) {
  const seen = new Set(), out = []
  for (const v of BUILTIN_MODULATIONS.concat(extra || [])) {
    const key = String(v == null ? '' : v).toUpperCase()
    const factor = modFactorOf(v)
    if (!key || seen.has(key) || factor == null) continue
    seen.add(key)
    const p = parseModulation(v)
    out.push({ value: v, label: v, family: p ? p.family : null, order: p ? p.order : null, factor })
  }
  return out
}

// '3/4' → 0.75；'0.75' → 0.75；空/非法 → def
export function parseFrac(s, def) {
  if (s === '' || s == null) return def
  if (typeof s === 'number') return s
  s = String(s).trim()
  if (s.includes('/')) { const p = s.split('/'); const a = Number(p[0]); const b = Number(p[1]); return b ? a / b : def }
  const n = parseFloat(s); return isNaN(n) ? def : n
}
const num = (v, d) => { const n = parseFloat(v); return isNaN(n) ? d : n }

// 换算链上的四个乘数（默认值＝字段 def，与面板一致）
export function rateFactors(form) {
  const f = form || {}
  return {
    mf: modFactorOf(f.modulation) || 2,          // 调制因子（bit/symbol）
    fec: parseFrac(f.fec, 0.75),
    rs: parseFrac(f.rsCode, 188 / 204),          // 帧效率
    m: num(f.m, 1),                              // 扩频增益
    bw: num(f.bandwidthFactor, 1.2)              // 滚降 (1+α)
  }
}

// 由信息速率算出整条链；信息速率非法时四项均为 NaN
export function rateChain(form) {
  const { mf, fec, rs, m, bw } = rateFactors(form)
  const info = num((form || {}).infoRate, NaN)
  const carrier = isNaN(info) ? NaN : info / fec / rs
  const chip = isNaN(carrier) ? NaN : carrier * m
  const symbol = isNaN(chip) ? NaN : chip / mf
  return { info, carrier, chip, symbol, bw: isNaN(symbol) ? NaN : symbol * bw }
}

// 反解：把锚点字段的目标值换回信息速率（'info' 无需反解，返回 null）
export function infoRateFrom(form, which, v) {
  const { mf, fec, rs, m, bw } = rateFactors(form)
  if (which === 'chip') return v / m * fec * rs
  if (which === 'symbol') return v * mf / m * fec * rs
  if (which === 'bw') return (v / bw) * mf / m * fec * rs
  return null
}

// 锚点元信息（顺序＝面板上四个输入框的排布）
export const RATE_ANCHORS = {
  info: { label: '信息速率', unit: 'kbps' },
  chip: { label: '码片速率', unit: 'kcps' },
  symbol: { label: '符号率', unit: 'ksps' },
  bw: { label: '载波带宽', unit: 'kHz' }
}
export const anchorOf = (form) => (RATE_ANCHORS[(form || {}).rateAnchor] ? form.rateAnchor : 'info')

export const fmtRate = (v) => (isNaN(v) ? '--' : (Math.round(v * 1000) / 1000).toString())

// 锚点字段用用户填的原值（form.rateAnchorValue），不用反推回来的：infoRate 只存到 3 位小数，
// 沿链再算回去会掉精度——填 5000 kcps 显示/命名成「4999.999 kcps」。锚点那一项他刚定过，照原值报。
function pinnedValue(form) {
  const f = form || {}
  if (anchorOf(f) === 'info') return NaN            // 信息速率自己就是存储字段，无需另记
  const v = Number(f.rateAnchorValue)
  return (f.rateAnchorValue == null || f.rateAnchorValue === '' || !isFinite(v)) ? NaN : v
}

// 四个速率框的显示值（锚点那项照原值，其余按链反推）。info 不在此列——它是存储字段，直接 v-model
export function rateDisplays(form) {
  const chain = rateChain(form)
  const key = anchorOf(form), pin = pinnedValue(form)
  const one = (k) => fmtRate((k === key && !isNaN(pin)) ? pin : chain[k])
  return { chip: one('chip'), symbol: one('symbol'), bw: one('bw') }
}

// 当前锚点那一项的读数：{ key, label, value, unit, text }。
// value/unit 是原始口径（kbps/kcps/ksps/kHz，面板与引擎都按它）；text 是给人读的一行，
// 按数值大小换档到 Mbps/GHz 这一档（与结果列同一套 adaptUnits 档位表）——36000 kHz 报「36 MHz」。
export function anchoredRate(form) {
  const key = anchorOf(form)
  const pin = pinnedValue(form)
  const value = isNaN(pin) ? rateChain(form)[key] : pin
  const meta = RATE_ANCHORS[key]
  // fmtQty 的第三参显式 true：本读数只喂自动命名（见 lbAutoName.carrierAutoName），条目名是数据，
  // 不随功能区「单位」档变——那个开关一动全库载波条目就要改名，存档凭空 dirty。
  return { key, label: meta.label, value, unit: meta.unit, text: isNaN(value) ? '' : fmtQty(fmtRate(value), meta.unit, true) }
}
