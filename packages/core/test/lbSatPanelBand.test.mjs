// 资源库卫星编辑器：换条目不许套频段预设（2026-10-16 体检 #1）。运行：npm test -- lbSatPanelBand
//
// 现象：资源库里从 Ku 条目点到 C 条目，C 的手填频率被改成频段预设 6.15 / 3.95 GHz，约 0.5 s 后落盘，
// 所有引用它的配置都按预设频率算 FSL / 增益 / 雨衰；点回 Ku，Ku 也被改。根因两层：
//   ① 三窗库编辑器没加 :key —— 同一组件实例换了 form；
//   ② 频段 watcher 只盯 form.frequencyBand —— 把「换了一份表单」当成「改了频段」。
// 两道一起验：
//   · 静态：三窗库编辑器标签带 :key="cfg.id"；
//   · 真组件挂载：GSO / NGSO / 再生式三个面板的 <script setup> 原样编译，按 LbLibrary 的结构挂上去——
//     不加 key（同一实例换 form）也不许套预设；加 key 换条目照样不套；库从盘上重载成新对象（同 id、
//     组件不重建、form 换了身份）不套；同一份表单里改频段照旧套预设（功能本身不能丢）。
//
// 挂载办法：@vue/compiler-sfc 只编 <script setup>（不编模板，渲染函数换成空的——这里验的是脚本里的 watcher），
// import 改写成本测试给的模块表：vue → @vue/runtime-core（与下面的无 DOM 渲染器同一实例）、频段预设用真文件，
// 联网 / IPC / 组件类依赖给桩，其余纯模块照真文件加载。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const require = createRequire(import.meta.url)
const { parse, compileScript } = require('@vue/compiler-sfc')
const VUE = require('@vue/runtime-core')
const { createRenderer, h, reactive, ref, nextTick, defineComponent } = VUE

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra !== undefined && extra !== '' ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')

// —— ① 静态：三窗库编辑器带 :key="cfg.id" ——
for (const [win, tag] of [
  ['src/linkbudget/LinkBudgetApp.vue', 'SatellitePanel'],
  ['src/ngso/NgsoLinkBudgetApp.vue', 'NgsoSatellitePanel'],
  ['src/regen/RegenLinkBudgetApp.vue', 'RegenSatPanel']
]) {
  const src = read(win)
  const at = src.indexOf('<' + tag + ' ')
  const end = at < 0 ? -1 : src.indexOf('/>', at)
  const el = at < 0 || end < 0 ? '' : src.slice(at, end)
  ok(`${win.split('/').pop()}：<${tag}> 带 :key="cfg.id"`, /\s:key="cfg\.id"/.test(el), el.slice(0, 60))
}

// —— ② 真组件挂载 ——
// import 子句 → 从模块表取值的 const 声明（只认编译产物里那几种单行写法）
function bindImport(clause, spec) {
  const s = JSON.stringify(spec)
  let rest = clause.trim()
  const ns = /^\*\s+as\s+([\w$]+)$/.exec(rest)
  if (ns) return `const ${ns[1]} = __mod(${s})`
  const out = []
  const def = /^([A-Za-z_$][\w$]*)\s*(?:,\s*([\s\S]*))?$/.exec(rest)
  if (def) { out.push(`const ${def[1]} = __mod(${s}).default`); rest = (def[2] || '').trim() }
  const named = /^\{([^}]*)\}$/.exec(rest)
  if (named) {
    const list = named[1].split(',').map((x) => x.trim()).filter(Boolean).map((x) => x.replace(/\s+as\s+/, ': '))
    out.push(`const { ${list.join(', ')} } = __mod(${s})`)
  } else if (rest) throw new Error('无法解析的 import 子句：' + clause)
  return out.join('; ')
}
// SFC → 组件定义：编译脚本 → import / export 改写 → new Function 求值
async function loadPanel(rel, stubs) {
  const { descriptor, errors } = parse(read(rel), { filename: rel })
  if (errors.length) throw new Error(rel + ' 解析失败：' + errors[0])
  const code = compileScript(descriptor, { id: 'lbsp' }).content
  const specs = []
  const body = code.split('\n').map((line) => {
    const m = /^import\s+(.+?)\s+from\s+['"]([^'"]+)['"];?\s*$/.exec(line)
    if (m) { specs.push(m[2]); return bindImport(m[1], m[2]) }
    if (/^export default /.test(line)) return line.replace(/^export default /, '__exports.default = ')
    if (/^export (async function|function|const|let|class) /.test(line)) return line.replace(/^export /, '')
    if (/^(import|export)\b/.test(line)) throw new Error(rel + ' 编译产物里有未支持的 import / export：' + line)
    return line
  }).join('\n')
  const table = {}
  for (const spec of new Set(specs)) {
    if (spec === 'vue') { table[spec] = VUE; continue }
    if (stubs[spec]) { table[spec] = stubs[spec]; continue }
    if (/\.vue$/.test(spec)) { table[spec] = { default: {} }; continue }   // 子组件：不渲染模板，用不到
    const abs = join(ROOT, dirname(rel), spec)
    try { table[spec] = await import(pathToFileURL(abs).href) } catch (e) { throw new Error(`${rel} 的依赖 ${spec} 加载失败（需要时在本测试里补桩）：${e.message}`) }
  }
  const exp = {}
  new Function('__mod', '__exports', body)((spec) => table[spec], exp)   // eslint-disable-line no-new-func
  return { ...exp.default, render: () => null }
}

const POOL_STUB = { ensureSearchPool: async () => ({ all: [], customNames: [] }), findPoolByNorad: async () => null, orbitSpecOf: () => null }
const GEO_SLOT_STUB = { fmtGeoSlot: () => '', geoSlotOfOmm: () => '', geoSlotOfSatrec: () => '', geoLonAtEpoch: () => null, isGeoSatrec: () => false }
const PANELS = [
  {
    name: 'GSO SatellitePanel', file: 'src/linkbudget/SatellitePanel.vue', presets: 'src/linkbudget/satPresets.js', stubs: {},
    props: (c) => ({ form: c.form, fields: [], satTree: [], sel: c.grd, localFolder: 'lb:' + c.id })
  },
  {
    name: 'NGSO NgsoSatellitePanel', file: 'src/ngso/NgsoSatellitePanel.vue', presets: 'src/ngso/satPresets.js',
    stubs: { './satSearchPool.js': POOL_STUB, '../shared/geoSlot.js': GEO_SLOT_STUB },
    props: (c) => ({ form: c.form, fields: [], satTree: [], ngsoSat: c.ngsoSat, showTree: true, showSearch: true })
  },
  {
    name: '再生式 RegenSatPanel', file: 'src/regen/RegenSatPanel.vue', presets: 'src/ngso/satPresets.js',
    stubs: { '../ngso/satSearchPool.js': POOL_STUB, '../shared/geoSlot.js': GEO_SLOT_STUB },
    props: (c) => ({ form: c.form, fields: [], ngsoSat: c.ngsoSat, satTree: [] })
  }
]

// 无 DOM 的最小渲染器（只要组件生命周期与响应式，不画任何东西）
const nodeOps = {
  insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
  setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, patchProp() {}
}
const { createApp } = createRenderer(nodeOps)
const tick = async () => { await nextTick(); await nextTick() }
// 两颗手填频率的库条目：Ku 星 14.0 / 12.25、C 星 5.925 / 3.7（都不等于各自频段的预设）
const mkSats = () => reactive([
  { id: 'sat1', form: { frequencyBand: 'Ku', centerFrequency: '14.0', rxCenterFrequency: '12.25' }, grd: { satFolder: '', eirpKey: '', gtKey: '', fpId: '', fpNo: '' }, ngsoSat: { mode: 'manual', orbit: null, name: '', noradId: null, folder: '' } },
  { id: 'sat2', form: { frequencyBand: 'C', centerFrequency: '5.925', rxCenterFrequency: '3.7' }, grd: { satFolder: '', eirpKey: '', gtKey: '', fpId: '', fpNo: '' }, ngsoSat: { mode: 'manual', orbit: null, name: '', noradId: null, folder: '' } }
])
const freqOf = (c) => `${c.form.centerFrequency}/${c.form.rxCenterFrequency}`

for (const P of PANELS) {
  const Panel = await loadPanel(P.file, P.stubs)
  const { BAND_FREQ } = await import(pathToFileURL(join(ROOT, P.presets)).href)
  // 父组件 = LbLibrary 的骨架：v-if="selected" 里 <slot :cfg="selected" />；keyed 决定插槽内容带不带 :key
  const mount = (sats, selId, keyed) => {
    let made = 0
    const Wrapped = { ...Panel, setup(props, ctx) { made++; return Panel.setup(props, ctx) } }
    const Lib = defineComponent({
      setup() {
        return () => {
          const c = sats.find((x) => x.id === selId.value) || sats[0]
          return c ? h('div', [h(Wrapped, { ...P.props(c), ...(keyed ? { key: c.id } : null) })]) : null
        }
      }
    })
    const app = createApp(Lib)
    app.config.warnHandler = () => {}
    app.mount({})
    return { app, made: () => made }
  }

  // a. 不加 key（故障现场的组件结构）：同一实例换 form，watcher 自己也不许套预设
  {
    const sats = mkSats(), selId = ref('sat1')
    const m = mount(sats, selId, false)
    await tick()
    selId.value = 'sat2'; await tick()
    ok(`${P.name}：同一实例换到 C 条目，手填频率不动`, freqOf(sats[1]) === '5.925/3.7', freqOf(sats[1]))
    selId.value = 'sat1'; await tick()
    ok(`${P.name}：再点回 Ku 条目，手填频率不动`, freqOf(sats[0]) === '14.0/12.25', freqOf(sats[0]))
    ok(`${P.name}：确是同一实例在换 form（复现故障结构）`, m.made() === 1, '实例数 ' + m.made())
    sats[0].form.frequencyBand = 'Ka'; await tick()
    ok(`${P.name}：同一份表单里改频段照旧套预设`, freqOf(sats[0]) === `${BAND_FREQ.Ka.up}/${BAND_FREQ.Ka.dn}`, freqOf(sats[0]))
    m.app.unmount()
  }

  // b. 加 key（三窗现行结构）：换条目即重建；新实例的 watcher 照常工作
  {
    const sats = mkSats(), selId = ref('sat1')
    const m = mount(sats, selId, true)
    await tick()
    selId.value = 'sat2'; await tick()
    ok(`${P.name}（:key）：换到 C 条目即重建、手填频率不动`, m.made() === 2 && freqOf(sats[1]) === '5.925/3.7', `实例数 ${m.made()} · ${freqOf(sats[1])}`)
    sats[1].form.frequencyBand = 'Ku'; await tick()
    ok(`${P.name}（:key）：新实例上改频段套预设`, freqOf(sats[1]) === `${BAND_FREQ.Ku.up}/${BAND_FREQ.Ku.dn}`, freqOf(sats[1]))
    // 库从盘上重载（applyLibrary 整组换成新对象，id 不变）：组件不重建、form 换了身份，频段也不同——不是用户改频段
    sats.splice(0, sats.length, ...mkSats().map((c) => (c.id === 'sat2' ? { ...c, form: { frequencyBand: 'Ka', centerFrequency: '27.8', rxCenterFrequency: '17.9' } } : c)))
    await tick()
    ok(`${P.name}（:key）：库重载成新对象（同 id），新表单的手填频率不动`, m.made() === 2 && freqOf(sats[1]) === '27.8/17.9', `实例数 ${m.made()} · ${freqOf(sats[1])}`)
    m.app.unmount()
  }
}

console.log(`lbSatPanelBand：${pass} 通过，${fail} 失败`)
if (fail) process.exit(1)
