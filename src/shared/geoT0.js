// 自动最差几何的搜索时窗起点 t0 —— NGSO / 再生式 / 端到端三窗共用一份口径。
//
// 三档（场景级，随配置存档：起点决定这份配置算出什么数）：
//   'scene' 时间轴：主窗口全局仿真时钟的「此刻」（shared/sceneClock.js；没有主窗口时钟镜像时即系统钟）。出厂与老配置缺省。
//   'now'   系统时钟：点「计算」那一刻的系统时间（v1.4.13 及以前的口径）。
//   'fixed' 指定：用户给定的绝对时刻（存 ISO UTC 带 Z）。同一份配置任何时候算都是同一个起点，结果可复现。
// 指定档的时刻框按窗口的显示时区档位读写（shared/tz.js 两个咽喉），换档不改所指的瞬间。
// 存档只在非缺省时写这两个键（geoT0State）：老配置载入再序列化逐字不变，指纹不平白翻动。
// 纯 ESM、无 Vue 依赖：node 可直接测（packages/core/test/geoT0.test.mjs）。
import { tzParts, tzToMs } from './tz.js'
import { sceneNowMs } from './sceneClock.js'

export const GEO_T0_MODES = [{ v: 'scene', l: '时间轴' }, { v: 'now', l: '系统时钟' }, { v: 'fixed', l: '指定' }]

export function normGeoT0Mode(v) { return v === 'now' || v === 'fixed' ? v : 'scene' }

/** 存档 / 输入的时刻 → 规范 ISO（带 Z）；解不出返回 '' */
export function normGeoT0ISO(v) {
  if (typeof v !== 'string' || !v) return ''
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : ''
}

/** 场景里的起点两键：缺省（时间轴、没指定过时刻）不写 */
export function geoT0State(mode, iso) {
  const m = normGeoT0Mode(mode), t = normGeoT0ISO(iso)
  const o = {}
  if (m !== 'scene' || t) o.geoT0Mode = m
  if (t) o.geoT0ISO = t
  return o
}

/**
 * 起点 → ISO（带 Z），每批计算取一次。指定档的时刻无效（手改坏的存档）退回时间轴档 ——
 * 不送 null 给主进程（那边会按轨道历元另编一个起点）。clock 可注入（单测）。
 */
export function resolveGeoT0ISO(mode, fixedISO, clock = {}) {
  const scene = clock.scene || sceneNowMs, now = clock.now || Date.now
  const m = normGeoT0Mode(mode)
  if (m === 'fixed') { const t = normGeoT0ISO(fixedISO); if (t) return t }
  return new Date(m === 'now' ? now() : scene()).toISOString()
}

/** 时间轴此刻取整到秒（切到「指定」时的初值：datetime-local 只到秒） */
export function sceneSecondISO(clock = {}) {
  const scene = clock.scene || sceneNowMs
  return new Date(Math.floor(scene() / 1000) * 1000).toISOString()
}

const p2 = (n) => String(n).padStart(2, '0')

/**
 * ISO → datetime-local 的值（该档位的墙钟，到秒）。秒为 0 时省掉「:00」：与 datetime-local 自己规范化后的 value
 * 同一写法，字面不同的话每次重渲染都会把框重写一遍。
 */
export function t0InputValue(iso, tzMode) {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const p = tzParts(ms, tzMode)
  return `${String(p.y).padStart(4, '0')}-${p2(p.mo)}-${p2(p.d)}T${p2(p.h)}:${p2(p.mi)}` + (p.s ? ':' + p2(p.s) : '')
}

/**
 * datetime-local 的值（该档位的墙钟）→ ISO；解析不出返回 null。
 * 年份首位为 0 的不收：Chromium 的年份段键到一半是 0002 / 0020 / 0202，Date.UTC 还把 0–99 年当 1900+。
 */
export function parseT0Input(val, tzMode) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(val == null ? '' : val).trim())
  if (!m || m[1][0] === '0') return null
  const ms = tzToMs(tzMode, m[1], m[2], m[3], m[4], m[5], m[6] || 0)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}
