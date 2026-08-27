// 城市名的语言分流 —— 城市名是【数据】不是界面文本：它被写进站名字段、存进 configs.json、
// 显示在 <input> 的 value 与打了 data-i18n-skip 的下拉行上，呈现层的观察器一概碰不到（同 i18n/lang.js 头注）。
// 故在「取名」这一步就按平台语言出字：英文界面下拉里报 Beijing，选中后写进站名的也是 Beijing。
//
// 城市库每条都带 en（见 packages/core/utils/cities.js）；万一缺了就回退中文名，不出空白。

import { byLang } from './i18n/lang.js'

// 列表主名 / 写进站名字段的那个名字
export const cityName = (c) => (c ? byLang(c.name || '', c.en || c.name || '') : '')

// 下拉行的副标题。中文模式沿用旧样：国际条目报「英文名 · 国家」，国内条目留空；
// 英文模式主名已是英文，副标题只报国家（国内条目同样留空，与中文模式对称）。
export const citySubtitle = (c) => {
  if (!c) return ''
  return byLang(
    [c.country ? c.en : '', c.country].filter(Boolean).join(' · '),
    c.country ? (c.countryEn || c.country) : ''
  )
}

// 站名反查城市库时的候选键：中英两名都算。英文界面写进去的是英文名、中文界面是中文名，
// 从 Excel 粘来的两种都可能，反查一律两路都比（库内英文名无重复，不会引入歧义）。
export const cityNameKeys = (c) => (c ? [c.name, c.en].filter(Boolean) : [])
