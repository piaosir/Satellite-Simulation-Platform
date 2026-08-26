// 中国行政区划（民政部口径）—— 阿里 DataV GeoAtlas 的 areas_v3 接口。
//
// 为什么中国单独走这一路（而不是与其余 250 个国家一样用 Natural Earth / geoBoundaries）：
//   ① 层级对不上：geoBoundaries 的 CHN ADM2 是【县级】2391 个（Mohexian / Tahexian …），
//      本平台要的是【地级市】333 个 —— 那才是卫星波束覆盖、地球站选址会用到的那一层。
//   ② 没有中文：geoBoundaries 的 shapeName 全是拼音，两档名称都只能回落英文。
//   ③ 疆域口径：DataV 基于民政部行政区划，台港澳、藏南、阿克赛钦与本平台的红线一致，
//      且省界与市界出自同一套几何 —— 两层叠起来严丝合缝，不会一层压着另一层错开几百米。
//
// ★ 出版提示：DataV 是公开服务、数据源为民政部行政区划，日常仿真与内部报告够用；
//   对外正式出版的地图仍须换成带审图号的底图（与 basemap-*.json 的 claim_note_zh 同一条口径）。
import fs from 'node:fs'
import path from 'node:path'
import { cached, CACHE } from './neFetch.mjs'

const BASE = 'https://geo.datav.aliyun.com/areas_v3/bound/'

// 拉一个行政区的「本级 + 下一级」几何。缓存在 scripts/_ne/，与 NE 那套共用一个目录。
export async function datavFull(adcode) {
  const f = await cached(BASE + adcode + '_full.json', 'datav-' + adcode + '.json')
  return JSON.parse(fs.readFileSync(f, 'utf8'))
}

// 34 个省级单元（100000_full 里还有一条 adcode='100000_JD' 的南海诸岛断续线，不是行政区，剔掉）
export const isProvince = (p) => typeof p.adcode === 'number' && p.adcode % 10000 === 0

// 省级：中文简称（地图上不写全称 —— 「广西壮族自治区」在省会字号下会盖掉半个省）
const PROV_SHORT = { 150000: '内蒙古', 450000: '广西', 540000: '西藏', 640000: '宁夏', 650000: '新疆', 810000: '香港', 820000: '澳门' }
export const provShort = (adcode, name) => PROV_SHORT[adcode] || name.replace(/(省|市)$/, '')

// 省级：英文名（DataV 只有中文；34 条手写，用通行译名 —— Tibet / Inner Mongolia / Macao 这类不按拼音）
export const PROV_EN = {
  110000: 'Beijing', 120000: 'Tianjin', 130000: 'Hebei', 140000: 'Shanxi', 150000: 'Inner Mongolia',
  210000: 'Liaoning', 220000: 'Jilin', 230000: 'Heilongjiang', 310000: 'Shanghai', 320000: 'Jiangsu',
  330000: 'Zhejiang', 340000: 'Anhui', 350000: 'Fujian', 360000: 'Jiangxi', 370000: 'Shandong',
  410000: 'Henan', 420000: 'Hubei', 430000: 'Hunan', 440000: 'Guangdong', 450000: 'Guangxi',
  460000: 'Hainan', 500000: 'Chongqing', 510000: 'Sichuan', 520000: 'Guizhou', 530000: 'Yunnan',
  540000: 'Tibet', 610000: 'Shaanxi', 620000: 'Gansu', 630000: 'Qinghai', 640000: 'Ningxia',
  650000: 'Xinjiang', 710000: 'Taiwan', 810000: 'Hong Kong', 820000: 'Macao'
}

// 要逐个拉地级单元的省（排除 4 直辖市与港澳台 —— 它们下面直接是县区，没有「地级市」这一层）
export const ADM2_PROVINCES = [
  130000, 140000, 150000, 210000, 220000, 230000, 320000, 330000, 340000, 350000,
  360000, 370000, 410000, 420000, 430000, 440000, 450000, 460000, 510000, 520000,
  530000, 540000, 610000, 620000, 630000, 640000, 650000
]

// 自治州命名里出现即截断的民族关键字（取其前缀作简称）。★ '蒙古' 必须排在 '蒙古族' 后面，
// 否则「内蒙古」会被切成「内」——省级不走这条路，但自治州里同样有先长后短的坑（哈萨克 vs 哈萨克族）。
const ETHNIC = ['维吾尔', '哈萨克', '柯尔克孜', '蒙古族', '蒙古', '藏族', '回族', '彝族', '苗族', '侗族',
  '白族', '傣族', '景颇族', '傈僳族', '壮族', '布依族', '土家族', '朝鲜族', '羌族', '纳西族',
  '拉祜族', '佤族', '哈尼族', '黎族', '满族']

// 地级：中文简称
export function cityShort(n) {
  if (n === '海南藏族自治州') return '海南州'                 // 与海南省区分
  if (n.endsWith('盟')) return n                              // 兴安盟 / 锡林郭勒盟 / 阿拉善盟保留
  if (n.endsWith('林区')) return n.replace(/林区$/, '')        // 神农架林区 → 神农架
  if (n.includes('自治州')) {
    let cut = n.length
    for (const e of ETHNIC) { const i = n.indexOf(e); if (i >= 0 && i < cut) cut = i }
    return n.slice(0, cut)
  }
  return n.replace(/地区$/, '').replace(/市$/, '')
}

// 「并入相邻、不标注」的单元：所有省直辖县级(adcode%100≠0，如新疆兵团师市 / 海南直管县 / 湖北仙桃潜江天门神农架)
//   + REMOVE 里点名的地级市。它们照常参与算边（边界要正确溶解/扩张），只是不出名字、领地并进邻居。
// 410600 鹤壁市：与安阳几乎垂直重叠，按用户此前的要求并掉。
const REMOVE = new Set([410600])
export const isMerged = (ad) => REMOVE.has(ad) || ad % 100 !== 0

// 拉全部地级单元（含要并掉的）
export async function fetchPrefectures() {
  const out = []
  for (const ad of ADM2_PROVINCES) {
    const j = await datavFull(ad)
    for (const f of j.features) {
      const p = f.properties
      if (!p || !f.geometry || p.adcode == null) continue
      out.push({ adcode: p.adcode, prov: ad, name: p.name, center: p.center, centroid: p.centroid, geometry: f.geometry })
    }
  }
  return out
}

// 归并：从保留的地级市向内泛洪。被并单元按「与各已定组的共享边界总长」选最长者并入，
// 逐轮传播 → 被其他被并单元包住的县级（如海南岛内部）最终也能落到某个地级市。
// 返回 adcode → 归属地级市 adcode。
export function mergeGroups(feats, polysOf) {
  const ek = (a, b) => {
    const ka = a[0].toFixed(5) + ',' + a[1].toFixed(5), kb = b[0].toFixed(5) + ',' + b[1].toFixed(5)
    return ka < kb ? ka + '|' + kb : kb + '|' + ka
  }
  const segLen = (a, b) => { const cl = Math.cos((a[1] + b[1]) / 2 * Math.PI / 180); return Math.hypot((a[0] - b[0]) * cl, a[1] - b[1]) }
  const owners = new Map(), coord = new Map()
  for (const f of feats) for (const rings of polysOf(f.geometry)) for (const ring of rings)
    for (let i = 0; i + 1 < ring.length; i++) {
      const k = ek(ring[i], ring[i + 1])
      let arr = owners.get(k); if (!arr) { arr = []; owners.set(k, arr); coord.set(k, [ring[i], ring[i + 1]]) }
      arr.push(f.adcode)
    }
  const nbr = new Map()
  const add = (x, y, L) => { let m = nbr.get(x); if (!m) { m = new Map(); nbr.set(x, m) } m.set(y, (m.get(y) || 0) + L) }
  for (const [k, list] of owners) {
    if (list.length < 2) continue
    const [a, b] = coord.get(k), L = segLen(a, b)
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++)
      if (list[i] !== list[j]) { add(list[i], list[j], L); add(list[j], list[i], L) }
  }
  const g = new Map()
  for (const f of feats) if (!isMerged(f.adcode)) g.set(f.adcode, f.adcode)
  for (let round = 0; round < 12; round++) {
    let changed = false
    for (const f of feats) {
      if (g.has(f.adcode)) continue
      const nb = nbr.get(f.adcode); if (!nb) continue
      const tally = new Map()
      for (const [n, L] of nb) { const t = g.get(n); if (t != null) tally.set(t, (tally.get(t) || 0) + L) }
      let best = null, bl = -1
      for (const [t, l] of tally) if (l > bl) { bl = l; best = t }
      if (best != null) { g.set(f.adcode, best); changed = true }
    }
    if (!changed) break
  }
  return g
}

// 地级市英文名。NE 10m populated_places 的 NAME_ZH↔NAME 能对上 238/332，但里头有明显错项
// （邢台 Xiangtai、沈阳 Shenyeng、牡丹江 Mudangiang、滨州 Buizhou、昭通 Zhaotang、宣城 Xuanzhou…），
// 且对不上的 94 个全是盟/自治州/新设市。故本表【优先】：先查这里，再退 NE，最后回落中文。
// 少数民族地区用通行的音译写法（Ordos / Xilingol / Garzê / Ngari / Bortala …），不硬套汉语拼音。
export const CITY_EN = {
  // NE 给错或写法过时的
  邢台: 'Xingtai', 沈阳: 'Shenyang', 营口: 'Yingkou', 淮安: 'Huaian', 牡丹江: 'Mudanjiang',
  滨州: 'Binzhou', 昭通: 'Zhaotong', 宣城: 'Xuancheng',
  西安: "Xi'an", 吉安: "Ji'an", 泰安: "Tai'an", 六安: "Lu'an",
  // NE 里没有的
  晋中: 'Jinzhong', 运城: 'Yuncheng', 吕梁: 'Lüliang',
  鄂尔多斯: 'Ordos', 呼伦贝尔: 'Hulunbuir', 巴彦淖尔: 'Bayannur', 乌兰察布: 'Ulanqab',
  兴安盟: 'Hinggan', 锡林郭勒盟: 'Xilingol', 阿拉善盟: 'Alxa',
  盘锦: 'Panjin', 葫芦岛: 'Huludao', 延边: 'Yanbian', 大兴安岭: 'Da Hinggan Ling',
  宿迁: 'Suqian', 舟山: 'Zhoushan', 台州: 'Taizhou',
  黄山: 'Huangshan', 滁州: 'Chuzhou', 亳州: 'Bozhou', 池州: 'Chizhou',
  宁德: 'Ningde', 景德镇: 'Jingdezhen', 鹰潭: 'Yingtan', 抚州: 'Fuzhou',
  东营: 'Dongying', 三门峡: 'Sanmenxia', 驻马店: 'Zhumadian',
  鄂州: 'Ezhou', 黄冈: 'Huanggang', 咸宁: 'Xianning', 随州: 'Suizhou', 恩施: 'Enshi',
  张家界: 'Zhangjiajie', 怀化: 'Huaihua', 娄底: 'Loudi', 湘西: 'Xiangxi',
  汕尾: 'Shanwei', 中山: 'Zhongshan', 揭阳: 'Jieyang', 云浮: 'Yunfu',
  防城港: 'Fangchenggang', 贵港: 'Guigang', 百色: 'Baise', 贺州: 'Hezhou', 来宾: 'Laibin', 崇左: 'Chongzuo',
  三沙: 'Sansha', 儋州: 'Danzhou',
  眉山: 'Meishan', 广安: "Guang'an", 达州: 'Dazhou', 巴中: 'Bazhong', 资阳: 'Ziyang',
  阿坝: 'Aba', 甘孜: 'Garzê', 凉山: 'Liangshan',
  毕节: 'Bijie', 黔西南: 'Qianxinan', 黔东南: 'Qiandongnan', 黔南: 'Qiannan',
  曲靖: 'Qujing', 普洱: "Pu'er", 临沧: 'Lincang', 红河: 'Honghe', 西双版纳: 'Xishuangbanna',
  德宏: 'Dehong', 怒江: 'Nujiang', 迪庆: 'Dêqên',
  山南: 'Shannan', 阿里: 'Ngari',
  延安: "Yan'an", 商洛: 'Shangluo',
  白银: 'Baiyin', 酒泉: 'Jiuquan', 庆阳: 'Qingyang', 定西: 'Dingxi', 陇南: 'Longnan', 甘南: 'Gannan',
  海东: 'Haidong', 海北: 'Haibei', 黄南: 'Huangnan', 海南州: 'Hainan Prefecture',
  果洛: 'Golog', 玉树: 'Yushu', 海西: 'Haixi',
  吴忠: 'Wuzhong', 固原: 'Guyuan', 中卫: 'Zhongwei',
  哈密: 'Hami', 昌吉: 'Changji', 博尔塔拉: 'Bortala', 巴音郭楞: 'Bayingolin',
  克孜勒苏: 'Kizilsu', 伊犁: 'Ili'
}
