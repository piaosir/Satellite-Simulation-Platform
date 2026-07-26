// 载波速率换算链（信息速率 / 码片速率 / 符号率 / 载波带宽）—— 载波面板与资源库自动命名共用一份口径。
// 链与引擎 linkCalculator.js 完全一致：
//   infoRate → carrierRate(÷fec÷rs) → chipRate(×m，码片速率) → symbolRate(÷调制因子) → carrierBW(×滚降)
//
// 四者是同一条链上的四个视角，真正入库的只有 infoRate；用户最近编辑的那一个是「锚点」（form.rateAnchor），
// 调制/FEC/扩频/滚降变化时按锚点反解 infoRate，使锚点字段保持用户定下的值不动（见 BasebandPanel）。
// 锚点随配置入库（不再是面板的局部态）：切走再回来、下次开软件，用户按的还是自己那个口径——
// 条目自动命名也据此报（改带宽就报带宽、改符号率就报符号率，见 lbAutoName.carrierAutoName）。

import { fmtQty } from './adaptUnits.js'   // 显示单位自适应（kbps→Mbps/Gbps、kHz→MHz/GHz…），与结果列同一套档位表

export const MOD_FACTORS = { BPSK: 1, QPSK: 2, '8PSK': 3, '8QAM': 3, '16QAM': 4, '16APSK': 4, '32APSK': 5, '64QAM': 6, '64APSK': 6, '128APSK': 7, '256APSK': 8 }

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
    mf: MOD_FACTORS[f.modulation] || 2,          // 调制因子（bit/symbol）
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
  return { key, label: meta.label, value, unit: meta.unit, text: isNaN(value) ? '' : fmtQty(fmtRate(value), meta.unit) }
}
