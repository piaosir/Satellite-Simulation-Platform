// 星座 →「发送到小程序 · 星座地图」的载荷（渲染端 ESM；星座3D 页用）。
//
// 三类内容打成同一种「卫星集」件（type='sat-set'），落到小程序星座地图的分组列表里各成一行：
//   · 卫星组     —— 平台侧只存 NORAD 清单，发送前按号解析成根数（见页面 satGroupRecordMap）
//   · 自定义卫星 —— 「文件管理 · 星历」导入的每一个组（本就是 OMM 记录）
//   · 自定义星座 —— Walker 合成星（customConstellationsToOmmRecords 展开，历元=场景历元）
//
// ★ 送的是【OMM 根数本身】，不是 NORAD 清单。理由：小程序那边照 omm2satrec 直接建 satrec 渲染，
//   零联网、与本机看到的是同一批根数；若只送编号，对方得先把 5MB 的 active 全集拉下来才认得出，
//   而自定义卫星/合成星根本不在任何目录里，编号在那边什么都对不上。
//   代价是诚实的：历元定格在发送这一刻，真实目录星会随时间变旧 —— 重发即按 setId 覆盖同一份。
//
// ★★ 字段名两边逐字相同（name/noradId/epoch/meanMotion/ecc/incl/raan/argp/ma/bstar/mdot/mddot）：
//    平台 viz/constellation/tle.js 的 parseOMMCsv 与小程序 utils/tleStore.js 的 parseOMMCsv 是同一份
//    解析器的两个副本，omm2satrec 也是同一份。故这里【原样保字符串】，不做数值化/四舍五入 ——
//    转一道数就可能让两边的 satrec 不再逐位一致，那正是这套东西唯一值得保证的性质。
//
// ★★★ 体积：一条记录约 210 B，1000 颗 ≈ 210 KB。单件上限由 miniPack 的 SIZE_MAX(900 KB) 把关
//    （绑定投递按件判、密钥模式按整包判），此处不再自设截断 —— 无声截断比报错难查得多。

export const SATSET_TYPE = 'sat-set'

/** 三类来源的显示名（发送弹窗清单的类型列 + 小程序侧列表的来源标） */
export const SATSET_SRC = { group: '卫星组', custom: '自定义卫星', walker: '自定义星座' }

const S = (v) => String(v == null ? '' : v)

// setId 是幂等键的一部分，最终会当 wx storage 的键名后缀用 —— 收紧到 [A-Za-z0-9_-]。
// 平台三处 id 生成器（sg…/g…/cc…）本就只出字母数字，这里是防线不是转换。
const safeId = (s) => S(s).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48)

/**
 * OMM 记录瘦身：只留 omm2satrec 真正会读的那几列，值原样保字符串。
 * 缺历元 / 缺平均运动的记录构不出 satrec，直接丢（返回 null）。
 */
export function trimOmm(r) {
  if (!r || r.noradId == null || r.noradId === '') return null
  const epoch = S(r.epoch), meanMotion = S(r.meanMotion)
  if (!epoch || !meanMotion) return null
  const out = {
    name: S(r.name) || ('NORAD ' + S(r.noradId)),
    noradId: S(r.noradId),
    epoch,
    meanMotion,
    ecc: S(r.ecc) || '0',
    incl: S(r.incl) || '0',
    raan: S(r.raan) || '0',
    argp: S(r.argp) || '0',
    ma: S(r.ma) || '0',
    bstar: S(r.bstar) || '0',
    mdot: S(r.mdot) || '0',
    mddot: S(r.mddot) || '0'
  }
  const oid = S(r.objectId)
  if (oid) out.objectId = oid   // 只在有值时占位（COSPAR 号不参与解算，纯展示）
  return out
}

/**
 * 造一件「卫星集」。记录为空则返回 null（调用方 filter(Boolean) 掉）。
 * @param {object} o
 *   srcKind  'group' | 'custom' | 'walker'
 *   id       平台侧该条目的 id（卫星组 id / 导入组 id / 自定义星座 id）
 *   name     显示名
 *   records  OMM 记录数组（任意顺序，内部按 NORAD 去重，后者覆盖）
 *   epochMode 'file'（各记录自带历元）| 'scenario'（合成星，历元=场景历元）
 *   epoch    epochMode='scenario' 时的场景历元 ISO（展示用）
 */
export function makeSatSetItem({ srcKind, id, name, records, epochMode, epoch } = {}) {
  const prefix = srcKind === 'custom' ? 'cs' : srcKind === 'walker' ? 'cc' : 'sg'
  const setId = prefix + '_' + safeId(id)
  const map = new Map()
  for (const r of (Array.isArray(records) ? records : [])) {
    const t = trimOmm(r)
    if (t) map.set(t.noradId, t)
  }
  const sats = [...map.values()]
  if (!sats.length) return null
  const src = SATSET_SRC[srcKind] || SATSET_SRC.group
  return {
    type: SATSET_TYPE,
    label: src,                                   // 发送弹窗清单的类型列（见 miniPack.unitsOfPack）
    name: S(name).trim() || src,
    setId,
    src,
    epochMode: epochMode === 'scenario' ? 'scenario' : 'file',
    epoch: epochMode === 'scenario' ? S(epoch) : '',
    count: sats.length,
    sats
  }
}
