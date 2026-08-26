// 地图视角的轻量状态源：设置页写它、主权解算器订阅它。
//
// ★ 方向是「轻依赖重」，不能反过来。设置页若直接（或动态）import povResolver，打包器会把
//   povResolver + 3.8 MB 底图 + 两个渲染器 + three 全都并进设置页也要的公共块 ——
//   实测那一版把 ConstellationMap3D 的 17.5 MB 拆成了一个 15.9 MB 的公共块，
//   等于「点一下设置就把整套地图引擎拉起来」。这里只依赖 povList（六份几 KB 的视角表），
//   povResolver 反过来订阅，重的那一头仍只被真正要画底图的模块拉进去。
import { MAP_POV_DEF, normMapPov } from '../viz/geo/povList.js'

let cur = normMapPov(MAP_POV_DEF)
let booted = false
const subs = new Set()

export const getMapPov = () => normMapPov(cur)

// 设置页改一下就广播（解算器随即重算、两个渲染器整份重建）；落盘另走 setSettings。
export function setMapPov(v) {
  cur = normMapPov(v)
  for (const fn of [...subs]) { try { fn(cur) } catch (e) { console.warn('[mapPov]', e) } }
  return cur
}

// 落盘：地图视角是【全局设置】（存在 settings 的 mapPov 一项里），星座地图页的侧栏改完即写回。
// 与 setMapPov 分开是因为验证台/单测里没有 window.api —— 那边只要广播，不要落盘。
export async function saveMapPov(v) {
  const cfg = setMapPov(v)
  if (typeof window === 'undefined' || !window.api || !window.api.store || !window.api.store.setSettings) return cfg
  try {
    const st = (await window.api.store.getSettings()) || {}
    await window.api.store.setSettings({ ...st, mapPov: JSON.parse(JSON.stringify(cfg)) })
  } catch (e) { console.warn('[mapPov] 落盘失败', e) }
  return cfg
}

// 订阅：立刻回调一次当前值，返回退订函数
export function onMapPov(fn) {
  subs.add(fn)
  try { fn(cur) } catch (e) { console.warn('[mapPov]', e) }
  return () => subs.delete(fn)
}

// 从「设置」里把视角读进来，只读一次。没有 window.api（单测 / 离屏验证台）时静默保持默认。
export function bootMapPov() {
  if (booted) return
  booted = true
  if (typeof window === 'undefined' || !window.api || !window.api.store || !window.api.store.getSettings) return
  window.api.store.getSettings().then((st) => { if (st && st.mapPov) setMapPov(st.mapPov) }).catch(() => { /* 读不到就用默认视角 */ })
}
