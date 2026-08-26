// 视角登记表 —— 新增一套视角只改这一个文件（一条 import + 一条登记），解算器与设置页都不动。
//
// 六套预设的 own 表由 scripts/build-basemap.mjs 从 Natural Earth 自带的 32 套官方归属列生成，
// 不是手写的：NE 对每个面都标了「在某国出版物里这块地算谁的」（ADM0_A3_CN / ADM0_ISO / ADM0_A3_US …），
// 本平台取其中六套。★ 台湾/港澳三个单元在生成时就被剔除，任何视角表里都不会出现它们（见 frozen.js 的红线）。
import CN from './povs/CN.json' with { type: 'json' }
import ISO from './povs/ISO.json' with { type: 'json' }
import US from './povs/US.json' with { type: 'json' }
import IN from './povs/IN.json' with { type: 'json' }
import JP from './povs/JP.json' with { type: 'json' }
import RU from './povs/RU.json' with { type: 'json' }

export const POV_FILES = { CN, ISO, US, IN, JP, RU }
export const DEFAULT_POV = 'CN'
// 'custom' 不是一套视角表，而是「在 own0（NE 默认归属）之上只叠用户覆写」
export const CUSTOM_POV = 'custom'

// 下拉里的顺序与名字（中国视角在最前、默认选中）
export const POV_META = [
  ...Object.values(POV_FILES).map((p) => ({ id: p.id, zh: p.name_zh, en: p.name_en })),
  { id: CUSTOM_POV, zh: '自定义', en: 'Custom' }
]

// 取某个视角的归属表。★ 'custom'（以及任何不认识的 id）以【中国视角】为底 —— 只叠用户覆写。
// 不这么做的话，切到「自定义」会连南海十段线一起没了（那条线由视角表的 lines.claim 声明）。
export const povTableOf = (id) => POV_FILES[id] || POV_FILES[DEFAULT_POV]

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
