<script setup>
// 装配属性面板（契约 §6.4）：单选 = 组件属性（名称 / 参数 / 安装 / 位置 / 质量与材质 / 对称）；多选 = 批量；无选中 = 文档属性。
//   · 参数行由 asmLogic.paramRows 按 ParamSpec 生成（num → NumIn、enum / 带选项的 int → 下拉、bool → 复选框）；口径 / 出处 / 范围只进 title。
//   · 描红：校验报到该键的错误，或模板示意值且还没改过（来源标记 wb.asm.prov）；提交任何参数即记 touched。
//   · 非法值照样提交（编辑器保留该件上次合法几何 + 红染，自动入库暂停），与生成页「缺值描红」同口径。
//   · 拖动中（gizmo / 拾起）只有安装量与位置随会话的实时量 ui.live 刷新（≤ 15 Hz；编辑器 liveOf 的小对象）；结构类选项
//     （父件 / 插座 / 面 / 安装插座 / 参数行）一律按已提交的文档算，拖动中不重算。松手后回到提交快照。
//   · 位置读数取编辑器解算表（asm.poseOf），不对冻结快照自己 solvePose（冻结数组会把编辑器热路径的读取点带成装箱，见编辑器 freezeDoc）。
//   · 只读：锁定件；拖动的就是这一件时（只读样式、不整片置灰）。拖别的件（从库里拖新件）属性面板照常。
import { inject, computed, ref, watch } from 'vue'
import Icon from '../../components/Icon.vue'
import NumIn from '../NumIn.vue'
import { getComponent } from '@core/models/components/index.mjs'
import { componentFacts } from '@core/models/assembly.mjs'
import { defaultAsmName } from '@core/models/asmMeta.mjs'
import {
  paramRows, paramErrors, compById, compLabel, parentChoices, socketChoices, faceChoices, mountChoices, splitSymInfo, materialOptions,
  densityRows, SYM_UI, SYM_AXIS_OPTIONS, MODE_UI, DOMAIN_LABELS, roleIcon, encOpt, decOpt, poseReadout, relPose, withPoseComponent,
  freeTQFromBody, mul16
} from '../asmLogic.js'
import { fmtNum } from '../wbLogic.js'
import { densKeysInWorker } from '../../viz/models/asmExport.js'

const asm = inject('asm')
const wb = inject('wb')
const ui = asm.ui
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
/** 领域 → 该领域组件（缺省参数）读到的密度表键（Worker 算好的，窗口内常驻；'sync' = 退回主线程算） */
const DOMAIN_DENS_KEYS = globalThis.__asmDomDensKeys || (globalThis.__asmDomDensKeys = new Map())

// 文档：已提交的快照（结构类选项、参数行都按它算）；拖动中被拖的就是选中件时，安装量与位姿另取 ui.live
const vdoc = computed(() => asm.doc.value)
const nSel = computed(() => ui.selIds.length)
const comp = computed(() => (nSel.value === 1 && vdoc.value ? compById(vdoc.value, ui.selIds[0]) : null))
const def = computed(() => (comp.value ? getComponent(comp.value.type) : null))
const locked = computed(() => !!(comp.value && comp.value.locked))
const isRoot = computed(() => !!(comp.value && comp.value.parent === null))
const live = computed(() => (ui.live && comp.value && ui.live.id === comp.value.id ? ui.live : null))
// gizmo / 拾起（含 Ctrl+D 复制后的拾起）拖的都是选中件本身；从库里拖新件（ghost）时属性面板照常可用
const beingDragged = computed(() => !!(ui.dragging && comp.value && ui.dragKind !== 'ghost'))
const ro = computed(() => locked.value || beingDragged.value)

const isOpen = (k) => ui.secOpen['p-' + k] !== false
function toggle(k) { ui.secOpen = { ...ui.secOpen, ['p-' + k]: !isOpen(k) } }

// ── 头行 ──
const headTip = computed(() => (def.value ? [def.value.type, def.value.title].filter(Boolean).join('\n') : ''))
function cmd(c) { return asm.cmd(c) }
function setHidden(on) { if (comp.value) cmd({ type: 'setHidden', ids: [comp.value.id], on }) }
function setLocked(on) { if (comp.value) cmd({ type: 'setLocked', ids: [comp.value.id], on }) }

// ── 名称 ──
function rename(ev) {
  const v = String(ev.target.value || '').trim()
  if (comp.value && v !== (comp.value.name || '')) cmd({ type: 'rename', id: comp.value.id, name: v })
}
const blurOnEnter = (ev) => { if (ev.key === 'Enter') ev.target.blur(); else if (ev.key === 'Escape') { ev.target.value = ev.target.defaultValue; ev.target.blur() } }

// ── 参数 ──
const rows = computed(() => (comp.value && def.value ? paramRows(def.value, comp.value.params, { compId: comp.value.id, prov: wb.asm.prov }) : []))
const generalErr = computed(() => (comp.value && def.value ? paramErrors(def.value, comp.value.params).general : []))
const nBad = computed(() => rows.value.filter((r) => r.bad).length)
function setParam(key, v) {
  const c = comp.value
  if (!c) return
  cmd({ type: 'setParams', id: c.id, params: { [key]: v } })
  wb.asmTouch(`${c.id}.${key}`)
}

// ── 安装 ──
const attach = computed(() => (live.value && live.value.attach) || (comp.value && comp.value.attach) || null)
const mode = computed(() => (attach.value ? attach.value.mode : 'free'))
const parentOpts = computed(() => (comp.value && vdoc.value ? parentChoices(vdoc.value, comp.value.id) : []))
const socketOpts = computed(() => (comp.value && vdoc.value ? socketChoices(vdoc.value, comp.value) : []))
const faceOpts = computed(() => (comp.value && vdoc.value ? faceChoices(vdoc.value, comp.value) : []))
const mountOpts = computed(() => (comp.value ? mountChoices(comp.value) : []))
const curFace = computed(() => faceOpts.value.find((f) => f.value === (attach.value && attach.value.face)) || null)
function setAttach(patch) {
  const c = comp.value
  if (!c) return
  const a = { ...plain(c.attach), ...patch }
  const o = { type: 'setAttach', id: c.id, attach: a }
  if (a.mode === 'free') { o.t = plain(c.t); o.q = plain(c.q) }
  cmd(o)
}
const setMode = (m) => { if (comp.value && m !== mode.value && !ro.value) cmd({ type: 'setMode', id: comp.value.id, mode: m }) }
const reparent = (p) => { if (comp.value && p && p !== comp.value.parent) cmd({ type: 'reparent', id: comp.value.id, parent: p }) }
const uvAt = (k) => (attach.value && Array.isArray(attach.value.uv) ? attach.value.uv[k] : 0)
function setUv(k, v) { const uv = [uvAt(0), uvAt(1)]; uv[k] = v; setAttach({ uv }) }
const uvMax = (k) => { const f = curFace.value; return f ? (k === 0 ? f.halfU : f.halfV) : Infinity }

// ── 位置（本体系 / 相对父件）──
// 位姿取编辑器解算表的副本（asm.poseOf）；拖动中取 ui.live 里的实时位姿。依赖 asm.doc.value：每次提交后重读
const pose = computed(() => { void vdoc.value; const c = comp.value; if (!c) return null; if (live.value && live.value.m) return live.value.m; return asm.poseOf(c.id) })
const parentPose = computed(() => { void vdoc.value; const c = comp.value; if (!c || !c.parent) return null; if (live.value && live.value.pm) return live.value.pm; return asm.poseOf(c.parent) })
const frameBody = computed(() => ui.posFrame === 'body' || isRoot.value)
const shown = computed(() => (pose.value ? (frameBody.value ? pose.value : relPose(parentPose.value, pose.value)) : null))
const rd = computed(() => (shown.value ? poseReadout(shown.value) : null))
const poseEditable = computed(() => mode.value === 'free' && !isRoot.value && !ro.value && !!pose.value)
const poseTip = computed(() => (poseEditable.value ? '' : isRoot.value ? '根件恒在本体原点' : '插座 / 贴面件的位姿由安装量决定（在视口里拖或改上面的安装量）'))
function setPoseK(k, v) {
  const c = comp.value
  if (!c || !poseEditable.value || !shown.value) return
  const next = withPoseComponent(shown.value, k, v)
  const mNew = frameBody.value || !parentPose.value ? next : mul16(parentPose.value, next)
  const r = freeTQFromBody(c.t || [0, 0, 0], c.q || [0, 0, 0, 1], pose.value, mNew)
  cmd({ type: 'setAttach', id: c.id, attach: plain(c.attach), t: r.t, q: r.q })
}

// ── 质量与材质 ──
// 自动质量 = 该件按当前参数 / 文档密度生成的质量（componentFacts：生成缓存轻层、不出 IR），按 (type, 参数, 密度) 记一份，拖动中快照换了也不重算
const massMemo = new Map()
const autoMass = computed(() => {
  const c = comp.value, d = vdoc.value
  if (!c || !d) return null
  const key = c.type + '|' + JSON.stringify(c.params) + '|' + JSON.stringify(d.density || {})
  if (massMemo.has(key)) return massMemo.get(key)
  let m = null
  const f = componentFacts(c.type, c.params, d.density)
  m = f ? f.massKg : null
  if (massMemo.size > 64) massMemo.clear()
  massMemo.set(key, m)
  return m
})
const MAT_OPTS = materialOptions()
const setMass = (v) => { if (comp.value) cmd({ type: 'setMass', id: comp.value.id, massKg: v }) }
const setMaterial = (v) => { if (comp.value) cmd({ type: 'setMaterial', id: comp.value.id, material: v || null }) }

// ── 对称 ──
const sym = computed(() => (comp.value && comp.value.sym) || null)
const symOp = computed(() => (sym.value ? sym.value.op : 'none'))
const ancestorSym = computed(() => {
  const d = vdoc.value, c = comp.value
  if (!d || !c) return ''
  let p = c.parent ? compById(d, c.parent) : null, guard = 0
  while (p && guard++ < 256) { if (p.sym) return p.id; p = p.parent ? compById(d, p.parent) : null }
  return ''
})
const symLock = computed(() => ro.value || isRoot.value || !!ancestorSym.value)
const symTip = computed(() => (isRoot.value ? '根件不能对称' : ancestorSym.value ? `随祖先 ${ancestorSym.value} 对称（不支持嵌套对称）` : '对称：派生件随主件自动生成'))
function setSymOp(op) {
  const c = comp.value
  if (!c) return
  if (op === 'none') cmd({ type: 'setSym', id: c.id, sym: null })
  else if (op === 'radial') cmd({ type: 'setSym', id: c.id, sym: { op, n: sym.value && sym.value.n ? sym.value.n : 2, axis: (sym.value && sym.value.axis) || undefined } })
  else cmd({ type: 'setSym', id: c.id, sym: { op } })
}
function setSymField(k, v) { const c = comp.value; if (c && sym.value) cmd({ type: 'setSym', id: c.id, sym: { ...plain(sym.value), [k]: v } }) }
const split = computed(() => (comp.value ? splitSymInfo(comp.value) : { ok: false, why: '' }))

// ── 多选 ──
const selComps = computed(() => (vdoc.value ? ui.selIds.map((id) => compById(vdoc.value, id)).filter(Boolean) : []))
const allHidden = computed(() => selComps.value.length > 0 && selComps.value.every((c) => c.hidden))
const allLocked = computed(() => selComps.value.length > 0 && selComps.value.every((c) => c.locked))
const anyLocked = computed(() => selComps.value.some((c) => c.locked))
const hasRoot = computed(() => selComps.value.some((c) => c.parent === null))

// ── 文档属性（无选中）──
const d = computed(() => vdoc.value)
const docName = computed(() => (d.value && d.value.name) || '')
function setDocName(ev) {
  const v = String(ev.target.value || '').trim()
  if (d.value && v !== d.value.name) cmd({ type: 'setDoc', patch: { name: v || defaultAsmName(d.value.domain) } })
}
// 只列文档内各件 ∪ 本领域组件实际用到的密度键（飞机 / 地球站文档不列太阳翼基板、电池片、反射面、MLI、OSR）。
// 「本领域组件（缺省参数）读哪些键」要把整个领域生成一遍（船体一套 ~30 ms）：放 Worker 里算、按领域记一份；没到之前先只列文档内各件的
const domKeys = ref(null)   // null = 还没到；'sync' = Worker 不可用，退回主线程同步算
watch(() => (d.value ? d.value.domain : ''), async (dom) => {
  if (!dom) return
  if (DOMAIN_DENS_KEYS.has(dom)) { domKeys.value = DOMAIN_DENS_KEYS.get(dom); return }
  domKeys.value = null
  const k = await densKeysInWorker(dom)
  DOMAIN_DENS_KEYS.set(dom, Array.isArray(k) ? k : 'sync')
  if (d.value && d.value.domain === dom) domKeys.value = DOMAIN_DENS_KEYS.get(dom)
}, { immediate: true })
const dens = computed(() => (d.value ? densityRows(d.value.density, d.value, domKeys.value === 'sync' ? {} : { domainKeys: domKeys.value || [] }) : []))
const nDens = computed(() => dens.value.filter((r) => r.value != null).length)
const setDens = (k, v) => cmd({ type: 'setDoc', patch: { density: { [k]: v } } })
const massAuto = computed(() => ui.stats.massKg)
// 目标质量的余量由「首个带质量汇点（平台体 / 机身 / 船体 / 车体）、质量没手填的件」吃掉（assembly.collectMass）：文档里没有这样的件
// （地球站）时目标质量不生效——没填过就禁用输入；填过的（换根 / 删件之后失效）留着能清，下面出一行状态
const hasSink = computed(() => !!(d.value && d.value.comps.some((c) => {
  const df = getComponent(c.type)
  return !!(df && df.massSink) && !(typeof c.massKg === 'number' && c.massKg > 0) && !(c.params && typeof c.params.massKg === 'number' && Number.isFinite(c.params.massKg))
})))
// 空文档不禁用（先填目标、再放平台体照样生效）
const targetOff = computed(() => !!(d.value && d.value.comps.length) && !hasSink.value && d.value.massTargetKg == null)
const targetTip = computed(() => (hasSink.value ? '整件目标质量：余量由平台体 / 机身 / 船体 / 车体吃掉；留空 = 按组件累加' : '整件目标质量：文档里没有可吃余量的平台体 / 机身 / 船体 / 车体（或它们的质量已手填），目标质量不生效'))
const massWarnShort = computed(() => { const w = ui.stats.massWarn || ''; return !w ? '' : w.includes('未生效') ? '目标质量未生效。' : '目标质量小于其余组件合计。' })
</script>

<template>
  <div class="asm-propbox">
    <!-- ═══ 单件 ═══ -->
    <template v-if="comp && def">
      <div class="asm-hd">
        <span class="asm-hd-ic"><Icon :name="roleIcon(def.role)" :size="13" /></span>
        <span class="asm-hd-t" :title="headTip" data-i18n-skip>{{ def.titleZh || def.title }}</span>
        <span class="asm-hd-id" data-i18n-skip>{{ comp.id }}</span>
        <span class="sp"></span>
        <button class="asm-ib" :class="{ on: comp.hidden }" data-act="p-hide" :title="comp.hidden ? '显示' : '隐藏'" :disabled="beingDragged" @click="setHidden(!comp.hidden)"><Icon :name="comp.hidden ? 'eye-off' : 'eye'" :size="13" /></button>
        <button class="asm-ib" :class="{ on: locked }" data-act="p-lock" :title="locked ? '解锁' : '锁定'" :disabled="beingDragged" @click="setLocked(!locked)"><Icon :name="locked ? 'lock' : 'lock-open'" :size="13" /></button>
      </div>
      <div class="asm-props" :class="{ 'asm-live': beingDragged }">
        <div class="sec">
          <div class="srow">
            <label>名称</label>
            <input :key="comp.id + '|' + (comp.name || '')" class="ci asm-txt" type="text" spellcheck="false" :value="comp.name || ''" :placeholder="def.titleZh || def.title" :disabled="ro"
                   title="显示名（结构树 / 部件名）；留空 = 组件缺省名。挂点 / 关节 / 太阳翼组的名字只由组件 id 决定，改名不影响绑定" @change="rename" @keydown="blurOnEnter" />
            <span class="u"></span>
          </div>
          <div v-if="generalErr.length" class="md-state bad" data-i18n-skip><Icon name="alert-triangle" :size="12" />{{ generalErr[0] }}</div>
        </div>

        <!-- 参数 -->
        <div class="sec" data-sec="params">
          <div class="sect acc" @click="toggle('params')">
            <Icon name="chevron-down" class="disc" :class="{ shut: !isOpen('params') }" :size="12" />
            <span class="sect-t">参数</span>
            <span class="cnt" :class="{ bad: nBad }" data-i18n-skip>{{ nBad ? nBad + ' / ' : '' }}{{ rows.length }}</span>
          </div>
          <template v-if="isOpen('params')">
            <div v-for="r in rows" :key="comp.id + '.' + r.key" class="srow" :data-param="r.key">
              <label :class="{ 'md-red': r.bad }" :title="r.title || null">{{ r.label }}</label>
              <NumIn v-if="r.control === 'num'" :model-value="r.value" :min="r.min" :max="r.max" :integer="r.integer" :allow-empty="r.allowEmpty"
                     :placeholder="r.placeholder" :bad="r.bad" :title="r.title" :sig="6" :disabled="ro" @commit="(v) => setParam(r.key, v)" />
              <select v-else-if="r.control === 'select'" :class="{ 'md-red': r.bad }" :value="encOpt(r.value)" :title="r.title || null" :disabled="ro" @change="setParam(r.key, decOpt($event.target.value))">
                <option v-for="o in r.options" :key="encOpt(o.value)" :value="encOpt(o.value)">{{ o.label }}</option>
              </select>
              <label v-else class="md-chkrow" :title="r.title || null"><input type="checkbox" :checked="!!r.value" :disabled="ro" @change="setParam(r.key, $event.target.checked)" /></label>
              <span class="u" data-i18n-skip>{{ r.unit }}</span>
            </div>
          </template>
        </div>

        <!-- 安装 -->
        <div class="sec" data-sec="install">
          <div class="sect acc" @click="toggle('install')">
            <Icon name="chevron-down" class="disc" :class="{ shut: !isOpen('install') }" :size="12" />
            <span class="sect-t">安装</span>
          </div>
          <template v-if="isOpen('install')">
            <div v-if="isRoot" class="srow"><label>方式</label><span class="asm-ro dim">根件</span></div>
            <template v-else>
              <div class="srow">
                <label>父件</label>
                <select :value="comp.parent" :disabled="ro" title="改父件：方式变为自由、世界位姿不动" @change="reparent($event.target.value)">
                  <option v-for="o in parentOpts" :key="o.value" :value="o.value">{{ o.label }}</option>
                </select>
              </div>
              <div class="srow">
                <label>方式</label>
                <div class="seg nseg">
                  <span v-for="m in MODE_UI" :key="m.key" class="sg" :class="{ on: mode === m.key, off: ro }" :data-act="'mode-' + m.key" :title="m.tip" @click="setMode(m.key)">{{ m.label }}</span>
                </div>
              </div>
              <div v-if="mode === 'socket'" class="srow">
                <label>插座</label>
                <select :value="attach.socket || ''" :disabled="ro" title="父件的插座（只列接得了本件、且没被占用的）" @change="setAttach({ socket: $event.target.value })">
                  <option v-for="o in socketOpts" :key="o.value" :value="o.value">{{ o.label }}{{ o.ok ? '' : '（不兼容）' }}</option>
                </select>
              </div>
              <template v-if="mode === 'surface'">
                <div class="srow">
                  <label>面</label>
                  <select :value="attach.face || ''" :disabled="ro" title="父件的可贴面" @change="setAttach({ face: $event.target.value, uv: [0, 0] })">
                    <option v-for="o in faceOpts" :key="o.value" :value="o.value">{{ o.label }}</option>
                  </select>
                </div>
                <div class="srow">
                  <label title="面内偏移（以面心为原点；柱面 u 沿轴、v 为弧长）">u / v</label>
                  <div class="asm-v3 two">
                    <NumIn :model-value="uvAt(0)" :min="-uvMax(0)" :max="uvMax(0)" :sig="6" :disabled="ro" title="u（m）" @commit="(v) => setUv(0, v)" />
                    <NumIn :model-value="uvAt(1)" :min="-uvMax(1)" :max="uvMax(1)" :sig="6" :disabled="ro" title="v（m）" @commit="(v) => setUv(1, v)" />
                  </div>
                  <span class="u">m</span>
                </div>
              </template>
              <div v-if="mode !== 'free'" class="srow">
                <label title="绕插座 / 面法向的滚转（0° = 插座上向 / 面 u 方向）">滚转</label>
                <NumIn :model-value="attach.roll" :sig="6" :disabled="ro" title="滚转（°）" @commit="(v) => setAttach({ roll: v })" />
                <span class="u">°</span>
              </div>
              <div v-if="mode !== 'free'" class="srow">
                <label title="本件拿哪个插座去贴父件">安装插座</label>
                <select :value="attach.mount || ''" :disabled="ro" @change="setAttach({ mount: $event.target.value || null })">
                  <option v-for="o in mountOpts" :key="o.value" :value="o.value">{{ o.label }}</option>
                </select>
              </div>
              <div v-if="mode === 'free' && (attach.socket || attach.face)" class="srow">
                <label title="自由件的位姿相对这个锚点系">锚点</label>
                <span class="asm-ro" data-i18n-skip>{{ attach.socket || attach.face }}</span>
              </div>
            </template>
          </template>
        </div>

        <!-- 位置 -->
        <div class="sec" data-sec="pose">
          <div class="sect acc" @click="toggle('pose')">
            <Icon name="chevron-down" class="disc" :class="{ shut: !isOpen('pose') }" :size="12" />
            <span class="sect-t">位置</span>
          </div>
          <template v-if="isOpen('pose') && rd">
            <div v-if="!isRoot" class="srow">
              <label>坐标系</label>
              <div class="seg nseg">
                <span class="sg" :class="{ on: ui.posFrame !== 'body' }" data-act="pos-parent" title="相对父件坐标系" @click="ui.posFrame = 'parent'">相对父件</span>
                <span class="sg" :class="{ on: ui.posFrame === 'body' }" data-act="pos-body" title="本体系（文档原点 = 根件坐标系）" @click="ui.posFrame = 'body'">本体系</span>
              </div>
            </div>
            <div class="srow">
              <label :title="poseTip || null">位置</label>
              <div class="asm-v3">
                <NumIn v-for="k in 3" :key="'t' + k" :model-value="rd.t[k - 1]" :sig="7" :disabled="!poseEditable" :title="'XYZ'[k - 1] + '（m）'" @commit="(v) => setPoseK(k - 1, v)" />
              </div>
              <span class="u">m</span>
            </div>
            <div class="srow">
              <label :title="poseTip || '3-2-1 欧拉角：R = Rz(偏航)·Ry(俯仰)·Rx(滚转)'">姿态</label>
              <div class="asm-v3">
                <NumIn v-for="k in 3" :key="'r' + k" :model-value="rd.rpy[k - 1]" :sig="6" :disabled="!poseEditable" :title="['滚转', '俯仰', '偏航'][k - 1] + '（°）'" @commit="(v) => setPoseK(k + 2, v)" />
              </div>
              <span class="u">°</span>
            </div>
          </template>
        </div>

        <!-- 质量与材质 -->
        <div class="sec" data-sec="mass">
          <div class="sect acc" @click="toggle('mass')">
            <Icon name="chevron-down" class="disc" :class="{ shut: !isOpen('mass') }" :size="12" />
            <span class="sect-t">质量与材质</span>
          </div>
          <template v-if="isOpen('mass')">
            <div class="srow">
              <label>质量</label>
              <NumIn :model-value="comp.massKg" allow-empty :min="0" :sig="6" :disabled="ro" :placeholder="autoMass != null ? fmtNum(autoMass, 5) : '自动'"
                     title="留空 = 按组件几何与文档密度自动估算（占位显示自动值）" @commit="setMass" />
              <span class="u">kg</span>
            </div>
            <div class="srow">
              <label>材质</label>
              <select :value="comp.material || ''" :disabled="ro" title="整件换一种表面材质；组件缺省 = 各部分用组件自己的材质" @change="setMaterial($event.target.value)">
                <option v-for="o in MAT_OPTS" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
            </div>
          </template>
        </div>

        <!-- 对称 -->
        <div class="sec" data-sec="sym">
          <div class="sect acc" @click="toggle('sym')">
            <Icon name="chevron-down" class="disc" :class="{ shut: !isOpen('sym') }" :size="12" />
            <span class="sect-t">对称</span>
          </div>
          <template v-if="isOpen('sym')">
            <div class="srow">
              <label :title="symTip">方式</label>
              <select :value="symOp" :disabled="symLock" :title="symTip" @change="setSymOp($event.target.value)">
                <option v-for="s in SYM_UI" :key="s.key" :value="s.key">{{ s.label }}</option>
              </select>
            </div>
            <template v-if="symOp === 'radial'">
              <div class="srow">
                <label>数量</label>
                <select :value="String(sym.n || 2)" :disabled="symLock" title="件数（含主件）" @change="setSymField('n', Number($event.target.value))">
                  <option v-for="n in 7" :key="n" :value="String(n + 1)">{{ n + 1 }}</option>
                </select>
              </div>
              <div class="srow">
                <label>轴</label>
                <select :value="sym.axis || ''" :disabled="symLock" title="径向均布的旋转轴（本体系）" @change="setSymField('axis', $event.target.value)">
                  <option v-for="a in SYM_AXIS_OPTIONS" :key="a" :value="a">{{ a }}</option>
                </select>
              </div>
            </template>
            <div v-if="symOp !== 'none'" class="md-acts">
              <button class="lb-mini" data-act="p-split" :disabled="!split.ok || ro" :title="split.ok ? '拆分：派生件转为独立件（之后各改各的）' : split.why" @click="cmd({ type: 'splitSym', id: comp.id })">
                <Icon name="unlink-2" :size="12" />拆分
              </button>
            </div>
          </template>
        </div>
      </div>
    </template>

    <!-- ═══ 多选 ═══ -->
    <template v-else-if="nSel > 1">
      <div class="asm-hd"><span class="asm-hd-k">属性</span><span class="asm-hd-n" data-i18n-skip>{{ selComps.length }}</span></div>
      <div class="asm-props">
        <div class="sec">
          <div class="md-kvs one">
            <div class="md-kv"><span class="k">已选</span><span class="v" data-i18n-skip>{{ selComps.length }}</span><span class="u">件</span></div>
          </div>
          <div class="md-acts">
            <button class="lb-mini" data-act="m-hide" :disabled="ui.dragging" @click="cmd({ type: 'setHidden', ids: ui.selIds.slice(), on: !allHidden })"><Icon :name="allHidden ? 'eye' : 'eye-off'" :size="12" />{{ allHidden ? '显示' : '隐藏' }}</button>
            <button class="lb-mini" data-act="m-lock" :disabled="ui.dragging" @click="cmd({ type: 'setLocked', ids: ui.selIds.slice(), on: !allLocked })"><Icon :name="allLocked ? 'lock-open' : 'lock'" :size="12" />{{ allLocked ? '解锁' : '锁定' }}</button>
            <button class="lb-mini" data-act="m-mirror" :disabled="anyLocked || hasRoot || ui.dragging" title="镜像（M）" @click="asm.mirror()"><Icon name="flip-horizontal-2" :size="12" />镜像</button>
            <button class="lb-mini" data-act="m-remove" :disabled="anyLocked || ui.dragging" title="删除（Delete）" @click="asm.remove()"><Icon name="trash" :size="12" />删除</button>
          </div>
          <div class="asm-sel-list" data-i18n-skip>
            <span v-for="c in selComps" :key="c.id" class="asm-sel-chip" :title="c.type">{{ compLabel(c) }}<i>{{ c.id }}</i></span>
          </div>
        </div>
      </div>
    </template>

    <!-- ═══ 文档属性（无选中）═══ -->
    <template v-else-if="d">
      <div class="asm-hd"><span class="asm-hd-k">文档</span><span class="asm-hd-t" data-i18n-skip>{{ docName || defaultAsmName(d.domain) }}</span></div>
      <div class="asm-props">
        <div class="sec">
          <div class="srow">
            <label>名称</label>
            <input :key="'doc|' + docName" class="ci asm-txt" type="text" spellcheck="false" :value="docName" :placeholder="defaultAsmName(d.domain)" title="装配件名（库卡片 / 3D 页里的模型名）" @change="setDocName" @keydown="blurOnEnter" />
            <span class="u"></span>
          </div>
          <div class="srow"><label>领域</label><span class="asm-ro dim">{{ DOMAIN_LABELS[d.domain] || d.domain }}</span></div>
          <div class="srow">
            <label>目标质量</label>
            <NumIn :model-value="d.massTargetKg" allow-empty :min="0" :sig="6" :placeholder="massAuto ? fmtNum(massAuto, 5) : ''" :disabled="targetOff"
                   :title="targetTip" @commit="(v) => cmd({ type: 'setDoc', patch: { massTargetKg: v } })" />
            <span class="u">kg</span>
          </div>
          <div v-if="massWarnShort && d.massTargetKg != null" class="md-state bad" data-act="mass-warn" :title="ui.stats.massWarn"><Icon name="alert-triangle" :size="12" />{{ massWarnShort }}</div>
        </div>
        <div class="sec" data-sec="density">
          <div class="sect acc" @click="toggle('density')">
            <Icon name="chevron-down" class="disc" :class="{ shut: !isOpen('density') }" :size="12" />
            <span class="sect-t">密度</span>
            <span class="cnt" data-i18n-skip>{{ nDens || '' }}</span>
          </div>
          <template v-if="isOpen('density')">
            <div v-for="r in dens" :key="r.key" class="srow asm-dens">
              <label :title="r.title">{{ r.label }}</label>
              <NumIn :model-value="r.value" allow-empty :min="0" :max="1e5" :sig="6" :placeholder="String(r.def)" :title="r.title" @commit="(v) => setDens(r.key, v)" />
              <span class="u" data-i18n-skip>{{ r.unit }}</span>
            </div>
          </template>
        </div>
      </div>
    </template>
    <div v-else class="asm-empty">尚无装配文档。</div>
  </div>
</template>

<style scoped>
.asm-propbox { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.asm-props { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; font-size: var(--fs-3); }
/* 标签列定宽、长标签折两行（不截断、也不把输入框挤出对齐线：「桁架杆半径 / 口径」一类）。整个面板（组件 / 文档 / 密度行）
   同一组标签宽与单位宽：左右缘都落在同一条线上 */
.asm-props .srow { --srow-lab: 84px; }
.asm-props .srow > .u { min-width: 34px; }
/* 没有单位列的行（下拉 / 分段 / 只读）补一个同宽的空位：所有控件的右缘对齐在同一条线上 */
.asm-props .srow:not(:has(> .u))::after { content: ''; flex: none; width: 34px; }
/* 拖着这一件时：控件只读（不接受输入），样式不整片换成禁用灰——读数照常清楚 */
.asm-props.asm-live :deep(:is(input, select, .seg)) { pointer-events: none; }
.asm-props.asm-live :deep(:is(input, select):disabled) { opacity: 1; color: var(--text); background: var(--field-bg); }
.asm-props .srow > label:not(.md-chkrow) { width: var(--srow-lab); min-width: var(--srow-lab); white-space: normal; overflow: visible; text-overflow: clip; word-break: keep-all; overflow-wrap: anywhere; line-height: 1.25; }
.asm-hd-ic { flex: none; display: inline-flex; color: var(--accent-ui); }
.cnt.bad { color: var(--danger); }
.asm-v3.two { grid-template-columns: repeat(2, minmax(0, 1fr)); flex-basis: 110px; min-width: 110px; }
.md-kvs.one { grid-template-columns: minmax(0, 1fr); }
.asm-sel-list { display: flex; flex-wrap: wrap; gap: 4px; }
.asm-sel-chip { display: inline-flex; align-items: baseline; gap: 5px; padding: 2px 6px; font-size: var(--fs-2); color: var(--text); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-ctl); }
.asm-sel-chip i { font-style: normal; font-family: var(--font-mono); font-size: var(--fs-1); color: var(--text-faint); }
.srow > select.md-red { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 70%, var(--field-border)); }
</style>
