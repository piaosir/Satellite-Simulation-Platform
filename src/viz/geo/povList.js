// 视角登记表 —— 新增一套视角只改这一个文件（一条 import + 一条登记），解算器与设置页都不动。
//
// 预设的 own 表由 scripts/build-basemap.mjs 从 Natural Earth 自带的 32 套官方归属列生成，
// 不是手写的：NE 对每个面都标了「在某国出版物里这块地算谁的」（ADM0_A3_CN / ADM0_ISO / ADM0_A3_US …），
// 本平台取其中四套。★ 台湾/港澳三个单元在生成时就被剔除，任何视角表里都不会出现它们（见 frozen.js 的红线）。
import CN from './povs/CN.json' with { type: 'json' }
import ISO from './povs/ISO.json' with { type: 'json' }
import US from './povs/US.json' with { type: 'json' }
import RU from './povs/RU.json' with { type: 'json' }

export const POV_FILES = { CN, ISO, US, RU }
export const DEFAULT_POV = 'CN'
// 'custom' 不是一套视角表，而是「在 own0（NE 默认归属）之上只叠用户覆写」
export const CUSTOM_POV = 'custom'

// 下拉里的顺序与名字（中国视角在最前、默认选中）
export const POV_META = [
  ...Object.values(POV_FILES).map((p) => ({ id: p.id, zh: p.name_zh, en: p.name_en })),
  { id: CUSTOM_POV, zh: '自定义', en: 'Custom' }
]

// 归属码规范化 —— NE 的 32 套视角列里混着一批「同一个实体的另一个内部码」和「无公认主权方」的占位码，
// 它们既不是底图单元用的 SU_A3，也不都是 ISO 3166-1 实体，直接当归属用会造出一批假国家：
//   · ISO 视角把葡萄牙记成 PR1、苏丹 SDZ、南苏丹 SSD、巴新 PN1 —— 与底图本体的 PRT/SDN/SDS/PNG 对不上，
//     于是「葡萄牙」「苏丹」「南苏丹」在 ISO 视角下查不到中文名，整个从地图和国家清单里消失；
//   · 中国/俄罗斯视角把汉斯岛记成 DEN、美国视角把阿扎尔记成 GEA —— 与 DNK/GEO 不合并，
//     格陵兰北边和格鲁吉亚旁边会各多出一个同名标注；
//   · UUU 是 NE 的「未定」占位（德拉戈尼亚河口、杜梅拉岛），KOD/PFA 是独岛与西沙的争议占位 ——
//     它们表达的是「没有公认主权方」，语义就是 disputed，不是国家。
// ★ 只收「码不同、实体相同」与「占位码」两类。斯瓦尔巴 SJM、法属圭亚那 GUF、留尼汪 REU 这些不在此列：
//   它们是真实的 ISO 3166-1 实体，ISO 视角把它们从宗主国里拆出来正是那套视角的本意，各自有名字。
export const OWNER_ALIAS = {
  DEN: 'DNK',        // 丹麦（汉斯岛所属）
  GEA: 'GEO',        // 格鲁吉亚（阿扎尔所属）
  PN1: 'PNG',        // 巴布亚新几内亚
  PR1: 'PRT',        // 葡萄牙
  SDZ: 'SDN',        // 苏丹
  SSD: 'SDS',        // 南苏丹（底图单元用 SDS）
  KOD: 'disputed',   // 独岛 / 竹岛：无公认主权方
  PFA: 'disputed',   // 西沙群岛：本视角认定为争议
  UUU: 'disputed'    // NE 的「未定」占位
}
export const normOwner = (v) => (v && OWNER_ALIAS[v]) || v

// 取某个视角的归属表。★ 'custom'（以及任何不认识的 id）以【中国视角】为底 —— 只叠用户覆写。
// 不这么做的话，切到「自定义」会连南海十段线一起没了（那条线由视角表的 lines.claim 声明）。
export const povTableOf = (id) => POV_FILES[id] || POV_FILES[DEFAULT_POV]

// ★ 某套视角下「这个国家的国境一律按国界（实线）画，不出未定界虚线」。
//   中国官方地图就是这个画法：疆域按本视角的归属表算定之后，界就是界，不再留「未定」这个中间态
//   —— 中国视角下画着自家的未定界虚线，是自相矛盾的。
//   挂在视角上而不是写死给 CHN：换到 ISO / 美国 / 俄罗斯那几套视角，虚线照旧出。
export const POV_SOLID = { CN: 'CHN' }

export const MAP_POV_DEF = { id: DEFAULT_POV, overrides: {}, layers: { claim: true, loc: true, indefinite: true } }

// 设置里存的那一坨（{ id, overrides, layers }）→ 规整成可用值。
// overrides 的键是【争议区分组键】（frozen.js 的 CUSTOMIZABLE_DISPUTES[].key），不是单元 id ——
// 存分组键才稳：底图换版时单元 id 可能增删，分组键是人定的。
export function normMapPov(v) {
  const out = { id: DEFAULT_POV, overrides: {}, layers: { ...MAP_POV_DEF.layers } }
  if (!v || typeof v !== 'object') return out
  if (typeof v.id === 'string' && (POV_FILES[v.id] || v.id === CUSTOM_POV)) out.id = v.id
  if (v.overrides && typeof v.overrides === 'object') {
    for (const [k, o] of Object.entries(v.overrides)) if (typeof o === 'string' && o) out.overrides[k] = o
  }
  if (v.layers && typeof v.layers === 'object') {
    for (const k of ['claim', 'loc', 'indefinite']) if (typeof v.layers[k] === 'boolean') out.layers[k] = v.layers[k]
  }
  return out
}
