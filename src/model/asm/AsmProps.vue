<script setup>
// 装配属性面板（契约 §6.4）：单选 = 组件属性（名称 / 参数 / 安装 / 位置 / 质量与材质 / 对称）；多选 = 批量；
// 无选中（结构树根节点）= 模型级属性（2026-10 统一设计：原「模型」页对装配件只读的那些量在这里——概况 / 质量特性 / 改写清单 /
// 挂点 · 关节 · 太阳翼组 / 密度）。
//   · 参数分两档：主要参数（asmLogic.KEY_PARAMS）常开，细节参数缺省折叠；驱动装配件的参数行标驱动（链环）/ 改写（加粗 + 色条 + 恢复钮），
//     设参数一律走会话 setParams（联动参数直写驱动参数）。
//   · 参数行由 asmLogic.paramRows 按 ParamSpec 生成（num → NumIn、enum / 带选项的 int → 下拉、bool → 复选框）；口径 / 出处 / 范围只进 title。
//   · 描红：校验报到该键的错误，或模板示意值且还没改过（来源标记 wb.asm.prov）；提交任何参数即记 touched。
//   · 非法值照样提交（编辑器保留该件上次合法几何 + 红染，自动入库暂停），与生成页「缺值描红」同口径。
//   · 拖动中（gizmo / 拾起）只有安装量与位置随会话的实时量 ui.live 刷新（≤ 15 Hz；编辑器 liveOf 的小对象）；结构类选项
//     （父件 / 接口 / 面 / 安装接口 / 参数行）一律按已提交的文档算，拖动中不重算。松手后回到提交快照。
//   · 「安装」节（2026-10-06 任务书 §3.3.3）：选中非根件时置顶、缺省展开（结构树高度随行数自适应，见 AsmDock）。
//     接口下拉 = asmSnap.freeSocketChoices（与编辑器落点同一占用口径，占用按编辑器解算表的位姿认）；安装接口下拉 = asmSnap.mountChoices
//     （本件接口 ∪「面心 …」∪「包围盒 …」，B 键循环同一份）；偏移（接口：x / y / 法向；面安装：法向）、倾角（两轴，t0 ∈ ±90°）、
//     滚转、u / v、带锚自由件的锚系位姿：数值写入走 setAttach（asmSnap.applyCmd 同一语义），按「件 + 键」MERGE_MS 内合并成一步撤销
//     （编辑器 apply 只合并 setParams：这里先在文档副本上跑 applyCmd，再交编辑器 replaceDoc 带 mergeKey 提交）。
//     方式三键 = setMode（内核保持世界位姿、保锚）；失败时在方式行下给内核的状态短语（「无可用接口。」）。
//     数值框统一 NumIn：键入过才在失焦时提交、外部值变了丢草稿；按件 id 作 key（换件 = 新框，旧草稿不会落到新件上）。
//   · 位置读数取编辑器解算表（asm.poseOf），不对冻结快照自己 solvePose（冻结数组会把编辑器热路径的读取点带成装箱，见编辑器 freezeDoc）。
//   · 只读：锁定件；拖动的就是这一件时（只读样式、不整片置灰）。拖别的件（从库里拖新件）属性面板照常。
import { inject, computed, ref, watch, onBeforeUnmount } from 'vue'
import Icon from '../../components/Icon.vue'
import NumIn from '../NumIn.vue'
import ParamRow from './ParamRow.vue'
import { getComponent } from '@core/models/components/index.mjs'
import { componentFacts, buildAssembly, asmHash } from '@core/models/assembly.mjs'
import { isDriven, driveMarks, driveBase } from '@core/models/drive.mjs'
import { principalInertia } from '@core/models/massProps.mjs'
import { setSpecValue } from '../quickLogic.js'
import { defaultAsmName } from '@core/models/asmMeta.mjs'
import { freeSocketChoices, mountChoices as mountChoicesOf, mountLabel, faceLabel, faceMountable, applyCmd } from '@core/models/asmSnap.mjs'
import {
  paramRows, paramErrors, compById, compLabel, parentChoices, faceChoices, splitSymInfo, materialOptions,
  densityRows, SYM_UI, SYM_AXIS_OPTIONS, MODE_UI, DOMAIN_LABELS, roleIcon, encOpt, decOpt, poseReadout, relPose, withPoseComponent,
  freeTQFromBody, mul16, optText, offAxesOf, offOf, tiltOf, offPatch, tiltPatch, attachMergeKey, anchorOf, tqReadout, tqWith, ROOT_LABELS, wholeMassLabel
} from '../asmLogic.js'
import { fmtNum, STAGE_LABEL } from '../wbLogic.js'
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

// 分节开合记在会话 ui.secOpen（键 p-*）；细节参数 / 改写清单 / 派生量缺省折叠
const CLOSED_BY_DEFAULT = new Set(['pmore', 'over', 'derived'])
const isOpen = (k) => { const v = ui.secOpen['p-' + k]; return v === undefined ? !CLOSED_BY_DEFAULT.has(k) : v }
function toggle(k) { ui.secOpen = { ...ui.secOpen, ['p-' + k]: !isOpen(k) } }

// ── 驱动装配件：每件相对驱动基线的状态（drive.driveMarks）──
const driven = computed(() => isDriven(vdoc.value))
const marksAll = computed(() => (driven.value ? driveMarks(vdoc.value) : {}))
const mk = computed(() => (comp.value ? marksAll.value[comp.value.id] || null : null))
const baseOf = (id) => { if (!driven.value) return null; const b = driveBase(vdoc.value.drive.spec); return b.ok ? b.byId.get(id) || null : null }
const baseC = computed(() => (comp.value ? baseOf(comp.value.id) : null))
const rowState = (r) => (mk.value && mk.value.params ? mk.value.params[r.key] || '' : '')
function valText(v, r) {
  if (v === null || v === undefined) return '自动'
  if (typeof v === 'number') return fmtNum(v, 6) + (r && r.unit ? ' ' + r.unit : '')
  if (typeof v === 'boolean') return v ? '是' : '否'
  const o = r && r.options ? r.options.find((x) => x.value === v) : null
  return o ? o.label : String(v)
}
const baseText = (r) => (baseC.value ? valText(baseC.value.params[r.key], r) : '')
const resetParam = (key) => { if (comp.value) asm.resetBase(comp.value.id, key) }
const nOver = computed(() => { const m = mk.value; if (!m || m.user) return 0; return Object.values(m.params || {}).filter((x) => x === 'over').length + ['attach', 'pose', 'mass', 'material', 'name', 'sym'].filter((k) => m[k]).length })

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
  asm.setParams(c.id, { [key]: v })
  wb.asmTouch(`${c.id}.${key}`)
}
const mainRows = computed(() => rows.value.filter((r) => r.main))
const moreRows = computed(() => rows.value.filter((r) => !r.main))
const nMoreOver = computed(() => moreRows.value.filter((r) => rowState(r) === 'over').length)

// ── 安装 ──
const attach = computed(() => (live.value && live.value.attach) || (comp.value && comp.value.attach) || null)
const mode = computed(() => (attach.value ? attach.value.mode : 'free'))
// 结构类选项（父件 / 接口 / 面 / 安装接口）按已提交文档的普通副本算：冻结快照不进内核的生成 / 解算缓存（编辑器 freezeDoc 注释）
const pdoc = computed(() => (vdoc.value ? JSON.parse(JSON.stringify(vdoc.value)) : null))
const pcomp = computed(() => (comp.value && pdoc.value ? compById(pdoc.value, comp.value.id) : null))
const parentOpts = computed(() => (comp.value && vdoc.value ? parentChoices(vdoc.value, comp.value.id) : []))
// 接口下拉：与编辑器落点同一口径（兼容、非父件自身安装接口、未被占用——几何占用按编辑器解算表的位姿认，件当前的接口恒列出）
const socketOpts = computed(() => {
  const c = pcomp.value, d = pdoc.value
  if (!c || !d || c.parent == null) return []
  const poses = new Map()
  for (const x of d.comps) { const m = asm.poseOf(x.id); if (m) poses.set(x.id, m) }
  let list = []
  try { list = freeSocketChoices(d, c.id, null, poses.size ? poses : undefined) } catch { list = [] }
  return list.map((o) => ({ value: o.id, label: optText(o.label, o.id) }))
})
// 面下拉：父件的可安装面（faceMountable：机构 / 小件的面不收件），件当前的面恒列出
const faceOpts = computed(() => {
  const c = pcomp.value, d = pdoc.value
  if (!c || !d) return []
  const par = c.parent != null ? compById(d, c.parent) : null
  const cur = c.attach && c.attach.face
  return faceChoices(d, c).filter((f) => f.value === cur || !par || faceMountable(par, f.value, c.type)).map((f) => ({ ...f, label: optText(faceLabel(f.value), f.value) }))
})
// 安装接口：本件接口 ∪「面心 …」∪「包围盒 …」（asmSnap.mountChoices，去重后与 B 键循环同一份）；null = 组件缺省安装接口
const mountVal = computed(() => (attach.value && attach.value.mount) || (def.value && def.value.mountSocket) || '')
const mountOpts = computed(() => {
  const c = pcomp.value
  if (!c) return []
  let list = []
  try { list = mountChoicesOf({ ...c, attach: { ...c.attach, mount: mountVal.value || null } }) } catch { list = [] }
  const out = list.map((o) => ({ value: o.id, label: optText(o.label, o.id) }))
  if (mountVal.value && !out.some((o) => o.value === mountVal.value)) out.unshift({ value: mountVal.value, label: optText(mountLabel(mountVal.value), mountVal.value) })
  return out
})
const curFace = computed(() => faceOpts.value.find((f) => f.value === (attach.value && attach.value.face)) || null)
/** 结构类改动（换接口 / 面 / 安装接口 / 居中）：一条 setAttach、一步撤销 */
function setAttach(patch) {
  const c = comp.value
  if (!c) return
  const a = { ...plain(c.attach), ...patch }
  const o = { type: 'setAttach', id: c.id, attach: a }
  if (a.mode === 'free') { o.t = plain(c.t); o.q = plain(c.q) }
  cmd(o)
}
function setMount(id) { const dm = def.value && def.value.mountSocket; setAttach({ mount: !id || id === dm ? null : id }) }
/**
 * 数值改动（偏移 / 倾角 / 滚转 / u v / 锚系位姿）：同一条 setAttach 语义，按「件 + 键」合并撤销（MERGE_MS 内连续输入合成一步）。
 * 先在编辑器文档的副本上跑 asmSnap.applyCmd（与 editor.apply 同一函数），再交编辑器 replaceDoc 带 mergeKey 提交。tq = 自由件的新 t / q。
 */
function setAttachNum(patch, key, tq) {
  const c = comp.value
  if (!c || ro.value) return
  const ed = asm.editor ? asm.editor() : null
  let cur = null
  try { cur = ed ? ed.getDoc() : null } catch { cur = null }
  const cc = cur ? compById(cur, c.id) : null
  if (!cc) return
  const a = { ...cc.attach, ...patch }
  const o = { type: 'setAttach', id: c.id, attach: a }
  if (a.mode === 'free') { o.t = tq ? tq.t : cc.t; o.q = tq ? tq.q : cc.q }
  const r = applyCmd(cur, o)
  if (!r.ok) { asm.setStatus('error', r.error, 4000); return }
  if (!r.changed) return
  const out = asm.replaceDoc(r.doc, { label: 'setAttach', mergeKey: attachMergeKey(c.id, key) })
  if (out && out.ok && r.symDropped && r.symDropped.length) asm.setStatus('warn', `${compLabel(compById(r.doc, c.id))} 已取消对称。`, 4000)
}
// 方式三键：内核保持世界位姿、保锚；失败（接口档阈值内没有空闲接口 / 面档没有可安装面）在方式行下给内核的状态短语
const modeErr = ref('')
let modeErrT = 0
function setMode(m) {
  if (!comp.value || m === mode.value || ro.value) return
  const r = cmd({ type: 'setMode', id: comp.value.id, mode: m })
  clearTimeout(modeErrT)
  modeErr.value = r && r.ok === false && r.error ? r.error : ''
  if (modeErr.value) modeErrT = setTimeout(() => { modeErr.value = '' }, 4000)
}
watch(() => (comp.value ? comp.value.id : ''), () => { clearTimeout(modeErrT); modeErr.value = '' })
onBeforeUnmount(() => clearTimeout(modeErrT))
const reparent = (p) => { if (comp.value && p && p !== comp.value.parent) cmd({ type: 'reparent', id: comp.value.id, parent: p }) }
const uvAt = (k) => (attach.value && Array.isArray(attach.value.uv) ? attach.value.uv[k] : 0)
function setUv(k, v) { const uv = [uvAt(0), uvAt(1)]; uv[k] = v; setAttachNum({ uv }, 'uv') }
const uvMax = (k) => { const f = curFace.value; return f ? (k === 0 ? f.halfU : f.halfV) : Infinity }
// 偏移 / 倾角：拖动中读实时量（编辑器 liveOf 给了 off / tilt 才有），否则按已提交的
const offAxes = computed(() => offAxesOf(mode.value))
const liveAttach = computed(() => (live.value && live.value.attach) || null)
const offNow = computed(() => offOf(liveAttach.value && Array.isArray(liveAttach.value.off) ? liveAttach.value : comp.value && comp.value.attach))
const tiltNow = computed(() => tiltOf(liveAttach.value && Array.isArray(liveAttach.value.tilt) ? liveAttach.value : comp.value && comp.value.attach))
const OFF_TIPS = ['x：接口上向（滚转零位方向）', 'y：接口系 y', '法向：沿接口外法向（正 = 离开父件）']
function setOff(k, v) { const c = comp.value; if (c) setAttachNum(offPatch(c.attach, k, v), 'off') }
function setTilt(k, v) { const c = comp.value; if (c) setAttachNum(tiltPatch(c.attach, k, v), 'tilt') }
const setRoll = (v) => setAttachNum({ roll: v }, 'roll')
// 带锚自由件：锚点（接口 / 面 + u v）与相对锚系的位姿（t / q）
const anchor = computed(() => (mode.value === 'free' ? anchorOf(attach.value) : null))
const anchorText = computed(() => { const a = anchor.value; return a ? (a.kind === 'socket' ? '接口 ' : '面 ') + optText(a.label, a.id) : '' })
const tqNow = computed(() => {
  const c = comp.value
  if (!c) return null
  const t = live.value && Array.isArray(live.value.t) ? live.value.t : c.t
  const q = live.value && Array.isArray(live.value.q) ? live.value.q : c.q
  return tqReadout(t, q)
})
function setAnchorPose(k, v) {
  const c = comp.value
  if (!c) return
  setAttachNum({}, k < 3 ? 't' : 'q', tqWith(c.t, c.q, k, v))
}

// ── 位置（本体系 / 相对父件）──
// 位姿取编辑器解算表的副本（asm.poseOf）；拖动中取 ui.live 里的实时位姿。依赖 asm.doc.value：每次提交后重读
const pose = computed(() => { void vdoc.value; const c = comp.value; if (!c) return null; if (live.value && live.value.m) return live.value.m; return asm.poseOf(c.id) })
const parentPose = computed(() => { void vdoc.value; const c = comp.value; if (!c || !c.parent) return null; if (live.value && live.value.pm) return live.value.pm; return asm.poseOf(c.parent) })
const frameBody = computed(() => ui.posFrame === 'body' || isRoot.value)
const shown = computed(() => (pose.value ? (frameBody.value ? pose.value : relPose(parentPose.value, pose.value)) : null))
const rd = computed(() => (shown.value ? poseReadout(shown.value) : null))
const poseEditable = computed(() => mode.value === 'free' && !isRoot.value && !ro.value && !!pose.value)
const poseTip = computed(() => (poseEditable.value ? '' : isRoot.value ? '根件固定于本体原点' : '接口 / 面安装件的位姿由安装参数决定（可在视口中拖动或修改上方安装参数）'))
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
// 驱动装配件：目标质量 / 密度与整星驱动参数是同一份量（快速设置也改它们）→ 直写驱动参数，两处永远一致
const setDens = (k, v) => (driven.value ? asm.driveSet(setSpecValue(d.value.drive.spec, 'density.' + k, v), { mergeKey: 'doc|dens|' + k }) : cmd({ type: 'setDoc', patch: { density: { [k]: v } } }))
function setTarget(v) {
  if (driven.value) asm.driveSet(setSpecValue(d.value.drive.spec, 'massTargetKg', v), { mergeKey: 'doc|mass' })
  else cmd({ type: 'setDoc', patch: { massTargetKg: v } })
}

// ── 模型级：根节点名 / 质量特性 / 改写清单 / 派生量 ──
const rootLabel = computed(() => (d.value ? ROOT_LABELS[d.value.domain] || '整体' : ''))
// 质量特性读数（编辑器 stats：对质心、沿本体轴；张量非对角元 = −∫xy dm）。惯性积按工程力学定义 P = +∫xy dm 显示（= −张量元），
// 主惯量与记法无关，便于与 CAD / 总体结果对拍
const MINUS = '−'
const minus = (t) => (t[0] === '-' ? MINUS + t.slice(1) : t)
const sig = (v, n = 5) => { if (!Number.isFinite(v)) return '—'; return minus(Math.abs(v) < 1e-12 ? '0' : fmtNum(v, n)) }
/** 定点 d 位小数；舍入后是 0 的写 0（不出 −0.000）。质心 / 质量读数用（与视口读数同口径，不出科学计数法） */
const fx = (v, d) => { if (!Number.isFinite(v)) return '—'; const x = Math.abs(v) >= 0.5 * 10 ** -d ? v : 0; return minus(x.toFixed(d)) }
/** 惯量量级读数：≥ 1000 取整、≥ 100 一位小数、≥ 1 五位有效、更小四位有效；|v| < 1e-6·尺度 记 0（数值噪声） */
function inr(v, scale = 1) {
  if (!Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a < 1e-6 * Math.max(scale, 1e-9)) return '0'
  if (a >= 1000) return minus(v.toFixed(0))
  if (a >= 100) return minus(v.toFixed(1))
  if (a >= 1) return minus(String(Number(v.toPrecision(5))))
  return minus(String(Number(v.toPrecision(4))))
}
const iScale = computed(() => (mp.value && mp.value.I ? Math.max(Math.abs(mp.value.I[0][0]), Math.abs(mp.value.I[1][1]), Math.abs(mp.value.I[2][2])) : 1))
const mp = computed(() => {
  const s = ui.stats
  if (!s || !s.count) return null
  const I = Array.isArray(s.inertia) && s.inertia.length === 3 ? s.inertia : null
  let pm = null
  if (I && I.every((r) => r.every(Number.isFinite))) { try { pm = principalInertia(I).moments.slice().sort((a, b) => a - b) } catch { pm = null } }
  return {
    m: s.massKg, com: s.com, I,
    prod: I ? [-I[0][1], -I[0][2], -I[1][2]] : null,
    pm
  }
})
// 改写清单（驱动装配件）：件 · 项；逐项恢复 / 全部恢复；被删掉的驱动件数
const OVER_KEYS = { attach: '安装', pose: '位置', mass: '质量', material: '材质', name: '名称', sym: '对称' }
const overList = computed(() => {
  if (!driven.value || !d.value) return []
  const out = []
  for (const c of d.value.comps) {
    const m = marksAll.value[c.id]
    if (!m || m.user) continue
    const df = getComponent(c.type)
    const items = []
    for (const [k, st] of Object.entries(m.params || {})) if (st === 'over') items.push({ what: k, label: (df && df.params[k] && df.params[k].label) || k })
    for (const k of Object.keys(OVER_KEYS)) if (m[k]) items.push({ what: k === 'attach' ? 'pose' : k, label: OVER_KEYS[k] })
    const seen = new Set()
    const uniq = items.filter((x) => { const key = x.what + '|' + x.label; if (seen.has(key)) return false; seen.add(key); return true })
    if (uniq.length) out.push({ id: c.id, label: compLabel(c), items: uniq, locked: !!c.locked })
  }
  return out
})
const nOverAll = computed(() => overList.value.reduce((n, g) => n + g.items.length, 0))
// 「全部恢复」跳过锁定件（drive.resetAllOverrides 同口径）：只剩锁定件的改写时按钮不可用
const nResettable = computed(() => overList.value.reduce((n, g) => n + (g.locked ? 0 : g.items.length), 0))
const nUser = computed(() => (driven.value && d.value ? d.value.comps.filter((c) => marksAll.value[c.id] && marksAll.value[c.id].user).length : 0))
const nSuppressed = computed(() => { if (!driven.value || !d.value) return 0; const b = driveBase(d.value.drive.spec); if (!b.ok) return 0; const have = new Set(d.value.comps.map((c) => c.id)); return b.comps.filter((c) => !have.has(c.id)).length })
const tplLabel = computed(() => { const t = driven.value && d.value.drive.templateId; const e = t ? wb.byId('param:' + t) : null; return (e && (e.titleZh || e.title)) || t || '' })
// 派生量（挂点 / 关节 / 太阳翼组）：buildAssembly 出的同一份（入库元数据就是它），展开时才在空闲时段算、按文档哈希记一份
const derived = ref(null)
let derivedKey = '', derivedT = 0
function scheduleDerived() {
  if (!d.value || !isOpen('derived')) return
  const key = asmHash(d.value)
  if (key === derivedKey) return
  if (derivedT) { (typeof cancelIdleCallback === 'function' ? cancelIdleCallback : clearTimeout)(derivedT); derivedT = 0 }
  const docNow = d.value
  const run = () => {
    derivedT = 0
    if (asm.doc.value !== docNow) return
    try {
      const r = buildAssembly(docNow)
      // 入库元数据的挂点以几何中心为原点；屏上与质心读数、属性面板位置同一原点（根件坐标系）：加回 specOriginBody
      const o = Array.isArray(r.specOriginBody) ? r.specOriginBody : [0, 0, 0]
      derived.value = { aps: r.attachPoints.map((a) => ({ name: a.name, pos: a.posBody.map((v, k) => v + o[k]), dir: a.dirBody })), arts: r.articulations.map((a) => ({ name: a.name, n: a.nodes.length, stage: a.stages[0] ? a.stages[0].type : '' })), spg: r.solarPanelGroups.map((g) => ({ name: g.name, n: g.nodes.length, eff: g.efficiency })) }
      derivedKey = key
    } catch (e) { derived.value = { error: (e && e.message) || String(e) }; derivedKey = key }
  }
  derivedT = typeof requestIdleCallback === 'function' ? requestIdleCallback(run, { timeout: 600 }) : setTimeout(run, 120)
}
watch([() => asm.doc.value, () => isOpen('derived'), () => nSel.value], () => { if (nSel.value === 0) scheduleDerived() }, { immediate: true })
onBeforeUnmount(() => { if (derivedT) (typeof cancelIdleCallback === 'function' ? cancelIdleCallback : clearTimeout)(derivedT) })
const vecText = (v) => (Array.isArray(v) ? v.map((x) => sig(x, 4)).join(', ') : '')
/** 挂点所属件：名字前缀 = 组件节点前缀（assembly：`${前缀}_${短名}`） */
function selectOwner(name) { const pre = String(name).split('_')[0].replace('-', '~'); const id = pre.split('~')[0]; if (d.value && compById(d.value, id)) asm.select([id]) }
const massAuto = computed(() => ui.stats.massKg)
// 目标质量的余量由「首个带质量汇点（平台体 / 机身 / 船体 / 车体）、质量没手填的件」吃掉（assembly.collectMass）：文档里没有这样的件
// （地球站）时目标质量不生效——没填过就禁用输入；填过的（换根 / 删件之后失效）留着能清，下面出一行状态
const hasSink = computed(() => !!(d.value && d.value.comps.some((c) => {
  const df = getComponent(c.type)
  return !!(df && df.massSink) && !(typeof c.massKg === 'number' && c.massKg > 0) && !(c.params && typeof c.params.massKg === 'number' && Number.isFinite(c.params.massKg))
})))
// 空文档不禁用（先填目标、再放平台体照样生效）
const targetOff = computed(() => !!(d.value && d.value.comps.length) && !hasSink.value && d.value.massTargetKg == null)
const targetTip = computed(() => (hasSink.value ? '指定后差额由星体 / 机身 / 船体 / 车体承担；留空 = 按组件累加' : '文档中没有可承担差额的星体 / 机身 / 船体 / 车体（或其质量已手动指定），指定值不生效'))
// 整体质量的叫法随领域（整星质量 / 整机质量 / 全船质量 …），与快速设置同一个
const massLabel = computed(() => (d.value ? wholeMassLabel(d.value.domain) : ''))
const massWarnShort = computed(() => { const w = ui.stats.massWarn || ''; return !w ? '' : w.includes('未生效') ? massLabel.value + '未生效。' : massLabel.value + '小于其余组件合计。' })
</script>

<template>
  <div class="asm-propbox">
    <!-- ═══ 单件 ═══ -->
    <template v-if="comp && def">
      <div class="asm-hd">
        <span class="asm-hd-ic"><Icon :name="roleIcon(def.role)" :size="13" /></span>
        <span class="asm-hd-t" :title="headTip">{{ def.titleZh || def.title }}</span>
        <span class="asm-hd-id" data-i18n-skip>{{ comp.id }}</span>
        <Icon v-if="baseC" name="link-2" :size="12" class="asm-hd-drv" :title="nOver ? `由总体参数生成；本件已改写 ${nOver} 项` : '由总体参数生成'" />
        <span class="sp"></span>
        <button v-if="nOver" class="asm-ib" data-act="p-reset-all" :disabled="ro" :title="`恢复驱动值：本件全部 ${nOver} 项改写`" @click="asm.resetBase(comp.id, 'all')"><Icon name="undo-2" :size="13" /></button>
        <button class="asm-ib" :class="{ on: comp.hidden }" data-act="p-hide" :title="comp.hidden ? '显示' : '隐藏'" :disabled="beingDragged" @click="setHidden(!comp.hidden)"><Icon :name="comp.hidden ? 'eye-off' : 'eye'" :size="13" /></button>
        <button class="asm-ib" :class="{ on: locked }" data-act="p-lock" :title="locked ? '解锁' : '锁定'" :disabled="beingDragged" @click="setLocked(!locked)"><Icon :name="locked ? 'lock' : 'lock-open'" :size="13" /></button>
      </div>
      <div class="asm-props" :class="{ 'asm-live': beingDragged }">
        <!-- 安装（非根件：置顶、缺省展开） -->
        <div v-if="!isRoot" class="sec" data-sec="install">
          <div class="sect acc" @click="toggle('install')">
            <Icon name="chevron-down" class="disc" :class="{ shut: !isOpen('install') }" :size="12" />
            <span class="sect-t">安装</span>
            <button v-if="mk && (mk.attach || mk.pose)" class="asm-ib asm-sect-rst" data-act="p-reset-pose" :disabled="ro" title="恢复驱动值：安装与位置" @click.stop="asm.resetBase(comp.id, 'pose')"><Icon name="undo-2" :size="12" /></button>
          </div>
          <template v-if="isOpen('install')">
            <div class="srow">
              <label>父件</label>
              <select :value="comp.parent" :disabled="ro" title="更改父件：世界位姿保持，在新父件上就近取锚" @change="reparent($event.target.value)">
                <option v-for="o in parentOpts" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
            </div>
            <div class="srow">
              <label>方式</label>
              <div class="seg nseg">
                <span v-for="m in MODE_UI" :key="m.key" class="sg" :class="{ on: mode === m.key, off: ro }" :data-act="'mode-' + m.key" :title="m.tip" @click="setMode(m.key)">{{ m.label }}</span>
              </div>
            </div>
            <div v-if="modeErr" class="md-state bad" data-act="mode-err"><Icon name="alert-triangle" :size="12" />{{ modeErr }}</div>
            <div v-if="mode === 'socket'" class="srow">
              <label>接口</label>
              <select :value="attach.socket || ''" :disabled="ro" data-act="p-socket" title="父件的接口（与本件兼容、未被占用；与视口落点同一判据）" @change="setAttach({ socket: $event.target.value })">
                <option v-for="o in socketOpts" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
            </div>
            <template v-if="mode === 'surface'">
              <div class="srow">
                <label>面</label>
                <select :value="attach.face || ''" :disabled="ro" data-act="p-face" title="父件的可安装面" @change="setAttach({ face: $event.target.value, uv: [0, 0] })">
                  <option v-for="o in faceOpts" :key="o.value" :value="o.value">{{ o.label }}</option>
                </select>
              </div>
              <div class="srow">
                <label title="面内位置（以面心为原点；柱面 u 沿轴、v 为弧长）">u / v</label>
                <div class="asm-v3 two uvc">
                  <NumIn :key="comp.id + '|u'" :model-value="uvAt(0)" :min="-uvMax(0)" :max="uvMax(0)" :sig="6" :disabled="ro" data-act="p-u" title="u（m）" @commit="(v) => setUv(0, v)" />
                  <NumIn :key="comp.id + '|v'" :model-value="uvAt(1)" :min="-uvMax(1)" :max="uvMax(1)" :sig="6" :disabled="ro" data-act="p-v" title="v（m）" @commit="(v) => setUv(1, v)" />
                  <button class="asm-ib" type="button" data-act="p-center" :disabled="ro || (uvAt(0) === 0 && uvAt(1) === 0)" title="居中：u = v = 0（面心）" @click="setAttach({ uv: [0, 0] })"><Icon name="crosshair" :size="13" /></button>
                </div>
                <span class="u">m</span>
              </div>
            </template>
            <div v-if="offAxes.length === 3" class="srow" data-row="off">
              <label title="安装点在接口系中的偏移（x = 接口上向、法向 = 接口外法向，正 = 离开父件）；滚转与倾角绕偏移后的安装点">偏移</label>
              <div class="asm-v3">
                <NumIn v-for="k in 3" :key="comp.id + '|off' + k" :model-value="offNow[k - 1]" :sig="6" :disabled="ro" :data-act="'p-off' + (k - 1)" :title="OFF_TIPS[k - 1] + '（m）'" @commit="(v) => setOff(k - 1, v)" />
              </div>
              <span class="u">m</span>
            </div>
            <div v-else-if="offAxes.length === 1" class="srow" data-row="off">
              <label title="沿安装面外法向的偏移（正 = 离开面）；滚转与倾角绕偏移后的安装点">法向偏移</label>
              <NumIn :key="comp.id + '|off2'" :model-value="offNow[2]" :sig="6" :disabled="ro" data-act="p-off2" title="法向偏移（m）" @commit="(v) => setOff(2, v)" />
              <span class="u">m</span>
            </div>
            <div v-if="mode !== 'free'" class="srow">
              <label title="绕接口 / 安装面法向的滚转（0° = 接口上向 / 面 u 方向）">滚转</label>
              <NumIn :key="comp.id + '|roll'" :model-value="attach.roll" :sig="6" :disabled="ro" data-act="p-roll" title="滚转（°）" @commit="setRoll" />
              <span class="u">°</span>
            </div>
            <div v-if="mode !== 'free'" class="srow" data-row="tilt">
              <label title="滚转之后绕本件安装点的两轴倾斜：先绕 x、再绕 y（第一轴 −90° – 90°）">倾角</label>
              <div class="asm-v3 two">
                <NumIn :key="comp.id + '|t0'" :model-value="tiltNow[0]" :min="-90" :max="90" :sig="6" :disabled="ro" data-act="p-tilt0" title="绕 x（°，−90 – 90）" @commit="(v) => setTilt(0, v)" />
                <NumIn :key="comp.id + '|t1'" :model-value="tiltNow[1]" :min="-180" :max="180" :sig="6" :disabled="ro" data-act="p-tilt1" title="绕 y（°）" @commit="(v) => setTilt(1, v)" />
              </div>
              <span class="u">°</span>
            </div>
            <div v-if="mode !== 'free'" class="srow">
              <label title="本件与父件对接所用的一端：本件接口、平面面心或包围盒面心">安装接口</label>
              <select :value="mountVal" :disabled="ro" data-act="p-mount" @change="setMount($event.target.value)">
                <option v-for="o in mountOpts" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
            </div>
            <template v-if="anchor">
              <div class="srow">
                <label title="自由件位姿的参考锚点系（随父件尺寸联动）">锚点</label>
                <span class="asm-ro" data-act="p-anchor" data-i18n-skip>{{ anchorText }}</span>
              </div>
              <div v-if="anchor.kind === 'face'" class="srow">
                <label title="锚点在面内的位置（以面心为原点）">u / v</label>
                <span class="asm-ro" data-i18n-skip>{{ fmtNum(anchor.uv[0], 6) }}, {{ fmtNum(anchor.uv[1], 6) }}</span>
                <span class="u">m</span>
              </div>
              <div v-if="tqNow" class="srow">
                <label title="相对锚点系的位置">锚系位置</label>
                <div class="asm-v3">
                  <NumIn v-for="k in 3" :key="comp.id + '|at' + k" :model-value="tqNow.t[k - 1]" :sig="7" :disabled="ro" :data-act="'p-at' + (k - 1)" :title="'XYZ'[k - 1] + '（m）'" @commit="(v) => setAnchorPose(k - 1, v)" />
                </div>
                <span class="u">m</span>
              </div>
              <div v-if="tqNow" class="srow">
                <label title="相对锚点系的姿态（3-2-1 欧拉角：R = Rz(偏航)·Ry(俯仰)·Rx(滚转)）">锚系姿态</label>
                <div class="asm-v3">
                  <NumIn v-for="k in 3" :key="comp.id + '|ar' + k" :model-value="tqNow.rpy[k - 1]" :sig="6" :disabled="ro" :data-act="'p-ar' + (k - 1)" :title="['滚转', '俯仰', '偏航'][k - 1] + '（°）'" @commit="(v) => setAnchorPose(k + 2, v)" />
                </div>
                <span class="u">°</span>
              </div>
            </template>
          </template>
        </div>

        <div class="sec">
          <div class="srow">
            <label>名称</label>
            <input :key="comp.id + '|' + (comp.name || '')" class="ci asm-txt" type="text" spellcheck="false" :value="comp.name || ''" :placeholder="def.titleZh || def.title" :disabled="ro"
                   title="显示名称（结构树 / 部件名）；留空 = 组件缺省名称。挂点 / 关节 / 太阳翼组的名称仅由组件 id 决定，重命名不影响绑定" @change="rename" @keydown="blurOnEnter" />
            <span class="u"></span>
          </div>
          <div v-if="generalErr.length" class="md-state bad"><Icon name="alert-triangle" :size="12" />{{ generalErr[0] }}</div>
        </div>

        <!-- 参数 -->
        <div class="sec" data-sec="params">
          <div class="sect acc" @click="toggle('params')">
            <Icon name="chevron-down" class="disc" :class="{ shut: !isOpen('params') }" :size="12" />
            <span class="sect-t">参数</span>
            <span class="cnt" :class="{ bad: nBad }" data-i18n-skip>{{ nBad ? nBad + ' / ' : '' }}{{ rows.length }}</span>
          </div>
          <template v-if="isOpen('params')">
            <ParamRow v-for="r in mainRows" :key="comp.id + '.' + r.key" :row="r" :state="rowState(r)" :base-text="baseText(r)" :disabled="ro"
                      @set="(v) => setParam(r.key, v)" @reset="resetParam(r.key)" />
            <template v-if="moreRows.length">
              <div class="sect acc asm-subsect" data-act="p-more" @click="toggle('pmore')">
                <Icon name="chevron-down" class="disc" :class="{ shut: !isOpen('pmore') }" :size="12" />
                <span class="sect-t">细节参数</span>
                <span class="cnt" data-i18n-skip><template v-if="nMoreOver"><span class="cnt-over" title="其中已改写">{{ nMoreOver }}</span> / </template>{{ moreRows.length }}</span>
              </div>
              <template v-if="isOpen('pmore')">
                <ParamRow v-for="r in moreRows" :key="comp.id + '.' + r.key" :row="r" :state="rowState(r)" :base-text="baseText(r)" :disabled="ro"
                          @set="(v) => setParam(r.key, v)" @reset="resetParam(r.key)" />
              </template>
            </template>
          </template>
        </div>

        <!-- 安装（根件：只有方式一行；非根件的「安装」节在最上面） -->
        <div v-if="isRoot" class="sec" data-sec="install">
          <div class="sect acc" @click="toggle('install')">
            <Icon name="chevron-down" class="disc" :class="{ shut: !isOpen('install') }" :size="12" />
            <span class="sect-t">安装</span>
          </div>
          <div v-if="isOpen('install')" class="srow"><label>方式</label><span class="asm-ro dim">根件</span></div>
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
                <NumIn v-for="k in 3" :key="comp.id + '|t' + k" :model-value="rd.t[k - 1]" :sig="7" :disabled="!poseEditable" :title="'XYZ'[k - 1] + '（m）'" @commit="(v) => setPoseK(k - 1, v)" />
              </div>
              <span class="u">m</span>
            </div>
            <div class="srow">
              <label :title="poseTip || '3-2-1 欧拉角：R = Rz(偏航)·Ry(俯仰)·Rx(滚转)'">姿态</label>
              <div class="asm-v3">
                <NumIn v-for="k in 3" :key="comp.id + '|r' + k" :model-value="rd.rpy[k - 1]" :sig="6" :disabled="!poseEditable" :title="['滚转', '俯仰', '偏航'][k - 1] + '（°）'" @commit="(v) => setPoseK(k + 2, v)" />
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
            <button v-if="mk && mk.mass" class="asm-ib asm-sect-rst" data-act="p-reset-mass" :disabled="ro" title="恢复驱动值：质量" @click.stop="asm.resetBase(comp.id, 'mass')"><Icon name="undo-2" :size="12" /></button>
            <button v-if="mk && mk.material" class="asm-ib asm-sect-rst" data-act="p-reset-mat" :disabled="ro" title="恢复驱动值：材质" @click.stop="asm.resetBase(comp.id, 'material')"><Icon name="undo-2" :size="12" /></button>
          </div>
          <template v-if="isOpen('mass')">
            <div class="srow">
              <label>质量</label>
              <NumIn :key="comp.id + '|mass'" :model-value="comp.massKg" allow-empty :min="0" :sig="6" :disabled="ro" :placeholder="autoMass != null ? fmtNum(autoMass, 5) : '自动'"
                     title="留空 = 按组件几何与文档密度自动估算（占位符显示估算值）" @commit="setMass" />
              <span class="u">kg</span>
            </div>
            <div class="srow">
              <label>材质</label>
              <select :value="comp.material || ''" :disabled="ro" title="整件统一替换表面材质；组件缺省 = 各部分沿用组件自身材质" @change="setMaterial($event.target.value)">
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
              <button class="lb-mini" data-act="p-split" :disabled="!split.ok || ro" :title="split.ok ? '拆分：派生件转为独立件（此后可分别编辑）' : split.why" @click="cmd({ type: 'splitSym', id: comp.id })">
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

    <!-- ═══ 模型级属性（无选中 = 结构树根节点）═══ -->
    <template v-else-if="d">
      <div class="asm-hd"><span class="asm-hd-k">{{ rootLabel }}</span><span class="asm-hd-t" data-i18n-skip>{{ docName || defaultAsmName(d.domain) }}</span></div>
      <div class="asm-props">
        <div class="sec">
          <div class="srow">
            <label>名称</label>
            <input :key="'doc|' + docName" class="ci asm-txt" type="text" spellcheck="false" :value="docName" :placeholder="defaultAsmName(d.domain)" title="模型名称（模型库卡片与 3D 页中显示）" @change="setDocName" @keydown="blurOnEnter" />
            <span class="u"></span>
          </div>
          <div class="srow"><label>领域</label><span class="asm-ro dim">{{ DOMAIN_LABELS[d.domain] || d.domain }}</span></div>
          <div v-if="driven" class="srow"><label title="总体参数驱动：快速设置改它，组件随之重新生成；逐件改写保留">驱动</label>
            <span class="asm-ro" data-i18n-skip :title="d.drive.templateId ? 'param:' + d.drive.templateId : ''">{{ tplLabel || '整星参数' }}</span>
            <button class="lb-mini" data-act="doc-detach" title="解除驱动：组件原样保留，转为普通装配件（快速设置不再联动）" @click="asm.detach()"><Icon name="unlink-2" :size="12" />解除驱动</button>
          </div>
        </div>

        <!-- 质量特性 -->
        <div class="sec" data-sec="massprops">
          <div class="sect acc" @click="toggle('massprops')">
            <Icon name="chevron-down" class="disc" :class="{ shut: !isOpen('massprops') }" :size="12" />
            <span class="sect-t">质量特性</span>
          </div>
          <template v-if="isOpen('massprops')">
            <div class="srow">
              <label :title="targetTip">{{ massLabel }}</label>
              <NumIn :model-value="d.massTargetKg" allow-empty :min="0" :sig="6" :placeholder="massAuto ? fmtNum(massAuto, 5) : ''" :disabled="targetOff"
                     :title="targetTip" @commit="setTarget" />
              <span class="u">kg</span>
            </div>
            <div v-if="massWarnShort && d.massTargetKg != null" class="md-state bad" data-act="mass-warn" :title="ui.stats.massWarn"><Icon name="alert-triangle" :size="12" />{{ massWarnShort }}</div>
            <template v-if="mp">
              <!-- 质量特性表：三列同轴对齐（质心 X / Y / Z · 惯量 xx / yy / zz · 惯性积 xy / xz / yz · 主惯量 1 / 2 / 3），单位列靠右 -->
              <div class="asm-mpg" data-act="mp-read">
                <span class="h" title="展开对称后全部组件之和">质量</span><span class="c c3"><b>{{ fx(mp.m, mp.m >= 10 ? 1 : 3) }}</b></span><span class="u">kg</span>
                <span class="h" title="质心（本体系，原点 = 根件坐标系）">质心</span>
                <span v-for="(a, i) in ['X', 'Y', 'Z']" :key="'c' + a" class="c"><i>{{ a }}</i>{{ fx(mp.com[i], 3) }}</span><span class="u">m</span>
                <template v-if="mp.I">
                  <span class="h" title="转动惯量（对质心、沿本体轴）">惯量</span>
                  <span v-for="(a, i) in ['xx', 'yy', 'zz']" :key="'i' + a" class="c"><i>{{ a }}</i>{{ inr(mp.I[i][i], iScale) }}</span><span class="u">kg·m²</span>
                  <span class="h" title="惯性积 P = +∫xy dm（对质心、沿本体轴；惯量张量非对角元 = −P）">惯性积</span>
                  <span v-for="(a, i) in ['xy', 'xz', 'yz']" :key="'p' + a" class="c"><i>{{ a }}</i>{{ inr(mp.prod[i], iScale) }}</span><span class="u">kg·m²</span>
                  <template v-if="mp.pm">
                    <span class="h" title="主惯量（惯量张量特征值，由小到大；与惯性积符号记法无关）">主惯量</span>
                    <span v-for="(v, i) in mp.pm" :key="'m' + i" class="c"><i>{{ i + 1 }}</i>{{ inr(v, iScale) }}</span><span class="u">kg·m²</span>
                  </template>
                </template>
              </div>
            </template>
          </template>
        </div>

        <!-- 改写（驱动装配件） -->
        <div v-if="driven" class="sec" data-sec="over">
          <div class="sect acc" @click="toggle('over')">
            <Icon name="chevron-down" class="disc" :class="{ shut: !isOpen('over') }" :size="12" />
            <span class="sect-t">改写</span>
            <span class="cnt" :title="`改写 ${nOverAll} 项 · 附加件 ${nUser} · 删除的驱动件 ${nSuppressed}`">{{ nOverAll }}</span>
          </div>
          <template v-if="isOpen('over')">
            <div v-if="!overList.length" class="asm-empty asm-empty-s">暂无改写。</div>
            <div v-for="g in overList" :key="g.id" class="asm-ovr">
              <span class="asm-ovr-n" data-i18n-skip :title="g.id" @click="asm.select([g.id])">{{ g.label }}</span>
              <span class="asm-ovr-items">
                <span v-for="it in g.items" :key="it.what" class="asm-ovr-i" data-i18n-skip>{{ it.label }}<button class="pr-x" :disabled="g.locked" :title="'恢复驱动值：' + it.label" @click="asm.resetBase(g.id, it.what)"><Icon name="undo-2" :size="10" /></button></span>
              </span>
            </div>
            <div class="md-acts">
              <button class="lb-mini" data-act="doc-reset-all" :disabled="!nResettable" title="全部改写恢复为驱动值（附加件、删除、锁定件以及隐藏 / 锁定状态不受影响）" @click="asm.resetAll()"><Icon name="undo-2" :size="12" />全部恢复</button>
              <button class="lb-mini" data-act="doc-restore" :disabled="!nSuppressed" :title="`找回删除的驱动件（${nSuppressed}）`" @click="asm.restoreDeleted()"><Icon name="history" :size="12" />找回删除件</button>
            </div>
          </template>
        </div>

        <!-- 挂点 / 关节 / 太阳翼组（入库元数据同一份，只读；点名称选中所属组件） -->
        <div class="sec" data-sec="derived">
          <div class="sect acc" @click="toggle('derived')">
            <Icon name="chevron-down" class="disc" :class="{ shut: !isOpen('derived') }" :size="12" />
            <span class="sect-t">挂点 · 关节 · 太阳翼组</span>
            <span v-if="derived && !derived.error" class="cnt" data-i18n-skip>{{ derived.aps.length }} · {{ derived.arts.length }} · {{ derived.spg.length }}</span>
          </div>
          <template v-if="isOpen('derived')">
            <div v-if="!derived" class="asm-empty asm-empty-s">…</div>
            <div v-else-if="derived.error" class="md-state bad"><Icon name="alert-triangle" :size="12" />{{ derived.error }}</div>
            <template v-else>
              <div class="asm-dl-h">挂点</div>
              <div v-for="a in derived.aps" :key="a.name" class="asm-dl" :title="'位置 ' + vecText(a.pos) + ' m · 视轴 ' + vecText(a.dir)" @click="selectOwner(a.name)"><span class="n" data-i18n-skip>{{ a.name }}</span><span class="v">{{ vecText(a.pos) }}</span></div>
              <div v-if="!derived.aps.length" class="asm-empty asm-empty-s">暂无挂点。</div>
              <div class="asm-dl-h">关节</div>
              <!-- 关节：变换类型显示界面名（不显示 yRotate 一类原始键），节点数进读数 -->
              <div v-for="a in derived.arts" :key="a.name" class="asm-dl" :title="a.name + ' · ' + (STAGE_LABEL[a.stage] || a.stage) + ' · 驱动节点 ' + a.n" @click="selectOwner(a.name)"><span class="n" data-i18n-skip>{{ a.name }}</span><span class="v"><span>{{ STAGE_LABEL[a.stage] || a.stage }}</span><span data-i18n-skip> · {{ a.n }}</span></span></div>
              <div v-if="!derived.arts.length" class="asm-empty asm-empty-s">暂无关节。</div>
              <div class="asm-dl-h">太阳翼组</div>
              <div v-for="g in derived.spg" :key="g.name" class="asm-dl" data-i18n-skip @click="selectOwner(g.name)"><span class="n">{{ g.name }}</span><span class="v">{{ sig(g.eff, 3) }} %</span></div>
              <div v-if="!derived.spg.length" class="asm-empty asm-empty-s">暂无太阳翼组。</div>
            </template>
          </template>
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
/* u / v 两格 + 「居中」钮 */
.asm-v3.two.uvc { grid-template-columns: repeat(2, minmax(0, 1fr)) 22px; flex-basis: 136px; min-width: 136px; align-items: center; }
.md-kvs.one { grid-template-columns: minmax(0, 1fr); }
.asm-sel-list { display: flex; flex-wrap: wrap; gap: 4px; }
.asm-sel-chip { display: inline-flex; align-items: baseline; gap: 5px; padding: 2px 6px; font-size: var(--fs-2); color: var(--text); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-ctl); }
.asm-sel-chip i { font-style: normal; font-family: var(--font-mono); font-size: var(--fs-1); color: var(--text-faint); }
/* 驱动装配件：头行链环、分节头的恢复钮、细节参数子节 */
.asm-hd-drv { flex: none; color: var(--accent-ui); opacity: .8; }
.asm-sect-rst { margin-left: auto; width: 20px; height: 20px; color: var(--accent-ui); }
.asm-sect-rst + .asm-sect-rst { margin-left: 0; }
.asm-subsect { margin-top: 2px; }
.asm-subsect .sect-t { font-weight: 500; color: var(--text-muted); }
.cnt-over { color: var(--accent-ui); font-weight: 600; }
/* 质量特性表：标签 | 三列数值（各带淡色分量名，右对齐、等宽数字）| 单位；行间发丝线 */
.asm-mpg { display: grid; grid-template-columns: 46px repeat(3, minmax(0, 1fr)) 38px; align-items: baseline; column-gap: 6px; font-size: var(--fs-3); }
.asm-mpg > * { padding: 3px 0; border-bottom: 1px solid var(--lb-rule-soft); }
.asm-mpg .h { color: var(--text-muted); white-space: nowrap; }
.asm-mpg .c { display: flex; align-items: baseline; justify-content: space-between; gap: 4px; min-width: 0; font-family: var(--font-mono); font-variant-numeric: tabular-nums; color: var(--text); white-space: nowrap; }
.asm-mpg .c.c3 { grid-column: span 3; justify-content: flex-end; }
.asm-mpg .c b { font-weight: 600; }
.asm-mpg .c i { font-style: normal; font-family: var(--font-ui); font-size: var(--fs-1); color: var(--text-faint); }
.asm-mpg .u { color: var(--text-faint); font-size: var(--fs-2); text-align: right; white-space: nowrap; }
/* 改写清单：件名（点了选中）+ 各项小签（各带恢复钮） */
.asm-ovr { display: flex; flex-wrap: wrap; align-items: baseline; gap: 3px 6px; padding: 3px 0; border-bottom: 1px solid var(--lb-rule-soft); }
.asm-ovr-n { flex: none; min-width: 72px; font-size: var(--fs-3); color: var(--text); cursor: pointer; }
.asm-ovr-n:hover { color: var(--accent-ui); }
.asm-ovr-items { display: flex; flex-wrap: wrap; gap: 3px; }
.asm-ovr-i { display: inline-flex; align-items: center; gap: 2px; padding: 0 2px 0 6px; height: 18px; font-size: var(--fs-2); color: var(--text); background: color-mix(in srgb, var(--accent-ui) 8%, var(--bg)); border: 1px solid color-mix(in srgb, var(--accent-ui) 35%, var(--border)); border-radius: var(--r-ctl); }
.pr-x { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; padding: 0; color: var(--accent-ui); background: transparent; border: 0; border-radius: 2px; cursor: pointer; }
.pr-x:hover { background: var(--wash-hover); }
/* 派生量列表（只读）：名称 … 读数；点行选中所属件 */
.asm-dl-h { margin-top: 4px; font-size: var(--fs-2); font-weight: 600; color: var(--text-muted); }
.asm-dl { display: flex; align-items: baseline; gap: 8px; padding: 1px 0; font-size: var(--fs-2); cursor: pointer; border-bottom: 1px solid var(--lb-rule-soft); }
.asm-dl:hover .n { color: var(--accent-ui); }
.asm-dl .n { flex: 1; min-width: 0; color: var(--text); font-family: var(--font-mono); overflow-wrap: anywhere; }
.asm-dl .v { flex: none; color: var(--text-muted); font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.asm-empty-s { padding: 6px 4px; font-size: var(--fs-2); }
.srow > select.md-red { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 70%, var(--field-border)); }
</style>
