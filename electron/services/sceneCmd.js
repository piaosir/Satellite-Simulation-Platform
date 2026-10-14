'use strict'
// 计算窗 → 主窗口的反向通道（scene:cmd）的参数清洗。纯函数，不碰 electron。
//
// 计算窗（NGSO 典型时刻 t*、日凌逐日表、星间距离极值、C/I 最差时刻…）把一个动作发回主窗口：
//   seekClock  { tMs }                        拨主时间轴到该时刻（暂停）
//   focusSat   { norad?, name? }              聚焦该星
//   faceLonLat { lat, lon, name? }            画面正对该点（瞬时）
//   markTime   { t0, t1?, label, src }        时间轴上加一个事件标记（同 src + label 覆盖）
// 白名单外的 cmd 一律拒收（返回 null）；数值必须有限且在范围内，字符串去控制字符、截长。
// 出参是现造的纯数据 { cmd, payload }，可以直接过 IPC（渲染端送来的 Vue Proxy / 多余字段到这里为止）。

// 时刻范围与日凌 / 星侧太阳侵入同一口径（1900–2200 UTC）
const T_MIN = Date.UTC(1900, 0, 1)
const T_MAX = Date.UTC(2200, 0, 1)

const num = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
// 去控制字符、去首尾空白、截长
const str = (v, n) => (v == null ? '' : String(v)).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n)
const timeOf = (v) => { const t = num(v); return t != null && t >= T_MIN && t <= T_MAX ? t : null }
// 经度归一到 (−180, 180]；本就在范围内的原样返回（取模会带进 1e-14 级的舍入，116.4 变 116.39999999999998）
const wrapLon = (x) => {
  if (x > -180 && x <= 180) return x === 0 ? 0 : x
  let l = ((x + 180) % 360 + 360) % 360 - 180
  if (l === -180) l = 180
  return l === 0 ? 0 : l
}

const CMDS = {
  seekClock(p) {
    const tMs = timeOf(p.tMs)
    return tMs == null ? null : { tMs }
  },
  focusSat(p) {
    const n = p.norad == null ? '' : str(p.norad, 24).replace(/[^\w-]/g, '')
    const name = str(p.name, 160)
    if (!n && !name) return null
    const out = {}
    if (n) out.norad = n
    if (name) out.name = name
    return out
  },
  faceLonLat(p) {
    const lat = num(p.lat), lon = num(p.lon)
    if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 360) return null
    const out = { lat, lon: wrapLon(lon) }
    const name = str(p.name, 120)
    if (name) out.name = name
    return out
  },
  markTime(p) {
    let t0 = timeOf(p.t0)
    if (t0 == null) return null
    const label = str(p.label, 120), src = str(p.src, 40)
    if (!label || !src) return null
    const out = { t0, label, src }
    let t1 = p.t1 == null || p.t1 === '' ? null : timeOf(p.t1)
    if (p.t1 != null && p.t1 !== '' && t1 == null) return null      // 给了 t1 却不合法：整条拒收，不悄悄当成时刻点
    if (t1 != null) {
      if (t1 < t0) { const x = t0; t0 = t1; t1 = x; out.t0 = t0 }
      if (t1 > t0) out.t1 = t1
    }
    return out
  }
}
const SCENE_CMDS = Object.freeze(Object.keys(CMDS))

function sanitizeSceneCmd(cmd, payload) {
  if (typeof cmd !== 'string' || !Object.prototype.hasOwnProperty.call(CMDS, cmd)) return null
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
  let clean = null
  try { clean = CMDS[cmd](p) } catch { clean = null }
  return clean ? { cmd, payload: clean } : null
}

module.exports = { sanitizeSceneCmd, SCENE_CMDS, SCENE_T_MIN: T_MIN, SCENE_T_MAX: T_MAX }
