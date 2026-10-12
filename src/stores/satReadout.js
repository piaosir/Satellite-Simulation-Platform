import { reactive, watch } from 'vue'

// 卫星信息栏读数偏好（本地记忆）：
//  - sv：「状态矢量」的参考系 FIXED（地固 ECEF）| J2000 | TEME
//  - osc：「密切根数」的参考系 J2000 | TEME（只认惯性系）
//  - ewBox / nsBox：同步轨道「位置保持范围」半宽（°）；0 = 不设（日轨迹图不画框、读数不着色）
//  - nominal：逐星的标称经度覆写（°，东正西负），键 = satIdOf(entry)；没有覆写的 GEO 取「定点」（历元星下点经度，0.1° 档）
// 信息栏与视频叠加共读这一份（成片里的状态矢量 / 密切根数与信息栏同一个参考系）。只管呈现，不进任何计算与导出。
const KEY = 'sat-readout-v1'
export const SV_FRAME_KEYS = ['FIXED', 'J2000', 'TEME']
export const OSC_FRAME_KEYS = ['J2000', 'TEME']
export const BOX_MAX = 10
export const SAT_READOUT_DEF = { sv: 'FIXED', osc: 'J2000', ewBox: 0.1, nsBox: 0.1 }

export const satReadout = reactive({ ...SAT_READOUT_DEF, nominal: {} })

const boxOk = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= BOX_MAX
try {
  const s = JSON.parse(localStorage.getItem(KEY) || 'null')
  if (s && typeof s === 'object') {
    if (SV_FRAME_KEYS.includes(s.sv)) satReadout.sv = s.sv
    if (OSC_FRAME_KEYS.includes(s.osc)) satReadout.osc = s.osc
    if (boxOk(s.ewBox)) satReadout.ewBox = s.ewBox
    if (boxOk(s.nsBox)) satReadout.nsBox = s.nsBox
    if (s.nominal && typeof s.nominal === 'object') {
      for (const [k, v] of Object.entries(s.nominal)) if (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 180) satReadout.nominal[k] = v
    }
  }
} catch { /* 存档坏了按出厂 */ }
watch(satReadout, () => { try { localStorage.setItem(KEY, JSON.stringify(satReadout)) } catch { /* 配额 / 隐私模式 */ } }, { deep: true })

// 标称经度覆写：给数写入（折回 ±180），给 null 撤销（回到「定点」）
export function setNominalLon(id, lon) {
  if (!id) return
  if (lon == null || !Number.isFinite(Number(lon))) { delete satReadout.nominal[id]; return }
  const v = ((Number(lon) + 180) % 360 + 360) % 360 - 180
  satReadout.nominal[id] = Math.round(v * 1e6) / 1e6
}
export function setBox(k, v) {
  if (k !== 'ewBox' && k !== 'nsBox') return
  const n = Number(v)
  satReadout[k] = Number.isFinite(n) ? Math.max(0, Math.min(BOX_MAX, n)) : 0
}
