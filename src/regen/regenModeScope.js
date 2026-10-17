// 再生式各计算模块（上行 / 下行 / 星间微波 / 星间激光）按模块取口径的几件纯函数。
// RegenLinkBudgetApp 在取结果处、交报告处调用；不依赖 Vue，便于单测（单跳时延：packages/core/test/lbSla.test.mjs，
// 报告输入清单：packages/core/test/lbWorkbenchResults.test.mjs）。
//
// 背景：再生式上 / 下行复用弯管 NGSO 引擎与双站几何求解器，靠「把同一座站、同一斜距灌进上下两侧」让它们良定
// （另一侧是镜像占位，见 regenParams.buildRegenParams / buildRegenDownlinkParams）。于是：
//   · 凡是「上行段 + 下行段」合成的量（引擎 linkDelayResult、几何 worst.oneWayDelayMs）都是本跳的两倍；
//   · 凡是逐字段从入参里摘值的地方（报告「输入参数」清单）都会摘到占位。
// 这里把两类口径收回到本模块真实的那一跳、那几组字段。

import { FIELD_GROUPS } from './regenParams.js'

const C_KM_S = 299792.458

// 模块 → 真实那一跳在弯管入参 / 几何里的侧别：上行取 up，下行取 dn（星间 / 激光不走这条路）
export const hopSideOf = (mode) => (mode === 'downlink' ? 'dn' : 'up')

// 单跳传播时延（ms）；斜距不成数返回 null
export function hopDelayMs(slantKm) {
  const s = Number(slantKm)
  return Number.isFinite(s) && s > 0 ? s / C_KM_S * 1000 : null
}

// 几何：单站求解（tx = rx = 本站）返回的 worst.oneWayDelayMs 是 (d_up + d_dn) / c —— 弯管端到端口径，
// 对单跳的再生上 / 下行就是本跳的两倍。就地改写成本跳：结果回填（mergePlatformGeometry）、几何卡、
// 报告「几何关系」页读的都是这一个数。
export function regenHopGeometry(geo, side) {
  const w = geo && geo.worst
  const hop = w && w[side]
  const t = hop ? hopDelayMs(hop.slantKm) : null
  if (t != null) w.oneWayDelayMs = t
  return geo
}

// 引擎出参：linkDelayResult（弯管口径 = 上行段 + 下行段）改写成本跳的分段时延；镜像那一侧的分段时延清空
// （同引擎把再生上行的 downlinkCN 清空的口径）——留着它，自定义列与 SLA 依据会把它当成第二跳读。
// 瀑布表的往返时延（RTT = 单程 × 2）随 linkDelayResult 一起回到本跳口径。
export function regenHopDelay(d, side) {
  if (!d) return d
  const own = side === 'dn' ? 'linkDelayDownResult' : 'linkDelayUpResult'
  const mirror = side === 'dn' ? 'linkDelayUpResult' : 'linkDelayDownResult'
  const v = d[own]
  if (v !== undefined && v !== null && v !== '') d.linkDelayResult = v
  d[mirror] = ''
  return d
}

// —— 报告「输入参数」清单：按模块只交参与计算的字段 ——
// useLbReport 拿全量 FIELD_GROUPS 逐组从「本行送进引擎的那份入参」里摘值（lbReport.buildInputDigest），而再生式那份
// 入参有一半是让弯管引擎良定的占位：上行带着镜像的收信站与下行缺省（DL_LINK_DEFAULTS），下行带着上行占位
// （UP_LINK_DEFAULTS），星间带着「发 / 收」两座假站与上下行全套占位。原样交出去，报告就把这些不参与计算的数
// 当成输入印出来（上行多出一整块「收信站群」，星间多出两座站）。
// 这里把入参投影到本模块真正参与计算的字段上：组外的键一律不交，那几组在清单里自然整块不出；
// opt 原样交（「功放功率预设」等 target:'op' 字段从 opt 里取，见 lbReport 的 fieldValue）。
const GROUPS_BY_MODE = {
  uplink: ['carrier', 'sat', 'station', 'uplink'],
  downlink: ['carrier', 'sat', 'station', 'downlink'],
  isl: ['carrier', 'isl'],
  laser: ['laser']
}
// 卫星群里只属于一个方向的字段（频率 / 极化 / 四项干扰）：上行模块不交下行那几项，下行模块不交上行那几项
const SAT_UP_ONLY = new Set(['centerFrequency', 'uplinkPolarization', 'aciUplinkFactor', 'adjUplinkFactor', 'xpolUplinkFactor', 'hpaIntermodFactor'])
const SAT_DN_ONLY = new Set(['rxCenterFrequency', 'downlinkPolarization', 'aciDownlinkFactor', 'adjDownlinkFactor', 'xpolDownlinkFactor', 'xpdrIntermodFactor'])

// 本模块参与计算的引擎入参键
export function regenDigestKeys(mode) {
  const m = GROUPS_BY_MODE[mode] ? mode : 'uplink'
  const groups = GROUPS_BY_MODE[m]
  const keys = new Set()
  for (const g of FIELD_GROUPS) {
    if (!groups.includes(g.key)) continue
    for (const f of g.fields) {
      if (g.key === 'sat' && (m === 'uplink' ? SAT_DN_ONLY : SAT_UP_ONLY).has(f.key)) continue
      if (g.key === 'station') {
        // 地球站库：上行只取发射链 + 收发共用的口径（引擎键 = key），下行只取接收链 + 口径（引擎键 = rxKey，
        // 与 lbReport 收侧取值同一条规则）——另一侧在入参里是占位
        if (m === 'uplink' && (f.side === 'tx' || f.side === 'common')) keys.add(f.key)
        else if (m === 'downlink' && (f.side === 'rx' || f.side === 'common')) keys.add(f.rxKey || f.key)
        continue
      }
      keys.add(f.key)
    }
  }
  return keys
}

/**
 * 交给报告的入参：投影到本模块参与计算的字段上。
 * 注意投影按键不按组：星间 / 激光两组共用 islRangeKm 等几个 target:'geom' 键，往入参里补这类键会在两组各印一遍，
 * 故这里只删不补（星间距离在该链路的详细预算里有）。
 * @param mode   链路所属模块（l.mode）
 * @param params 计算时留底的 { satParams, linkParams, opt }（sweepParamsByRow）；缺省返回 null（报告不出输入清单）
 */
export function regenDigestParams(mode, params) {
  if (!params) return null
  const keys = regenDigestKeys(mode)
  const pick = (src) => { const out = {}; for (const k of Object.keys(src || {})) if (keys.has(k)) out[k] = src[k]; return out }
  return { satParams: pick(params.satParams), linkParams: pick(params.linkParams), opt: { ...(params.opt || null) } }
}
