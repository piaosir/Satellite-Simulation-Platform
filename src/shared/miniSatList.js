// 小程序「卫星覆盖」页的卫星列表 —— 【镜像】。
//
// 真相源在小程序仓库 miniprogram/pages/satellite-coverage/satellite-coverage.js 的 data.satellites。
// 这里放一份是因为「发覆盖图先选哪颗星」必须只让人选【小程序那边真有的】星：
// 波束在小程序里是按 satelliteName 归类显示的，选一个那边没有的名字，导过去就挂在一颗
// 凭空多出来的星下面，跟其它覆盖对不上号。
//
// ★ 顺序也照抄，不排序不去重：小程序那份就有同名轨位（CHINASAT 9 / 9C 都在 92.2，
//   10 / 10R / 16 都在 110.5），排序或去重都会让两边的下拉长得不一样，反而更难核对。
// ★★ 别改用平台自己的 SAT_PRESETS：那是【超集】（含 JCSAT-1C/2B/3A 等小程序没有的），
//   顺序也不同。2026-08-02 之前就是用它，结果两边列表对不上。
// ★★★ 漂了会被逮住：.bindharness/gen.mjs 把小程序覆盖页真加载进来，逐项比对本表与
//   data.satellites。改小程序那边的列表后跑一次 harness，它会指出差在哪。

export const MINI_COVERAGE_SATS = [
  { name: 'CHINASAT 6D', lon: 125 },
  { name: 'CHINASAT 6C', lon: 130.5 },
  { name: 'CHINASAT 6E', lon: 115.5 },
  { name: 'CHINASAT 9', lon: 92.2 },
  { name: 'CHINASAT 9B', lon: 101.4 },
  { name: 'CHINASAT 9C', lon: 92.2 },
  { name: 'CHINASAT 10', lon: 110.5 },
  { name: 'CHINASAT 10R', lon: 110.5 },
  { name: 'CHINASAT 11', lon: 98 },
  { name: 'CHINASAT 12', lon: 87.5 },
  { name: 'CHINASAT 15', lon: 51.5 },
  { name: 'CHINASAT 19', lon: 163.4 },
  { name: 'CHINASAT 16', lon: 110.5 },
  { name: 'CHINASAT 26', lon: 125 },
  { name: 'APSTAR 6D', lon: 134 },
  { name: 'APSTAR 6C', lon: 134 },
  { name: 'APSTAR 7', lon: 76.5 },
  { name: 'APSTAR 9', lon: 142 },
  { name: 'CHINASAT 27', lon: 87.5 },
  { name: 'APSTAR 5C', lon: 138 },
  { name: 'AsiaSat 5', lon: 100.5 },
  { name: 'AsiaSat 6', lon: 120 },
  { name: 'AsiaSat 7', lon: 105.5 },
  { name: 'AsiaSat 9', lon: 122 }
]

/** 名字归一后的查找键（与小程序 _matchSatNameStrict 同口径：大写、去空格与连字符） */
export const satKey = (s) => String(s == null ? '' : s).trim().toUpperCase().replace(/[\s-]/g, '')

const KEYS = new Set(MINI_COVERAGE_SATS.map((s) => satKey(s.name)))

/** 这个名字小程序那边有没有 */
export const inMiniList = (name) => KEYS.has(satKey(name))
