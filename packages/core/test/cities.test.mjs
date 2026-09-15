// 城市库自检 —— 守住站名反查与分层选点依赖的几条不变式：
//   ① 中外分界：前 CHINA_CITIES_COUNT 条不带 country，其后每条都带 country / countryEn / en / py
//   ② 中文名、英文名全库唯一（站名→坐标反查靠它，撞名会静默写错一组经纬度）
//   ③ 经纬度 / 海拔在合法范围，且没有两条坐标几乎重合（「已加」按 ±1e-4 判同，重合会串标）
//   ④ 省份区间 PROVINCE_MAPPING 连续、不越过中外分界；分层库 listCitiesGrouped 的条目总数 = 全库
//   ⑤ 检索四路：中文名 / 拼音首字母 / 英文名 / 国家名（中英）都能命中，且拼音全等排最前
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const C = require('../utils/cities.js')

let fails = 0
const ok = (cond, msg, extra = '') => {
  if (cond) console.log(`PASS  ${msg}${extra ? '  (' + extra + ')' : ''}`)
  else { console.log(`FAIL  ${msg}${extra ? '  (' + extra + ')' : ''}`); fails++ }
}
const D = C.CITIES_DATA, N = C.CHINA_CITIES_COUNT

// ① 中外分界
ok(D.slice(0, N).every((c) => c.country == null), '① 国内条目不带 country', `${N} 条`)
const intl = D.slice(N)
const bad = intl.filter((c) => !c.country || !c.countryEn || !c.en || !c.py)
ok(bad.length === 0, '① 国际条目 country / countryEn / en / py 齐全', bad.map((c) => c.name).slice(0, 5).join(','))
ok(intl.length >= 500, '① 国际条目扩容到位', `${intl.length} 条`)
ok(D.every((c) => c.en), '① 每条都有英文名')

// ② 唯一性
const dup = (key) => { const seen = new Map(), out = []; for (const c of D) { const k = String(c[key]).toLowerCase(); if (seen.has(k)) out.push(c[key]); seen.set(k, 1) } return out }
const dn = dup('name'), de = dup('en')
ok(dn.length === 0, '② 中文名唯一', dn.join(','))
ok(de.length === 0, '② 英文名唯一', de.join(','))
ok(D.every((c) => /^[a-z]+$/.test(c.py || 'x')), '② py 只含小写字母', D.filter((c) => !/^[a-z]+$/.test(c.py || 'x')).map((c) => c.name).slice(0, 5).join(','))

// ③ 数值范围 + 坐标不重合
ok(D.every((c) => Number.isFinite(c.lat) && Math.abs(c.lat) <= 90 && Number.isFinite(c.lon) && Math.abs(c.lon) <= 180 && Number.isFinite(c.alt)), '③ 经纬度 / 海拔合法')
const close = []
for (let i = 0; i < D.length; i++) for (let j = i + 1; j < D.length; j++) {
  if (Math.abs(D[i].lat - D[j].lat) < 3e-3 && Math.abs(D[i].lon - D[j].lon) < 3e-3) close.push(D[i].name + '~' + D[j].name)
}
ok(close.length === 0, '③ 没有两条坐标几乎重合（<0.003°）', close.slice(0, 5).join(' '))

// ④ 省份区间 + 分层库守恒
let cursor = 0, contiguous = true
for (const p of C.PROVINCES) { const m = C.PROVINCE_MAPPING[p]; if (m.start !== cursor) contiguous = false; cursor = m.start + m.count }
ok(contiguous && cursor <= N, '④ PROVINCE_MAPPING 区间连续且不越过中外分界', `末尾 ${cursor} / 分界 ${N}`)
const G = C.listCitiesGrouped()
const gTotal = G.china.reduce((n, g) => n + g.cities.length, 0) + G.intl.reduce((n, g) => n + g.cities.length, 0)
ok(gTotal === D.length, '④ 分层库条目总数 = 全库', `${gTotal} / ${D.length}`)
ok(G.china.every((g) => g.province && g.provinceEn && g.cities.length), '④ 中国各省组有英文名且非空', `${G.china.length} 省`)
ok(G.intl.every((g) => g.country && g.countryEn && g.cities.length), '④ 国际各国组有英文名且非空', `${G.intl.length} 国`)
ok(G.intl.length >= 150, '④ 国际分组国家数', `${G.intl.length}`)
ok(G.china[0].province === '北京' && G.intl[0].country === '日本', '④ 组序：中国从北京起、国际从日本起')
const stats = C.getCitiesStats()
ok(stats.total === D.length && stats.china === N && stats.international === intl.length, '④ getCitiesStats 与数据一致')

// ⑤ 检索
const jp = C.searchCities('日本')
ok(jp.length === G.intl.find((g) => g.country === '日本').cities.length && jp.every((c) => c.countryEn === 'Japan'), '⑤ 中文国家名 → 该国全部城市', `${jp.length} 座`)
ok(C.searchCities('Japan').length === jp.length, '⑤ 英文国家名同样命中')
ok(C.searchCities('bj')[0].name === '北京', '⑤ 拼音首字母全等排最前')
ok(C.searchCities('tokyo')[0].en === 'Tokyo', '⑤ 英文名（小写）命中')
ok(C.searchCities('江苏').every((c) => C.PROVINCE_MAPPING['江苏'] && C.getCitiesByProvince('江苏').includes(c)), '⑤ 省份名 → 该省城市')
ok(C.searchCities('Antarctica').length >= 10, '⑤ 南极科考站可按国家名检索', `${C.searchCities('Antarctica').length} 站`)
ok(C.getCityByName('拜科努尔') && C.getCityByName('拜科努尔').countryEn === 'Kazakhstan', '⑤ 按中文名精确取条目')
ok(C.searchCities('Kwajalein').length === 1 && C.searchCities('夸贾林')[0].en === 'Kwajalein', '⑤ 新增条目中英都可检索')

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS')
process.exit(fails ? 1 : 0)
