// 主权解算的【冻结常量】—— 解算器最外层，任何视角、任何用户覆写都改不动。
//
// ★ 红线：台湾、香港、澳门，以及南海诸岛（西沙 PFA / 南沙 PGA / 中沙黄岩岛 SCR）与钓鱼岛（JP-SEN）
//   的主权归属一律是中国。
//   它不是数据文件里的一条可改项，而是 povResolver.ownerOf() 优先级链最前面那一环：
//     owner = FROZEN[u] ?? userOverride[u] ?? pov.own[u] ?? baseOwner[u]
//   视角文件 src/viz/geo/povs/*.json 的 own 表里不许出现这些键（构建脚本会剔除），
//   可自定义争议区清单 CUSTOMIZABLE_DISPUTES 里也不许出现（UI 因此拿不到这个开关）。
//   这几条由 packages/core/test/povInvariants.test.mjs 逐条守住。
// ★ 岛礁四个单元进红线的缘由：Natural Earth 把黄岩岛、南沙各造成一个「自己归自己」的独立单元
//   （own0 = SCR / PGA），四套视角列里只有中国视角对南沙表了态、对黄岩岛谁都没表态 ——
//   不冻结的话，黄岩岛在【每一套视角、包括中国视角】下都会以独立实体的身份被标成一个国家名、
//   进国家清单、被点选成「黄岩岛」；南沙在 ISO / 美 / 俄视角下同样如此，西沙在美 / 俄视角下判成争议，
//   钓鱼岛在中国视角以外归日本。本平台的立场是中国官方地图的立场：这几块不是可切换的视角差异，
//   与台港澳同列红线，任何视角都不再表达别的归属。
export const FROZEN = {
  'CN-TW': 'CHN', 'CN-HK': 'CHN', 'CN-MO': 'CHN',
  PFA: 'CHN', PGA: 'CHN', SCR: 'CHN', 'JP-SEN': 'CHN'
}

// 老存档迁移用：这三个 ISO3 在本平台恒折算成 CHN（与 FROZEN 里三个 ISO 3166 单元一一对应）。
// 「逐国大地颜色」的键从 ISO 数字码换成 ISO3 时要过一遍，见 src/viz/landPalette.js。
// 岛礁四个单元没有 ISO 数字码、也不再可能成为归属，老存档里若以 SCR / PGA 作键则整条丢弃（同见 landPalette）。
export const FROZEN_ISO3 = { TWN: 'CHN', HKG: 'CHN', MAC: 'CHN' }

// 可自定义争议区：设置页「地图视角 → 自定义」展开的那张表。
//   key    覆写分组键（UI 存的就是它，写回时展开成 units 里的逐个单元覆写）
//   zh     侧栏那一列的显示名，最多五个字（列宽只有这么多）；写不下的把全称放 full，由 title 兜住
//   units  该分组包含的底图单元 id（basemap-*.json 的 units[].properties.u）；某档没有的单元自动忽略
//   opts   可选归属，值域同 own：<ISO3> | 'disputed' 争议 | 'none' 不显示
//
// ★ 只收【陆地归属】争议。岛礁与海上主张（南千岛、独岛）不进这张表 —— 它们只随视角走，不开放逐项自定义。
// ★ 台湾 / 港澳、南海诸岛、钓鱼岛一个都不在这张表里，见文件头的红线。
export const CUSTOMIZABLE_DISPUTES = [
  { key: 'kashmir', zh: '克什米尔', full: '克什米尔（印巴）', en: 'Kashmir (India–Pakistan)', units: ['IN-PK-KAS', 'PK-AZK', 'PK-GB', 'KAS', 'KAS-SIA'], opts: ['IND', 'PAK', 'disputed'] },
  { key: 'aksai-chin', zh: '阿克赛钦', en: 'Aksai Chin', units: ['CN-AKS', 'CN-SHK'], opts: ['CHN', 'IND', 'disputed'] },
  { key: 'arunachal', zh: '藏南', full: '藏南（阿鲁纳恰尔）', en: 'South Tibet / Arunachal Pradesh', units: ['IN-ARP', 'IN-CN-DMC', 'IN-CN-SMD', 'IN-CN-TRP', 'IN-CN-BRH'], opts: ['CHN', 'IND', 'disputed'] },
  { key: 'crimea', zh: '克里米亚', en: 'Crimea', units: ['UA-CR'], opts: ['UKR', 'RUS', 'disputed'] },
  { key: 'donbas', zh: '顿巴斯', en: 'Donbas', units: ['UA-DPR', 'UA-LPR'], opts: ['UKR', 'RUS', 'disputed'] },
  { key: 'western-sahara', zh: '西撒哈拉', en: 'Western Sahara', units: ['MA-EH', 'SAH', 'EH-SADR'], opts: ['MAR', 'SAH', 'disputed'] },
  { key: 'kosovo', zh: '科索沃', en: 'Kosovo', units: ['KOS'], opts: ['KOS', 'SRB', 'disputed'] },
  { key: 'golan', zh: '戈兰高地', en: 'Golan Heights', units: ['IL-GOL'], opts: ['ISR', 'SYR', 'disputed'] },
  { key: 'abyei', zh: '阿卜耶伊', en: 'Abyei', units: ['SD-ABY'], opts: ['SDN', 'SDS', 'disputed'] },
  { key: 'n-cyprus', zh: '北塞浦路斯', en: 'Northern Cyprus', units: ['CYN', 'CNM'], opts: ['CYN', 'CYP', 'disputed'] },
  { key: 'somaliland', zh: '索马里兰', en: 'Somaliland', units: ['SOL'], opts: ['SOL', 'SOM', 'disputed'] },
  { key: 'south-ossetia', zh: '南奥塞梯', en: 'South Ossetia', units: ['GE-SO'], opts: ['GEO', 'disputed'] },
  { key: 'abkhazia', zh: '阿布哈兹', en: 'Abkhazia', units: ['GE-AB'], opts: ['GEO', 'disputed'] },
  { key: 'transnistria', zh: '德涅斯特', full: '德涅斯特河沿岸', en: 'Transnistria', units: ['MD-TRA'], opts: ['MDA', 'disputed'] },
  { key: 'artsakh', zh: '纳卡地区', full: '纳戈尔诺-卡拉巴赫', en: 'Nagorno-Karabakh', units: ['AZ-ART'], opts: ['AZE', 'disputed'] },
  { key: 'essequibo', zh: '埃塞奎博', en: 'Essequibo', units: ['GY-ESSEQUIBO'], opts: ['GUY', 'VEN', 'disputed'] }
]

// 归属值的中文名（争议区下拉的选项文案）。只收 CUSTOMIZABLE_DISPUTES 的 opts 里出现的那些码。
export const OWNER_ZH = {
  CHN: '中国', IND: '印度', PAK: '巴基斯坦', UKR: '乌克兰', RUS: '俄罗斯',
  MAR: '摩洛哥', SAH: '西撒哈拉', KOS: '科索沃', SRB: '塞尔维亚', ISR: '以色列', SYR: '叙利亚',
  SDN: '苏丹', SDS: '南苏丹', CYN: '北塞浦路斯', CYP: '塞浦路斯', SOL: '索马里兰', SOM: '索马里',
  GEO: '格鲁吉亚', MDA: '摩尔多瓦', AZE: '阿塞拜疆', GUY: '圭亚那', VEN: '委内瑞拉',
  disputed: '争议', none: '不显示'
}

// key → units 展开（UI 只认分组 key，解算器只认 unit）。
// 'none'（不显示）不在各组的 opts 里，但它对每一组都合法 —— 那是「当这块叠加不存在」的通用档。
export function expandOverrides(byKey) {
  const out = {}
  if (!byKey || typeof byKey !== 'object') return out
  for (const g of CUSTOMIZABLE_DISPUTES) {
    const v = byKey[g.key]
    if (!v || !(g.opts.includes(v) || v === 'none')) continue
    for (const u of g.units) if (!FROZEN[u]) out[u] = v
  }
  return out
}
