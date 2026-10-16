// 叠加星历（导入星历「对应已有卫星」）在渲染端 satPos 与 core orbitPos 两条取位路上必须逐位一致：
//   时段内用叠加表、多张时新导入的优先、时段外回落本体（SGP4 / 本体表）、定点星不叠加、Worker 只认戳。
// 同一张表分别装成 core 表（ephemInterp.buildTable）与渲染端表（ephemTable.tableFrom），同一批时刻对拍。
// 另：3D 页「对应已有卫星」的替身条目不进按号解析的来源（liveEntryOf / bodyEntryOf / 链路节点候选）、
//     信息栏组名跟改名走；导入 / 导出对话框与文件管理的几处修复（源码钉 + 从源码取出的纯函数）。

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { posAt, posAtMs, setOverlays, overlaysOf, overlayAt, stampOverlays, normId, propagatorLabel, validSpan, keepInRenderSet } from '../../../src/viz/constellation/satPos.js'
import { tableFrom } from '../../../src/viz/constellation/ephemTable.js'
import satR from '../../../src/viz/constellation/satellite.js'
import { createNoradResolver } from '../../../src/viz/grd/treeLink.js'

const require = createRequire(import.meta.url)
const OP = require('../utils/orbitPos.js')
const EI = require('../utils/ephemInterp.js')
const sat = require('../vendor/satellite.js')

let pass = 0, fail = 0
const ok = (c, m, x) => { if (c) pass++; else { fail++; console.error('  ✗ ' + m + (x !== undefined ? '\n      ' + x : '')) } }

const TLE = ['1 44067U 19012A   26280.97985421 -.00000351  00000+0  00000+0 0  9995', '2 44067   0.0554 298.8093 0012858 125.1382  75.8829  1.00270086 27879']
const recC = sat.twoline2satrec(TLE[0], TLE[1])
const recR = satR.twoline2satrec(TLE[0], TLE[1])
const EP = (recC.jdsatepoch - 2440587.5) * 86400000
// 叠加表：SGP4 位置整体挪 5 km（好认），两张：A 早、B 晚且更新（优先）
function mkTable(t0, n, dx) {
  const t = new Float64Array(n), p = new Float64Array(3 * n), v = new Float64Array(3 * n)
  for (let i = 0; i < n; i++) {
    const ms = t0 + i * 60000, pv = sat.propagate(recC, new Date(ms))
    t[i] = ms; p.set([pv.position.x + dx, pv.position.y, pv.position.z], 3 * i); v.set([pv.velocity.x, pv.velocity.y, pv.velocity.z], 3 * i)
  }
  const core = EI.buildTable({ t, p, v, frame: 'TEME', interp: { method: 'hermite', samples: 2 } })
  const rend = tableFrom({ t, p, v, method: 'hermite', samples: 2 })
  return { core, rend }
}
const A = mkTable(EP, 600, 5), B = mkTable(EP + 300 * 60000, 600, 9)
// core：查找函数；渲染端：注册表（新导入的在前：B, A）
OP.setOverlayResolver((id) => (id === '44067' ? [B.core, A.core] : null))
setOverlays(new Map([['44067', [B.rend, A.rend]]]))

const samples = []
for (let k = -30; k <= 1000; k += 7) samples.push(EP + k * 60000 + 1234)
let same = 0, inA = 0, inB = 0, out = 0, msWorst = 0
for (const ms of samples) {
  const c = OP.positionAt(recC, ms), r = posAt(recR, ms), r2 = posAtMs(recR, ms)
  const ta = EI.evalTable(A.core, ms), tb = EI.evalTable(B.core, ms)
  if (tb) inB++; else if (ta) inA++; else out++
  if (c && r && c.position.x === r.position.x && c.position.y === r.position.y && c.position.z === r.position.z) same++
  // posAtMs 在叠加时段内与 posAt 同走插值（逐位）；时段外走 sgp4 内核直调，tsince 由毫秒直接折日、与 propagate 的
  // jday 拼法舍入不同（既有口径，与本次改动无关；GEO 上实测 1.7 m）
  if (ta || tb) { if (r2.position.x !== r.position.x) msWorst = Infinity }
  else msWorst = Math.max(msWorst, Math.abs(r2.position.x - r.position.x))
}
ok(same === samples.length, '渲染端 posAt 与 core positionAt 逐位一致（' + same + '/' + samples.length + '）')
ok(msWorst < 5e-3, 'posAtMs：叠加时段内逐位、时段外与 posAt 差 < 5 m', msWorst)
ok(inA > 0 && inB > 0 && out > 0, '样本覆盖：仅 A / B 优先 / 时段外 三种', [inA, inB, out].join(' / '))
{
  const ms = EP + 450 * 60000
  const r = posAt(recR, ms), sg = sat.propagate(recC, new Date(ms))
  ok(Math.abs(r.position.x - sg.position.x - 9) < 1e-6, 'A、B 都覆盖的时刻用新导入的 B（偏 9 km）', r.position.x - sg.position.x)
  const ms2 = EP + 100 * 60000
  ok(Math.abs(posAt(recR, ms2).position.x - sat.propagate(recC, new Date(ms2)).position.x - 5) < 1e-6, '只有 A 覆盖：用 A（偏 5 km）')
  const ms3 = EP + 2000 * 60000
  ok(posAt(recR, ms3).position.x === satR.propagate(recR, new Date(ms3)).position.x, '时段外：回落 SGP4 逐位')
  ok(propagatorLabel(recR, ms) === '星历点序列' && propagatorLabel(recR, ms3) === 'SDP4', '传播器读数随时刻')
  ok(overlayAt(recR, ms) === B.rend && overlayAt(recR, ms3) === null, 'overlayAt 指到供位的那张表')
  ok(validSpan(recR) === null && keepInRenderSet(recR, ms3), 'satrec 带叠加：时段无限、留在渲染集')
}
// Worker：没有注册表，只认戳
{
  const stamped = stampOverlays(recR)
  ok(Array.isArray(stamped) && stamped[0] === B.rend, 'stampOverlays 把叠加表戳在传播体上')
  const clone = structuredClone(recR)
  ok(Array.isArray(clone.__ovl) && clone.__ovl.length === 2 && clone.__ovl[0].t instanceof Float64Array, '结构化克隆带着叠加表过去')
}
// 定点星不叠加；编号归一
{
  const fix = Object.assign({}, recR, { __fix: { r: [-27426, 32030, 0] } })
  ok(overlaysOf(fix) === null, '定点星（__fix）不叠加')
  ok(normId(' 44067') === '44067' && normId('A0001') === '100001' && normId('00005') === '5' && OP.normId('A0001') === '100001', '编号归一两侧同式')
}
// 注册表换掉：缓存按版本作废
{
  setOverlays(new Map())
  const ms = EP + 450 * 60000
  ok(posAt(recR, ms).position.x === satR.propagate(recR, new Date(ms)).position.x, '清空注册表：立即回落 SGP4')
  OP.setOverlayResolver(null)
}

// ---- 3D 页：「对应已有卫星」的替身不进按号解析的来源 ----
// 替身 = ephemEntriesOf 给的条目：顶着目标星的号（noradId），却只有导入表（eph）、身份键 ephem:…、没有 rec。
// 它若进了 entries / 点序列来源，天线树关联星（satLivePos）、挂点姿态（bodyEntryOf）就按号解到它身上。
{
  const poolE = { rec: recR, noradId: '44067', name: 'ZHONGXING-6C', group: 'geo' }
  const stand = { eph: A.rend, key: 'ZX6C', name: 'ZHONGXING-6C', noradId: '44067', group: 'ci:g1', _ephGroup: 'g1', _ephName: '6C', _bound: true }
  const other = { eph: B.rend, key: 'S2', name: 'SAT-2', noradId: '800002', group: 'ci:g2', _ephGroup: 'g2' }
  const ephAll = [stand, other], ephAllOwn = ephAll.filter((x) => !x._bound)
  const before = createNoradResolver(() => ({ entries: [stand], pool: [poolE], eph: ephAll }))
  ok(before('44067') === stand && before('44067').rec === undefined, '对照（修复前）：替身进了 entries，先于全量池被按号认走、没有 rec')
  let src = { entries: [], pool: [], eph: ephAllOwn }
  const after = createNoradResolver(() => src)
  ok(after('44067') === null, '池没就绪：不拿替身顶本尊，解不出（null）')
  src = { entries: [], pool: [poolE], eph: ephAllOwn }
  ok(after('44067') === poolE, '换池（来源引用变了）：重解到全量池里的本尊')
  ok(after('800002') === other, '独立的导入点序列星照常从点序列一路解出')
  const ms = EP + 2000 * 60000
  ok(!!posAt(poolE, ms) && posAt(stand, ms) === null, '出了星历时段：本尊照样有 SGP4 星位，替身没有')
}

// ---- 源码钉：3D 页 / 对话框 / 文件管理（.vue 不能直接 import）----
const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
// 函数体：从 head 那一行到同缩进的第一个「}」行
const fnText = (text, head) => {
  const i = text.indexOf(head)
  if (i < 0) return ''
  const ls = text.lastIndexOf('\n', i) + 1
  const indent = /^[ \t]*/.exec(text.slice(ls, i))[0]
  const j = text.indexOf('\n' + indent + '}', i)
  return j > i ? text.slice(i, j) : ''
}
{
  const V = rd('../../../src/pages/ConstellationMap3D.vue')
  ok(/function rebuildEphAll\(\) \{[^\n]*ephAllOwn = ephAll\.filter\(\(x\) => !x\._bound\)/.test(V), '3D 页：rebuildEphAll 另备不含替身的 ephAllOwn')
  ok(/const liveEntryOf = createNoradResolver\([^\n]*eph: ephAllOwn[,\s]/.test(V), '3D 页：liveEntryOf 的点序列来源是 ephAllOwn')
  const be = fnText(V, 'function bodyEntryOf(')
  ok(/_beSrcX !== ephAllOwn/.test(be) && /ephAllOwn\.find\(/.test(be) && !/\bephAll\.find\(/.test(be), '3D 页：bodyEntryOf 只认 ephAllOwn')
  const rr = fnText(V, 'function rebuildRenderSet(')
  ok(/for \(const g of importGroups\.value\) \{[\s\S]*?for \(const e of list\) \{ if \(!e\._bound\) real\.push\(e\); else \{ const live = boundLiveOf\(e\); if \(live\) real\.push\(live\) \} \}\n  \}/.test(rr), '3D 页：rebuildRenderSet 的 real 里替身换成本尊、解不出就不放')
  const la = fnText(V, 'function lnkAllSet(')
  ok(/e\._bound\) continue/.test(la) && /add\(ephAllOwn\)/.test(la) && !/add\(ephAll\)/.test(la), '3D 页：链路「全部卫星」不列替身')
  const li = fnText(V, 'async function lnkImportSet(')
  ok(/g && g\.bound && apiOk\) await ensureSearchPool\(\)/.test(li) && /e\._bound \? \(boundLiveOf\(e\) \|\| e\) : e/.test(li), '3D 页：链路「导入星历」集里对应的星换成本尊')
  ok(/importGroups\.value\.find\(\(x\) => x\.id === info\.groupId\)/.test(fnText(V, 'const rdkEphSrc = computed(')), '3D 页：信息栏「星历文件」按 groupId 取导入组现名')
  ok(/byLang\('导出星历失败：', 'Ephemeris export failed: '\)/.test(fnText(V, 'function onEphExportDone(')), '3D 页：导出星历失败日志按语言出字')
  ok(/mapping failed: \$\{err\}/.test(fnText(V, 'async function commitRebind(')), '3D 页：对应失败日志按语言出字')
  ok(/Ephemeris \$\{s\.name\} · \$\{s\.n\} points/.test(fnText(V, 'async function impSatList(')), '3D 页：对应星成员行悬停串按语言出字')
}
{
  const DI = rd('../../../src/components/EphemImportDialog.vue')
  ok(/Array\.isArray\(searchEl\.value\) \? searchEl\.value\[0\] : searchEl\.value/.test(DI), '导入对话框：v-for 里的检索框 ref 是数组，取第一个再 focus')
  const DE = rd('../../../src/components/EphemExportDialog.vue')
  ok(/<optgroup :label="byLang\('平均根数', 'Mean elements'\)">/.test(DE) && /<optgroup :label="byLang\('星历点序列', 'Ephemeris point sequence'\)">/.test(DE) && !/<optgroup label="/.test(DE), '导出对话框：optgroup 标题按语言现出字')
  const m = /const fmtBytes = (\(b\) => [^\n]+)/.exec(DE)
  const fmtBytes = m ? new Function('return ' + m[1])() : null
  const got = fmtBytes ? [fmtBytes(200), fmtBytes(0), fmtBytes(null), fmtBytes(1536), fmtBytes(5 * 1048576)] : []
  ok(got.join('|') === '1 KB|0 KB|—|2 KB|5.0 MB', '导出对话框：体积读数 KB 档按 1 KB 起（单颗 OMM 不再显示 0 KB）', got.join('|'))
  const FM = rd('../../../src/components/FileManager.vue')
  ok(/import\s*\{[^}]*\bbyLang\b[^}]*\}\s*from\s*'\.\.\/shared\/i18n\/lang\.js'/.test(FM) && FM.includes("byLang('对应失败：', 'Mapping failed: ')"), '文件管理：对应失败提示按语言出字')
}

console.log('\nsatPosOverlay: 通过 ' + pass + '，失败 ' + fail)
process.exit(fail ? 1 : 0)
