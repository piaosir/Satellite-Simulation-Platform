<script setup>
// 生成页（DESIGN §7 / 任务书 §5.6）：参数化整星。模板 → 表单（平台 / 太阳翼 / 反射面 / 馈源 / 其他（天线塔 · 杆件 · 推力器 · 散热面）
// 可增删 / 密度表全部可改）→ 150 ms 防抖实时重建预览。参数缺值 / 有误时视口清空、只留一句状态（上一颗星留在屏上会被当成当前参数的结果）。
//
// 缺口口径（W3 报告 ④-2，编排者定案）：
//   · 缺省 fill:'illustrative'：模板里没出处的值先补示意值，描红、title 写来源（示意值 / 推算 / 出处 URL），照样能生成；
//   · 「只用有出处的值」切 fill:'none'：没出处的值留空，validateSpec().missing 的字段描红、生成禁用，直到用户填上；
//   · 用户亲手填过的格不再描红（值是用户给的，不是示意）；
//   · 加翼 / 加反射面用模板的 itemDefaults；反射面口径在示意档补预设的示意口径（描红），在只用出处档留空。
// 「保存到库」：spec 哈希等于模板原 spec（任一档）时禁用（会与模板重复，W3 ④-3）；库里已有同一哈希时同样禁用。
import { ref, reactive, computed, watch, inject, provide, onActivated, onDeactivated, onBeforeUnmount } from 'vue'
import Icon from '../components/Icon.vue'
import MdSec from './MdSec.vue'
import GenNum from './gen/GenNum.vue'
import GenVec from './gen/GenVec.vue'
import { templateCatalog, templateSpec, DETAIL_PRESETS, DEFAULT_TEMPLATE_ID, resolveTemplateId } from '@core/models/paramTemplates.mjs'
import { buildParamModel, validateSpec, normalizeSpec, specHash, paramModelIdForSpec, LAYOUT_PRESETS, DENSITY } from '@core/models/paramBus.mjs'
import { getPath, setPath, sourceTitle, sourceKey, pathFlagged, shiftIndexedPaths, fmtInt, fmtNum, fmtBox } from './wbLogic.js'

const wb = inject('wb')
const { st, cur } = wb
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v } catch { return d } }
const lsSet = (k, v) => { try { localStorage.setItem(k, v) } catch { /* 便利数据 */ } }
const clone = (o) => JSON.parse(JSON.stringify(o))

// ============ 模板目录 ============
const CATALOG = templateCatalog()
const GROUPS = [
  { key: 'geo', label: 'GEO 通信平台', has: (t) => t.tags.includes('geo') },
  { key: 'leo', label: 'LEO', has: (t) => t.tags.includes('leo-flat') },
  { key: 'cube', label: '立方星', has: (t) => t.tags.includes('cubesat') },
  { key: 'gen', label: '通用', has: (t) => !t.tags.includes('geo') && !t.tags.includes('leo-flat') && !t.tags.includes('cubesat') }
]
const groups = GROUPS.map((g) => ({ ...g, items: CATALOG.filter(g.has) })).filter((g) => g.items.length)
const tplOf = (id) => CATALOG.find((t) => t.templateId === id) || CATALOG[0]

// ============ 工作状态 ============
// 上次选的模板：旧 id（已撤下的模板）经 resolveTemplateId 换成现行 id；查不到 / 不在目录里 → 默认卫星
const savedTpl = resolveTemplateId(lsGet('model/gen/tpl', DEFAULT_TEMPLATE_ID))
const tplId = ref(savedTpl && CATALOG.some((t) => t.templateId === savedTpl) ? savedTpl : DEFAULT_TEMPLATE_ID)
const fill = ref(lsGet('model/gen/fill', 'illustrative') === 'none' ? 'none' : 'illustrative')
const base = computed(() => templateSpec(tplId.value, { fill: fill.value }))
const spec = ref(null)
const ill = reactive(new Set())        // 示意值路径（模板给的 + 示意档里新加条目补的）
const touched = reactive(new Set())    // 用户亲手填过的路径（不再描红）

function resetFromTemplate() {
  const b = base.value
  spec.value = clone(b.spec)
  ill.clear(); for (const p of b.illustrative || []) ill.add(p)
  touched.clear()
}
// 恢复上次的草稿（同模板同档才用）
;(() => {
  try {
    const d = JSON.parse(lsGet('model/gen/draft', 'null'))
    if (d && d.tplId === tplId.value && d.fill === fill.value && d.spec && typeof d.spec === 'object') {
      spec.value = d.spec
      for (const p of d.ill || []) ill.add(p)
      for (const p of d.touched || []) touched.add(p)
      return
    }
  } catch { /* 草稿坏了就从模板起 */ }
  resetFromTemplate()
})()
const edited = computed(() => touched.size > 0 || JSON.stringify(spec.value) !== JSON.stringify(base.value.spec))
async function changeTpl(id) {
  if (id === tplId.value) return
  if (edited.value && !(await wb.askConfirm(`放弃对「${tplOf(tplId.value).titleZh}」的修改？`))) return
  tplId.value = id
  lsSet('model/gen/tpl', id)
  resetFromTemplate()
  firstShow = true
}
async function setFill(v) {
  if (v === fill.value) return
  if (edited.value && !(await wb.askConfirm('放弃当前修改？'))) return
  fill.value = v
  lsSet('model/gen/fill', v)
  resetFromTemplate()
}
async function resetAll() {
  if (edited.value && !(await wb.askConfirm('复原为模板参数？'))) return
  resetFromTemplate()
}

// ============ 字段读写 / 描红 / 出处 ============
const v = computed(() => (spec.value ? validateSpec(spec.value) : { ok: false, errors: [], missing: [] }))
// 归一后的 spec：没写出来的字段取生成器缺省（如太阳翼效率 28 %），做数字框的占位读数
const norm = computed(() => (spec.value ? normalizeSpec(spec.value) : null))
function val(path) { const x = getPath(spec.value, path); return typeof x === 'number' ? x : (x == null ? null : Number(x)) }
function def(path) { const x = norm.value ? getPath(norm.value, path) : null; return typeof x === 'number' && Number.isFinite(x) ? x : null }
// 可省略的覆盖项（密度表逐项覆盖、天线塔尺寸）清空 = 删掉这个键回生成器缺省；写 null 进去 validateSpec 会判非法
const OPTIONAL_RE = /^(density\.[A-Za-z]+|tower\.(hM|wM))$/
function setVal(path, x) {
  if (x == null && OPTIONAL_RE.test(path)) {
    const [obj, key] = path.split('.')
    const o = spec.value[obj]
    if (o && typeof o === 'object') { delete o[key]; if (!Object.keys(o).length) delete spec.value[obj] }
  } else setPath(spec.value, path, x)
  touched.add(path)
  ill.delete(path)
}
// 自己有出处（source / derived）的字段不因「整组是示意」而描红：例如翼数是示意，但板长板宽有文献出处
function ownSourced(path) {
  const ss = base.value.specSources || {}
  const e = ss[path] || ss[sourceKey(path)]
  return !!(e && e.kind !== 'illustrative')
}
// validateSpec 对附加件（feeds / booms / thrusters / radiators）不给逐字段 missing，只给「feeds[0]：须有 …」这样的整条错误：按条目前缀认
function errFlagged(path) {
  const m = /^((?:feeds|booms|thrusters|radiators)\[\d+\])/.exec(path)
  return !!m && v.value.errors.some((e) => e.startsWith(m[1] + '：') || e.startsWith(m[1] + '.'))
}
function bad(path) {
  if (pathFlagged(v.value.missing, path) || errFlagged(path)) return true
  if (fill.value !== 'illustrative' || touched.has(path)) return false
  if (ill.has(path)) return true
  return pathFlagged([...ill], path) && !ownSourced(path)
}
function tip(path) {
  const t = sourceTitle(base.value.specSources, path)
  if (touched.has(path)) return t ? '已改（模板：' + t.split('\n')[0] + '）' : ''
  if (!t && pathFlagged([...ill], path)) return '示意值'
  return t
}
provide('gen', { val, def, setVal, bad, tip })

// ============ 数组条目：增删与路径平移 ============
// 删掉 arr[i] 后，arr[i+1…] 的路径都要前移一位：示意 / 已改两张路径表跟着改，否则描红串到别的条目上
function shiftPaths(set, arr, i) {
  const next = shiftIndexedPaths(set, arr, i)
  set.clear(); for (const p of next) set.add(p)
}
const wings = computed(() => (spec.value && Array.isArray(spec.value.wings) ? spec.value.wings : null))
const refls = computed(() => (spec.value && Array.isArray(spec.value.reflectors) ? spec.value.reflectors : null))
const layout = computed(() => (spec.value && spec.value.layout) || 'geo')
const isCube = computed(() => layout.value === 'cubesat')
const canAddWing = computed(() => !isCube.value && (!wings.value || wings.value.length < 2))
function addWing() {
  const s = spec.value
  if (!Array.isArray(s.wings)) s.wings = []
  const used = new Set(s.wings.map((w) => w.side))
  const side = !used.has('+Y') ? '+Y' : '-Y'
  const d = base.value.itemDefaults.wing || { panels: 1, panelHM: 1, panelWM: 1, sidePanels: 0, yokeLenM: 0.3, gapM: 0.02, tiltDeg: 0, axis: 'y' }
  const w = { side, ...clone(d) }
  const i = s.wings.length
  // 模板也没数的字段（null）留空：validateSpec 报缺、描红；有数的按 [*] 通配照常显示出处 title
  s.wings.push(w)
  touched.add(`wings[${i}].side`)
}
function removeWing(i) {
  spec.value.wings.splice(i, 1)
  shiftPaths(ill, 'wings', i); shiftPaths(touched, 'wings', i)
}
const SLOTS = [
  { key: '+X', label: '东 +X' }, { key: '-X', label: '西 −X' }, { key: '+X2', label: '东 +X（二）' }, { key: '-X2', label: '西 −X（二）' },
  { key: 'deck+Y', label: '对地板 +Y' }, { key: 'deck-Y', label: '对地板 −Y' }
]
function freeSlot() {
  const used = new Set((refls.value || []).filter((r) => !r.posBody).map((r) => r.slot))
  return (SLOTS.find((s) => !used.has(s.key)) || SLOTS[0]).key
}
const canAddRefl = computed(() => !refls.value || refls.value.filter((r) => !r.posBody).length < SLOTS.length)
function illReflD(slot) {
  const D = DETAIL_PRESETS[spec.value.detailPreset] || {}
  const deck = String(slot).startsWith('deck')
  const d = deck ? D.illustrativeDeckReflectorDM : D.illustrativeReflectorDM
  if (Number.isFinite(d)) return d
  const b = spec.value.bus || {}
  return +(Math.max(0.05, Math.min(b.xM || 1, b.yM || 1) * 0.8)).toFixed(3)
}
function addRefl() {
  const s = spec.value
  if (!Array.isArray(s.reflectors)) s.reflectors = []
  const d = base.value.itemDefaults.reflector || { diameterM: null, focalM: null, offsetHM: null, posBody: null, boresightBody: [0, 0, 1], feedType: 'horn', mesh: false, shaped: false }
  const slot = freeSlot()
  const r = { slot, ...clone(d) }
  delete r.mount
  const i = s.reflectors.length
  if (r.diameterM == null && fill.value === 'illustrative') { r.diameterM = illReflD(slot); ill.add(`reflectors[${i}].diameterM`) }
  s.reflectors.push(r)
  touched.add(`reflectors[${i}].slot`)
}
function removeRefl(i) {
  spec.value.reflectors.splice(i, 1)
  shiftPaths(ill, 'reflectors', i); shiftPaths(touched, 'reflectors', i)
}
function setField(path, x) { setVal(path, x) }

// ============ 附加件：馈源 / 杆件 / 推力器 / 散热面（spec 坐标 = 本体系、原点在平台体中心）============
// 新条目的初值按平台尺寸摆在看得见、不穿进平台体的位置（全是用户自己加的，不算示意值、不描红）
const busH = () => { const b = (spec.value && spec.value.bus) || {}; return [(b.xM || 1) / 2, (b.yM || 1) / 2, (b.zM || 1) / 2] }
const r3 = (v) => v.map((x) => +x.toFixed(3))
const EXTRA_NEW = {
  feeds: (n) => { const h = busH(); return { kind: 'horn', posBody: r3([-h[0] * 0.5 + n * 0.25 * h[0], h[1] * 0.4, h[2] + 0.02]), dirBody: [0, 0, 1], apertureM: +Math.max(0.05, Math.min(h[0], h[1]) * 0.25).toFixed(3) } },
  booms: (n) => { const h = busH(); const y = r3([0, (n % 2 ? -1 : 1) * h[1] * 0.5, -h[2] * 0.5]); return { fromBody: r3([h[0], y[1], y[2]]), toBody: r3([h[0] + Math.max(0.5, h[0] * 1.5), y[1], y[2]]), dM: +Math.max(0.01, h[0] * 0.04).toFixed(3) } },
  thrusters: (n) => { const h = busH(); const s = n % 2 ? -1 : 1; return { posBody: r3([s * h[0] * 0.8, h[1] * 0.8, -h[2]]), dirBody: [0, 0, -1], exitDM: +Math.max(0.02, h[0] * 0.06).toFixed(3), lengthM: +Math.max(0.03, h[0] * 0.1).toFixed(3) } },
  radiators: (n) => { const h = busH(); const f = ['+Y', '-Y', '+X', '-X'][n % 4]; const [a, b] = f.endsWith('Y') ? [h[0], h[2]] : [h[1], h[2]]; return { face: f, wM: +(a * 1.2).toFixed(3), hM: +(b * 1.2).toFixed(3) } }
}
const extras = (k) => (spec.value && Array.isArray(spec.value[k]) ? spec.value[k] : [])
function addExtra(k) {
  const s = spec.value
  if (!Array.isArray(s[k])) s[k] = []
  const i = s[k].length
  s[k].push(EXTRA_NEW[k](i))
  touched.add(`${k}[${i}]`)
}
function removeExtra(k, i) {
  spec.value[k].splice(i, 1)
  if (!spec.value[k].length) delete spec.value[k]   // 空数组与省略同义（normalizeSpec 补 []），删掉免得 spec 哈希因「写没写」不同
  shiftPaths(ill, k, i); shiftPaths(touched, k, i)
}
const FACES = ['+X', '-X', '+Y', '-Y', '+Z', '-Z']
const FACE_LABEL = { '+X': '东 +X', '-X': '西 −X', '+Y': '南 +Y', '-Y': '北 −Y', '+Z': '对地 +Z', '-Z': '背地 −Z' }
const nExtras = computed(() => ['booms', 'thrusters', 'radiators'].reduce((n, k) => n + extras(k).length, 0) + (spec.value && spec.value.tower ? 1 : 0))

// ============ 密度表（spec.density 逐项覆盖 DENSITY.value；留空 = 生成器缺省）============
const DENSITY_ROWS = [
  { key: 'busVolume', label: '平台体' }, { key: 'panelAreal', label: '太阳翼基板' }, { key: 'cellAreal', label: '电池片' },
  { key: 'reflectorAreal', label: '实面反射面' }, { key: 'meshReflectorAreal', label: '网状反射面' }, { key: 'mliAreal', label: 'MLI' },
  { key: 'radiatorAreal', label: '散热面 OSR' }, { key: 'hornAreal', label: '喇叭' }, { key: 'towerAreal', label: '天线塔' },
  { key: 'arrayAreal', label: '相控阵' }, { key: 'boomLinear', label: '杆件' }, { key: 'laeMass', label: '远地点发动机' },
  { key: 'rcsMass', label: '姿轨控推力器' }, { key: 'epMass', label: '电推力器' }
].filter((r) => DENSITY[r.key])
const nDensity = computed(() => Object.keys((spec.value && spec.value.density) || {}).length)
function resetDensity() {
  if (!spec.value || !spec.value.density) return
  for (const k of Object.keys(spec.value.density)) { touched.delete('density.' + k); ill.delete('density.' + k) }
  delete spec.value.density
}

// ============ 生成（150 ms 防抖）============
const gen = reactive({ ms: 0, tris: 0, massKg: null, bbox: null, hash: '', err: '', busy: false, at: 0 })
let genT = 0, firstShow = true, active = false
function scheduleGen(delay = 150) { clearTimeout(genT); genT = setTimeout(runGen, delay) }
function runGen() {
  genT = 0
  if (!active || !spec.value) return
  if (!v.value.ok) {
    // 缺值 / 参数有误：视口清空、只留一句状态，别让上一颗星（或上一个模板）留在屏上冒充当前参数的结果
    gen.err = ''; gen.at = 0
    wb.showBlank(v.value.missing.length ? '缺值。' : '参数有误。')
    firstShow = true
    return
  }
  const t0 = performance.now()
  try {
    const r = buildParamModel(clone(spec.value))
    const tpl = tplOf(tplId.value)
    const nm = spec.value.name || tpl.titleZh
    wb.showGenerated(r, { id: 'gen:' + tplId.value, title: tpl.title, titleZh: nm, source: { kind: 'param', url: '', credit: tpl.source.credit, license: 'param', redistributable: true } }, { keepView: !firstShow })
    firstShow = false
    gen.ms = Math.round(performance.now() - t0)
    gen.tris = r.ir.meshes.reduce((s, m) => s + m.index.length / 3, 0)
    gen.massKg = r.massProps ? r.massProps.massKg : null
    gen.bbox = r.bboxBody || null
    gen.hash = r.specHash
    gen.err = ''
    gen.at = Date.now()
  } catch (e) {
    gen.err = (e && e.message) || String(e)
    gen.at = 0
    wb.showBlank('生成失败。')
    firstShow = true
  }
}
watch(() => JSON.stringify(spec.value), () => {
  scheduleGen()
  try { lsSet('model/gen/draft', JSON.stringify({ tplId: tplId.value, fill: fill.value, spec: spec.value, ill: [...ill], touched: [...touched] })) } catch { /* 便利数据 */ }
})
onActivated(() => { active = true; if (cur.kind !== 'gen' || cur.id !== 'gen:' + tplId.value) firstShow = true; scheduleGen(0) })
onDeactivated(() => { active = false; clearTimeout(genT) })
onBeforeUnmount(() => { active = false; clearTimeout(genT) })

// ============ 保存到库 ============
const tplHashes = computed(() => {
  const out = new Set()
  for (const f of ['illustrative', 'none']) { const t = templateSpec(tplId.value, { fill: f }); if (t.spec) { try { out.add(specHash(t.spec)) } catch { /* 缺值的 spec 也能算哈希；兜底 */ } } }
  return out
})
const curHash = computed(() => (spec.value ? specHash(spec.value) : ''))
const saveId = computed(() => (spec.value ? paramModelIdForSpec(spec.value) : ''))
const inLib = computed(() => !!(saveId.value && wb.byId(saveId.value)))
const sameAsTpl = computed(() => tplHashes.value.has(curHash.value))
const saving = ref(false)
const canSave = computed(() => !!wb.api && v.value.ok && !sameAsTpl.value && !inLib.value && !saving.value && !gen.err)
const saveTip = computed(() => (sameAsTpl.value ? '与模板参数相同' : inLib.value ? '库里已有同参数的模型：' + saveId.value : '存为本机参数化模型（参数 + glb + 缩略图）：' + saveId.value))
async function saveToLib() {
  if (!canSave.value) return
  saving.value = true
  try {
    const r = buildParamModel(clone(spec.value))
    const tpl = tplOf(tplId.value)
    const nm = (spec.value.name && spec.value.name !== tpl.titleZh) ? spec.value.name : tpl.titleZh + '（改）'
    const id = await wb.saveParam(r, { id: saveId.value, title: tpl.title + ' (custom)', titleZh: nm })
    if (id) wb.toast('已保存到库：' + nm)
  } catch (e) { wb.hint((e && e.message) || String(e)) }
  finally { saving.value = false }
}

// ============ 其它显示 ============
const presets = computed(() => LAYOUT_PRESETS[layout.value] || [])
const PRESET_LABEL = { geo: 'GEO 平台', small: '小卫星', leo: 'LEO 平板', cubesat: '立方星' }
const MLI = [{ key: 'mli_gold', label: '金色' }, { key: 'mli_silver', label: '银色' }, { key: 'mli_black', label: '黑色' }, { key: '', label: '无' }]
const nameVal = computed(() => (spec.value && spec.value.name) || '')
function setName(s) { const t = String(s || '').trim(); if (t === nameVal.value) return; spec.value.name = t || tplOf(tplId.value).titleZh; touched.add('name') }
const missText = computed(() => v.value.missing.length)
const tplTip = computed(() => { const t = tplOf(tplId.value); return [t.titleZh, t.title, t.source.credit].filter(Boolean).join('\n') })
</script>

<template>
  <div class="gn">
    <!-- 模板 -->
    <div class="gn-top">
      <div class="srow"><label>模板</label>
        <select class="ci" :value="tplId" :title="tplTip" @change="changeTpl($event.target.value); $event.target.value = tplId">
          <optgroup v-for="g in groups" :key="g.key" :label="g.label">
            <option v-for="t in g.items" :key="t.templateId" :value="t.templateId">{{ t.titleZh }}</option>
          </optgroup>
        </select>
        <button class="lb-mini lb-mini-ico" :disabled="!edited" title="复原为模板参数" @click="resetAll"><Icon name="undo-2" :size="13" /></button>
      </div>
      <div class="srow"><label title="示意值：模板里没有出处的尺寸先按工程示意补上（描红）；只用有出处的值：这些格留空，填齐才能生成">取值</label>
        <div class="lbu-seg gn-seg">
          <button :class="{ on: fill === 'illustrative' }" title="没有出处的尺寸按工程示意值补齐（描红，悬停看来源）" @click="setFill('illustrative')">含示意值</button>
          <button :class="{ on: fill === 'none' }" title="只用有出处的值：缺的格留空描红，填齐才生成" @click="setFill('none')">只用有出处的值</button>
        </div>
      </div>
      <div class="srow"><label title="保存到库时的中文名">名称</label>
        <input class="ci" type="text" :value="nameVal" spellcheck="false" data-i18n-skip @change="setName($event.target.value)" @keydown.enter="$event.target.blur()" />
      </div>
      <div class="gn-read">
        <template v-if="gen.at && v.ok && !gen.err">
          <span class="k">生成</span><b data-i18n-skip>{{ gen.ms }}</b><span class="u">ms</span><span class="s">·</span>
          <b data-i18n-skip>{{ fmtInt(gen.tris) }}</b><span class="u">▲</span><span class="s">·</span>
          <b data-i18n-skip>{{ fmtNum(gen.massKg, 5) }}</b><span class="u">kg</span><span class="s">·</span>
          <b data-i18n-skip :title="'specHash ' + gen.hash">{{ fmtBox(gen.bbox) }}</b><span class="u">m</span>
        </template>
        <span v-if="missText" class="md-state bad"><Icon name="alert-triangle" :size="12" /><span>缺</span><b data-i18n-skip>{{ missText }}</b><span>项</span></span>
      </div>
      <div v-if="v.errors.length" class="md-state bad gn-errs" :title="v.errors.join('\n')"><Icon name="alert-triangle" :size="12" /><span data-i18n-skip>{{ v.errors[0] }}</span><span v-if="v.errors.length > 1" data-i18n-skip>（+{{ v.errors.length - 1 }}）</span></div>
      <div v-if="gen.err" class="md-state bad gn-errs" :title="gen.err"><Icon name="alert-triangle" :size="12" /><span data-i18n-skip>{{ gen.err }}</span></div>
      <div class="md-acts">
        <button class="lb-mini" :disabled="!v.ok" title="立即重新生成预览" @click="scheduleGen(0)"><Icon name="refresh-cw" :size="12" />生成</button>
        <span class="sp"></span>
        <button class="lb-mini primary" :disabled="!canSave" :title="saveTip" @click="saveToLib"><Icon name="save" :size="12" />{{ saving ? '保存中…' : '保存到库' }}</button>
      </div>
    </div>

    <template v-if="spec">
      <!-- 平台 -->
      <MdSec id="g-bus" title="平台">
        <div class="srow"><label title="工程细节示意档（MLI、散热面、推力器、适配环等附件的示意尺度）">细节档</label>
          <select class="ci" :value="spec.detailPreset" @change="setField('detailPreset', $event.target.value)">
            <option v-for="p in presets" :key="p" :value="p">{{ PRESET_LABEL[p] || p }}</option>
          </select></div>
        <div class="gn-grid">
          <GenNum path="bus.xM" label="X 向" unit="m" :min="0.01" :max="50" tip="平台体沿本体 X（东西）" />
          <GenNum path="bus.yM" label="Y 向" unit="m" :min="0.01" :max="50" tip="平台体沿本体 Y（南北，太阳翼安装面法向）" />
          <GenNum path="bus.zM" label="Z 向" unit="m" :min="0.01" :max="50" tip="平台体沿本体 Z（对地）" />
          <GenNum path="massTargetKg" label="整星质量" unit="kg" allow-empty :min="0.01" :max="1e5" placeholder="按密度" tip="给了就让平台体吃掉「整星 − 其余组件」的余量，总质量钉在它上；留空按体密度估" />
        </div>
        <div v-if="layout === 'geo'" class="srow"><label title="平台体多层隔热包覆的颜色">MLI</label>
          <div class="lbu-seg gn-seg">
            <button v-for="x in MLI" :key="x.key" :class="{ on: (spec.bus.mli || '') === x.key }" @click="setField('bus.mli', x.key || null)">{{ x.label }}</button>
          </div></div>
        <div v-if="layout === 'geo'" class="gn-chks">
          <label class="md-chkrow" title="包覆层单独成节点"><input type="checkbox" :checked="spec.detail && spec.detail.mli !== false" @change="setField('detail.mli', $event.target.checked)" />MLI 包覆</label>
          <label class="md-chkrow" title="南北面 OSR 散热面"><input type="checkbox" :checked="spec.detail && spec.detail.radiators !== false" @change="setField('detail.radiators', $event.target.checked)" />散热面</label>
          <label class="md-chkrow" title="远地点发动机与姿轨控推力器"><input type="checkbox" :checked="spec.detail && spec.detail.thrusters !== false" @change="setField('detail.thrusters', $event.target.checked)" />推力器</label>
          <label class="md-chkrow" title="星箭对接环"><input type="checkbox" :checked="spec.detail && spec.detail.adapter !== false" @change="setField('detail.adapter', $event.target.checked)" />适配环</label>
        </div>
        <div v-if="layout === 'geo'" class="gn-grid">
          <GenNum path="detail.deckHorns" label="对地喇叭" unit="个" integer :min="0" :max="12" tip="对地板测控 / 信标小喇叭个数" />
        </div>
        <template v-if="layout === 'leo-flat'">
          <div class="srow"><label title="对地面相控阵块数">相控阵</label>
            <div class="lbu-seg gn-seg">
              <button v-for="n in [0, 1, 2, 4]" :key="n" :class="{ on: spec.phasedArray && spec.phasedArray.tiles === n, 'md-red': bad('phasedArray.tiles') && spec.phasedArray && spec.phasedArray.tiles === n }"
                      :title="tip('phasedArray.tiles')" @click="setField('phasedArray.tiles', n)" data-i18n-skip>{{ n }}</button>
            </div><span class="u">块</span></div>
        </template>
        <template v-if="isCube">
          <label class="md-chkrow"><input type="checkbox" :checked="spec.cubesat && spec.cubesat.bodyCells" @change="setField('cubesat.bodyCells', $event.target.checked)" />体装电池片</label>
          <div class="srow"><label title="背地端展开板块数">展开板</label>
            <div class="lbu-seg gn-seg">
              <button v-for="n in [0, 2]" :key="n" :class="{ on: spec.cubesat && spec.cubesat.deployPanels === n }" @click="setField('cubesat.deployPanels', n)" data-i18n-skip>{{ n }}</button>
            </div><span class="u">块</span></div>
        </template>
      </MdSec>

      <!-- 太阳翼 -->
      <MdSec v-if="!isCube" id="g-wings" title="太阳翼" :count="wings ? wings.length : null">
        <template #actions>
          <button class="lb-mini" :disabled="!canAddWing" title="按模板缺省加一翼（±Y 面各至多一翼）" @click="addWing"><Icon name="plus" :size="12" />加翼</button>
        </template>
        <div v-if="!wings" class="md-state bad"><Icon name="alert-triangle" :size="12" />太阳翼缺值。</div>
        <div v-else-if="!wings.length" class="lb-placeholder gn-none">无太阳翼。</div>
        <div v-for="(w, i) in wings || []" :key="'w' + i" class="gn-item">
          <div class="gn-ih">
            <b :class="{ 'md-red': bad(`wings[${i}]`) }" :title="tip('wings') || null">翼</b><b data-i18n-skip :class="{ 'md-red': bad(`wings[${i}]`) }">{{ i + 1 }}</b>
            <select class="ci gn-side" :value="w.side" title="挂在哪个面（翼轴 = ±Y）" @change="setField(`wings[${i}].side`, $event.target.value)">
              <option value="+Y">+Y 面</option><option value="-Y">−Y 面</option>
            </select>
            <span class="sp"></span>
            <button class="lb-mini lb-mini-ico" title="删除这一翼" @click="removeWing(i)"><Icon name="trash" :size="12" /></button>
          </div>
          <div class="gn-grid">
            <GenNum :path="`wings[${i}].panels`" label="板数" unit="块" integer :min="1" :max="20" tip="沿翼展串联的板数" />
            <GenNum :path="`wings[${i}].panelHM`" label="板长" unit="m" :min="0.01" :max="30" tip="单板沿翼展长" />
            <GenNum :path="`wings[${i}].panelWM`" label="板宽" unit="m" :min="0.01" :max="30" tip="单板横宽（垂直翼轴、在板面内）" />
            <GenNum :path="`wings[${i}].yokeLenM`" label="轭长" unit="m" :min="0" :max="30" tip="SADA 外端到第一块板内缘；0 = 无轭" />
            <GenNum :path="`wings[${i}].gapM`" label="板缝" unit="m" :min="0" :max="2" />
            <GenNum :path="`wings[${i}].tiltDeg`" label="转角" unit="°" :min="-180" :max="180" tip="绕翼轴转角；0 时电池面朝天顶（−Z）" />
            <GenNum :path="`wings[${i}].efficiency`" label="效率" unit="%" :min="0" :max="100" tip="太阳翼组光电转换效率（AGI 百分数口径）" />
            <div class="gn-f2"><label title="最外一块两侧的侧板（Spacebus 4000 类）">侧板</label>
              <div class="lbu-seg gn-seg">
                <button v-for="n in [0, 2]" :key="n" :class="{ on: w.sidePanels === n }" @click="setField(`wings[${i}].sidePanels`, n)" data-i18n-skip>{{ n }}</button>
              </div></div>
          </div>
        </div>
      </MdSec>

      <!-- 反射面 -->
      <MdSec id="g-refl" title="反射面" :count="refls ? refls.length : null">
        <template #actions>
          <button class="lb-mini" :disabled="!canAddRefl" title="加一副偏置抛物面反射面（占第一个空闲槽位）" @click="addRefl"><Icon name="plus" :size="12" />加反射面</button>
        </template>
        <div v-if="!refls" class="md-state bad"><Icon name="alert-triangle" :size="12" />反射面缺值。</div>
        <div v-else-if="!refls.length" class="lb-placeholder gn-none">无反射面。</div>
        <div v-for="(r, i) in refls || []" :key="'r' + i" class="gn-item">
          <div class="gn-ih">
            <b :class="{ 'md-red': bad(`reflectors[${i}]`) }" :title="tip('reflectors') || null">反射面</b><b data-i18n-skip :class="{ 'md-red': bad(`reflectors[${i}]`) }">{{ i + 1 }}</b>
            <select class="ci gn-slot" :value="r.slot" title="槽位：东西侧壁展开 / 对地板天线塔馈" @change="setField(`reflectors[${i}].slot`, $event.target.value)">
              <option v-for="s in SLOTS" :key="s.key" :value="s.key">{{ s.label }}</option>
            </select>
            <span class="sp"></span>
            <button class="lb-mini lb-mini-ico" title="删除这副反射面" @click="removeRefl(i)"><Icon name="trash" :size="12" /></button>
          </div>
          <div class="gn-grid">
            <GenNum :path="`reflectors[${i}].diameterM`" label="口径" unit="m" :min="0.01" :max="50" tip="偏置口径面直径" />
            <GenNum :path="`reflectors[${i}].focalM`" label="焦距" unit="m" allow-empty :min="0.01" :max="100" placeholder="f/D 示意" tip="母抛物面焦距；留空按 f/D 示意值" />
            <GenNum :path="`reflectors[${i}].offsetHM`" label="偏置高" unit="m" allow-empty :min="0" :max="100" placeholder="自动" tip="口径面中心到母轴的距离（GRASP 口径）；留空自动（内缘离侧壁留净空）" />
            <div class="gn-f2"><label title="馈源形式">馈源</label>
              <div class="lbu-seg gn-seg">
                <button :class="{ on: r.feedType !== 'array' }" @click="setField(`reflectors[${i}].feedType`, 'horn')">喇叭</button>
                <button :class="{ on: r.feedType === 'array' }" @click="setField(`reflectors[${i}].feedType`, 'array')">阵列</button>
              </div></div>
          </div>
          <div class="gn-chks">
            <label class="md-chkrow" title="可展开网状反射面（金属网 + 周边桁架）"><input type="checkbox" :checked="!!r.mesh" @change="setField(`reflectors[${i}].mesh`, $event.target.checked)" />网状</label>
            <label class="md-chkrow" title="赋形反射面（只记录，不改几何）"><input type="checkbox" :checked="!!r.shaped" @change="setField(`reflectors[${i}].shaped`, $event.target.checked)" />赋形</label>
          </div>
        </div>
      </MdSec>

      <!-- 馈源（独立喇叭 / 贴片阵；反射面自带的馈源不在这里）-->
      <MdSec id="g-feeds" title="馈源" :count="extras('feeds').length || null" :default-open="false"
             tip="独立馈源 / 测控喇叭 / 贴片阵（反射面焦点上的馈源随反射面自动生成，不在此列）">
        <template #actions>
          <button class="lb-mini" title="加一个独立馈源（对地板上、朝 +Z）" @click="addExtra('feeds')"><Icon name="plus" :size="12" />加馈源</button>
        </template>
        <div v-if="!extras('feeds').length" class="lb-placeholder gn-none">无独立馈源。</div>
        <div v-for="(f, i) in extras('feeds')" :key="'f' + i" class="gn-item">
          <div class="gn-ih">
            <b :class="{ 'md-red': bad(`feeds[${i}]`) }">馈源</b><b data-i18n-skip :class="{ 'md-red': bad(`feeds[${i}]`) }">{{ i + 1 }}</b>
            <div class="lbu-seg gn-seg gn-kind">
              <button :class="{ on: f.kind !== 'patchArray' }" title="锥形喇叭（长 1.6 × 口径）" @click="setField(`feeds[${i}].kind`, 'horn')">喇叭</button>
              <button :class="{ on: f.kind === 'patchArray' }" title="方形贴片阵（边长 = 口径）" @click="setField(`feeds[${i}].kind`, 'patchArray')">贴片阵</button>
            </div>
            <span class="sp"></span>
            <button class="lb-mini lb-mini-ico" title="删除这个馈源" @click="removeExtra('feeds', i)"><Icon name="trash" :size="12" /></button>
          </div>
          <div class="gn-grid">
            <GenVec :path="`feeds[${i}].posBody`" label="位置" unit="m" tip="口径面中心（本体系，原点 = 平台体中心）" />
            <GenVec :path="`feeds[${i}].dirBody`" label="指向" tip="辐射方向（本体系，不必归一）" />
            <GenNum :path="`feeds[${i}].apertureM`" label="口径" unit="m" :min="0.001" :max="20" />
          </div>
        </div>
      </MdSec>

      <!-- 其他：天线塔 / 杆件 / 推力器 / 散热面 -->
      <MdSec id="g-other" title="其他" :count="nExtras || null" :default-open="false" tip="天线塔、额外杆件、推力器、散热面">
        <div class="gn-sub">天线塔</div>
        <div class="gn-grid">
          <GenNum path="tower.hM" label="塔高" unit="m" allow-empty :min="0.01" :max="20" placeholder="自动" tip="对地板天线塔高度；留空按对地板反射面焦距自动（没有对地板反射面就不画）" />
          <GenNum path="tower.wM" label="截面" unit="m" allow-empty :min="0.01" :max="10" placeholder="自动" tip="天线塔截面边长；留空按细节档" />
        </div>

        <div class="gn-sub gn-subh"><span>杆件</span><span class="sp"></span>
          <button class="lb-mini" title="加一根杆件（碳纤维管）" @click="addExtra('booms')"><Icon name="plus" :size="12" />加杆件</button></div>
        <div v-for="(b, i) in extras('booms')" :key="'b' + i" class="gn-item">
          <div class="gn-ih">
            <b :class="{ 'md-red': bad(`booms[${i}]`) }">杆</b><b data-i18n-skip :class="{ 'md-red': bad(`booms[${i}]`) }">{{ i + 1 }}</b>
            <span class="sp"></span>
            <button class="lb-mini lb-mini-ico" title="删除这根杆件" @click="removeExtra('booms', i)"><Icon name="trash" :size="12" /></button>
          </div>
          <div class="gn-grid">
            <GenVec :path="`booms[${i}].fromBody`" label="起点" unit="m" tip="本体系，原点 = 平台体中心" />
            <GenVec :path="`booms[${i}].toBody`" label="终点" unit="m" tip="本体系，原点 = 平台体中心" />
            <GenNum :path="`booms[${i}].dM`" label="直径" unit="m" :min="0.001" :max="5" />
          </div>
        </div>

        <div class="gn-sub gn-subh"><span>推力器</span><span class="sp"></span>
          <button class="lb-mini" title="加一台推力器（背地板、喷流朝 −Z）" @click="addExtra('thrusters')"><Icon name="plus" :size="12" />加推力器</button></div>
        <div v-for="(t, i) in extras('thrusters')" :key="'t' + i" class="gn-item">
          <div class="gn-ih">
            <b :class="{ 'md-red': bad(`thrusters[${i}]`) }">推力器</b><b data-i18n-skip :class="{ 'md-red': bad(`thrusters[${i}]`) }">{{ i + 1 }}</b>
            <span class="sp"></span>
            <button class="lb-mini lb-mini-ico" title="删除这台推力器" @click="removeExtra('thrusters', i)"><Icon name="trash" :size="12" /></button>
          </div>
          <div class="gn-grid">
            <GenVec :path="`thrusters[${i}].posBody`" label="喉部" unit="m" tip="喷管喉部位置（本体系，原点 = 平台体中心）" />
            <GenVec :path="`thrusters[${i}].dirBody`" label="喷流" tip="喷流方向（本体系，不必归一）" />
            <GenNum :path="`thrusters[${i}].exitDM`" label="出口径" unit="m" :min="0.001" :max="5" />
            <GenNum :path="`thrusters[${i}].lengthM`" label="喷管长" unit="m" :min="0.001" :max="10" />
          </div>
        </div>

        <div class="gn-sub gn-subh"><span>散热面</span><span class="sp"></span>
          <button class="lb-mini" title="加一块散热面（贴在平台体外表面）" @click="addExtra('radiators')"><Icon name="plus" :size="12" />加散热面</button></div>
        <div v-for="(r, i) in extras('radiators')" :key="'rd' + i" class="gn-item">
          <div class="gn-ih">
            <b :class="{ 'md-red': bad(`radiators[${i}]`) }">散热面</b><b data-i18n-skip :class="{ 'md-red': bad(`radiators[${i}]`) }">{{ i + 1 }}</b>
            <select class="ci gn-side" :value="r.face" title="贴在平台体哪一面" @change="setField(`radiators[${i}].face`, $event.target.value)">
              <option v-for="fc in FACES" :key="fc" :value="fc">{{ FACE_LABEL[fc] }}</option>
            </select>
            <span class="sp"></span>
            <button class="lb-mini lb-mini-ico" title="删除这块散热面" @click="removeExtra('radiators', i)"><Icon name="trash" :size="12" /></button>
          </div>
          <div class="gn-grid">
            <GenNum :path="`radiators[${i}].wM`" label="宽" unit="m" :min="0.01" :max="50" tip="沿该面第一切向" />
            <GenNum :path="`radiators[${i}].hM`" label="高" unit="m" :min="0.01" :max="50" tip="沿该面第二切向" />
          </div>
        </div>
      </MdSec>

      <!-- 密度表：质量特性按它逐件累加 -->
      <MdSec id="g-dens" title="密度" :count="nDensity || null" :default-open="false" tip="质量特性按组件累加时用的密度 / 面密度 / 单件质量；留空 = 生成器缺省（全部为量级示意值，悬停看依据）">
        <template #actions>
          <button class="lb-mini lb-mini-ico" :disabled="!nDensity" title="全部回生成器缺省" @click="resetDensity"><Icon name="undo-2" :size="12" /></button>
        </template>
        <div class="gn-grid gn-dens">
          <GenNum v-for="d in DENSITY_ROWS" :key="d.key" :path="'density.' + d.key" :label="d.label" :unit="DENSITY[d.key].unit" allow-empty :min="0" :max="1e5"
                  :placeholder="String(DENSITY[d.key].value)" :tip="'示意值：' + DENSITY[d.key].note" />
        </div>
      </MdSec>
    </template>
  </div>
</template>

<style scoped>
.gn { display: flex; flex-direction: column; gap: 2px; }
.gn-top { display: flex; flex-direction: column; gap: 5px; padding-bottom: 8px; margin-bottom: 4px; border-bottom: 1px solid var(--lb-rule); }
.gn-seg { flex: 1 1 auto; min-width: 0; display: flex; }
.gn-seg > button { flex: 1 1 auto; min-width: 0; height: var(--h-ctl); padding-top: 0; padding-bottom: 0; font-size: var(--fs-3); overflow: hidden; text-overflow: ellipsis; }
.gn-read { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px; min-height: 18px; font-size: var(--fs-2); color: var(--text-muted); }
.gn-read b { color: var(--text); font-weight: 600; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.gn-read .u { color: var(--text-faint); }
.gn-read .s { color: var(--text-faint); padding: 0 1px; }
.gn-read .md-state { margin-left: auto; }
.gn-errs span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gn-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 3px 12px; }
.gn-f2 { display: flex; align-items: center; gap: 5px; min-width: 0; min-height: var(--h-ctl); }
.gn-f2 > label { flex: none; width: 58px; color: var(--text-muted); font-size: var(--fs-3); white-space: nowrap; }
.gn-f2 > .gn-seg { margin-right: 27px; }
.gn-chks { display: flex; flex-wrap: wrap; gap: 0 14px; }
.gn-item { border: 1px solid var(--border); border-radius: var(--r-box); padding: 5px 7px 6px; display: flex; flex-direction: column; gap: 4px; }
.gn-item:hover { border-color: var(--border-strong); }
.gn-ih { display: flex; align-items: center; gap: 5px; font-size: var(--fs-3); }
.gn-ih .sp { flex: 1; }
.gn-side, .gn-slot { flex: none !important; width: 108px; min-width: 0 !important; margin-left: 6px; }
.gn-none { text-align: left; padding: 2px 0; }
button.md-red { color: var(--danger) !important; }
.gn-kind { flex: none !important; width: 120px; margin-left: 6px; }
/* 「其他」节里的小节题：细线 + 小号字，与 .md-sec 的粗题线区分层级 */
.gn-sub { display: flex; align-items: center; gap: 5px; min-height: 22px; margin-top: 2px; font-size: var(--fs-2); font-weight: 600; color: var(--text-muted); border-bottom: 1px solid var(--lb-rule-soft); }
.gn-sub .sp { flex: 1; }
.gn-sub .lb-mini { height: 20px; }
/* 密度表：一列，标签与单位都要宽一些（「姿轨控推力器」「kg/m³」） */
.gn-dens { grid-template-columns: minmax(0, 1fr); --gn-lab: 96px; --gn-u: 42px; }
</style>
