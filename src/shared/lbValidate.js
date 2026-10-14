// 链路预算 · 数值字段校验（逐格标红与计算前预校验共用一处口径）。
//
// 字段 schema（linkbudget/params.js、ngso/ngsoParams.js、regen/regenParams.js、e2e/e2eParams.js）里
// type:'num' 的字段可带范围：
//   min / max   闭区间端点（数值，单位 = 该字段 unit）
//   minEx:true  下界开区间（> min，如功率、带宽、口径类「必须为正」）
// 没写范围的字段只查「是不是数」。
//
// 口径：
//   · 空（'' / 纯空白 / null / undefined）＝合法，按缺省算——与引擎「留空 → 缺省」同一条路；
//   · 数值语法与引擎严格解析逐字相同（shared/num.js 的 numStrict ⇔ packages/core/utils/strictNum.js）：
//     允许前后空白、全角数字（先转半角）、科学计数；「36 MHz」「12,5」「1.2.3」一律「不是数值」；
//   · msg 只陈述状态（「不是数值」「超出范围 0.1–100」），不写教学从句（CLAUDE.md）。
//
// 用法：
//   validateValue(field, raw)        → null | { msg, code: 'nan' | 'range', range }
//   validateRows(fields, rows)       → [{ row, id, key, label, value, msg }]   row = 0 起的行下标，id = 行 _id
//   validateForm(fields, form)       → [{ key, label, value, msg }]            资源库表单（卫星 / 载波 / 地球站配置）
//   rangeText(field) / rangeTitle(field) → '0.1–100' / '0.1–100 GHz'（悬停 title 用）
import { numStrict } from './num.js'

const isNumField = (f) => !!f && f.type === 'num' && !f.ro
const hasMin = (f) => typeof f.min === 'number' && Number.isFinite(f.min)
const hasMax = (f) => typeof f.max === 'number' && Number.isFinite(f.max)

// 范围文本（不带单位）：两端闭 '0.1–100'；下界开 '(0, 100]'；单边 '> 0' / '≥ 0' / '≤ 100'；无范围 ''
export function rangeText(f) {
  if (!f) return ''
  const lo = hasMin(f), hi = hasMax(f)
  if (lo && hi) return f.minEx ? `(${f.min}, ${f.max}]` : `${f.min}–${f.max}`
  if (lo) return (f.minEx ? '> ' : '≥ ') + f.min
  if (hi) return '≤ ' + f.max
  return ''
}
// 范围文本带单位：'0.1–100 GHz'（字段口径，放悬停 title）
export function rangeTitle(f) {
  const r = rangeText(f)
  if (!r) return ''
  return f.unit ? r + ' ' + f.unit : r
}
export function inRange(f, n) {
  if (hasMin(f) && (f.minEx ? !(n > f.min) : !(n >= f.min))) return false
  if (hasMax(f) && !(n <= f.max)) return false
  return true
}

/**
 * 校验一格。非数值字段 / 计算列一律 null。
 * @returns {null | { msg: string, code: 'nan' | 'range', range: string }}
 */
export function validateValue(field, raw) {
  if (!isNumField(field)) return null
  const n = numStrict(raw)
  if (n === null) return null                                   // 留空＝按缺省
  if (Number.isNaN(n)) return { msg: '不是数值', code: 'nan', range: rangeTitle(field) }
  if (!inRange(field, n)) return { msg: `超出范围 ${rangeText(field)}`, code: 'range', range: rangeTitle(field) }
  return null
}

// 格的悬停 title：'不是数值 · 0.1–100 GHz' / '超出范围 0.1–100 GHz'（范围带单位）
export function invalidTitle(field, res) {
  if (!res) return ''
  if (res.code === 'range') return `超出范围 ${res.range || rangeText(field)}`
  return res.range ? res.msg + ' · ' + res.range : res.msg
}

/**
 * 校验整表。只看 type:'num' 的非计算列；返回坏格清单（按行序、列序）。
 * @param {object[]} fields 表的列（StationGrid 的 fields）
 * @param {object[]} rows   行数据
 * @returns {{ row: number, id: string|undefined, key: string, label: string, value: *, msg: string }[]}
 */
export function validateRows(fields, rows) {
  const out = []
  const nf = (fields || []).filter(isNumField)
  if (!nf.length) return out
  ;(rows || []).forEach((r, i) => {
    if (!r) return
    for (const f of nf) {
      const res = validateValue(f, r[f.key])
      if (res) out.push({ row: i, id: r._id, key: f.key, label: f.label, value: r[f.key], msg: res.msg })
    }
  })
  return out
}

/** 校验一份表单（资源库条目：卫星 / 载波 / 地球站配置）。 */
export function validateForm(fields, form) {
  const out = []
  if (!form) return out
  for (const f of (fields || [])) {
    if (!isNumField(f)) continue
    const res = validateValue(f, form[f.key])
    if (res) out.push({ key: f.key, label: f.label, value: form[f.key], msg: res.msg })
  }
  return out
}
