// 链路预算「地球站库」按站型对号：导入图上链路 / 站址时，站带来的【天线口径 + 天线罩】→ 库条目（GSO / NGSO / 再生式 / 端到端共用）。
//
// 一份地球站库条目 = 一种站型（一面天线）。对号键 = （口径，带罩与否）：
//   · 找：口径相等（±1 µm）且带罩与否相同；prefer（该侧原缺省引用的那份）命中优先，其次按库序第一份。
//   · 建：以 prefer（它若是带罩的，取库里第一份不带罩的）为底本复制一份，只改口径；带罩时上 / 下行「其他损耗」各加
//         该侧工作频率下的典型罩损（mapLinks.radomeLossDb），名字写成「4.5 m 天线罩」；不带罩的名字交还自动命名（「4.5 m」）。
//         其余射频参数（效率 / 功放 / 馈线 / 噪温 / UPC …）照抄底本，由用户在库里改。
//   · 「带罩」判据 = 条目名含「天线罩 / Radome」——不给库加字段，库结构与既有存档逐字不变（GSO 已有用户在用）。
// 发端站带功放功率（powerW + powerKey）时功率也进对号键，新建条目写入该功率。
// 站既没带口径、罩也没带功率：不对号（返回 null），调用方沿用该侧原来的引用。
// 纯函数、不碰响应式；建条目由各窗口按自己的 id 规则落（见各窗 importChains）。

import { byLang } from './i18n/lang.js'
import { radomeLossDb, okDiaM, okPwrW } from '../../packages/core/models/mapLinks.mjs'

export const RADOME_NAME_RE = /天线罩|radome/i
export const esIsRadome = (cfg) => RADOME_NAME_RE.test(String((cfg && cfg.name) || ''))
const diaOf = (cfg) => Number(cfg && cfg.form && cfg.form.antennaDiameter)
const sameDia = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-6
const samePwr = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(b))
// 口径写回表单的字面：最多 3 位小数、去掉尾零（4.5 → '4.5'、1.2 → '1.2'、0.75 → '0.75'）
const diaText = (d) => String(Math.round(d * 1000) / 1000)
const dbText = (v) => String(Math.round(v * 100) / 100)

/** 「4.5 m 天线罩」/「4.5 m 40 W 天线罩」——带罩条目的名字（按平台语言出字：名字是数据，呈现层翻不到）。 */
export const radomeEsName = (d, w) => {
  const p = okPwrW(w) ? ` ${String(Math.round(w * 1000) / 1000)} W` : ''
  return byLang(`${diaText(d)} m${p} 天线罩`, `${diaText(d)} m${p} Radome`)
}

/**
 * 站型对号。
 * @param {Array} configs   该窗口的地球站库（esConfigs）
 * @param {object} o
 *   diaM     站的天线口径（m）；缺省 = 沿用 prefer 的口径
 *   radome   站有天线罩
 *   prefer   该侧原缺省引用的条目（GSO / NGSO 发端 = 库第一份、收端 = 库第二份；再生式 / 端到端 = 库第一份）
 *   lossKeys { up, dn }：带罩时加罩损的两个表单键（GSO / NGSO / 再生式 = uplinkOtherLoss / downlinkOtherLoss）；
 *            null = 该库没有损耗字段（端到端：罩损由调用方加到相邻跳的「其他损耗」上，库条目只按口径对号）
 *   freq     { up, dn }：上 / 下行工作频率（GHz），定罩损档位
 *   powerW   发端站的功放功率（W）；给了就并进对号键（收端不给）
 *   powerKey 该库的功放功率表单键（GSO / NGSO = paPowerW；再生式 / 端到端 = opPowerW）；不给则不按功率对号
 * @returns {null | {hit: object} | {make: {form, name, nameAuto}}}
 */
export function esStationType(configs, o) {
  const list = Array.isArray(configs) ? configs.filter(Boolean) : []
  if (!list.length) return null
  const radome = !!(o && o.radome) && !!(o && o.lossKeys)   // 库里记不下罩损（端到端）就只按口径对号
  const wantDia = o && okDiaM(o.diaM) ? o.diaM : null
  const pk = o && o.powerKey ? String(o.powerKey) : ''
  const wantW = pk && okPwrW(o.powerW) ? o.powerW : null
  if (wantDia == null && !radome && wantW == null) return null
  const prefer = (o && o.prefer && list.includes(o.prefer)) ? o.prefer : list[0]
  const d = wantDia != null ? wantDia : diaOf(prefer)
  if (!(d > 0)) return null
  const fits = (c) => sameDia(diaOf(c), d) && esIsRadome(c) === radome && (wantW == null || samePwr(Number(c && c.form && c.form[pk]), wantW))
  if (fits(prefer)) return { hit: prefer }
  const hit = list.find(fits)
  if (hit) return { hit }
  const base = !esIsRadome(prefer) ? prefer : (list.find((c) => !esIsRadome(c)) || prefer)
  const form = JSON.parse(JSON.stringify(base.form || {}))
  form.antennaDiameter = diaText(d)
  if (wantW != null) form[pk] = String(Math.round(wantW * 1000) / 1000)
  if (radome && !esIsRadome(base)) {
    const k = o.lossKeys, f = o.freq || {}
    if (k.up) form[k.up] = dbText((Number(form[k.up]) || 0) + radomeLossDb(f.up))
    if (k.dn) form[k.dn] = dbText((Number(form[k.dn]) || 0) + radomeLossDb(f.dn))
  }
  return radome ? { make: { form, name: radomeEsName(d, wantW), nameAuto: false } } : { make: { form, name: '', nameAuto: true } }
}
