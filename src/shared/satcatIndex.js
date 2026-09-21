// 卫星编目（SATCAT）索引：NORAD -> 一行编目。给搜索筛选器用。
//
// 取数走与「空间态势报告」同一条通路（api.satcat.csv），解析直接用 src/shared/ssaStats.js 的
// parseSatcatCsv —— 那是编目解析的唯一真值源，这里不另写一份。
//
// 【只读本机、绝不联网】筛选是个随手的动作，不该因为没网就卡住；编目要不要下载由
// 「文件管理 · 轨道星历」那边决定。取不到就返回 null，界面据此把编目四项禁用。
// 缓存按 fetchedAt 对号：同一份明文只解析一次（编目 6.7 MB，解析一次几百毫秒）。

import { parseSatcatCsv } from './ssaStats.js'

let _cache = null        // { fetchedAt, index }
let _inflight = null

/** 返回 Map(NORAD -> row) 或 null（没有编目）。 */
export async function loadSatcatIndex(opts) {
  const o = opts || {}
  if (o.force) { _cache = null; _inflight = null }
  if (_cache) return _cache.index
  if (_inflight) return _inflight
  _inflight = (async () => {
    try {
      const api = (typeof window !== 'undefined') && window.api
      if (!api || !api.satcat || !api.satcat.csv) return null
      // cacheOnly：只读本机缓存 / 随包快照
      const res = await api.satcat.csv({ cacheOnly: true })
      const text = res && res.text
      if (!text) return null
      const fetchedAt = (res && res.fetchedAt) || ''
      if (_cache && _cache.fetchedAt === fetchedAt) return _cache.index
      const rows = parseSatcatCsv(text)
      if (!rows.length) return null
      const index = new Map()
      for (const r of rows) if (r && r.norad) index.set(String(r.norad), r)
      _cache = { fetchedAt, index }
      return index
    } catch { return null } finally { _inflight = null }
  })()
  return _inflight
}

/** 已经取到过的索引（同步取，没取到返回 null）——渲染期间不想 await 时用。 */
export const satcatIndexNow = () => (_cache ? _cache.index : null)
export const hasSatcat = () => !!(_cache && _cache.index && _cache.index.size > 0)
export function clearSatcatIndex() { _cache = null; _inflight = null }

export default { loadSatcatIndex, satcatIndexNow, hasSatcat, clearSatcatIndex }
