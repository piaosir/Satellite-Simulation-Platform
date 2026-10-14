// 主窗口「分析 ▸」带上下文打开日凌 / 雨衰：没存成配置的工作区不许被冲掉（2026-10-07 相对 v1.4.13 审查 P0 #1）。
// 运行：node packages/core/test/toolContextKeep.test.mjs
//   ① useConfigTree.saveWorkspaceAs：当前工作区原样存成新配置并接上（真 storage）；名字缺省走 defaultCfgName、重名加序号
//   ② 日凌 / 雨衰的 applyToolContext（源码钉）：2026-10-15 起自动保存，换星时 createAndOpen 另建一份配置承接
//   ②b 雨衰带站：先 await 全部 autoGeo 再回执（v1.5.0 上线前排查 #2）
//   ②c 日凌 / 雨衰导出前补算：输入已变 / 未算先 compute()，算不成就不导（排查 #7）
//   ③ 主窗口右键「分析 ▸」：无名点标记 / 地球站补「点标记N / 地球站N」（否则日凌 / 雨衰站名显示并导出成缺省「北京」）
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import 'vue'   // ★ 先于下面的 document 垫片载入：runtime-dom 载入时见到 document 就当真 DOM 去 createElement

const require = createRequire(import.meta.url)
let pass = 0, fail = 0
const ok = (cond, msg, extra) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + msg + (extra ? `  (${extra})` : '')); cond ? pass++ : fail++ }
const src = (p) => readFileSync(new URL('../../../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

// ① 真 storage
{
  const store = new Map()
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }
  globalThis.document = { querySelector: () => null }
  process.env.SATSIM_DATA_DIR = mkdtempSync(join(tmpdir(), 'satsim-ctxkeep-'))
  const storage = require('../../../electron/services/storage.js')
  const api = { store: { listConfigs: async (ns) => storage.listConfigs(ns), saveConfig: async (ns, cfg) => storage.saveConfig(ns, cfg) } }
  const { useConfigTree } = await import('../../../src/shared/useConfigTree.js')
  let ws = { orbitType: 'SUN', rows: ['未存的表'] }, baseline = 0
  const t = useConfigTree({
    ns: 'sun', orbitType: 'SUN', api, storageKey: 'test/exp', toast: () => {},
    blankState: () => ({ orbitType: 'SUN', rows: [] }), serializeState: () => JSON.parse(JSON.stringify(ws)),
    applyState: (st) => { ws = st }, setBaseline: () => { baseline++ }, guardedLeave: async () => true,
    askConfirm: async () => true, defaultCfgName: () => '中星6C 日凌 2026'
  })
  await t.loadConfigs()
  const a = await t.saveWorkspaceAs()
  ok(!!a && a.name === '中星6C 日凌 2026' && JSON.stringify(a.state) === JSON.stringify({ orbitType: 'SUN', rows: ['未存的表'] }), '工作区原样存成新配置（名字走 defaultCfgName）')
  ok(t.activeId.value === a.id && baseline === 1, '存完接上：成为当前配置、以当前内容为基线')
  const b = await t.saveWorkspaceAs()
  ok(!!b && b.name === '中星6C 日凌 2026 2', '重名加序号')
  const c = await t.saveWorkspaceAs('  APSTAR-6D 日凌 2026 ')
  ok(!!c && c.name === 'APSTAR-6D 日凌 2026', '给了名字用它（去首尾空白）')
}

// ② 日凌 / 雨衰接收端（源码钉）
// 2026-10-15 起两窗改自动保存：工作区恒对应一份配置，「没存成配置的工作区」不复存在，留底那一步随之取消。
// 换星时改为 cfgTree.createAndOpen（内部先 guardedLeave = 把当前配置的改动写盘）另建一份配置承接，原配置不动；
// 建不成（未激活 / 写盘失败）就不动现场。
for (const f of ['src/suntool/SunOutageApp.vue', 'src/rain/RainApp.vue']) {
  const s = src(f)
  const i = s.indexOf('async function applyToolContext(c) {'), j = s.indexOf('\n}\n', i)
  const body = i >= 0 && j > i ? s.slice(i, j) : ''
  ok(!!body, f + '：找到 applyToolContext')
  ok(!body.includes('addBlankConfig('), f + '：带上下文不走 addBlankConfig')
  ok(!body.includes('saveWorkspaceAs('), f + '：自动保存下不再「留底 + 尾部另存」')
  ok(/const n = await cfgTree\.createAndOpen\(\{ state: [^}]*nameAuto: true \}\)\s*\n\s*if \(!n\) return/.test(body), f + '：换星另建一份配置承接，建不成就不动现场')
  ok(/createAndOpen\(\{ state: blankState\(\)|const st = blankState\(\)/.test(body), f + '：新配置从出厂空白起')
}

// ②b 雨衰：带站新建的配置要等海拔 / 降雨率回填落定再存（v1.5.0 上线前排查 #2：不等就把出厂海拔 '0' 存进配置，
//    基线却含回填值 —— 切回按海平面算、重开误判「已修改」）
{
  const s = src('src/rain/RainApp.vue')
  const i = s.indexOf('async function applyToolContext(c) {'), j = s.indexOf('\n}\n', i)
  const body = i >= 0 && j > i ? s.slice(i, j) : ''
  // 自动保存下回填值随写盘落盘；仍要等回填落定再回执，免得「已添加」时表里还是出厂海拔
  const push = body.indexOf('fills.push(autoGeo(cases[i]))'), wait = body.indexOf('await Promise.all(fills)'), tip = body.lastIndexOf('toast(')
  ok(push > 0 && wait > push && tip > wait, 'src/rain/RainApp.vue：带站先 await 全部 autoGeo，再回执')
  ok(!/\n\s*for \([^)]*\) autoGeo\(cases\[i\]\)/.test(body), 'src/rain/RainApp.vue：不再有不等结果的 autoGeo 循环')
}

// ②c 日凌 / 雨衰：导出前补算（v1.5.0 上线前排查 #7）——「输入已变」或还没算过时先按当前输入 compute()，
//    算不成就不导；compute 回 true/false 供导出判定（文件里不许是新参数配旧结果）
for (const [f, fn] of [['src/suntool/SunOutageApp.vue', 'async function runExport(kind) {'], ['src/rain/RainApp.vue', 'async function exportExcel() {']]) {
  const s = src(f)
  const i = s.indexOf(fn), body = i >= 0 ? s.slice(i, s.indexOf('\n}\n', i)) : ''
  const guard = body.indexOf('if (resultsStale.value || !hasResults.value) {'), calc = body.indexOf('if (!(await compute()) || !hasResults.value) return')
  const out = Math.max(body.indexOf('exportPayload()'), body.indexOf('api.exportExcel(payload)'))
  ok(guard > 0 && calc > guard && out > calc, f + '：导出前输入已变 / 未算先补算，算不成就中止')
  const c = s.indexOf('async function compute() {'), cb = c >= 0 ? s.slice(c, s.indexOf('\n}\n', c)) : ''
  ok(/return true\n/.test(cb) && (cb.match(/return false/g) || []).length >= 3, f + '：compute 回报算没算成')
}

// ③ 无名标记补名
{
  const page = src('src/pages/ConstellationMap3D.vue')
  const i = page.indexOf('const ctxAna = computed(() => {'), body = page.slice(i, page.indexOf('\n})\n', i))
  // 兜底名走全平台共用的 shared/markerNames.js（点标记N / 地球站N，英文 Point N / Station N）
  ok(body.includes('pointFallbackName(points.value.indexOf(eo))') && body.includes('stationFallbackName(stations.value.indexOf(eo))') && /name: eoName/.test(body), '「分析 ▸」带站：无名点标记 / 地球站补「点标记N / 地球站N」')
}

console.log(`\ntoolContextKeep: ${pass} 项通过${fail ? '，' + fail + ' 项失败' : ''}`)
if (fail) process.exit(1)
