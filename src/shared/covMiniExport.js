// 覆盖快照 →「发送到小程序 · 卫星覆盖」：目标卫星候选 / 目标解析 / 投递单元（名称与幂等键）/
// 自定义目标星的记忆（渲染端 ESM；星座3D 页用）。
//
// 快照本身由 3D 页的 buildMiniappSnapshot 攒（它要读画面状态）；本模块只管与画面无关的那一半，
// 零依赖 DOM —— packages/core 的 Node 测试直接 import 得动（test/covMiniExport.test.mjs）。
//
// 「目标卫星」决定这份覆盖在小程序里挂在哪颗星下（那边的波束按 satelliteName 归类显示）。候选分两段：
//   ① 小程序内置 —— 小程序「卫星覆盖」页那 24 颗，顺序照抄（miniSatList.js 的镜像）；
//   ② 自定义     —— 画面里的星（不在那 24 颗里的）+ 发送成功过的自定义星（最近的在前）+「手动指定…」。
// ★ 自定义段的星，小程序收到后先按名称（忽略大小写 / 空格 / 连字符）找本地已有的卫星，找不到才按
//   送过去的轨位登记成它自己的「自定义卫星」（那边的 _ensureSatName）。故手动指定时名称要与手机上
//   那颗对得上才会归到一起；轨位只在新建那一下用得上。
import { MINI_COVERAGE_SATS, satKey, inMiniList } from './miniSatList.js'
import { fmtGeoSlot } from './orbitClass.js'
import { byLang } from './i18n/lang.js'

/** 「手动指定…」那一项的取值（星名里不会出现） */
export const MANUAL = '__manual__'
/** 记住的自定义目标星上限（下拉里的一段，太长就成了负担） */
export const CUSTOM_MAX = 12

const numOrNaN = (x) => (x == null || String(x).trim() === '' ? NaN : Number(x))

/** 轨位归一到 [-180, 180)：输入认 0–360 的写法（250 即 110°W），发出去一律带符号 */
export const normLon = (x) => ((x % 360) + 540) % 360 - 180

/**
 * 下拉候选。每项 { value, label, lon, group, vals }：vals 是选中它时顺带写进「卫星名称 / 轨道位置」
 * 两格的值（见 MiniSendDialog 的 withVals），于是切到「手动指定」时两格里就是刚才那颗星。
 * @param {object} o
 * @param {Array} o.beams      快照里的波束（取 satName / lon，即画面里的星）
 * @param {Array} o.customs    记住的自定义目标星 [{ name, lon }]
 * @param {object} o.groups    { builtin, custom } 两段的分组名（<optgroup> 的 label 是属性，呈现层翻不到，由调用方按语言给）
 * @param {string} o.manualLabel 「手动指定…」的显示文字
 */
export function targetOptions({ beams = [], customs = [], groups = {}, manualLabel = '手动指定…' } = {}) {
  const opt = (name, lon, group) => {
    const ok = Number.isFinite(lon)
    return { value: name, label: ok ? `${name}（${fmtGeoSlot(lon)}）` : name, lon: ok ? lon : null, group, vals: { satName: name, satLon: ok ? String(lon) : '' } }
  }
  const gIn = groups.builtin || '', gCu = groups.custom || ''
  const custom = []
  const seen = new Set()
  const add = (raw, lon) => {
    const n = String(raw || '').trim()
    if (!n || seen.has(satKey(n)) || inMiniList(n)) return
    seen.add(satKey(n))
    custom.push(opt(n, lon, gCu))
  }
  for (const b of beams || []) add(b && b.satName, numOrNaN(b && b.lon))
  for (const s of customs || []) add(s && s.name, numOrNaN(s && s.lon))
  custom.push({ value: MANUAL, label: manualLabel, lon: null, group: gCu })
  return [...MINI_COVERAGE_SATS.map((s) => opt(s.name, s.lon, gIn)), ...custom]
}

/** 默认选中画面里那颗星：在内置里就选内置那项（最常见），否则选自定义段里它那一项；画面里没有星名就选第一项 */
export function defaultTarget(beams, options) {
  const bs = beams || []
  for (const b of bs) {
    const hit = MINI_COVERAGE_SATS.find((s) => satKey(s.name) === satKey(b && b.satName))
    if (hit) return hit.name
  }
  for (const b of bs) { const n = String((b && b.satName) || '').trim(); if (n) return n }
  return options && options.length ? options[0].value : ''
}

/** 选值 → 目标星 { satName, satLon }。列表里的项取它自带的轨位；手动指定取两格里的原文（轨位归一到 ±180） */
export function resolveTarget(picked, options) {
  const v = String((picked && picked.sat) || '')
  if (v === MANUAL) {
    const lon = numOrNaN(picked.satLon)
    return { satName: String(picked.satName || '').trim(), satLon: Number.isFinite(lon) ? normLon(lon) : null }
  }
  const hit = (options || []).find((o) => o.value === v)
  return { satName: v.trim(), satLon: hit && hit.lon != null ? hit.lon : null }
}

/** 自动名：「<星名> 覆盖」。是数据（要发到手机上），呈现层翻不到，故按语言现出字 */
export const autoCovName = (satName) => byLang(`${satName} 覆盖`, `${satName} coverage`)

/**
 * 投递单元（交给 MiniSendDialog 的整块载荷形态）。
 * @param {object} base     buildMiniappSnapshot() 的结果（不改它，外层浅拷一份再换字段）
 * @param {object} target   resolveTarget 的结果
 * @param {string} userName 用户在清单里改过的名称（'' = 没改过）
 */
export function covUnit(base, target, userName) {
  const satName = (target && target.satName) || ''
  const auto = satName ? autoCovName(satName) : base.name
  const name = String(userName || '').trim() || auto
  // 名称同时写进快照本身：密钥导入那条路（小程序那边没另填名字时）取的是 snap.name
  const raw = { ...base, name, createdAt: Date.now() }
  if (satName) raw.target = { satName, satLon: target.satLon != null && Number.isFinite(target.satLon) ? target.satLon : null }
  return {
    name,
    raw,
    label: '覆盖图',
    // 幂等键 = 目标星 + 名称：同星同名重发即更新手机上那一份；改了名就是另一份，于是同一颗星下可以
    // 并存多份覆盖（EIRP 与 G/T、不同波束）。没改过名的仍是老格式 'gxt:<星名>' —— 此前发过的那一份
    // 照旧被覆盖，不会在手机上多出一份。
    sync: 'gxt:' + (satName || base.name || '覆盖快照') + (name !== auto ? '|' + name : '')
  }
}

/** 解析 localStorage 里记住的自定义目标星（坏数据逐条丢弃） */
export function parseCustoms(text) {
  let a
  try { a = JSON.parse(text || '[]') } catch { return [] }
  return (Array.isArray(a) ? a : [])
    .map((s) => ({ name: String((s && s.name) || '').trim(), lon: numOrNaN(s && s.lon) }))
    .filter((s) => s.name && Number.isFinite(s.lon))
    .slice(0, CUSTOM_MAX)
}

/**
 * 发送成功后记住非内置的目标星：放到最前、按名称去重、封顶 CUSTOM_MAX。
 * 内置星与没有轨位的不记（前者本来就在列表里，后者下次选了也发不全）。返回新表；不需要记时返回 null。
 */
export function rememberTarget(list, target) {
  const satName = String((target && target.satName) || '').trim()
  const lon = target ? numOrNaN(target.satLon) : NaN
  if (!satName || inMiniList(satName) || !Number.isFinite(lon)) return null
  const k = satKey(satName)
  return [{ name: satName, lon }, ...(list || []).filter((s) => satKey(s.name) !== k)].slice(0, CUSTOM_MAX)
}
