<script setup>
// 转发器频率计划工作台（独立窗口）。
//
// 归属：频率计划挂在【卫星】下、与 GRD 天线平级，因此左栏按卫星分组——与覆盖分析那棵卫星树同源
// （shared/freqPlanSats 直读 localStorage，同 origin 无需 IPC）。
//
// 版式沿用平台既定范式：左列表（主从）· 中主体（图 + 页签）· 右检查器，同屏一个上下文。
// 存盘策略是「改即存」（debounce 600ms）——频率计划是「文件」不是「会话」，所以不设关窗守卫。
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import ActivationLock from '../components/ActivationLock.vue'
import {
  newPlan, normalizePlan, newChannel, newLo, newBeam, genSeries, validatePlan, errorCount,
  resolveChannel, resolveAll, planSummary, POLS, POL_LABEL, CHANNEL_KINDS, KIND_LABEL,
  MARK_KINDS, markSide, isMark, setChannelKind,
  DEFAULT_BEAM_COLORS, POL_ORTHO, guessBand, BANDS, beamLabel, FREQ_UNITS, DEFAULT_BW_MHZ,
  uplinkBw, planExtent, cleanFreq,
  setChannelFc, setDnDecoupled, isDnLinked, loValueOf, dnFromUp, upFromDn,
  channelEdges, setChannelEdge, setChannelSpan, setChannelBw,
  beamBw, beamSegs, segBwOf, channelBeams, BEAM_LAYOUTS, beamLayoutOf,
  setBeamBw, setBeamSegBw, setBeamSegEdge,
  fcLabel, fmtBeamNos, beamSynthText
} from '../shared/freqPlanModel.js'
import { loadSatNodes, satLabel } from '../shared/freqPlanSats.js'
import { loadSynthGroups } from '../shared/freqPlanBeamSynth.js'
import { fcCss } from '../shared/freqReuseColors.js'
import { useFreqUnit, useLateDraft } from './fpUnit.js'
import { num as parseNum } from '../shared/num.js'   // 全角容错：中文输入法下的全角数字也能落值
import { toPngDataUrl, toPdfDataUrl, toSvgText, toPngDataUrlMulti, toPdfDataUrlMulti, toSvgTextMulti } from './fpExport.js'
import { toSvgMulti } from '../shared/freqPlanRender.js'
import FpChart from './FpChart.vue'
import FpAlloc from './FpAlloc.vue'
import BeamPicker from './BeamPicker.vue'
import Icon from '../components/Icon.vue'
import MiniSendDialog from '../components/MiniSendDialog.vue'
import { fpMiniItem } from '../shared/fpMiniExport.js'
import { estimateBytes, SIZE_MAX } from '../shared/miniPack.js'
import { buildFreqPlanXlsx } from '../shared/fpXlsxModel.js'
import { byLang } from '../shared/i18n/lang.js'   // 运行时才拼得出全貌的长句：生成时就按平台语言出字

const api = typeof window !== 'undefined' ? window.api : null

// ---- 状态 ----
const index = ref([])              // 计划索引（左栏）
const plan = ref(null)             // 当前打开的计划全文
const currentId = ref('')
const selectedId = ref('')         // 选中通道
const tab = ref('table')           // table | alloc | check
const carriers = ref([])           // 频率分配表的载波（随计划走，存在计划里）
const msg = ref('')
const busy = ref('')
const confirmMsg = ref('')
let _confirmResolve = null
const chartWrap = ref(null)
const chartW = ref(1240)

// 左右两栏宽度：右栏默认给足（转发器参数是两列、波束那组三个控件一行，旧的 316px 挤成一团）；
// 左栏也可拖（卫星名 + 轨位 + 缩进后的计划名，236px 常不够）。两个手柄都骑在分界线上
// （0 宽轨 + 负边距），不占版面；现调现存。
//
// ★ 设置栏在分配表那一页另记一个宽度，且可以一路拖到 0 收起。从前那一页是把整栏隐藏死的
//   （十四列的表在 620px 的中栏里只能横着拖着看），但波束占段（一条转发器的频带切给哪几个
//   波束）恰恰只在设置栏里改 —— DTP 载荷正是边看分配表边切段，隐藏死等于两页来回跳。
//   故改成宽度可调：拖到下限一半以内即吸到 0，不留窄到没法用的中间态；收起后手柄仍在右缘，
//   页签那头还有一个开合钮。两页各记各的宽度 —— 共用一个值的话每切一次页就要重拖一遍。
const LEFT_W_MIN = 190, LEFT_W_MAX = 460
const RIGHT_W_MIN = 260, RIGHT_W_MAX = 760, ALLOC_RIGHT_W_DEF = 320
const clampW = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
// ★ 存过 0（收起）与没存过是两回事：`|| 默认值` 会把收起状态弹回默认宽（同 Number(null) 是 0 那一课）
function readW(key, def) {
  let raw = null
  try { raw = localStorage.getItem(key) } catch { /* 隐私模式下读不到，用默认值 */ }
  const n = raw == null || raw === '' ? NaN : Number(raw)
  return Number.isFinite(n) ? n : def
}
// 分配表页的档位：0 = 收起，其余落在 [RIGHT_W_MIN, RIGHT_W_MAX]
const snapAllocW = (v) => (v >= RIGHT_W_MIN ? Math.min(RIGHT_W_MAX, v) : v > RIGHT_W_MIN / 2 ? RIGHT_W_MIN : 0)
const leftW = ref(clampW(readW('freqplan/leftWidth', 250), LEFT_W_MIN, LEFT_W_MAX))
const rightW = ref(clampW(readW('freqplan/rightWidth', 396), RIGHT_W_MIN, RIGHT_W_MAX))
const allocRightW = ref(snapAllocW(readW('freqplan/allocRightWidth', ALLOC_RIGHT_W_DEF)))
const onAlloc = computed(() => tab.value === 'alloc')
const rightWNow = computed(() => (onAlloc.value ? allocRightW.value : rightW.value))
const resizing = ref('')
const saveW = (key, v) => { try { localStorage.setItem(key, String(v)) } catch { /* ignore */ } }
// 收起前的宽度：再打开时回到那个数，而不是回到默认宽
let lastAllocW = allocRightW.value || ALLOC_RIGHT_W_DEF
watch(allocRightW, (v) => { if (v > 0) lastAllocW = v })
function toggleAllocRight() {
  allocRightW.value = allocRightW.value > 0 ? 0 : clampW(lastAllocW, RIGHT_W_MIN, RIGHT_W_MAX)
  saveW('freqplan/allocRightWidth', allocRightW.value)
}
function startResize(side, e) {
  const alloc = side === 'right' && onAlloc.value
  const box = side === 'left' ? leftW : alloc ? allocRightW : rightW
  const key = side === 'left' ? 'freqplan/leftWidth' : alloc ? 'freqplan/allocRightWidth' : 'freqplan/rightWidth'
  const startX = e.clientX, startW = box.value
  resizing.value = side; document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'
  // 右栏的手柄在栏的左缘，往左拖 = 变宽，故取负号；左栏相反
  const move = (ev) => {
    const w = startW + (ev.clientX - startX) * (side === 'left' ? 1 : -1)
    box.value = side === 'left' ? clampW(w, LEFT_W_MIN, LEFT_W_MAX)
      : alloc ? snapAllocW(w) : clampW(w, RIGHT_W_MIN, RIGHT_W_MAX)
  }
  const up = () => {
    resizing.value = ''; document.body.style.cursor = ''; document.body.style.userSelect = ''
    window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up)
    saveW(key, box.value)
  }
  window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
}

// 显示选项。只留单位与字号两项 —— 频率标注 / 图例 / LO / 断轴曾各有一个工具栏开关，
// 但没人会去关（一张频率计划图缺了标注或图例就不成图了），四个常开的勾占着工具栏还添歧义。
// 现在不写进 opt，layout/toSvg 各自按 DEFAULT_STYLE 取 true；渲染层的这四个开关保留（供导出
// 与 core 测试用），只是界面不再暴露。
// ★ 单位是【整个工作台】的刻度，不只是图的：表、检查器、批量条、批量生成、LO、频率分配表、校验
//   条目里的每一个频率/带宽读数与输入框都按它写（见下面的 dispF/toM）。选了 kHz，14000 MHz 那条
//   转发器处处写成 14000000 —— 换的只是刻度，计划本身一个数都没动，故换来换去无损。
// ★ 存在 localStorage：换了刻度再打开另一份计划（或重开窗口）仍是那把尺子，不必每次重选。
const OPT_KEY = 'freqplan/opt'
function readOpt() {
  const d = { unit: 'MHz', fontSize: 12 }
  try {
    const o = JSON.parse(localStorage.getItem(OPT_KEY) || '{}')
    return {
      unit: FREQ_UNITS.includes(o.unit) ? o.unit : d.unit,
      fontSize: Number.isFinite(o.fontSize) ? Math.min(22, Math.max(8, o.fontSize)) : d.fontSize
    }
  } catch { return d }
}
const opt = ref(readOpt())
watch(opt, (o) => { try { localStorage.setItem(OPT_KEY, JSON.stringify(o)) } catch { /* ignore */ } }, { deep: true })

// 刻度换算与手输草稿在 fpUnit 那一份（频率分配表页共用同一份，见其文件头）：
//   U 单位名 · dispF MHz→屏上 · toM 屏上→MHz · textF「数 + 单位」读数 · dval/dput/ddone 录入草稿
const { U, dispF, toM, textF, dval, dput, ddone } = useFreqUnit(() => opt.value.unit)
// 转发器表那两格频率列写哪一种口径：'fc' 中心 + 带宽 · 'edge' 起 + 止。手上的频率计划表两种都有
// （「13932~14112」与「中心 14022 / 180 MHz」），切到与手上那张同一档就能整列往下 Tab 着录，
// 不必先自己加减半个带宽、也不必一条条进右栏。列数不变：两档都是两格。
// ★ 与 zoom 同理不放进 opt —— opt 整份当版式参数传给 layout/toSvg，表格的列口径与图无关。
const TCOLS_KEY = 'freqplan/tableCols'
const tcols = ref(localStorage.getItem(TCOLS_KEY) === 'edge' ? 'edge' : 'fc')
watch(tcols, (v) => { try { localStorage.setItem(TCOLS_KEY, v) } catch { /* ignore */ } })
// 屏上缩放。★ 不放进 opt：opt 会整份当版式参数传给 layout/toSvg，而 toSvg 导出时会把里头每个数
// 都乘上倍率——缩放比例混进去会被连乘一次，导出图就跟着屏上的缩放走样了。
const ZOOM_MIN = 0.1, ZOOM_MAX = 8
const zoom = ref(1)
const zoomClamp = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))
// 输入框草稿。★ 手输期间不即时钳制也不即时格式化：想打「50」，在敲下「5」那一刻若立刻钳到下限
// 并回写，第二个字符就再也打不进去（同 oneway-value-binding-wipes-input 那类坑）。落值放到 change。
const zoomPct = ref('100')
watch(zoom, (z) => { zoomPct.value = String(Math.round(z * 100)) })
function commitZoom() {
  const n = parseNum(String(zoomPct.value).replace(/[%％]/g, ''))   // 全角容错，顺手吃掉手打的百分号
  if (n == null || n <= 0) { zoomPct.value = String(Math.round(zoom.value * 100)); return }
  zoom.value = zoomClamp(Math.round(n) / 100)                       // 收到整百分比，免得显示 138% 实为 137.6%
  zoomPct.value = String(Math.round(zoom.value * 100))              // 越界/带小数的输入回显成落定值
}
// Ctrl+滚轮：按 1.2 倍进退并收到 5% 一档，读数干净（100→120→145→175…），且不与手输的任意比例打架
function onWheelZoom(e) {
  if (!e.ctrlKey) return
  e.preventDefault()
  zoom.value = zoomClamp(Math.round(zoom.value * (e.deltaY < 0 ? 1.2 : 1 / 1.2) * 20) / 20)
}

function flash(t) { msg.value = t; setTimeout(() => { if (msg.value === t) msg.value = '' }, 3600) }
function ask(m) { confirmMsg.value = m; return new Promise((r) => { _confirmResolve = r }) }
function answer(ok) { confirmMsg.value = ''; const r = _confirmResolve; _confirmResolve = null; if (r) r(ok) }

// ---- 左栏：一棵「卫星 → 该星的频率计划」的树 ----
//
// 只有一层结构：每颗卫星恒占一行（有没有计划都在原位，不再把空星另拨到底部一个「尚无计划」的桶里
// ——同一颗星按有无计划出现在两个地方，正是层次读不出来的根因）。计划是卫星的子项：缩进 + 导引线，
// 卫星行是灰底粗体、计划行是白底 —— 层级靠「底色深浅 + 缩进」区分，而不是靠两行字号相近的文字。
const satNodes = ref([])
const q = ref('')                                    // 筛选（卫星多起来时全列出来会很长）
const COLLAPSE_KEY = 'freqplan/collapsedSats'
const collapsed = ref(new Set(readCollapsed()))
function readCollapsed() {
  try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]') } catch { return [] }
}
function isOpen(g) { return !!q.value.trim() || !collapsed.value.has(g.key) }   // 筛选时一律展开，否则命中项藏在折叠里等于没筛
function toggleSat(g) {
  const s = new Set(collapsed.value)
  if (s.has(g.key)) s.delete(g.key); else s.add(g.key)
  collapsed.value = s
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...s])) } catch { /* ignore */ }
}
function expandSat(folder) {
  const key = folder || '__none__'      // 与 tree 里那颗「未归属卫星」的 key 对齐
  if (!collapsed.value.has(key)) return
  const s = new Set(collapsed.value); s.delete(key); collapsed.value = s
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...s])) } catch { /* ignore */ }
}

// 同一棵树两处用：左栏（跟 q 走）与「合成导出」的选单（跟它自己那个筛选框走）。
// 树的口径只此一处 —— 两处各写一遍，卫星分组/孤儿归位的规则迟早分叉。
function buildTree(kw0) {
  const bySat = new Map()
  for (const e of index.value) {
    const k = e.satFolder || ''
    if (!bySat.has(k)) bySat.set(k, [])
    bySat.get(k).push(e)
  }
  const kw = String(kw0 || '').trim().toLowerCase()
  const hit = (s) => !kw || String(s).toLowerCase().includes(kw)
  // 卫星名命中 → 连同它的计划整颗留下；否则只留名字命中的那几份计划
  const pick = (label, items) => (hit(label) ? items : items.filter((e) => hit(e.name)))
  const out = []
  for (const s of satNodes.value) {
    const label = satLabel(s)
    const items = pick(label, bySat.get(s.folder) || [])
    bySat.delete(s.folder)
    if (!kw || hit(label) || items.length) out.push({ key: s.folder, folder: s.folder, satName: s.satName, label, items })
  }
  // 宿主卫星已不在树里的（卫星被删/改过 folder）排在最后，不让这些计划从界面上消失
  for (const [k, all] of bySat) {
    const label = k ? (all[0].satName || k) : '（未归属卫星）'
    const items = pick(label, all)
    if (!kw || hit(label) || items.length) out.push({ key: k || '__none__', folder: k, satName: label, label, items, orphan: true })
  }
  return out
}
const tree = computed(() => buildTree(q.value))
const shown = computed(() => tree.value.reduce((n, g) => n + g.items.length, 0))
// 计划名多半以卫星名打头（新建时就是这么起的），列表里紧跟在卫星行下面再念一遍纯属重复，
// 显示时把这段前缀摘掉（完整名仍在 title 与右栏「名称」里）——去掉重复，父子两行才读得出主次。
function shortName(e, g) {
  const sat = g.satName || e.satName || ''
  if (!sat || !e.name.startsWith(sat)) return e.name
  const rest = e.name.slice(sat.length).replace(/^[\s·\-—_:：]+/, '')
  return rest || e.name
}

// ---- 载入 / 存盘 ----
async function loadIndex() {
  if (!api?.freqPlan) return
  try { index.value = await api.freqPlan.list() || [] } catch { index.value = [] }
}
async function openPlan(id) {
  if (!api?.freqPlan || !id) return
  const p = await api.freqPlan.get(id)
  if (!p) { flash('计划不存在'); await loadIndex(); return }
  loading = true                        // 整份换入不是「改动」，别让深监听把它当编辑存回去
  plan.value = normalizePlan(p)
  carriers.value = Array.isArray(p.carriers) ? p.carriers : []
  currentId.value = id
  selectedId.value = plan.value.channels[0]?.id || ''
  clearChecked()                        // 换了一份计划，上一份的批量勾选不能留下来
  dirty = false
  // 从文件区双击进来、或新建/复制出来的那份，可能落在折叠着或滚动区外的位置——把它显出来
  expandSat(plan.value.satFolder || '')
  nextTick(() => {
    loading = false                     // 深监听是 pre-flush，nextTick 时它已经跑完了
    document.querySelector(`.li[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' })
  })
}

// 左栏树里的两个入口，点哪一个决定中栏落在哪一页（页签仍在，两处同步）：
//   计划行 → 转发器表（这份计划的本体）   ·   子节点「频率分配表」→ 分配表
// 已经打开的那份不重新载入 —— openPlan 会把选中通道弹回第一条，只是换个页签不该有这个副作用。
async function openTable(id) {
  if (currentId.value !== id) await openPlan(id)
  tab.value = 'table'
}
async function openAlloc(id) {
  if (currentId.value !== id) await openPlan(id)
  tab.value = 'alloc'
}
// 子节点上的载波数：当前打开的那份取编辑区里的实时值，其余取索引（存盘时一并写进去）
const allocCount = (e) => (e.id === currentId.value ? carriers.value.length : (e.carrierCount || 0))

let saveTimer = null
let dirty = false
let loading = false      // 正在把某份计划换入编辑区（见 openPlan）
function scheduleSave() {
  dirty = true
  clearTimeout(saveTimer)
  saveTimer = setTimeout(doSave, 600)
}
async function doSave() {
  if (!api?.freqPlan || !plan.value || !currentId.value) return
  clearTimeout(saveTimer)
  try {
    // 载波跟着计划走（频率分配表是这份计划的一部分，分开存会出现「计划改了载波还挂在旧转发器上」）
    // updateOnly：这份要是已经在文件区被删了，别把它写回来（广播还没到时也拦得住）
    const r = await api.freqPlan.save({ ...JSON.parse(JSON.stringify(plan.value)), id: currentId.value, carriers: JSON.parse(JSON.stringify(carriers.value)) }, { updateOnly: true })
    if (r?.ok) { dirty = false; await loadIndex() }
    else { dirty = false; flash('保存失败：' + (r?.error || '未知错误')); await loadIndex() }
  } catch (e) { flash('保存失败：' + e.message) }
}
// 深监听：图/表/检查器三处都直接改 plan，逐处调 scheduleSave 迟早漏
watch(plan, () => { if (plan.value && !loading) scheduleSave() }, { deep: true })
watch(carriers, () => { if (plan.value && !loading) scheduleSave() }, { deep: true })

// 文件区（主窗口）删/改名的广播：那边直接改库，编辑窗手里这份可能就是它。
function planRemovedRemote(id) {
  if (currentId.value === id) {
    clearTimeout(saveTimer); dirty = false      // 待存的那一笔要是落下去，删掉的计划就整份复活了
    plan.value = null; currentId.value = ''; carriers.value = []; selectedId.value = ''
    clearChecked()
  }
  loadIndex()
}
function planRenamedRemote(id, name) {
  if (currentId.value === id && plan.value && name) {
    loading = true                              // 跟进别人的改名不是编辑，别反手把整份存回去（旧名字就赢了）
    plan.value.name = name
    nextTick(() => { loading = false })
  }
  loadIndex()
}

// ---- 新建 / 删除 / 改名 ----
// 新建一律「给某颗星建」——入口就在左栏那颗星的行上，宿主由点击位置说了算。
// （旧的工具栏「新建」不带宿主，只能拿卫星树的第一颗顶上，点了才发现建到了别的星上。）
async function createPlan(satFolder, fromPlan = null) {
  if (!api?.freqPlan) return
  const folder = satFolder || ''
  const node = satNodes.value.find((s) => s.folder === folder)
  const p = fromPlan ? normalizePlan(fromPlan) : newPlan()
  p.id = ''
  p.satFolder = folder
  p.satName = node?.satName || ''
  // 一颗星可以有多份计划（主用/备份、在轨/规划…），重名时顺次加序号，列表里才分得清
  if (!fromPlan) {
    // 计划名会当段头画进导出的图，故系统给的默认名走英文（人改中文名照画中文，见 freqPlanRender 文件头）
    const base = node ? `${node.satName} Frequency Plan` : 'Frequency Plan'
    const used = new Set(index.value.filter((e) => (e.satFolder || '') === folder).map((e) => e.name))
    let name = base
    for (let i = 2; used.has(name); i++) name = `${base} ${i}`
    p.name = name
  }
  const r = await api.freqPlan.save(JSON.parse(JSON.stringify(p)))
  if (r?.ok) {
    expandSat(folder)                 // 建在折叠着的星下面，看不见等于没建
    await loadIndex()
    await openPlan(r.id)
    flash('已新建')
  }
  return r?.id
}
async function removePlan(e) {
  if (!(await ask(`删除频率计划「${e.name}」？此操作不可撤销。`))) return
  await api.freqPlan.remove(e.id)
  if (currentId.value === e.id) { plan.value = null; currentId.value = ''; carriers.value = [] }
  await loadIndex()
  flash('已删除')
}
async function duplicatePlan(e) {
  const src = await api.freqPlan.get(e.id)
  if (!src) return
  const copy = { ...src, id: '', name: src.name + ' Copy' }      // 名字会进图，后缀同样走英文
  const r = await api.freqPlan.save(copy)
  if (r?.ok) { await loadIndex(); await openPlan(r.id); flash('已复制') }
}

// ---- 频段 ----
// 默认「自动」：按图上最低的那个频率猜（见 guessBand），批量生成换到别的段时跟着走；
// 也可手选钉死 —— 一份计划横跨两段、或按各家内部口径把某段叫成另一个名字（12.75~13.25 之类）时，
// 猜出来的那个名字总得有处可改。band 只进汇总行与列表说明，不参与作图与校验，故手选不会与频率打架。
const autoBand = computed(() => {
  const ext = plan.value ? (planExtent(plan.value, 'up', 0) || planExtent(plan.value, 'dn', 0)) : null
  return guessBand(ext ? ext.dataMin : NaN)      // 空计划无频率可依 → guessBand 兜底给 Ku
})
// 下拉的值：空串 = 自动档（选中自动时把当下的猜测落成 band，读的人不必再去想它现在算哪段）
const bandPick = computed({
  get: () => (plan.value?.bandAuto === false ? plan.value.band : ''),
  set: (v) => {
    if (!plan.value) return
    plan.value.bandAuto = !v
    plan.value.band = v || autoBand.value
  }
})
// 自动档下 band 是派生值，频率一改就跟着刷新。★ 这件事不能只放在批量生成里做：逐个改频率、
// 或把整批删掉重铺，同样会让旧的那个段名过期。
watch(autoBand, (b) => { if (plan.value && plan.value.bandAuto !== false) plan.value.band = b })

// ---- 通道编辑 ----
const selected = computed(() => plan.value?.channels.find((c) => c.id === selectedId.value) || null)
const selectedResolved = computed(() => (plan.value && selected.value ? resolveChannel(plan.value, selected.value) : null))
// 选中这一条是不是标记类载波，是的话在哪一侧（'' = 转发器 / 保留，两侧都在）
const selMark = computed(() => markSide(selected.value?.kind))
const rowsResolved = computed(() => (plan.value ? resolveAll(plan.value) : []))
// 表上几个数字列的最小宽度，跟着刻度走：Hz 档下 14022000000 比 MHz 档长 6 位，列不跟着长就把数
// 截在框里 —— 框内也看不全（只能靠光标左右挪），等于换个单位就读不了表。按当前刻度下最长的那个
// 读数定宽（表格是 auto 布局，输入框的 min-width 就是这一列的最小内容宽）。
// 两端一并量：切到「起 + 止」那一档写的是它们，而 14022 ± 20.75 比中心本身多两位小数。
const numColW = computed(() => {
  let n = 6                                     // 底数 = MHz 档常见的「14022.5」那个长度
  for (const r of rowsResolved.value) {
    for (const v of [r.up?.fc, r.up?.bw, r.dn?.fc, r.up?.f1, r.up?.f2, r.dn?.f1, r.dn?.f2]) {
      if (Number.isFinite(v)) n = Math.max(n, String(dispF(v)).length)
    }
  }
  return `${n + 1}ch`
})
const issues = computed(() => (plan.value ? validatePlan(plan.value, opt.value.unit) : []))
const errCount = computed(() => errorCount(issues.value))

// ---- 标记类载波：信标 / 遥控 / 遥测 ----
//
// 这三类只有【频率 + 极化】两项，且只在一侧（信标与遥测是星上发的 → 下行，遥控是地面发的 → 上行）。
// 表与检查器据此只留它有的那几格：带宽 / 波束 / LO / 起止一律不出现 —— 摆出来也是填了不生效的格子。
const mkSide = (ch) => markSide(ch?.kind)          // '' = 转发器 / 保留（两侧都在）
const isMk = (ch) => isMark(ch)
// 该侧那一格出不出：转发器两侧都出，标记类只出它自己那一侧
const hasSide = (ch, side) => !mkSide(ch) || mkSide(ch) === side
const setKind = (ch, v) => setChannelKind(plan.value, ch, v)
// 标记类载波的那一个频率（解析结果里只有一侧非空）
const mkFc = (r) => (r?.up || r?.dn || {}).fc ?? null

function addChannel(kind = 'transponder') {
  if (!plan.value) return
  const side = markSide(kind)
  if (side) {
    // 极化照抄同侧最近的那一条（一颗星的几个信标多半同极化；不同再改一格即可）
    const prev = [...plan.value.channels].reverse().find((c) => markSide(c.kind) === side)
      || plan.value.channels[plan.value.channels.length - 1]
    const ch = newChannel({ no: '', kind })
    const pol = (side === 'up' ? prev?.up?.pol : prev?.dn?.pol)
    if (POLS.includes(pol)) ch[side].pol = pol
    plan.value.channels.push(ch)
    selectedId.value = ch.id
    return
  }
  // 「上一条」只认转发器：信标那几条没有带宽也没有排在序列上的频率，照抄过来只会得到一条空行
  const last = [...plan.value.channels].reverse().find((c) => !isMark(c))
  // 带宽照抄上一条的「录入状态」：上一条留空（随波束组）就跟着留空，别硬塞一个 36 把继承打断
  const lastBw = last ? uplinkBw(plan.value, last) : null
  const ch = newChannel({
    no: '',
    up: { fcMHz: last?.up.fcMHz != null ? last.up.fcMHz + (lastBw || 36) : null, bwMHz: last ? last.up.bwMHz : 36, pol: last?.up.pol || 'H' },
    dn: { pol: POL_ORTHO[last?.up.pol || 'H'] || 'V' },
    loId: last?.loId || plan.value.los[0]?.id || '',
    // 两侧都照抄上一条的录入状态：上一条下行留空（随上行）就跟着留空，别在这里替人做主填一份
    beamUpIds: last?.beamUpIds || [],
    beamDnIds: last?.beamDnIds || []
  })
  plan.value.channels.push(ch)
  selectedId.value = ch.id
}
function removeChannel(id) {
  if (!plan.value) return
  const at = plan.value.channels.findIndex((c) => c.id === id)
  plan.value.channels = plan.value.channels.filter((c) => c.id !== id)
  // 删掉的正是选中那条 → 落到顶上来的那条（删的是末条则退到前一条）。弹回第一行等于把视线
  // 从手头这一段甩到表头，删连着几条时尤其难受
  if (selectedId.value === id) {
    const list = plan.value.channels
    selectedId.value = (list[at] || list[at - 1] || list[0])?.id || ''
  }
  uncheck([id])                      // 勾选集里不能留悬挂 id（留着「已选 N 个」就与表上对不上）
}
function duplicateChannel(id) {
  const c = plan.value?.channels.find((x) => x.id === id)
  if (!c) return
  const copy = newChannel({ ...JSON.parse(JSON.stringify(c)), id: undefined, no: c.no + "'" })
  const i = plan.value.channels.indexOf(c)
  plan.value.channels.splice(i + 1, 0, copy)
  selectedId.value = copy.id
}
// 分配表组头上点色片：指定这条转发器的载波默认归哪个波束。只对「几个波束同频叠放」的转发器
// 有意义（频带被切开的按频率认领，见 freqPlanCapacity 的 rowBeam）。老计划没有这个字段，
// 直接补上去即可 —— 计划是深监听存盘的，加一个键照样落盘。
function setChannelBeam({ channelId, beamId }) {
  const ch = plan.value?.channels.find((c) => c.id === channelId)
  if (ch) ch.carrierBeamId = beamId || ''
}
// 该转发器从所属「波束/带宽」组继承来的带宽——带宽输入框留空时以灰字占位显示（同样按当前刻度写）
function groupBw(ch) {
  // 多波束时取第一个给了标称带宽的波束 —— 与 uplinkBw 的继承口径一致
  const b = (ch.beamUpIds || []).map((id) => plan.value?.beams.find((x) => x.id === id))
    .find((x) => Number.isFinite(x?.bwMHz))
  return Number.isFinite(b?.bwMHz) ? String(dispF(b.bwMHz)) : ''
}
// 不带刻度的数（dB、dBW/m²…）走这个；频率与带宽一律走 dput（要过一次换算）
function setNum(obj, key, v) {
  obj[key] = parseNum(v)
}

// ---- 上下行联动（等式与口径都在 freqPlanModel 那一段，这里只是接线）----
// 三处频率录入（表 / 检查器 / 批量生成）全走 setFc：LO 确定时改哪一边另一边都跟着变。
const setFc = (ch, side, v) => setChannelFc(plan.value, ch, side, v)
// 下行框里显示的数：联动态下它就是这条转发器的下行频率（由等式给出），不再是「灰字占位提示」。
// ★ 不四舍五入到 2 位：窄带计划里 0.01 MHz 以下是有效信息，而回写一个舍过的数会把正在敲的字改掉。
const dnDisp = (r) => (r?.dn ? r.dn.fc : null)
const dnLinked = (ch) => isDnLinked(plan.value, ch)
// 解耦态：挂着 LO 却又显式填了下行（cross-strap / 下行重排）——此时两侧各改各的，界面上要说清楚
const dnCut = (ch) => plan.value && loValueOf(plan.value, ch) != null && Number.isFinite(ch?.dn?.fcMHz)
const setCut = (ch, off) => setDnDecoupled(plan.value, ch, off)

// ---- 频带四格：中心 · 带宽 · 起 · 止 ----
//
// 四个数、两个自由度，是同一段频带的两种写法（等式与分支都在 freqPlanModel 的「频带两端」那一段，
// 这里只管录入手感）。三条口径：
//
//  ① 一律【迟落】—— 敲字期间只留字面，回车或离焦才落值。这四个数互相约束，敲到一半的前缀在等式里
//     同样成立：把 14022 改成 14100 的中途要经过 141，即时落值先拿 141 把整条转发器定死（带宽被算
//     成荒唐数），下一次按键又正好落在「越过另一端」那条分支上；带宽格同理（36 → 72 的中途是 7）。
//     从前只有起止两格走草稿、中心与带宽即时落值，两半手感不一样，图还要为每个中间态重排一次。
//  ② 改带宽【起始钉住】（setChannelBw 的 anchor='f1'）—— 与同一面板里波束段那格一致，也贴合频率
//     计划表「起始 + 带宽」的口径。从前是中心钉住、两端对称张缩。
//  ③ 中心与带宽都还没有的条目（波束合成导进来的、批量生成里带宽留空的），从前起止两格填什么都被
//     弹回空 —— 一端确实定不出一段频带，但那不该是死路。现在把落不下去的那一端记下（格子里照旧
//     显示着），另一端录进来就两端一起定（setChannelSpan）；中间去填了中心或带宽，落完也把它补上。
//
// 草稿带上【开敲时是哪一条】，见 useLateDraft 文件头：点表格另一行时 mousedown 先改 selectedId，
// 本格的 change/blur 在那之后才到，不抓下来这几个字就落到刚点中的那一行上了。
const { lval, lput, lend, lclr } = useLateDraft(() => opt.value.unit, dispF, toM)

const fcKey = (ch, side) => `${ch.id}.${side}.fc`
const bwKey = (ch, side) => `${ch.id}.${side}.bw`
const slotKey = (ch, side) => `${ch.id}.${side}.slot`
const edgeKey = (ch, side, which) => `${ch.id}.${side}.${which}`
const chEdges = (ch, side) => channelEdges(plan.value, ch, side)

// 落不下去的那一端（口径 ③）。一次只可能有一个：另一端录进来就当场兑现。
const edgePend = ref({ ch: null, side: '', which: '', mhz: null })
const clearPend = () => { edgePend.value = { ch: null, side: '', which: '', mhz: null } }
const pendOf = (ch, side, which) => {
  const p = edgePend.value
  return p.ch === ch && p.side === side && p.which === which ? p.mhz : null
}
// 记下了但还没成段的那一格：数照旧显示着，压成灰斜体与已落定的读数分开 —— 图上还没有这条频带，
// 不给个记号人会以为已经填进去了
const pendCls = (ch, side, which) => ({ pend: pendOf(ch, side, which) != null })
// 中心 / 带宽落值之后补上那一端：刚才缺的正是它俩之一
function flushPend(ch) {
  const p = edgePend.value
  if (p.ch !== ch || p.mhz == null) return
  if (setChannelEdge(plan.value, ch, p.side, p.which, p.mhz)) clearPend()
}
// 换刻度时那个数是上一把尺子上的（草稿由 useLateDraft 自己清）
watch(() => opt.value.unit, clearPend)

// ---- 右栏检查器：分区折叠 · 当前条定位 · 三处选中联动 ----
//
// 右栏是一条从「计划」一路到「批量生成」的长滚动区，从前分区之间只有一条 1px 的线（与栏内
// 行线同一档），整栏读起来是一列连不断的表单。现在每区一条 22px 的标题栏（吸顶）+ 区间 4px 灰槽，
// 标题栏可点折叠 —— 94 波束的计划里，把「波束/带宽」折起来才腾得出地方编转发器。
const SEC_KEY = 'freqplan/closedSecs'
const closedSecs = ref(new Set(readClosedSecs()))
function readClosedSecs() {
  try { return JSON.parse(localStorage.getItem(SEC_KEY) || '[]') } catch { return [] }
}
const secOpen = (k) => !closedSecs.value.has(k)
function putSecs(s) {
  closedSecs.value = s
  try { localStorage.setItem(SEC_KEY, JSON.stringify([...s])) } catch { /* ignore */ }
}
function toggleSec(k) {
  const s = new Set(closedSecs.value)
  if (s.has(k)) s.delete(k); else s.add(k)
  putSecs(s)
}
// 标题栏上的动作钮（加 LO / 加波束 / 从波束合成导入）在折叠着的区上也点得到，
// 那就必须连带展开——否则加出来的那一条落在看不见的地方，等同于「点了没反应」
function openSec(k) {
  if (secOpen(k)) return
  const s = new Set(closedSecs.value); s.delete(k); putSecs(s)
}

// 当前条在表上的位次：检查器标题栏写「7 / 18」并带 ‹ › 两个钮 —— 逐条核对参数时不必回表点
const selIdx = computed(() => (plan.value ? plan.value.channels.findIndex((c) => c.id === selectedId.value) : -1))
function stepSel(d) {
  const list = plan.value?.channels || []
  if (!list.length) return
  const i = selIdx.value < 0 ? (d > 0 ? -1 : list.length) : selIdx.value
  const n = Math.min(list.length - 1, Math.max(0, i + d))
  selectedId.value = list[n].id
}

// 行滚进视野。★ 不用 scrollIntoView：表头是 sticky 的，它算的「可见」不认那截表头，
// 往上翻时行会正好停在表头底下（看着就是「跳了一下还是没露出来」）。
function ensureRowVisible(tr) {
  const box = tblScroll.value
  if (!box || !tr) return
  const head = box.querySelector('thead')?.getBoundingClientRect().height || 0
  const br = box.getBoundingClientRect(), rr = tr.getBoundingClientRect()
  if (rr.top < br.top + head) box.scrollTop -= (br.top + head - rr.top)
  else if (rr.bottom > br.bottom) box.scrollTop += (rr.bottom - br.bottom)
}
// 图上点一块 / 校验条目跳过来 / ‹ › 翻条：表与右栏都跟到那一条上去。
// 反过来点表里的行时两者本就在视野内，nearest 的算法天然不动。
const chSecEl = ref(null)
watch(selectedId, (id) => {
  ddone()
  if (!id) return
  nextTick(() => {
    ensureRowVisible(document.querySelector(`.t tr[data-id="${id}"]`))
    // ★ 滚的是【区头】不是整区：转发器那一区比栏高，整区送进视野等于每选一条都把栏顶到那一区的
    //   开头（人正在下面编波束时尤其烦）。区头是 22px 的 sticky 条，已经在视野里就一动不动。
    chSecEl.value?.querySelector('.sh')?.scrollIntoView({ block: 'nearest' })
  })
})
// 图上双击一块 = 直接改它那一侧的中心频率（双击的是上行块就落在上行那一格）
function editBlock(b) {
  if (!b?.channelId) return
  selectedId.value = b.channelId
  openSec('ch')          // 折叠着的话先展开：v-show 的格子聚焦不了，双击会像没反应
  nextTick(() => {
    const el = chSecEl.value?.querySelector(`[data-f="${b.side === 'dn' ? 'dn' : 'up'}"]`)
    if (el) { el.focus(); el.select?.() }
  })
}
// 表里 ↑↓ 在同一列上下走（Excel 手感，与链路预算的站表一套）。
// ★ 只认输入框：下拉的 ↑↓ 是切选项，抢过来就没法用键盘选极化/LO 了。
function gridKey(e) {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
  const el = e.target
  if (!el || el.tagName !== 'INPUT' || el.type === 'checkbox') return
  const td = el.closest('td'), tr = el.closest('tr')
  if (!td || !tr) return
  const col = [...tr.children].indexOf(td)
  const next = e.key === 'ArrowUp' ? tr.previousElementSibling : tr.nextElementSibling
  const to = next?.children[col]?.querySelector('input:not([type=checkbox]), select')
  if (!to) return
  e.preventDefault()
  to.focus({ preventScroll: true })      // 自己按表头高度滚（见 ensureRowVisible）
  to.select?.()
  ensureRowVisible(next)
}

// 中心频率：带宽不动、两端一起挪。上下行联动仍走唯一收口（LO 确定时改哪一边另一边都跟着变）
function commitFc(ch, side, m) {
  setChannelFc(plan.value, ch, side, m)
  flushPend(ch)
}
// 带宽：起始钉住、终止随之走
function commitBw(ch, side, m) {
  setChannelBw(plan.value, ch, side, m, 'f1')
  flushPend(ch)
}

function edgeVal(ch, side, which) {
  const pend = pendOf(ch, side, which)
  if (pend != null) return lval(edgeKey(ch, side, which), pend)
  const e = chEdges(ch, side)
  // 带宽未定 → 两端无从谈起，空着（占位字提示这格是哪一端）
  return lval(edgeKey(ch, side, which), which === 'f1' ? e.f1 : e.f2)
}
function commitEdge(ch, side, which, m) {
  if (!ch) return
  const other = which === 'f1' ? 'f2' : 'f1'
  const twin = pendOf(ch, side, other)
  // 另一端刚才也没落下去 → 两端齐了，直接定出这一段
  if (m != null && twin != null) {
    clearPend()
    if (setChannelSpan(plan.value, ch, side, which === 'f1' ? m : twin, which === 'f1' ? twin : m)) return
  }
  const mode = setChannelEdge(plan.value, ch, side, which, m)
  if (mode == null) {
    // 数是好的却落不下去 = 中心与带宽都还没有：先记着，等另一端（或等中心/带宽录进来）。
    // 清空这一格 = 把记着的那个数擦掉（别的格子记着的不动）
    if (m != null) edgePend.value = { ch, side, which, mhz: m }
    else if (pendOf(ch, side, which) != null) clearPend()
    return
  }
  clearPend()
  if (mode === 'shift') {
    flash(`${which === 'f1' ? '起始越过终止' : '终止越过起始'} —— 已按「带宽不变、整条频带平移」处理`)
  }
}
// 说明写全：「改一端另一端钉住」是这两格与中心频率的全部区别，不写清人只会把它们当两个只读读数
// ★ 整条 title 由四五个从句拼出、其中几段还是三元选词 —— 拼完的整串永远进不了 uiDict，
//   呈现层只能按标点把它切碎了逐段查表，切错一层整句就成中英夹杂。这类「运行时才拼得出全貌」
//   的长句一律在生成时按平台语言出字（同 e2e / AboutDialog 的做法）。
function edgeTitle(ch, side, which) {
  const self = which === 'f1' ? '起始' : '终止'
  const other = which === 'f1' ? '终止' : '起始'
  const selfEn = which === 'f1' ? 'start' : 'stop'
  const otherEn = which === 'f1' ? 'stop' : 'start'
  const e = chEdges(ch, side)
  return byLang(
    `${side === 'up' ? '上行' : '下行'}频带${which === 'f1' ? '下' : '上'}边沿。`
      + `改这里${other}钉住，中心与带宽一并重算（中心 =（起 + 止）/ 2 · 带宽 = 止 − 起）；`
      + `${self}越过${other}时改按「带宽不变、整条频带平移」处理。回车或离焦生效。`
      + (e.fc == null && e.bw == null ? '这条还没有中心也没有带宽 —— 两端都录进来即定出这一段。'
        : e.bw == null ? '当前带宽未定 —— 此时改为中心钉住、由这一端定出带宽。'
          : '带宽随之落成本转发器自填值（不再随波束/带宽组）。')
      + (side === 'dn' && dnLinked(ch) ? '下行与 LO 联动：上行随等式反解，带宽两侧同宽故落在上行。' : ''),
    `${side === 'up' ? 'Uplink' : 'Downlink'} band ${which === 'f1' ? 'lower' : 'upper'} edge. `
      + `Editing it pins the ${otherEn}; the centre and bandwidth are both recomputed (centre = (start + stop) / 2 · bandwidth = stop − start). `
      + `If the ${selfEn} crosses the ${otherEn} it is handled as “bandwidth unchanged, whole band shifted”. Takes effect on Enter or blur. `
      + (e.fc == null && e.bw == null ? 'This one has neither a centre nor a bandwidth yet — entering both ends fixes the band.'
        : e.bw == null ? 'The bandwidth is undefined, so the centre is pinned instead and this end fixes the bandwidth.'
          : 'The bandwidth becomes this transponder’s own value (it no longer follows the beam / bandwidth group).')
      + (side === 'dn' && dnLinked(ch) ? ' The downlink is tied to the LO: the uplink is back-solved from the equation, and since both sides share one width the bandwidth lands on the uplink.' : '')
  )
}

// ---- 转发器占段：这条转发器的频带分给它的几个波束（界面上唯一的频率录入口）----
//
// 段位是【转发器】的属性，不是波束的：人一次编排一条转发器，「这条 36 MHz 分给哪几个波束、
// 各占哪一截」在那条转发器上一眼看得全。波束那边只有名字与标称带宽。口径与四条分支都在
// freqPlanModel 的 setBeamSegEdge，这里只管录入手感：
//   · 起止两格走草稿、回车或离焦才提交（同转发器自己的起止：敲到一半的前缀在等式里同样成立，
//     即时落值会把整段定死在中间值上）；带宽即时落值（它自己就是一个独立的数）。
//   · 三格恒自洽：只存 偏移 + 带宽，终止是算出来的。
//   · 留空 = 走排布档（自适应 / 频分排布 / 同频叠加），格子里写的是算出来的落点（灰字占位）。
// ★ 下行那一份【留空 = 随上行】（段内格局不变、整段随本转发器的 LO 平移，常态），填了才是
//   下行另有落点（cross-strap / 下行重排 / 收发不等宽）—— 同「下行波束留空 = 随上行」那套读法。
// 这条转发器这一侧实际生效的那组波束（下行留空 = 随上行，占段表跟着摊开同一组）
const chBeams = (ch, side) => (ch ? channelBeams(plan.value, ch, side) : [])
const segKey = (chId, beamId, side, which) => `sg.${chId}.${beamId}.${side}.${which}`
const segOf = (ch, side, beamId) => beamSegs(plan.value, ch, side).find((g) => g.beam.id === beamId) || null
// 这一格的【原值】：录过才写数，没录过写空（灰字占位写的是算出来的落点）
function segEdgeVal(ch, side, b, which) {
  const k = segKey(ch.id, b.id, side, which)
  const g = segOf(ch, side, b.id)
  if (!g || g.autoOff) return lval(k, null)
  return lval(k, which === 'f1' ? g.f1 : g.f2)
}
const segEdgePh = (ch, side, b, which) => {
  const g = segOf(ch, side, b.id)
  const v = !g ? null : (which === 'f1' ? g.f1 : g.f2)
  return v == null ? '' : String(dispF(v))
}
const segBwVal = (ch, side, b) => lval(segKey(ch.id, b.id, side, 'bw'), segBwOf(ch, b.id, side))
// 带宽留空之后实际用的那个数：该波束这一侧的标称带宽，没有标称就是「占满」整条频带
function segBwPh(ch, side, b) {
  const nom = beamBw(b)
  if (nom != null) return String(dispF(nom))
  const g = segOf(ch, side, b.id)
  return g && g.full ? '占满' : ''
}
function commitSegEdge(ch, side, b, which, m) {
  const mode = setBeamSegEdge(plan.value, ch, side, b.id, which, m)
  if (mode === 'shift') {
    flash(`${side === 'dn' ? '下行' : '上行'}波束「${b.name}」${which === 'f1' ? '起始越过终止' : '终止越过起始'} —— 已按「带宽不变、整段平移」处理`)
  }
}
// 同 edgeTitle：整串拼出来才成句，故在这里就按平台语言出字
function segEdgeTitle(ch, side, b, which) {
  const self = which === 'f1' ? '起始' : '终止'
  const other = which === 'f1' ? '终止' : '起始'
  const selfEn = which === 'f1' ? 'start' : 'stop'
  const otherEn = which === 'f1' ? 'stop' : 'start'
  const g = segOf(ch, side, b.id)
  const auto = g && g.autoOff
  return byLang(
    `波束「${b.name}」在本转发器${side === 'dn' ? '下行' : '上行'}频带里占的那一段的${which === 'f1' ? '下' : '上'}边沿（绝对频率）。`
      + (auto ? `当前是${LAYOUT_TEXT[g.from] || '自动'}排布生成的位置，录入后即固定。` : '')
      + `改这里${other}钉住、带宽随之变（带宽 = 终止 − 起始）；${self}越过${other}时改按「带宽不变、整段平移」处理。`
      + (which === 'f1' ? '清空 = 这个波束回到自动排布。' : '')
      + (side === 'dn' ? '留空 = 随上行（整段随本转发器的 LO 平移）。' : '')
      + '回车或离焦生效。',
    `${which === 'f1' ? 'Lower' : 'Upper'} edge (absolute frequency) of the slice beam “${b.name}” takes in this transponder’s ${side === 'dn' ? 'downlink' : 'uplink'} band. `
      + (auto ? `The position now comes from ${LAYOUT_TEXT_EN[g.from] || 'automatic'} layout and is fixed once entered. ` : '')
      + `Editing it pins the ${otherEn} and lets the bandwidth follow (bandwidth = stop − start); if the ${selfEn} crosses the ${otherEn} it is handled as “bandwidth unchanged, whole slice shifted”. `
      + (which === 'f1' ? 'Clearing it returns this beam to automatic layout. ' : '')
      + (side === 'dn' ? 'Leave empty to follow the uplink (the slice moves with this transponder’s LO). ' : '')
      + 'Takes effect on Enter or blur.'
  )
}
function segBwTitle(ch, side, b) {
  return `波束「${b.name}」在本转发器${side === 'dn' ? '下行' : '上行'}占的那一段有多宽（${U.value}）：`
    + '起始钉住、终止随之走（终止 = 起始 + 带宽）。'
    + `留空 = 随该波束的${side === 'dn' ? '下行' : ''}标称带宽（「波束/带宽」那里填的），波束也没填则占满整条频带。`
}
// 波束那边只剩标称带宽这一个数（频率不在那里设，上下行也不分两格）
function bmBwTitle(b) {
  return `波束「${b.name}」的标称带宽（${U.value}）：`
    + '转发器那行的带宽留空即取这个值；它在各转发器里占哪一段由那条转发器的占段表定，留空 = 占满整条频带。'
    + '收发不等宽的转发器在占段表里两侧各录各的。'
}
const LAYOUT_TEXT = { tile: '频分', stack: '同频', seg: '录入' }
const LAYOUT_TEXT_EN = { tile: 'frequency-division', stack: 'co-frequency', seg: 'manual' }
const LAYOUT_TIP = '这条转发器的频带在几个波束之间怎么摆（只管【没逐个录过起止】的那些）：'
  + '自适应 = 人人有带宽且装得下就频分排布，装不下就同频叠加；'
  + '频分排布 = 自频带下边沿依次紧排（HTS 那一路，转发器带宽 = Σ 各波束带宽）；'
  + '同频叠加 = 各自贴频带下边沿、各占各的带宽（常规多波束转发器 / 频率复用）。'
  + '整条转发器一档，上下行同一个（段内格局不变，下行随 LO 平移）。'
// 排布档换了之后，自动排出来的落点跟着变——草稿里还留着上一档的字面值会把新落点盖掉
const setLayout = (ch, v) => { lclr(); ch.beamLayout = v }

// 表上 LO 那格只写得下名字（列宽就那么点），数值补在 title 里
function loTitle(ch) {
  const l = plan.value?.los.find((x) => x.id === ch.loId)
  return l ? `${l.name}：${textF(l.valueMHz)}` : '未挂 LO —— 上下行各自独立'
}
// 下拉里的一条 LO（批量条与检查器共用）：名字 + 当前刻度下的数
const loOption = (l) => `${l.name} · ${textF(l.valueMHz)}`
function sortChannels() {
  if (!plan.value) return
  // 标记类载波一律排到表尾：它们没有上行频率（信标与遥测的那个数是下行的），混进来按数排的话
  // 一个 12500 的信标会插到 14022 那排转发器之前 —— 两个数不在同一侧，不可比。
  const fc = (c) => c.up.fcMHz ?? c.dn.fcMHz ?? 0
  plan.value.channels.sort((a, b) => (isMark(a) - isMark(b)) || (fc(a) - fc(b)))
  flash('已按上行频率排序')
}

// ---- 批量操作 ----
//
// 一份计划动辄二三十条转发器，而实际改动本就是成段成段的：A 面全 H / B 面全 V、这一段整体换个 LO、
// 这十条归到点波束、整条频带平移 0.5 MHz…… 逐行点二十遍是这张表最费手的地方。
//
// 口径：表左端那一列勾选 = 【批量作用域】，与「点行 = 送进右栏检查器改单条」是两件事，互不干扰
// （同覆盖分析那条「点行 = 编辑 ≠ 显示」的解耦）。勾选按 id 记，排序/复制后依然认得住。
// 批量条只在有勾选时浮出，条上每一项都是【动作】不是【状态】：选完即施加，随即弹回「—」——
// 否则一条常驻的工具栏会让人以为那几个下拉显示的是「这批转发器现在的值」。
const checkedIds = ref(new Set())
let lastCheckedId = ''                 // Shift 连选的锚点
const isChecked = (id) => checkedIds.value.has(id)
const checkedChannels = computed(() => (plan.value?.channels || []).filter((c) => checkedIds.value.has(c.id)))
const checkedCount = computed(() => checkedChannels.value.length)
const allChecked = computed(() => !!plan.value?.channels.length && checkedCount.value === plan.value.channels.length)
const someChecked = computed(() => checkedCount.value > 0 && !allChecked.value)

function setChecked(ids, on) {
  const s = new Set(checkedIds.value)
  for (const id of ids) { if (on) s.add(id); else s.delete(id) }
  checkedIds.value = s
}
const uncheck = (ids) => setChecked(ids, false)
function clearChecked() { checkedIds.value = new Set(); lastCheckedId = '' }
function toggleCheck(ch, e) {
  const on = !isChecked(ch.id)
  const list = plan.value?.channels || []
  const a = list.findIndex((c) => c.id === lastCheckedId)
  const b = list.findIndex((c) => c.id === ch.id)
  // Shift = 从上次点的那行连选到这行（表格通行手势；一段连号转发器正是最常见的选法）
  if (e?.shiftKey && a >= 0 && b >= 0 && a !== b) {
    const [lo, hi] = a < b ? [a, b] : [b, a]
    setChecked(list.slice(lo, hi + 1).map((c) => c.id), on)
  } else setChecked([ch.id], on)
  lastCheckedId = ch.id
}
function toggleCheckAll() {
  const list = plan.value?.channels || []
  checkedIds.value = allChecked.value ? new Set() : new Set(list.map((c) => c.id))
  lastCheckedId = ''
}

// ---- 拖选：Excel 行头那套手势 ----
//
// 手势只落在最左那道「勾选 + 行号」的槽上（就是 Excel 的行头），不认行身 —— 这张表几乎每一格都是
// 输入框，在输入框上按住拖是在选文字，两个手势不能抢同一块地方。槽上的三种动作：
//   按住拖 = 沿途整片同向切换（起始行原本没选就整片选上、原本选着就整片取消，与拖的方向无关）
//   单击   = 只切换这一行
//   Shift+单击/拖 = 从上次那行连选到这行（原有勾选保留）
// 勾选框本身设了 pointer-events:none，鼠标事件一律由整格接管 —— 否则「按下即切换」会与它自己的
// click 再切一次撞成来回翻。键盘走勾选框的 change（空格键仍能勾）。
let drag = null                    // { from, add, base:Set }
const dragging = ref(false)
let dragPt = null, dragTimer = null
const tblScroll = ref(null)

// 只按纵坐标找行，不做命中测试：横着晃出表宽、滑到表底那条横滚动条上（它正好压在边缘触发区里）
// 都还认得住 —— 拖选是「拖到第几行」的事，与横坐标无关（Excel 亦然）。
function rowIdxAtY(y) {
  const box = tblScroll.value
  if (!box) return -1
  let best = -1, bestD = Infinity
  for (const tr of box.querySelectorAll('tr[data-idx]')) {
    const r = tr.getBoundingClientRect()
    const i = Number(tr.dataset.idx)
    if (y >= r.top && y <= r.bottom) return i
    const d = y < r.top ? r.top - y : y - r.bottom
    if (d < bestD) { bestD = d; best = i }      // 拖过表头/表尾之外 → 收在第一行/最后一行
  }
  return best
}
function applyDrag(to) {
  const list = plan.value?.channels || []
  if (!drag || to < 0 || to >= list.length) return
  const [lo, hi] = drag.from <= to ? [drag.from, to] : [to, drag.from]
  const s = new Set(drag.base)
  for (let k = lo; k <= hi; k++) { if (drag.add) s.add(list[k].id); else s.delete(list[k].id) }
  checkedIds.value = s
}
function gutterDown(i, e) {
  if (e.button !== 0 || !plan.value) return
  e.preventDefault()                                   // 免得连带拖出浏览器自己的文字选区
  const list = plan.value.channels
  const ch = list[i]
  if (!ch) return
  selectedId.value = ch.id                             // 抓住哪行，右栏检查器就跟到哪行
  const anchor = list.findIndex((c) => c.id === lastCheckedId)
  if (e.shiftKey && anchor >= 0 && anchor !== i) drag = { from: anchor, add: true, base: new Set(checkedIds.value) }
  else {
    drag = { from: i, add: !isChecked(ch.id), base: new Set(checkedIds.value) }
    lastCheckedId = ch.id
  }
  dragging.value = true
  applyDrag(i)
  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('mouseup', endDrag)
}
function onDragMove(e) {
  if (!e.buttons) { endDrag(); return }                // 松手落在窗口外时的兜底，否则拖选会「粘住」
  dragPt = { x: e.clientX, y: e.clientY }
  applyDrag(rowIdxAtY(dragPt.y))
  autoScroll()
}
// 拖到表格上下边缘就自动滚 —— 二十几条转发器一屏放不下，不然连选只能选到看得见的那几行
function autoScroll() {
  const box = tblScroll.value
  if (!box || !dragPt) return
  const r = box.getBoundingClientRect()
  const near = (y) => (y < r.top + 26 ? -1 : y > r.bottom - 26 ? 1 : 0)
  if (!near(dragPt.y)) { clearInterval(dragTimer); dragTimer = null; return }
  if (dragTimer) return
  dragTimer = setInterval(() => {
    if (!drag || !dragPt) return
    box.scrollTop += near(dragPt.y) * 14
    applyDrag(rowIdxAtY(dragPt.y))            // 行在指针下滑过，选区跟着长
  }, 40)
}
function endDrag() {
  drag = null; dragging.value = false; dragPt = null
  clearInterval(dragTimer); dragTimer = null
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', endDrag)
}

// 批量条上的几个下拉/输入。下拉恒以 '' 为「—」，故「不挂 LO」得另给一个哨兵值（'' 已被占用）
const NO_LO = '__none__'
const bsel = ref({ kind: '', upPol: '', dnPol: '', lo: '' })
// bwMHz / shiftMHz 同模型一律存 MHz，格子里按当前刻度显示（走 dput/dval）
const batch = ref({ bwMHz: null, shiftMHz: null, noPattern: 'C{n}', noStart: 1 })
const beamPop = ref('')                // '' | 'up' | 'dn'：波束批量赋值的浮层
const batchBeamIds = ref([])
const addPop = ref(false)              // 「+ 转发器」旁那个小菜单（加信标 / 遥控 / 遥测）

function eachChecked(label, fn) {
  const list = checkedChannels.value
  if (!list.length) return
  list.forEach(fn)
  flash(`${list.length} 个转发器：${label}`)
}
// 标记类载波没有带宽 / 波束 / LO，批量施加时跳过它们 —— 勾了一整片（含中间那条信标）再改带宽是常事，
// 落值到信标身上既不显形又会在存储里留下不生效的数
const notMk = (fn) => (c) => { if (!isMark(c)) fn(c) }
function batchSet(key) {
  const v = bsel.value[key]
  if (v) {
    if (key === 'kind') eachChecked(`类型 → ${KIND_LABEL[v] || v}`, (c) => setKind(c, v))
    // 极化只落在这一条真有的那一侧：下行的信标不该被「上行极化」改到（那一格根本不出现在表上）
    else if (key === 'upPol') eachChecked(`上行极化 → ${v}`, (c) => { if (hasSide(c, 'up')) c.up.pol = v })
    // 「正交」不是一个极化值而是一条规则：逐条按各自的上行取正交（同频复用的 B 面正是这么排的）
    else if (key === 'dnPol') {
      eachChecked(v === 'ortho' ? '下行极化 → 随上行取正交' : `下行极化 → ${v}`,
        (c) => { if (hasSide(c, 'dn')) c.dn.pol = v === 'ortho' ? (POL_ORTHO[c.up.pol] || 'V') : v })
    } else if (key === 'lo') {
      const id = v === NO_LO ? '' : v
      const nm = id ? (plan.value?.los.find((l) => l.id === id)?.name || 'LO') : '不挂 LO'
      eachChecked(`本振 → ${nm}`, notMk((c) => { c.loId = id }))
    }
  }
  bsel.value[key] = ''                 // 动作不留痕：弹回「—」
}
// 带宽：填了数 = 各条单独指定；清 = 回到「随所属波束组的标称值」（与单行留空同一口径）
const batchBwOk = computed(() => Number.isFinite(batch.value.bwMHz))
function batchBw(clear) {
  if (clear) { eachChecked('带宽已清空（随波束组）', notMk((c) => { c.up.bwMHz = null })); return }
  const v = batch.value.bwMHz
  if (v == null) return
  eachChecked(`带宽 → ${textF(v)}`, notMk((c) => { c.up.bwMHz = v }))
}
// 频率平移：整条频带一起挪。联动态的下行由等式给出（不用动它），解耦态的下行不跟上行走，得自己挪一次
const batchShiftOk = computed(() => { const d = batch.value.shiftMHz; return Number.isFinite(d) && d !== 0 })
function batchShift() {
  const d = batch.value.shiftMHz
  if (!Number.isFinite(d) || !d) return
  eachChecked(`频率平移 ${d > 0 ? '+' : ''}${textF(d)}`, (c) => {
    if (Number.isFinite(c.up.fcMHz)) c.up.fcMHz = cleanFreq(c.up.fcMHz + d)
    if (Number.isFinite(c.dn.fcMHz)) c.dn.fcMHz = cleanFreq(c.dn.fcMHz + d)
  })
}
// 重编号：按表上的先后逐条顺次给号（先「排序」再重编号，就是把一排转发器理成 C1…Cn 的做法）
function batchRenumber() {
  const pat = String(batch.value.noPattern || '')
  if (!pat.includes('{n}')) { flash('编号模板要含 {n}（如 C{n}）'); return }
  const start = parseNum(batch.value.noStart) ?? 1
  let i = 0
  eachChecked(`已按「${pat}」重编号`, (c) => { c.no = pat.replace(/\{n\}/g, String(start + i)); i++ })
}
function openBeamPop(side) {
  if (beamPop.value === side) { beamPop.value = ''; return }
  beamPop.value = side
  // 预置成第一条勾选行的现值 —— 批量改波束多半是「在这组上再加/减一个」，不是从零选起
  const first = checkedChannels.value[0]
  batchBeamIds.value = [...((side === 'up' ? first?.beamUpIds : first?.beamDnIds) || [])]
}
function applyBeamPop(clear) {
  const side = beamPop.value
  const ids = clear ? [] : [...batchBeamIds.value]
  const txt = ids.length
    ? ids.map((id) => plan.value?.beams.find((b) => b.id === id)?.name).filter(Boolean).join(' + ')
    : (side === 'up' ? '不归组' : '随上行')
  eachChecked(`${side === 'up' ? '上行' : '下行'}波束 → ${txt}`,
    notMk((c) => { if (side === 'up') c.beamUpIds = [...ids]; else c.beamDnIds = [...ids] }))
  beamPop.value = ''
}
// 复制到表尾（不逐条插在原行后）：复制出来的这一批多半接着就要整批再改一遍（B 面翻极化那种），
// 连成一段才好接着批量操作 —— 故勾选顺势转到副本上；要回到频率次序点一下「排序」即可。
function batchDuplicate() {
  const list = checkedChannels.value
  if (!list.length || !plan.value) return
  const copies = list.map((c) => newChannel({ ...JSON.parse(JSON.stringify(c)), id: undefined, no: c.no + "'" }))
  plan.value.channels.push(...copies)
  checkedIds.value = new Set(copies.map((c) => c.id))
  lastCheckedId = ''
  selectedId.value = copies[0].id
  flash(`已复制 ${copies.length} 个转发器到表尾（勾选已转到副本）`)
}
async function batchRemove() {
  const list = checkedChannels.value
  if (!list.length || !plan.value) return
  if (!(await ask(`删除选中的 ${list.length} 个转发器？此操作不可撤销。`))) return
  const ids = new Set(list.map((c) => c.id))
  plan.value.channels = plan.value.channels.filter((c) => !ids.has(c.id))
  clearChecked()
  if (!plan.value.channels.some((c) => c.id === selectedId.value)) selectedId.value = plan.value.channels[0]?.id || ''
  flash(`已删除 ${ids.size} 个转发器`)
}

// ---- 批量生成 ----
// 「起始频率」是第一个转发器的【频带下边沿】，不是它的中心频率：手上的频率计划表给的本就是
// 「14004 起、41.5 间隔」这种边沿口径，让人先自己减掉半个带宽再填等于把算术摊回给读表的人。
// 模型内部一律存中心频率（fc ± bw/2 即频带两端），故边沿 → 中心的换算只在这个录入口做一次：
//   fc₁ = 起始频率 + 带宽/2
// dnPolMode: '' = 下行取上行的正交极化（默认，转发器翻极化的常见接法）| 'same' = 下行与上行同极化。
// 一排恒为同一个上行极化：真实计划里换极化的那一排，编号与起始频率本就另起一套，分两批生成更直白
// （曾有个「全同 / 逐个交替」的模式选择器，交替出来的那半排编号怎么排始终说不清，已撤）。
// 三个频率量（起始 / 间隔 / 带宽）同模型一律存 MHz，格子里按当前刻度显示 —— 换刻度时这三格
// 里的数跟着换算（14004 MHz ⇄ 14004000 kHz），与表上的数始终是同一把尺子。
const gen = ref({ count: 6, startFMHz: 14004, stepMHz: 41.5, bwMHz: 36, pol: 'H', dnPolMode: '', noPattern: 'C{n}', noStart: 1, loId: '', beamUpIds: [], beamDnIds: [], kind: 'transponder' })
// 批量生成也是双向的：手上拿到的若是下行那张表，直接填「下行起始频率」即可，上行由 LO 反解。
// 间隔不给两份 —— LO 是常数，两侧间隔本就相同，给两个只会多一处能填错的地方。
const genLo = computed(() => {
  const l = plan.value?.los.find((x) => x.id === gen.value.loId)
  return l && Number.isFinite(l.valueMHz) ? l.valueMHz : null
})
// 边沿 → 中心用的带宽：本栏填了用填的，留空则取所选上行波束组的标称值（与转发器那行
// 「带宽留空 = 取本组标称值」同一口径）。两处都没有 → 半带宽按 0 计：带宽都还没定，也就无边沿可言。
const genBw = computed(() => {
  const b = gen.value.bwMHz
  if (Number.isFinite(b)) return b
  for (const id of gen.value.beamUpIds || []) {
    const bm = plan.value?.beams.find((x) => x.id === id)
    if (Number.isFinite(bm?.bwMHz)) return bm.bwMHz
  }
  return null
})
const genHalfBw = computed(() => (Number.isFinite(genBw.value) ? genBw.value / 2 : 0))
// 上下行两侧填的都是边沿：整条频带平移 LO，边沿之差与中心之差是同一个数，故仍走同一条等式
const genDnStartMHz = computed(() => dnFromUp(gen.value.startFMHz, genLo.value))
// 收的是已换算好的 MHz（录入口统一在 dput 那一处过刻度，不在这里再过一次）
function setGenDnStart(mhz) {
  if (genLo.value == null) return
  gen.value.startFMHz = mhz == null ? null : upFromDn(mhz, genLo.value)
}
function runGen() {
  if (!plan.value) return
  // 带宽留空 → null（各通道随所属波束/带宽组走）。不能写成 Number('')，那会变成 0 宽转发器
  const bw = gen.value.bwMHz
  const startF = gen.value.startFMHz ?? 0
  const chs = genSeries({
    ...gen.value, count: parseNum(gen.value.count) || 0,
    startFcMHz: cleanFreq(startF + genHalfBw.value),   // 录入的是边沿，模型收的是中心
    stepMHz: gen.value.stepMHz ?? 0, bwMHz: bw, noStart: parseNum(gen.value.noStart) || 1,
    dnPol: gen.value.dnPolMode === 'same' ? gen.value.pol : null   // 模型收的是极化字母；null = 由它取正交
  })
  if (!chs.length) { flash('数量为 0'); return }
  plan.value.channels.push(...chs)
  selectedId.value = chs[0].id
  // 频段不在这儿设：自动档由 autoBand 那个监听按新的频率刷新，手选档则原样保留（见「---- 频段 ----」）
  flash(`已生成 ${chs.length} 个转发器`)
}

// ---- LO / 波束 ----
function addLo() { openSec('lo'); plan.value?.los.push(newLo({ name: `LO${(plan.value.los.length || 0) + 1}`, valueMHz: null })) }
function removeLo(id) {
  if (!plan.value) return
  plan.value.los = plan.value.los.filter((l) => l.id !== id)
  for (const c of plan.value.channels) if (c.loId === id) c.loId = ''
}
function addBeam() {
  openSec('beam')
  const i = plan.value?.beams.length || 0
  // 带宽默认跟上一条（一份计划里多半是同一档带宽的几个波束）；上一条也没填就给 36 MHz 兜底。
  // 频率不在这里给：这一条占哪一段是各转发器的事（在转发器那一区录）。
  const prev = plan.value?.beams[i - 1]
  plan.value?.beams.push(newBeam({
    name: `Beam ${i + 1}`,          // 波束名直接进图例，默认名走英文（人改中文名照画中文）
    color: DEFAULT_BEAM_COLORS[i % DEFAULT_BEAM_COLORS.length],
    bwMHz: Number.isFinite(prev?.bwMHz) ? prev.bwMHz : DEFAULT_BW_MHZ
  }))
}

// ---- 从波束合成导入波束 ----
//
// 【同色的波束合并成一条】：同色 = 同频同极化，在频率上本就是同一件事，分成几条会让同一段频率
// 在表里出现几遍。故一条 = 一个色，【名字 = 它覆盖的那几个波束代号】（'1,5'、'1-3,7'；代号 =
// 整星连续编号，与 3D 页草图上画的那个数同一套）。未配色的波束没法按色合并，逐个成条。颜色与代号
// 由波束合成给（几何是那边的事），起止频率与带宽仍在这里录（频率是这边的事）。
// 色号（F1 这类）落在 synth 上，不另占一格：它是这一条的来源，挂在名字那格的 title 上读得出。
// 重新导入按【色号】配对（未配色那种按波束 id）：名字/颜色还是上次导进来的原样就跟着刷新，
// 人改过一次就钉死不再覆盖（同资源库自动命名那套，比对上一次的值即可，不必存标志位）。
const synthPop = ref(false)
const synthGroups = ref([])
// 现读现用：波束合成在另一个窗口随时在改，缓存下来只会导进一份旧的
function openSynthPop() { openSec('beam'); synthGroups.value = loadSynthGroups(); synthPop.value = true }
// 本计划这颗星的组排前面（一份计划挂在一颗星下，多半就是导它自己那几组）
const synthList = computed(() => {
  const folder = plan.value?.satFolder || ''
  return [...synthGroups.value].sort((a, b) => (a.satFolder === folder ? 0 : 1) - (b.satFolder === folder ? 0 : 1))
})
const synthSatName = (folder) => (satNodes.value.find((s) => s.folder === folder) || {}).satName || ''
// 别的星上的组，行里写出星名 —— 一份计划挂在一颗星下，导错星是这一步唯一会犯的错
const synthOtherSat = (g) => (g.satFolder === (plan.value?.satFolder || '') ? '' : synthSatName(g.satFolder))
function synthTitle(g) {
  const sat = synthSatName(g.satFolder)
  const head = `${g.name}${sat ? ` · ${sat}` : ''} · ${g.beamCount} 个波束`
  if (!g.colors.length) return `${head}｜还没有频率配色`
  return `${head}｜${g.colors.map((c) => `${fcLabel(c.fc)}×${c.count}`).join(' · ')}${g.uncolored ? `｜${g.uncolored} 个未配色` : ''}`
}
// 名字 = 这一条覆盖的波束代号。撞名（另一颗星的组也有这几个号）才补上组名
function synthBeamName(nos, group, used) {
  const base = fmtBeamNos(nos)
  if (!used.has(base)) return base
  const withGroup = `${base}·${group}`
  if (!used.has(withGroup)) return withGroup
  for (let i = 2; ; i++) if (!used.has(`${base}(${i})`)) return `${base}(${i})`
}
function importSynth(g) {
  if (!plan.value || !g?.entries?.length) return
  const used = new Set(plan.value.beams.map((b) => b.name))
  let added = 0, updated = 0
  g.entries.forEach((e, i) => {
    // 配对键：按色合并的用色号，未配色那种用波束合成那边的波束 id
    const cur = plan.value.beams.find((b) => b.synth && b.synth.groupId === g.id
      && (e.fc != null ? b.synth.fc === e.fc : b.synth.beamId === e.beamId))
    const color = e.css || DEFAULT_BEAM_COLORS[i % DEFAULT_BEAM_COLORS.length]
    if (cur) {
      // 还是上次导进来的原样才跟着刷新 —— 人改过一次就是人的了（同 nameAuto 那套，只是不必存标志位）
      if (cur.name === fmtBeamNos(cur.synth.nos)) cur.name = fmtBeamNos(e.nos)
      if (cur.synth.fc != null && cur.color === fcCss(cur.synth.fc)) cur.color = color
      cur.synth = { groupId: g.id, group: g.name, fc: e.fc, beamId: e.beamId, nos: e.nos.slice() }
      updated++
      return
    }
    const name = synthBeamName(e.nos, g.name, used)
    used.add(name)
    // 带宽不给默认值：这一条占多宽是这份计划的事，猜一个 36 只会让人以为已经填过（同「起止留空」）
    plan.value.beams.push(newBeam({
      name, color,
      synth: { groupId: g.id, group: g.name, fc: e.fc, beamId: e.beamId, nos: e.nos.slice() }
    }))
    added++
  })
  synthPop.value = false
  flash(`「${g.name}」：新增 ${added} 条${updated ? ` · 更新 ${updated} 条` : ''}`)
}

// 带宽录入与表里那几格同一套：显示按工具栏那一个单位、存进去一律 MHz（36 MHz ⇄ 36000 kHz）
function removeBeam(id) {
  if (!plan.value) return
  plan.value.beams = plan.value.beams.filter((b) => b.id !== id)
  for (const c of plan.value.channels) {
    c.beamUpIds = (c.beamUpIds || []).filter((x) => x !== id)
    c.beamDnIds = (c.beamDnIds || []).filter((x) => x !== id)
  }
}

// ---- 导入 ----
async function importJson() {
  if (!api?.freqPlan?.importJson) return
  const r = await api.freqPlan.importJson()
  if (!r || r.canceled) return
  await loadIndex()
  flash(`导入 ${r.added} 份${r.replaced ? `，覆盖 ${r.replaced} 份` : ''}${r.errors?.length ? `，${r.errors.length} 份失败` : ''}`)
}

// ---- 导出 ----
// opts.plans 给了就走【合成】管线（哪怕只选了一份：总标题与段头是合成图的一部分，单份管线画不出来），
// 没给就是当前这一份，与合成前的行为逐字节一致。
async function doExport(kind, opts = {}) {
  const list = opts.plans?.length ? opts.plans : (plan.value ? [plan.value] : [])
  if (!list.length || !api?.freqPlan?.exportFile) return null
  const composite = !!opts.plans?.length
  busy.value = '导出中…'
  try {
    const style = { ...opt.value, ...(opts.style || {}), width: chartW.value }
    const png = kind === 'png2' ? 2 : kind === 'png6' ? 6 : 4
    let payload = ''
    let note = ''      // 合成图太高时 PNG 倍率会被画布上限压下来，成功消息里如实说一句
    if (kind === 'json') {
      // 合成的 JSON 是【计划数组】—— 导入端（freqPlan:importJson）本就认数组，一份份合成的图
      // 与它背后的几份计划这样才对得上，不必把它们硬揉成一份计划
      payload = composite ? JSON.stringify(list, null, 2)
        : JSON.stringify({ ...plan.value, carriers: carriers.value }, null, 2)
    } else if (kind === 'xlsx' || kind === 'xlsxData') {
      // ★ 出 IPC 前现造一份纯数据：Vue 的响应式 Proxy 过不了结构化克隆，invoke 会当场抛且
      //   没人 catch（见 ipc-no-reactive-proxy）。模型本就是逐字段重造的，这一趟只作保险。
      payload = JSON.parse(JSON.stringify(
        buildFreqPlanXlsx(kind === 'xlsxData' ? 'data' : 'styled', plan.value, carriers.value, { unit: opt.value.unit })
      ))
    } else if (kind === 'svg') payload = composite ? toSvgTextMulti(list, style) : toSvgText(plan.value, style)
    else if (kind === 'pdf') payload = composite ? await toPdfDataUrlMulti(list, style) : await toPdfDataUrl(plan.value, style)
    else if (composite) {
      payload = await toPngDataUrlMulti(list, style, png, (sc) => { note = `（纸面过大，倍率已降到 ${sc}×）` })
    } else payload = await toPngDataUrl(plan.value, style, png)
    const ext = kind === 'json' ? 'json' : kind === 'svg' ? 'svg' : kind === 'pdf' ? 'pdf'
      : (kind === 'xlsx' || kind === 'xlsxData') ? 'xlsx' : 'png'
    // Excel 的默认文件名带上体例：一份计划两种版式常常同时导，同名会互相盖掉
    const base = opts.name || plan.value?.name || 'Frequency Plan'
    const name = kind === 'xlsx' ? `${base}-频率分配表`
      : kind === 'xlsxData' ? `${base}-频率计划数据表` : base
    const r = await api.freqPlan.exportFile(ext, payload, name)
    if (r?.canceled) return r
    flash(r?.ok ? '已导出：' + r.filePath + note : '导出失败：' + (r?.error || '未知错误'))
    return r
  } catch (e) { flash('导出失败：' + e.message); return null } finally { busy.value = '' }
}

// ---- 发到小程序 ----
// 与上面五种导出并列的第六条路，只是落点不是文件而是一个 8 位密钥（小程序「工具栏 ·
// 频率计划」输入即看）。★ 送的是【屏上这一份】（含 debounce 还没落盘的改动与载波），
// 与合成导出的 planOf 同一个口径 —— 眼前的图与发出去的图必须是同一张。
// ★★ 送的是导出那一刻的【版式】（绘制指令 + 解析结果），不是模型：小程序不重算 layout
//    （那套口径两个月改三轮，照抄必漂，见 shared/fpMiniExport.js 文件头）。计划改了要重发。
const miniOpen = ref(false)
const miniConfigured = ref(false)
const miniDeviceId = ref('')
function buildMiniPack() {
  const p = planOf(currentId.value)
  if (!p) return { name: '', items: [] }
  let it = fpMiniItem(p, { unit: opt.value.unit })
  // Excel 数据表是随包【捎】的一件（小程序那边「导出数据表」吃的就是它）。它按一条载波一行铺开，
  // 载波多的计划能捎出上百 KB —— 不该为了捎一张表把整包顶过云函数的返回上限、连图都发不出去。
  // 估一次，紧了就摘掉：图与分配表照送，小程序点导出时会说清楚为什么没有。
  if (estimateBytes(it) > SIZE_MAX - 48 * 1024) it = fpMiniItem(p, { unit: opt.value.unit, xlsx: false })
  return { name: p.name || '频率计划', items: [it] }
}
function openMiniSend() {
  if (!plan.value) return
  miniOpen.value = true
}

// ---- 合成导出：多份计划叠成一张完整的频率计划图 ----
//
// 一颗星的频率计划本就是分频段各做一份（C 一份、Ku 一份、Ka 一份），而对外给的那张「完整频率计划」
// （Intelsat 20 那种）是把各频段自上而下叠在一张纸上：每段各带各的上下行两条频带、各自的图例与 LO。
// 故这里合的是【版式】不是【数据】—— 几份计划照旧各存各的，合成只发生在出图这一步。
const mergeOpen = ref(false)
const mergeQ = ref('')
const mergeIds = ref([])            // 已选 id；数组顺序 = 图上自上而下的叠放顺序
const mergePlans = ref([])          // 与 mergeIds 同序的计划全文（预览与导出都吃它）
const mergeCache = new Map()        // id → 全文：勾一次读一次盘，反复勾不重复读
const mergeTitle = ref('')
const mergeShared = ref(false)      // 各段统一比例尺
const mergeSecTitles = ref(true)
const mergeKind = ref('png4')
const mergeTree = computed(() => buildTree(mergeQ.value))
const mergeSelected = computed(() => mergeIds.value.map((id) => index.value.find((e) => e.id === id)).filter(Boolean))

async function cachePlan(id) {
  if (mergeCache.has(id)) return mergeCache.get(id)
  const raw = await api?.freqPlan?.get?.(id)
  if (!raw) return null
  // 归一模型字段，但保留计划文件里的其余键（carriers 等）—— 合成导出 JSON 时不能把它们丢了
  const p = { ...raw, ...normalizePlan(raw) }
  mergeCache.set(id, p)
  return p
}
// 当前打开的那份以【屏上这份】为准：debounce 还没落盘的改动也得进合成图，否则预览与眼前的图不一致
function planOf(id) {
  if (id === currentId.value && plan.value) {
    return { ...JSON.parse(JSON.stringify(plan.value)), id: currentId.value, carriers: JSON.parse(JSON.stringify(carriers.value)) }
  }
  return mergeCache.get(id) || null
}
async function syncMergePlans() {
  const out = []
  for (const id of mergeIds.value) {
    if (id !== currentId.value) await cachePlan(id)
    const p = planOf(id)
    if (p) out.push(p)
  }
  mergePlans.value = out
}
// 总标题是画在图最上方的那一行，故默认值同样是英文的（人自己改成中文的照画）
function defaultMergeTitle() {
  const sats = [...new Set(mergeSelected.value.map((e) => e.satName || '').filter(Boolean))]
  if (sats.length === 1) return `${sats[0]} Frequency Plan`
  return sats.length ? 'Frequency Plans' : (plan.value?.name || 'Frequency Plan')
}
async function openMerge() {
  if (!api?.freqPlan) return
  mergeQ.value = ''
  // 预置为当前计划所属卫星的全部计划 —— 合成的典型场景就是「这颗星的 C + Ku + Ka」，
  // 开着就是要的那几份，不必再勾一遍；不要的取消勾选即可
  const folder = plan.value ? (plan.value.satFolder || '') : null
  mergeIds.value = folder != null ? index.value.filter((e) => (e.satFolder || '') === folder).map((e) => e.id) : []
  if (currentId.value && !mergeIds.value.includes(currentId.value)) mergeIds.value.unshift(currentId.value)
  mergeTitle.value = defaultMergeTitle()
  mergeOpen.value = true
  busy.value = '载入中…'
  try { await syncMergePlans(); sortMergeByFreq() } finally { busy.value = '' }
}
async function toggleMerge(id) {
  const i = mergeIds.value.indexOf(id)
  if (i >= 0) mergeIds.value.splice(i, 1)
  else mergeIds.value.push(id)      // 后勾的落到末尾（不自动插队）；要按频段次序排就点「按频率排序」
  await syncMergePlans()
}
function moveMerge(i, d) {
  const a = [...mergeIds.value]
  const j = i + d
  if (j < 0 || j >= a.length) return
  ;[a[i], a[j]] = [a[j], a[i]]
  mergeIds.value = a
  syncMergePlans()
}
// 叠放顺序默认按上行频率升序：C 在上、Ku 居中、Ka 在下 —— 整星频率计划的通行次序
function sortMergeByFreq() {
  const key = (id) => {
    const p = mergePlans.value.find((x) => x.id === id)
    const ext = p ? (planExtent(p, 'up', 0) || planExtent(p, 'dn', 0)) : null
    return ext ? ext.dataMin : Number.POSITIVE_INFINITY   // 空计划沉底，别插在两个频段中间
  }
  mergeIds.value = [...mergeIds.value].sort((a, b) => key(a) - key(b))
  syncMergePlans()
}
const mergeStyle = computed(() => ({
  ...opt.value,
  title: mergeTitle.value.trim(),
  showSectionTitles: mergeSecTitles.value,
  sharedScale: mergeShared.value
}))
// 预览：与导出同一个 toSvgMulti，只是按预览框的实宽重排一遍 —— 不给 SVG 加 viewBox 让它自己缩
// （那条路会把线钉成发丝，见 freqPlanRender 里 svgOpen 上面那段）。故预览是「窄纸上的同一张图」，
// 版式（段序、比例尺、标题）如实，块与字的相对宽窄随纸宽走。
const prevBox = ref(null)
const prevW = ref(760)
function measurePrev() {
  const el = prevBox.value
  if (el) prevW.value = Math.max(420, el.clientWidth - 20)
}
const mergeSvg = computed(() => {
  if (!mergeOpen.value || !mergePlans.value.length) return ''
  try { return toSvgMulti(mergePlans.value, { ...mergeStyle.value, width: prevW.value, theme: 'light' }, 1) } catch (e) { return '' }
})
watch(mergeOpen, (v) => { if (v) nextTick(measurePrev) })
async function exportMerge() {
  if (!mergePlans.value.length) { flash('未选择计划'); return }
  const r = await doExport(mergeKind.value, {
    plans: mergePlans.value,
    style: mergeStyle.value,
    name: mergeTitle.value.trim() || 'Frequency Plans'
  })
  if (r?.ok) mergeOpen.value = false
}

// ---- 尺寸自适应 ----
function measure() {
  const el = chartWrap.value
  if (el) chartW.value = Math.max(760, el.clientWidth - 24)
  if (mergeOpen.value) measurePrev()      // 合成对话框是按视口尺寸开的，窗口一变它也跟着变宽
}

onMounted(async () => {
  satNodes.value = loadSatNodes()
  await loadIndex()
  if (index.value.length) await openPlan(index.value[0].id)
  measure()
  window.addEventListener('resize', measure)
  // Esc 逐层退出（最上面的那一层先退）：确认框 → 合成导出 → 各浮层。
  // 从前浮层只能点遮罩关，而手已经在键盘上（浮层多半是敲完一格顺手点开的）
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    if (confirmMsg.value) { answer(false); return }
    if (mergeOpen.value) { mergeOpen.value = false; return }
    if (addPop.value || beamPop.value || synthPop.value) { addPop.value = false; beamPop.value = ''; synthPop.value = false }
  })
  // 从文件区双击某份计划进来
  api?.freqPlan?.onOpenPlan?.((id) => { if (id) openPlan(id) })
  api?.freqPlan?.onPlanRemoved?.((id) => { if (id) planRemovedRemote(id) })
  api?.freqPlan?.onPlanRenamed?.((id, name) => { if (id) planRenamedRemote(id, name) })
  // 窗口失焦/关闭前把待存的落盘（debounce 尾巴不能丢）
  window.addEventListener('beforeunload', () => { if (dirty) doSave() })
  // 「发到小程序」的凭证与本机ID（缺凭证时菜单项仍在，点开即说明原因，不静默失效）
  api?.share?.configured?.().then((v) => { miniConfigured.value = !!v }).catch(() => {})
  api?.app?.deviceId?.().then((v) => { miniDeviceId.value = String(v || '') }).catch(() => {})
})
watch(tab, () => nextTick(measure))
watch([leftW, rightWNow], () => nextTick(measure))   // 左右栏拖宽 = 中栏变窄，图跟着重算宽度
</script>

<template>
  <div class="fp">
    <ActivationLock />
    <!-- 工具栏 -->
    <header class="tb">
      <span class="brand">转发器频率计划</span>
      <span class="sep"></span>
      <!-- 「新建」不在这里：见左栏每颗卫星行右端的 ＋ —— 建给哪颗星，由点哪颗星决定 -->
      <button class="mini ghost" @click="importJson"><Icon name="import" :size="12" /> 导入 JSON</button>
      <span class="sep"></span>
      <div class="dd">
        <button class="mini ghost" :disabled="!plan">导出 ▾</button>
        <div class="ddm">
          <button @click="doExport('png2')">PNG 2×</button>
          <button @click="doExport('png4')">PNG 4×</button>
          <button @click="doExport('png6')">PNG 6×</button>
          <button @click="doExport('pdf')">PDF（矢量）</button>
          <button @click="doExport('svg')">SVG</button>
          <button @click="doExport('json')">JSON 数据</button>
          <div class="ddsep"></div>
          <button @click="doExport('xlsx')" title="依《卫星转发器频率分配表》体例：总表（频率轴上的转发器排布，按极化分行，编号行下逐条绘制波束占段，配色与界面一致）＋ 波束表（各波束所属转发器）＋ 每 3 条转发器一张的分配表（波束占段带 · 载波占用条 · 使用情况汇总 · 冲突与越界明细）">Excel · 频率分配表（样式版）</button>
          <button @click="doExport('xlsxData')" title="两张表：计划概览（规模 / 跨度 / 装填合计 / 波束 / 本振 / 校验条目）＋ 转发器·载波总表（每行一条载波，转发器字段随之重复；整列无值时不输出该列）。频率与带宽以数值写入，逐转发器 / 逐波束的核算可由透视表直接得出">Excel · 纯数据表</button>
          <div class="ddsep"></div>
          <button @click="openMerge" title="选择多份计划（同一卫星的 C / Ku / Ka 各一份），自上而下合成为一张完整的频率计划">合成导出（多份）…</button>
          <div class="ddsep"></div>
          <button @click="openMiniSend" title="生成只读快照并上传，返回 8 位密钥；在小程序「工具栏 · 频率计划」输入该密钥即可查看图、转发器清单与频率分配表。快照对应当前版式，计划变更后需重新发送">发送到小程序…</button>
        </div>
      </div>
      <span class="spacer"></span>
      <select class="ci nar" v-model="opt.unit"
        title="整份计划共用的单位：图上的频率标注与图例、转发器表、检查器、批量条、批量生成、LO、频率分配表、校验条目，全部频率与带宽按此刻度读写。仅变更刻度，不改变物理量 —— 14000 MHz 切换至 kHz 即记为 14000000，既有计划一并换算">
        <option v-for="u in FREQ_UNITS" :key="u" :value="u">{{ u }}</option>
      </select>
      <label class="fld">图字号 <input class="ci num xnar" type="number" v-model.number="opt.fontSize" min="8" max="22" /></label>
      <label class="fld" title="10~800%，回车或离焦生效；Ctrl+滚轮同效。仅缩放界面显示，导出倍率在「导出」菜单中选择">缩放
        <input class="ci num xnar" :value="zoomPct" @input="zoomPct = $event.target.value"
          @change="commitZoom" @keydown.enter="commitZoom" /><span class="pct">%</span>
      </label>
      <span v-if="busy" class="busy">{{ busy }}</span>
    </header>
    <div v-if="msg" class="msg">{{ msg }}</div>

    <!-- 分配表是整幅的文档，故那一页的设置栏另记一个宽度、可一路拖到 0 收起（见 allocRightW）：
         十四列的表要中栏宽，而波束占段又只在设置栏里改，两边都得让人自己定。收起时第四轨从 0
         撑到 7px —— 手柄骑在分界线上靠负边距抵消，分界线正压在窗口右缘时会被切掉一半。
         转发器身份写在每一组的组头上，检查器不在场也读得出这一行落在哪条转发器上。 -->
    <div class="body" :style="{ gridTemplateColumns: plan ? `${leftW}px 0px minmax(0,1fr) ${rightWNow ? 0 : 7}px ${rightWNow}px` : `${leftW}px 0px minmax(0,1fr)` }">
      <!-- 左：卫星 → 频率计划 两级树 -->
      <aside class="left">
        <div class="lh">
          <span class="lht">计划库</span>
          <span class="spacer"></span>
          <span class="dim">{{ index.length }} 份 · {{ satNodes.length }} 星</span>
        </div>
        <div class="lq" v-if="satNodes.length">
          <Icon name="search" :size="11" class="qi-ic" />
          <input class="qi" v-model="q" placeholder="筛选卫星 / 计划" />
          <button v-if="q" class="qx" title="清空" @click="q = ''"><Icon name="x" :size="10" /></button>
        </div>
        <div class="lscroll">
          <div v-if="!satNodes.length" class="lnone">卫星树为空。</div>
          <div v-else-if="!tree.length" class="lnone">没有匹配「{{ q }}」的卫星或频率计划。</div>
          <template v-else>
            <section v-for="g in tree" :key="g.key" class="grp">
              <!-- 一级：卫星。有计划 → 点行折叠/展开；还没有 → 点行直接为它新建 -->
              <div class="sat" :class="{ orphan: g.orphan, bare: !g.items.length, cur: !!currentId && g.folder === plan?.satFolder }"
                :title="g.orphan ? `${g.label}：该卫星已不在卫星树中（被删除或改名），计划仍保留在此` : (g.items.length ? g.label : `${g.label} — 点击为其新建频率计划`)"
                @click="g.items.length ? toggleSat(g) : (!g.orphan && createPlan(g.folder))">
                <span class="tw"><Icon v-if="g.items.length" :name="isOpen(g) ? 'chevron-down' : 'chevron-right'" :size="11" /></span>
                <Icon class="si" name="satellite" :size="12" />
                <span class="sn">{{ g.label }}</span>
                <span class="sc" v-if="g.items.length > 1">{{ g.items.length }}</span>
                <button v-if="!g.orphan" class="sadd" :class="{ bare: !g.items.length }"
                  :title="`为「${g.satName}」新建频率计划`" @click.stop="createPlan(g.folder)">
                  <Icon name="plus" :size="11" /><span v-if="!g.items.length">新建</span>
                </button>
              </div>
              <!-- 二级：该星下的计划。三级：这份计划的频率分配表（载波摆在哪条转发器的哪一段上） -->
              <div class="kids" v-show="isOpen(g)">
                <div v-for="e in g.items" :key="e.id" class="pw">
                  <div class="li" :class="{ on: e.id === currentId && tab !== 'alloc' }" :data-id="e.id" @click="openTable(e.id)">
                    <div class="ln" :title="e.name">{{ shortName(e, g) }}</div>
                    <div class="lm">{{ e.band }} · {{ e.transponderCount }} 转发器<template v-if="e.beamCount"> · {{ e.beamCount }} 波束</template></div>
                    <div class="lops" @click.stop>
                      <button class="lop" title="复制" @click="duplicatePlan(e)"><Icon name="copy" :size="11" /></button>
                      <button class="lop del" title="删除" @click="removePlan(e)"><Icon name="trash" :size="11" /></button>
                    </div>
                  </div>
                  <div class="sub" :class="{ on: e.id === currentId && tab === 'alloc' }" @click="openAlloc(e.id)"
                    title="本计划的频率分配表：逐转发器列出该段频谱所分配的载波（起—中—止 · 占用带宽 · 功率带宽）">
                    <Icon name="table" :size="11" />
                    <span class="sbn">频率分配表</span>
                    <span class="sbc" v-if="allocCount(e)">{{ allocCount(e) }}</span>
                  </div>
                </div>
              </div>
            </section>
            <div v-if="q && !shown" class="lnone">所选卫星下尚无频率计划。</div>
          </template>
        </div>
      </aside>

      <!-- 左/中分界上的拖宽手柄 -->
      <div class="rz" :class="{ on: resizing === 'left' }" title="拖动调整计划库宽度"
        @mousedown.prevent="startResize('left', $event)"></div>

      <!-- 中：图 + 页签 -->
      <main class="center">
        <div v-if="!plan" class="mnone">
          <p>未打开频率计划。</p>
        </div>
        <template v-else>
          <div class="chartbox" ref="chartWrap" @wheel="onWheelZoom">
            <!-- 双击一块 = 选中并把光标送到它那一侧的中心频率格（见 editBlock）：改频率是这张图上
                 最常做的一件事，从前要「点块 → 眼睛移到右栏 → 找到那一格 → 点进去」 -->
            <FpChart :plan="plan" :selected-id="selectedId" :chart-style="opt" :width="chartW" :zoom="zoom"
              @select="selectedId = $event" @dblclick-block="editBlock" />
          </div>

          <div class="tabs">
            <button class="tb-b" :class="{ on: tab === 'table' }" @click="tab = 'table'">转发器表 <i>{{ plan.channels.length }}</i></button>
            <button class="tb-b" :class="{ on: tab === 'alloc' }" @click="tab = 'alloc'">频率分配表 <i v-if="carriers.length">{{ carriers.length }}</i></button>
            <button class="tb-b" :class="{ on: tab === 'check' }" @click="tab = 'check'">校验 <i v-if="issues.length" :class="{ bad: errCount }">{{ issues.length }}</i></button>
            <span class="spacer"></span>
            <template v-if="tab === 'table'">
              <button class="mini" @click="addChannel()"><Icon name="plus" :size="12" /> 转发器</button>
              <!-- 信标 / 遥控 / 遥测：加得少，收在一个小菜单里，免得工具栏并排四个「+」 -->
              <span class="bwrap">
                <button class="mini ghost caret" :class="{ on: addPop }" @click="addPop = !addPop"
                  title="添加信标 / 遥控 TC / 遥测 TM —— 该三类仅含频率与极化，图上以箭头标注">▾</button>
                <template v-if="addPop">
                  <div class="bpmask" @click="addPop = false"></div>
                  <div class="bpop addpop">
                    <button v-for="k in MARK_KINDS" :key="k.key" class="apo" @click="addChannel(k.key); addPop = false">
                      <Icon name="plus" :size="11" /> {{ k.label }}
                    </button>
                  </div>
                </template>
              </span>
              <button class="mini ghost" @click="sortChannels" title="按上行频率升序重排">排序</button>
            </template>
            <!-- 分配表页的设置栏开合。宽度靠拖分界线调，这个钮只管开与关（收起后分界线贴着窗口
                 右缘，光靠它不好找） -->
            <button v-if="tab === 'alloc'" class="mini ghost pnb" :class="{ on: allocRightW > 0 }" @click="toggleAllocRight"
              title="设置栏：波束占段（转发器频带在各波束间的划分）、转发器参数、LO 均在此处编辑。拖动左缘调整宽度">
              <Icon name="panel-right" :size="12" />
            </button>
          </div>

          <div class="tabbody">
            <!-- 批量条：勾了才浮出。作用域写在最左边（「已选 N 个」），条上每一项选完即施加到这 N 条 -->
            <div v-if="tab === 'table' && checkedCount" class="bbar">
              <span class="bn">已选 <b>{{ checkedCount }}</b> 个</span>
              <button class="mini ghost xs" @click="clearChecked" title="取消全部勾选">取消选择</button>
              <span class="bsep"></span>

              <!-- 这四个下拉不另配文字标签：占位项本身就是标签（「类型…」），选完即施加、随即弹回。
                   一条批量条上七八组控件，每组再前置两三个字，窄栏下能折成三行 -->
              <select class="ci bsl" v-model="bsel.kind" @change="batchSet('kind')" title="将已选转发器的类型统一设为…">
                <option value="">类型…</option>
                <option v-for="k in CHANNEL_KINDS" :key="k.key" :value="k.key">{{ k.label }}</option>
              </select>
              <select class="ci bsl" v-model="bsel.upPol" @change="batchSet('upPol')" title="将已选转发器的上行极化统一设为…">
                <option value="">上行极化…</option>
                <option v-for="p in POLS" :key="p" :value="p">{{ POL_LABEL[p] }}</option>
              </select>
              <select class="ci bsl" v-model="bsel.dnPol" @change="batchSet('dnPol')" title="将已选转发器的下行极化统一设为…">
                <option value="">下行极化…</option>
                <option value="ortho">逐条取上行的正交</option>
                <option v-for="p in POLS" :key="p" :value="p">{{ POL_LABEL[p] }}</option>
              </select>
              <select class="ci bsl" v-model="bsel.lo" @change="batchSet('lo')" title="将已选转发器统一挂接至同一本振（下行随之按等式重算）">
                <option value="">本振 LO…</option>
                <option :value="NO_LO">不挂 LO</option>
                <option v-for="l in plan.los" :key="l.id" :value="l.id">{{ loOption(l) }}</option>
              </select>
              <!-- 波束是多选，塞不进一个下拉：点开一个小浮层照常勾，勾完一次落到这 N 条上 -->
              <span v-for="side in ['up', 'dn']" :key="side" class="bwrap">
                <button class="mini ghost" :class="{ on: beamPop === side }" @click="openBeamPop(side)">
                  {{ side === 'up' ? '上行波束' : '下行波束' }} ▾
                </button>
                <template v-if="beamPop === side">
                  <div class="bpmask" @click="beamPop = ''"></div>
                  <div class="bpop">
                    <div class="bph">{{ side === 'up' ? '上行波束' : '下行波束' }} —— 施加到已选的 {{ checkedCount }} 个</div>
                    <BeamPicker mode="list" :beams="plan.beams" :unit="opt.unit" v-model="batchBeamIds"
                      :inherit="side === 'dn' ? (checkedChannels[0]?.beamUpIds || []) : null" />
                    <div class="bpo">
                      <button class="mini ghost xs" @click="applyBeamPop(true)"
                        :title="side === 'up' ? '清空上行波束（该转发器不归任何波束组）' : '清空下行波束 = 随上行'">
                        {{ side === 'up' ? '清空' : '设为随上行' }}
                      </button>
                      <span class="spacer"></span>
                      <button class="mini ghost xs" @click="beamPop = ''">取消</button>
                      <button class="mini imp xs" @click="applyBeamPop(false)">应用</button>
                    </div>
                  </div>
                </template>
              </span>
              <span class="bsep"></span>

              <label class="fld" title="填值 = 所选 N 条各自单独指定带宽；「清」= 恢复为所属波束组的标称值">带宽
                <input class="ci num xnar" :value="dval('batch.bw', batch.bwMHz)" :placeholder="U"
                  @input="dput('batch.bw', $event.target.value, (m) => { batch.bwMHz = m })" @blur="ddone"
                  @keydown.enter="batchBw(false)" />
              </label>
              <button class="mini ghost xs" :disabled="!batchBwOk" @click="batchBw(false)">应用</button>
              <button class="mini ghost xs" @click="batchBw(true)" title="清空带宽 = 随所属波束组的标称值">清</button>
              <label class="fld" title="整条频带整体平移：联动态下行按 LO 等式随动，解耦态下行等量平移">平移
                <input class="ci num xnar" :value="dval('batch.shift', batch.shiftMHz)" :placeholder="`±${U}`"
                  @input="dput('batch.shift', $event.target.value, (m) => { batch.shiftMHz = m })" @blur="ddone"
                  @keydown.enter="batchShift" />
              </label>
              <button class="mini ghost xs" :disabled="!batchShiftOk" @click="batchShift">应用</button>
              <label class="fld" title="按表内先后顺序编号；{n} 处替换为序号">编号
                <input class="ci xnar" v-model="batch.noPattern" @keydown.enter="batchRenumber" />
                <input class="ci num xxnar" v-model="batch.noStart" title="起始序号" @keydown.enter="batchRenumber" />
              </label>
              <button class="mini ghost xs" @click="batchRenumber">重编号</button>
              <span class="bsep"></span>

              <button class="mini ghost" @click="batchDuplicate" title="复制所选 N 条至表尾，勾选状态转至副本（随后整批修改极化/频率即为 B 面）">
                <Icon name="copy" :size="12" /> 复制
              </button>
              <button class="mini ghost bdel" @click="batchRemove"><Icon name="trash" :size="12" /> 删除</button>
            </div>

            <!-- 转发器表 -->
            <div v-if="tab === 'table'" class="tscroll" ref="tblScroll">
              <!-- ↑↓ 在同一列上下走（Excel 手感）：绑在表上而不是逐格绑，下拉自己那套 ↑↓ 让开 -->
              <table class="t" :class="{ dragsel: dragging }" :style="{ '--fp-numw': numColW }" @keydown="gridKey">
                <thead>
                  <tr>
                    <!-- 波束两列：一列贴上行、一列贴下行。多波束是分方向的（几个波束收、一个波束发是常态），
                         并成一列就只能两边一样多 —— 各自落在自己那组字段旁边，读表时不必再想它管的是哪一侧 -->
                    <th class="ck">
                      <input type="checkbox" :checked="allChecked" :indeterminate="someChecked"
                        :disabled="!plan.channels.length" @change="toggleCheckAll"
                        title="全选 / 全不选" />
                    </th>
                    <!-- 列头写的是当前刻度（工具栏那个下拉），不恒写 MHz —— 表上的数与图上的数同一把尺子。
                         频率那两格的口径可切：中心 + 带宽 ⇄ 起 + 止（列数不变，见 tcols） -->
                    <th>编号</th><th>类型</th>
                    <th class="colsw" @click="tcols = tcols === 'fc' ? 'edge' : 'fc'"
                      :title="`频率列口径：现为「${tcols === 'fc' ? '中心 + 带宽' : '起 + 止'}」，点击切到「${tcols === 'fc' ? '起 + 止' : '中心 + 带宽'}」。同一段频带的两种写法，手上的计划表是哪一种就切到哪一种`">
                      {{ tcols === 'fc' ? '上行中心' : '上行起' }} {{ U }} <Icon name="arrow-left-right" :size="10" />
                    </th>
                    <th>{{ tcols === 'fc' ? '带宽' : '上行止' }} {{ U }}</th><th>极化</th><th>上行波束</th>
                    <th>LO</th><th>{{ tcols === 'fc' ? '下行中心' : '下行起' }} {{ U }}</th>
                    <th v-if="tcols === 'edge'">下行止 {{ U }}</th>
                    <th>极化</th><th>下行波束</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  <!-- 选中走 mousedown + focusin，不走 click：这一行几乎每格都是输入框/下拉，
                       它们各自 stopPropagation 之后 click 根本冒不到 tr 上（「点第 5 行的编号，
                       右栏还停在第 1 行」即由此而来）。mousedown 在聚焦之前就落定，focusin 兜住
                       Tab 键跨行的情形 —— 落到哪一行，右栏检查器就是哪一行 -->
                  <tr v-for="(ch, i) in plan.channels" :key="ch.id" :data-idx="i" :data-id="ch.id"
                    :class="{ on: ch.id === selectedId, ckd: isChecked(ch.id) }"
                    @mousedown="selectedId = ch.id" @focusin="selectedId = ch.id">
                    <!-- 行头槽：按住往下划即整片选中（Excel 行头那套）。勾选 = 批量作用域，
                         与「点行身 = 送进右栏检查器」是两件事 -->
                    <td class="ck" @click.stop @mousedown="gutterDown(i, $event)"
                      title="按住拖动 = 连续多选；单击 = 单选该行；Shift 单击 = 从上一选中行连选至该行">
                      <input type="checkbox" :checked="isChecked(ch.id)" @change.stop="toggleCheck(ch, $event)" />
                      <i class="rn">{{ i + 1 }}</i>
                    </td>
                    <td><input class="ci nar" v-model="ch.no" /></td>
                    <td>
                      <!-- 改类型走 setKind：切成信标/遥测/遥控时把频率折到它那一侧（见 foldMark） -->
                      <select class="ci selc selkind" :value="ch.kind" @change="setKind(ch, $event.target.value)">
                        <option v-for="k in CHANNEL_KINDS" :key="k.key" :value="k.key">{{ k.label }}</option>
                      </select>
                    </td>
                    <!-- 标记类载波（信标/遥测/遥控）只有频率与极化，且只在一侧：其余那几格连同它那一侧
                         之外的两格一并留空，格位不动 —— 表还是那张表，只是这一行本就没有那些量。
                         等幅波没有频带两端，故切到「起 + 止」那一档时它这两格照旧写频率与间隔带宽 -->
                    <td><input v-if="hasSide(ch, 'up') && (tcols === 'fc' || isMk(ch))" class="ci num"
                      :value="lval(fcKey(ch, 'up'), ch.up.fcMHz)"
                      @input="lput(fcKey(ch, 'up'), ch, $event.target.value)"
                      @change="lend(fcKey(ch, 'up'), (c, m) => commitFc(c, 'up', m))" @blur="lend(fcKey(ch, 'up'), (c, m) => commitFc(c, 'up', m))"
                      :title="dnLinked(ch) ? '与下行经 LO 联动：此处修改后下行随动。回车或离焦生效' : '回车或离焦生效'" />
                      <input v-else-if="!isMk(ch)" class="ci num" :class="pendCls(ch, 'up', 'f1')" :value="edgeVal(ch, 'up', 'f1')" :title="edgeTitle(ch, 'up', 'f1')"
                        @input="lput(edgeKey(ch, 'up', 'f1'), ch, $event.target.value)"
                        @change="lend(edgeKey(ch, 'up', 'f1'), (c, m) => commitEdge(c, 'up', 'f1', m))"
                        @blur="lend(edgeKey(ch, 'up', 'f1'), (c, m) => commitEdge(c, 'up', 'f1', m))" /></td>
                    <!-- 这一格转发器写带宽（或终止），标记类写「间隔带宽」（轴上给它留的那一格，不是信号带宽）：
                         同一列两种量，各带各的 title —— 分两列的话标记类那一行会空着一格、转发器那一列
                         又空着一整列，格位反倒更乱 -->
                    <td class="dnum"><input v-if="!isMk(ch) && tcols === 'fc'" class="ci num nar"
                      :value="lval(bwKey(ch, 'up'), ch.up.bwMHz)" :placeholder="groupBw(ch)"
                      @input="lput(bwKey(ch, 'up'), ch, $event.target.value)"
                      @change="lend(bwKey(ch, 'up'), (c, m) => commitBw(c, 'up', m))" @blur="lend(bwKey(ch, 'up'), (c, m) => commitBw(c, 'up', m))"
                      title="留空 = 取所属波束/带宽组的标称值（灰字为继承值）；填值 = 本转发器单独指定。起始锁定、终止随动（终止 = 起始 + 带宽）。回车或离焦生效" />
                      <input v-else-if="!isMk(ch)" class="ci num" :class="pendCls(ch, 'up', 'f2')" :value="edgeVal(ch, 'up', 'f2')" :title="edgeTitle(ch, 'up', 'f2')"
                        @input="lput(edgeKey(ch, 'up', 'f2'), ch, $event.target.value)"
                        @change="lend(edgeKey(ch, 'up', 'f2'), (c, m) => commitEdge(c, 'up', 'f2', m))"
                        @blur="lend(edgeKey(ch, 'up', 'f2'), (c, m) => commitEdge(c, 'up', 'f2', m))" />
                      <input v-else class="ci num nar" :value="lval(slotKey(ch, mkSide(ch)), ch[mkSide(ch)].slotMHz)"
                        @input="lput(slotKey(ch, mkSide(ch)), ch, $event.target.value)"
                        @change="lend(slotKey(ch, mkSide(ch)), (c, m) => { c[mkSide(c)].slotMHz = m })"
                        @blur="lend(slotKey(ch, mkSide(ch)), (c, m) => { c[mkSide(c)].slotMHz = m })"
                        :title="`${KIND_LABEL[ch.kind]}在频率轴上占的那一格（间隔带宽，不是信号带宽）：填 n 则频带端点算到 频率 ± n/2 上；留空 = 不占频带`" /></td>
                    <td><select v-if="hasSide(ch, 'up')" class="ci selc selpol" v-model="ch.up.pol" :title="POL_LABEL[ch.up.pol]"><option v-for="p in POLS" :key="p" :value="p">{{ p }}</option></select></td>
                    <td>
                      <BeamPicker v-if="!isMk(ch)" mode="chips" :beams="plan.beams" :unit="opt.unit" v-model="ch.beamUpIds" />
                    </td>
                    <td>
                      <!-- 这格只写得下 LO 名，数值放进 title（几个 LO 重名时也就这一处分得清） -->
                      <select v-if="!isMk(ch)" class="ci selc sello" v-model="ch.loId" :title="loTitle(ch)">
                        <option value="">—</option>
                        <option v-for="l in plan.los" :key="l.id" :value="l.id" data-i18n-skip>{{ l.name }}</option>
                      </select>
                    </td>
                    <!-- 下行不再是「灰字占位的推算值」：LO 定了它就是可直接录的一侧，录进去上行反解跟着变 -->
                    <td class="dnum">
                      <div class="lkc" v-if="hasSide(ch, 'dn')">
                        <input v-if="tcols === 'fc' || isMk(ch)" class="ci num" :value="lval(fcKey(ch, 'dn'), dnDisp(rowsResolved[i]))"
                          @input="lput(fcKey(ch, 'dn'), ch, $event.target.value)"
                          @change="lend(fcKey(ch, 'dn'), (c, m) => commitFc(c, 'dn', m))" @blur="lend(fcKey(ch, 'dn'), (c, m) => commitFc(c, 'dn', m))"
                          :title="(isMk(ch) ? `${KIND_LABEL[ch.kind]}的频率（下行）`
                            : (dnLinked(ch) ? '与上行由 LO 联动：f下 = f上 − LO —— 改这里上行跟着变'
                              : (dnCut(ch) ? '下行已与 LO 解耦（cross-strap）：上下行分别录入。点击右侧图标按 LO 恢复联动'
                                : '未挂 LO —— 上下行各自独立；在左边 LO 列选一个即可联动'))) + '。回车或离焦生效'" />
                        <input v-else class="ci num" :class="pendCls(ch, 'dn', 'f1')" :value="edgeVal(ch, 'dn', 'f1')" :title="edgeTitle(ch, 'dn', 'f1')"
                          @input="lput(edgeKey(ch, 'dn', 'f1'), ch, $event.target.value)"
                          @change="lend(edgeKey(ch, 'dn', 'f1'), (c, m) => commitEdge(c, 'dn', 'f1', m))"
                          @blur="lend(edgeKey(ch, 'dn', 'f1'), (c, m) => commitEdge(c, 'dn', 'f1', m))" />
                        <button v-if="dnCut(ch)" class="lkb" title="下行已与 LO 解耦（cross-strap）—— 点击按 LO 重新联动"
                          @click.stop="setCut(ch, false)"><Icon name="unlink-2" :size="11" /></button>
                      </div>
                    </td>
                    <!-- 「起 + 止」那一档下行多出的这一格（中心 + 带宽档下没有：带宽两侧同宽，只写一遍） -->
                    <td class="dnum" v-if="tcols === 'edge'">
                      <input v-if="hasSide(ch, 'dn') && !isMk(ch)" class="ci num" :class="pendCls(ch, 'dn', 'f2')" :value="edgeVal(ch, 'dn', 'f2')" :title="edgeTitle(ch, 'dn', 'f2')"
                        @input="lput(edgeKey(ch, 'dn', 'f2'), ch, $event.target.value)"
                        @change="lend(edgeKey(ch, 'dn', 'f2'), (c, m) => commitEdge(c, 'dn', 'f2', m))"
                        @blur="lend(edgeKey(ch, 'dn', 'f2'), (c, m) => commitEdge(c, 'dn', 'f2', m))" />
                    </td>
                    <td><select v-if="hasSide(ch, 'dn')" class="ci selc selpol" v-model="ch.dn.pol" :title="POL_LABEL[ch.dn.pol]"><option v-for="p in POLS" :key="p" :value="p">{{ p }}</option></select></td>
                    <td>
                      <!-- 留空 = 随上行（灰色片示意），与带宽/下行频率两格的灰字继承值同一套读法 -->
                      <BeamPicker v-if="!isMk(ch)" mode="chips" :beams="plan.beams" :unit="opt.unit" v-model="ch.beamDnIds" :inherit="ch.beamUpIds" />
                    </td>
                    <td class="ops" @click.stop>
                      <button class="lop" title="复制" @click="duplicateChannel(ch.id)"><Icon name="copy" :size="11" /></button>
                      <button class="lop del" title="删除" @click="removeChannel(ch.id)"><Icon name="x" :size="11" /></button>
                    </td>
                  </tr>
                </tbody>
              </table>
              <div v-if="!plan.channels.length" class="none">还没有转发器。</div>
            </div>

            <!-- 频率分配表（左栏树里挂在这份计划下的那个子节点，也从这里出） -->
            <!-- selected-id 双向连着图：图上点一块转发器，分配表就摊开那一条；反过来亦然 -->
            <FpAlloc v-else-if="tab === 'alloc'" :plan="plan" :carriers="carriers" :unit="opt.unit" :selected-id="selectedId"
              @update:carriers="carriers = $event" @select-channel="selectedId = $event" @flash="flash"
              @set-channel-beam="setChannelBeam" />

            <!-- 校验 -->
            <div v-else class="tscroll chk">
              <div v-if="!issues.length" class="none">无待处理项。</div>
              <div v-for="(is, i) in issues" :key="i" class="ci-item" :class="is.severity"
                @click="is.refs?.length && (selectedId = is.refs[0])">
                <span class="sev">{{ is.severity === 'error' ? '错' : is.severity === 'warn' ? '注' : '提' }}</span>
                <span class="cm">{{ is.msg }}</span>
              </div>
            </div>
          </div>
        </template>
      </main>

      <!-- 中/右分界上的拖宽手柄。收起时仍在（这是把设置栏拉回来的那一处），故只认 plan -->
      <div class="rz" :class="{ on: resizing === 'right', closed: !rightWNow }" v-if="plan"
        :title="rightWNow ? '拖动调整设置栏宽度' : '向左拖出设置栏'"
        @mousedown.prevent="startResize('right', $event)"></div>

      <!-- 右：检查器 -->
      <aside class="right" v-if="plan && rightWNow">
        <!-- 分区壳：22px 吸顶标题栏（点标题即折叠）+ 区间 4px 灰槽。从前分区之间只有一条 1px 线，
             与栏内行线同一档，整栏读成一列连不断的表单 —— 这是「分区区分度低」的根。 -->
        <section class="sec" :class="{ closed: !secOpen('plan') }">
          <div class="sh" @click="toggleSec('plan')" title="点击折叠 / 展开本区">
            <Icon class="shx" :name="secOpen('plan') ? 'chevron-down' : 'chevron-right'" :size="11" />
            <span class="sht">计划</span>
          </div>
          <div class="sbd" v-show="secOpen('plan')">
            <label class="row"><span>名称</span><input class="ci" v-model="plan.name" /></label>
            <label class="row"><span>卫星</span>
              <select class="ci" v-model="plan.satFolder" @change="plan.satName = (satNodes.find((s) => s.folder === plan.satFolder) || {}).satName || ''">
                <option value="">（未归属）</option>
                <option v-for="s in satNodes" :key="s.folder" :value="s.folder">{{ satLabel(s) }}</option>
              </select>
            </label>
            <!-- 频段：默认自动（跟着图上的频率走），也可手选钉死。它只进汇总行与列表说明，
                 不参与作图与校验，故手选与图上的频率不会打架 -->
            <label class="row"><span>频段</span>
              <select class="ci" v-model="bandPick" title="自动 = 按图上最低频率判定，随频率变更而更新；手选 = 锁定该频段名（频段仅用于汇总与列表标注，不参与作图与校验）">
                <option value="">自动（{{ autoBand }}）</option>
                <option v-for="b in BANDS" :key="b" :value="b">{{ b }}</option>
              </select>
            </label>
            <div class="sum">{{ planSummary(plan, opt.unit) }}</div>
          </div>
        </section>

        <!-- 单条转发器 = 这一栏的主角。区内按图的读法分成 ↑上行 / 本振 / ↓下行 三段（图上正是这三段），
             字段名因此不再逐个前缀「上行/下行」，标题列反而收窄、数值格更宽。
             区头恒带一条左标（.cur），聚焦时整区再压一条实心竖标（:focus-within）——
             与图上选中块的描边、表里那一行的左标是同一套语言：三处认的是同一条转发器。 -->
        <section class="sec cur" :class="{ closed: !secOpen('ch') }" v-if="selected" ref="chSecEl">
          <div class="sh" @click="toggleSec('ch')" title="点击折叠 / 展开本区">
            <Icon class="shx" :name="secOpen('ch') ? 'chevron-down' : 'chevron-right'" :size="11" />
            <span class="sht">{{ KIND_LABEL[selected.kind] || '转发器' }} · {{ selected.no || '—' }}</span>
            <span class="spacer"></span>
            <!-- 逐条核对参数时不必回表点：‹ › 按表上的先后翻条，图与表跟着一起走 -->
            <span class="shnav" @click.stop>
              <button class="shb" :disabled="selIdx <= 0" title="上一条" @click="stepSel(-1)"><Icon name="chevron-left" :size="11" /></button>
              <i>{{ selIdx + 1 }} / {{ plan.channels.length }}</i>
              <button class="shb" :disabled="selIdx < 0 || selIdx >= plan.channels.length - 1" title="下一条" @click="stepSel(1)"><Icon name="chevron-right" :size="11" /></button>
            </span>
          </div>
          <div class="sbd" v-show="secOpen('ch')">
          <label class="row"><span>编号</span><input class="ci nar" v-model="selected.no" /></label>
          <label class="row"><span>类型</span>
            <select class="ci" :value="selected.kind" @change="setKind(selected, $event.target.value)">
              <option v-for="k in CHANNEL_KINDS" :key="k.key" :value="k.key">{{ k.label }}</option>
            </select>
          </label>

          <!-- 标记类载波（信标 / 遥控 / 遥测）：不载业务的等幅波，没有带宽、不归波束、不经变频。
               图上画成频率轴上的一根箭头（见 freqPlanRender 的 markGeom）；「间隔带宽」是给它在轴上
               留的那一格（频带两端因此算到 fc ± n/2 上，见 resolveChannel） -->
          <template v-if="selMark">
            <div class="fgrp"><i class="fgrp-ar">{{ selMark === 'dn' ? '↓' : '↑' }}</i>{{ selMark === 'dn' ? '下行' : '上行' }}</div>
            <label class="row"><span>频率 {{ U }}</span>
              <input class="ci num" :data-f="selMark" :value="lval(fcKey(selected, selMark), mkFc(selectedResolved))"
                @input="lput(fcKey(selected, selMark), selected, $event.target.value)"
                @change="lend(fcKey(selected, selMark), (c, m) => commitFc(c, selMark, m))"
                @blur="lend(fcKey(selected, selMark), (c, m) => commitFc(c, selMark, m))"
                :title="`${KIND_LABEL[selected.kind]}在${selMark === 'up' ? '上行' : '下行'}的频率。回车或离焦生效`" />
            </label>
            <label class="row"><span>间隔带宽 {{ U }}</span>
              <input class="ci num" :value="lval(slotKey(selected, selMark), selected[selMark].slotMHz)"
                @input="lput(slotKey(selected, selMark), selected, $event.target.value)"
                @change="lend(slotKey(selected, selMark), (c, m) => { c[selMark].slotMHz = m })"
                @blur="lend(slotKey(selected, selMark), (c, m) => { c[selMark].slotMHz = m })"
                title="在频率轴上为其预留的宽度（非信号带宽——等幅波无带宽）：填 n 则频带端点取 频率 ± n/2；留空 = 不占频带，界标仅标注转发器" />
            </label>
            <label class="row"><span>极化</span>
              <select class="ci" v-model="selected[selMark].pol"><option v-for="p in POLS" :key="p" :value="p">{{ POL_LABEL[p] }}</option></select>
            </label>
          </template>

          <template v-else>
          <div class="fgrp"><i class="fgrp-ar">↑</i>上行</div>
          <label class="row"><span>中心频率 {{ U }}</span>
            <input class="ci num" data-f="up" :value="lval(fcKey(selected, 'up'), selected.up.fcMHz)"
              title="带宽保持不变，两端等量平移。回车或离焦生效"
              @input="lput(fcKey(selected, 'up'), selected, $event.target.value)"
              @change="lend(fcKey(selected, 'up'), (c, m) => commitFc(c, 'up', m))"
              @blur="lend(fcKey(selected, 'up'), (c, m) => commitFc(c, 'up', m))" />
          </label>
          <label class="row"><span>带宽 {{ U }}</span>
            <input class="ci num" :value="lval(bwKey(selected, 'up'), selected.up.bwMHz)" :placeholder="groupBw(selected) ? groupBw(selected) + '（本组）' : ''"
              title="留空 = 取所属波束/带宽组的标称值（灰字为继承值）；填值 = 本转发器单独指定。起始锁定、终止随动（终止 = 起始 + 带宽）。回车或离焦生效"
              @input="lput(bwKey(selected, 'up'), selected, $event.target.value)"
              @change="lend(bwKey(selected, 'up'), (c, m) => commitBw(c, 'up', m))"
              @blur="lend(bwKey(selected, 'up'), (c, m) => commitBw(c, 'up', m))" />
          </label>
          <!-- 起止：与上面两格是同一段频带的两种写法（中心 + 带宽 ⇄ 起始 + 终止）。手上的计划表多半
               直接给频带两端，照着录进去比让人先自己减掉半个带宽直白；改一端另一端钉住，中心与
               带宽一并重算（口径与四条分支见 freqPlanModel 的「频带两端」那一段） -->
          <div class="row"><span>起止 {{ U }}</span>
            <input class="ci num" :class="pendCls(selected, 'up', 'f1')" :value="edgeVal(selected, 'up', 'f1')" placeholder="起始" :title="edgeTitle(selected, 'up', 'f1')"
              @input="lput(edgeKey(selected, 'up', 'f1'), selected, $event.target.value)"
              @change="lend(edgeKey(selected, 'up', 'f1'), (c, m) => commitEdge(c, 'up', 'f1', m))"
              @blur="lend(edgeKey(selected, 'up', 'f1'), (c, m) => commitEdge(c, 'up', 'f1', m))" />
            <span class="tw">~</span>
            <input class="ci num" :class="pendCls(selected, 'up', 'f2')" :value="edgeVal(selected, 'up', 'f2')" placeholder="终止" :title="edgeTitle(selected, 'up', 'f2')"
              @input="lput(edgeKey(selected, 'up', 'f2'), selected, $event.target.value)"
              @change="lend(edgeKey(selected, 'up', 'f2'), (c, m) => commitEdge(c, 'up', 'f2', m))"
              @blur="lend(edgeKey(selected, 'up', 'f2'), (c, m) => commitEdge(c, 'up', 'f2', m))" />
          </div>
          <label class="row"><span>极化</span>
            <select class="ci" v-model="selected.up.pol"><option v-for="p in POLS" :key="p" :value="p">{{ POL_LABEL[p] }}</option></select>
          </label>
          <div class="row top"><span>波束</span>
            <BeamPicker mode="list" :beams="plan.beams" :unit="opt.unit" v-model="selected.beamUpIds" />
          </div>
          <!-- 占段表：这条转发器的频带分给它的几个波束。★ 界面上唯一的频率录入口 ——
               波束那边只有名字与带宽，「谁占哪一截」在编排这条转发器时一眼看得全。
               留空 = 走排布档（灰字写的是算出来的落点）。下行留空 = 随上行（整段随 LO 平移）。 -->
          <template v-if="chBeams(selected, 'up').length">
          <div class="row"><span>排布</span>
            <select class="ci" :value="beamLayoutOf(selected)" :title="LAYOUT_TIP"
              @change="setLayout(selected, $event.target.value)">
              <option v-for="L in BEAM_LAYOUTS" :key="L.key" :value="L.key">{{ L.label }}</option>
            </select>
          </div>
          <div class="bsrow hd"><span>占段 {{ U }}</span><span>起始</span><span>终止</span><span>带宽</span></div>
          <div v-for="b in chBeams(selected, 'up')" :key="b.id" class="bsrow">
            <span class="bsn" :title="b.name"><i class="bsc" :style="{ background: b.color }"></i>{{ b.name }}</span>
            <input class="ci num" :value="segEdgeVal(selected, 'up', b, 'f1')" :placeholder="segEdgePh(selected, 'up', b, 'f1')"
              :title="segEdgeTitle(selected, 'up', b, 'f1')"
              @input="lput(segKey(selected.id, b.id, 'up', 'f1'), selected, $event.target.value)"
              @change="lend(segKey(selected.id, b.id, 'up', 'f1'), (c, m) => commitSegEdge(c, 'up', b, 'f1', m))"
              @blur="lend(segKey(selected.id, b.id, 'up', 'f1'), (c, m) => commitSegEdge(c, 'up', b, 'f1', m))" />
            <input class="ci num" :value="segEdgeVal(selected, 'up', b, 'f2')" :placeholder="segEdgePh(selected, 'up', b, 'f2')"
              :title="segEdgeTitle(selected, 'up', b, 'f2')"
              @input="lput(segKey(selected.id, b.id, 'up', 'f2'), selected, $event.target.value)"
              @change="lend(segKey(selected.id, b.id, 'up', 'f2'), (c, m) => commitSegEdge(c, 'up', b, 'f2', m))"
              @blur="lend(segKey(selected.id, b.id, 'up', 'f2'), (c, m) => commitSegEdge(c, 'up', b, 'f2', m))" />
            <input class="ci num" :value="segBwVal(selected, 'up', b)" :placeholder="segBwPh(selected, 'up', b)"
              :title="segBwTitle(selected, 'up', b)"
              @input="lput(segKey(selected.id, b.id, 'up', 'bw'), selected, $event.target.value)"
              @change="lend(segKey(selected.id, b.id, 'up', 'bw'), (c, m) => setBeamSegBw(plan, c, b.id, m, 'up'))"
              @blur="lend(segKey(selected.id, b.id, 'up', 'bw'), (c, m) => setBeamSegBw(plan, c, b.id, m, 'up'))" />
          </div>
          </template>

          <!-- 上下行之间那一步变频：图上就是 UPLINK → DOWNLINK 之间那支箭头，故它摆在两组之间 -->
          <label class="row hinge"><span>本振 LO</span>
            <select class="ci" v-model="selected.loId">
              <option value="">—</option>
              <option v-for="l in plan.los" :key="l.id" :value="l.id">{{ loOption(l) }}</option>
            </select>
          </label>

          <div class="fgrp"><i class="fgrp-ar">↓</i>下行</div>
          <label class="row"><span>中心频率 {{ U }}</span>
            <input class="ci num" data-f="dn" :value="lval(fcKey(selected, 'dn'), dnDisp(selectedResolved))"
              :placeholder="dnLinked(selected) ? '' : '未挂 LO'"
              :title="(dnLinked(selected) ? '与上行由 LO 联动：f下 = f上 − LO —— 改这里上行跟着变'
                : (dnCut(selected) ? '下行已与 LO 解耦（cross-strap）：两侧各填各的' : '未挂 LO —— 上下行各自独立')) + '。回车或离焦生效'"
              @input="lput(fcKey(selected, 'dn'), selected, $event.target.value)"
              @change="lend(fcKey(selected, 'dn'), (c, m) => commitFc(c, 'dn', m))"
              @blur="lend(fcKey(selected, 'dn'), (c, m) => commitFc(c, 'dn', m))" />
          </label>
          <label class="ck2" v-if="loValueOf(plan, selected) != null"
            :title="dnCut(selected) ? `下行按本行自填值，不再跟随上行（LO 推算值为 ${textF(dnFromUp(selected.up.fcMHz, loValueOf(plan, selected)))}）`
              : '勾选后下行与 LO 解耦，两侧各填各的'">
            <input type="checkbox" :checked="dnCut(selected)" @change="setCut(selected, $event.target.checked)" />
            <span>下行频率独立（cross-strap）</span>
          </label>
          <div class="row"><span>起止 {{ U }}</span>
            <input class="ci num" :class="pendCls(selected, 'dn', 'f1')" :value="edgeVal(selected, 'dn', 'f1')" placeholder="起始" :title="edgeTitle(selected, 'dn', 'f1')"
              @input="lput(edgeKey(selected, 'dn', 'f1'), selected, $event.target.value)"
              @change="lend(edgeKey(selected, 'dn', 'f1'), (c, m) => commitEdge(c, 'dn', 'f1', m))"
              @blur="lend(edgeKey(selected, 'dn', 'f1'), (c, m) => commitEdge(c, 'dn', 'f1', m))" />
            <span class="tw">~</span>
            <input class="ci num" :class="pendCls(selected, 'dn', 'f2')" :value="edgeVal(selected, 'dn', 'f2')" placeholder="终止" :title="edgeTitle(selected, 'dn', 'f2')"
              @input="lput(edgeKey(selected, 'dn', 'f2'), selected, $event.target.value)"
              @change="lend(edgeKey(selected, 'dn', 'f2'), (c, m) => commitEdge(c, 'dn', 'f2', m))"
              @blur="lend(edgeKey(selected, 'dn', 'f2'), (c, m) => commitEdge(c, 'dn', 'f2', m))" />
          </div>
          <label class="row"><span>极化</span>
            <select class="ci" v-model="selected.dn.pol"><option v-for="p in POLS" :key="p" :value="p">{{ POL_LABEL[p] }}</option></select>
          </label>
          <div class="row top" title="留空 = 与上行同组；勾选任一项即单独指定"><span>波束</span>
            <BeamPicker mode="list" :beams="plan.beams" :unit="opt.unit" v-model="selected.beamDnIds" :inherit="selected.beamUpIds" />
          </div>
          <!-- 占段表：这条转发器的频带分给它的几个波束。★ 界面上唯一的频率录入口 ——
               波束那边只有名字与带宽，「谁占哪一截」在编排这条转发器时一眼看得全。
               留空 = 走排布档（灰字写的是算出来的落点）。下行留空 = 随上行（整段随 LO 平移）。 -->
          <template v-if="chBeams(selected, 'dn').length">
          <div class="row"><span>排布</span>
            <select class="ci" :value="beamLayoutOf(selected)" :title="LAYOUT_TIP"
              @change="setLayout(selected, $event.target.value)">
              <option v-for="L in BEAM_LAYOUTS" :key="L.key" :value="L.key">{{ L.label }}</option>
            </select>
          </div>
          <div class="bsrow hd"><span>占段 {{ U }}</span><span>起始</span><span>终止</span><span>带宽</span></div>
          <div v-for="b in chBeams(selected, 'dn')" :key="b.id" class="bsrow">
            <span class="bsn" :title="b.name"><i class="bsc" :style="{ background: b.color }"></i>{{ b.name }}</span>
            <input class="ci num" :value="segEdgeVal(selected, 'dn', b, 'f1')" :placeholder="segEdgePh(selected, 'dn', b, 'f1')"
              :title="segEdgeTitle(selected, 'dn', b, 'f1')"
              @input="lput(segKey(selected.id, b.id, 'dn', 'f1'), selected, $event.target.value)"
              @change="lend(segKey(selected.id, b.id, 'dn', 'f1'), (c, m) => commitSegEdge(c, 'dn', b, 'f1', m))"
              @blur="lend(segKey(selected.id, b.id, 'dn', 'f1'), (c, m) => commitSegEdge(c, 'dn', b, 'f1', m))" />
            <input class="ci num" :value="segEdgeVal(selected, 'dn', b, 'f2')" :placeholder="segEdgePh(selected, 'dn', b, 'f2')"
              :title="segEdgeTitle(selected, 'dn', b, 'f2')"
              @input="lput(segKey(selected.id, b.id, 'dn', 'f2'), selected, $event.target.value)"
              @change="lend(segKey(selected.id, b.id, 'dn', 'f2'), (c, m) => commitSegEdge(c, 'dn', b, 'f2', m))"
              @blur="lend(segKey(selected.id, b.id, 'dn', 'f2'), (c, m) => commitSegEdge(c, 'dn', b, 'f2', m))" />
            <input class="ci num" :value="segBwVal(selected, 'dn', b)" :placeholder="segBwPh(selected, 'dn', b)"
              :title="segBwTitle(selected, 'dn', b)"
              @input="lput(segKey(selected.id, b.id, 'dn', 'bw'), selected, $event.target.value)"
              @change="lend(segKey(selected.id, b.id, 'dn', 'bw'), (c, m) => setBeamSegBw(plan, c, b.id, m, 'dn'))"
              @blur="lend(segKey(selected.id, b.id, 'dn', 'bw'), (c, m) => setBeamSegBw(plan, c, b.id, m, 'dn'))" />
          </div>
          </template>
          <div class="fgrp" title="已填项在链路预算引用本转发器时一并传递；留空则沿用卫星配置中的取值">转发器参数</div>
          <!-- 名称与单位逐项对齐链路预算卫星栏（params.js 的 sfdRef / sfdGtRef / BOi / BOo /
               xpdrIntermodFactor），引用过去时一一落位，不再需要人脑做一次名词映射。 -->
          <div class="grid2">
            <label class="row2"><span>SFDref dBW/m²</span><input class="ci num" :value="selected.sfdDbwm2 ?? ''" @input="setNum(selected, 'sfdDbwm2', $event.target.value)" /></label>
            <label class="row2"><span>G/Tref dB/K</span><input class="ci num" :value="selected.gtDbK ?? ''" @input="setNum(selected, 'gtDbK', $event.target.value)" /></label>
            <label class="row2"><span>IBO dB</span><input class="ci num" :value="selected.boiDb ?? ''" @input="setNum(selected, 'boiDb', $event.target.value)" /></label>
            <label class="row2"><span>OBO dB</span><input class="ci num" :value="selected.booDb ?? ''" @input="setNum(selected, 'booDb', $event.target.value)" /></label>
            <label class="row2"><span>C/IM dB</span><input class="ci num" :value="selected.cimDb ?? ''" @input="setNum(selected, 'cimDb', $event.target.value)" /></label>
          </div>
          </template>
          </div>
        </section>

        <section class="sec" :class="{ closed: !secOpen('lo') }">
          <div class="sh" @click="toggleSec('lo')" title="点击折叠 / 展开本区">
            <Icon class="shx" :name="secOpen('lo') ? 'chevron-down' : 'chevron-right'" :size="11" />
            <span class="sht">本振 LO</span>
            <button class="mini ghost xs" title="添加本振" @click.stop="addLo"><Icon name="plus" :size="10" /></button>
            <span class="spacer"></span>
            <span class="shn">{{ plan.los.length }}</span>
          </div>
          <div class="sbd" v-show="secOpen('lo')">
            <div v-for="l in plan.los" :key="l.id" class="lorow">
              <input class="ci nar" v-model="l.name" />
              <!-- 变频量同样跟刻度走：1750 MHz 在 kHz 档下写成 1750000（图上的 LO 注记与这里一致） -->
              <input class="ci num" :value="dval(`lo${l.id}`, l.valueMHz)" :placeholder="U"
                @input="dput(`lo${l.id}`, $event.target.value, (m) => { l.valueMHz = m })" @blur="ddone" />
              <button class="lop del" @click="removeLo(l.id)"><Icon name="x" :size="10" /></button>
            </div>
          </div>
        </section>

        <!-- 波束 = 颜色 + 名 + 带宽。★ 这里不设频率：占哪一段是【单条转发器】的事（在转发器那一区
             逐波束录起止），波束只管「叫什么、多宽」。上下行两个带宽，下行留空 = 同上行。 -->
        <section class="sec bmsec" :class="{ closed: !secOpen('beam') }">
          <div class="sh" @click="toggleSec('beam')"
            title="每行对应图例中的一条：颜色 + 波束名 + 带宽。频率不在此设置——所占频段在转发器分区逐条录入。点击标题折叠 / 展开本区">
            <Icon class="shx" :name="secOpen('beam') ? 'chevron-down' : 'chevron-right'" :size="11" />
            <span class="sht">波束/带宽 · {{ U }}</span>
            <button class="mini ghost xs" @click.stop="addBeam" title="添加波束"><Icon name="plus" :size="10" /></button>
            <!-- 从天线波束合成导入：一色一条（同色 = 同频同极化，一个色号对应一批波束号）。
                 浮层现读现用，不缓存另一个窗口的旧数据。 -->
            <button class="mini ghost xs" :class="{ on: synthPop }" @click.stop="synthPop ? (synthPop = false) : openSynthPop()"
              title="从天线波束合成导入：每个频率配色（F#）生成一条，该色对应的波束编号一并导入；带宽与频率仍在本平台录入">
              <Icon name="import" :size="10" />
            </button>
            <span class="spacer"></span>
            <span class="shn">{{ plan.beams.length }}</span>
          </div>
          <!-- 浮层贴本区左右两边（不挂在按钮上）：右栏可拖窄到 260px，挂按钮上的浮层会探出栏外被裁掉 -->
          <template v-if="synthPop">
            <div class="bpmask" @click="synthPop = false"></div>
            <div class="spop">
              <div class="bph">从天线波束合成导入</div>
              <button v-for="g in synthList" :key="g.id" type="button" class="sgrow"
                :disabled="!g.beamCount" :title="synthTitle(g)" @click="importSynth(g)">
                <span class="sgn" data-i18n-skip>{{ g.name }}</span>
                <span v-if="synthOtherSat(g)" class="sgsat">{{ synthOtherSat(g) }}</span>
                <span class="sgt">{{ g.beamCount }} 波束<template v-if="g.colors.length"> · {{ g.colors.length }} 色</template></span>
                <span class="sgc"><i v-for="c in g.colors" :key="c.fc" :style="{ background: c.css }"></i></span>
              </button>
              <p v-if="!synthList.length" class="sgnone">尚无天线波束合成的波束组。</p>
            </div>
          </template>
          <!-- 一个波束一行：色块 · 名字 · 带宽。列名只在整区顶上写一次。 -->
          <div class="sbd" v-show="secOpen('beam')">
          <div v-if="plan.beams.length" class="bmrow hd">
            <i></i><span>波束</span><span>带宽</span><i></i>
          </div>
          <div v-for="b in plan.beams" :key="b.id" class="bmrow">
            <input class="clr" type="color" v-model="b.color" title="色块与图例的颜色" />
            <input class="ci nm" v-model="b.name" placeholder="波束名"
              :title="beamSynthText(b) || '波束名（与图例一致）。由天线波束合成导入时为波束代号'" />
            <input class="ci num" :value="lval(`bm.${b.id}.bw`, b.bwMHz)" placeholder="占满" :title="bmBwTitle(b)"
              @input="lput(`bm.${b.id}.bw`, b, $event.target.value)"
              @change="lend(`bm.${b.id}.bw`, (x, m) => setBeamBw(x, m))"
              @blur="lend(`bm.${b.id}.bw`, (x, m) => setBeamBw(x, m))" />
            <button class="lop del" @click="removeBeam(b.id)"><Icon name="x" :size="10" /></button>
          </div>
          </div>
        </section>

        <section class="sec" :class="{ closed: !secOpen('gen') }">
          <div class="sh" @click="toggleSec('gen')" title="点击折叠 / 展开本区">
            <Icon class="shx" :name="secOpen('gen') ? 'chevron-down' : 'chevron-right'" :size="11" />
            <span class="sht">批量生成</span>
          </div>
          <div class="sbd" v-show="secOpen('gen')">
          <div class="grid2">
            <label class="row2"><span>转发器数量</span><input class="ci num" v-model="gen.count" /></label>
            <label class="row2"><span>频率间隔 {{ U }}</span>
              <input class="ci num" :value="dval('g.step', gen.stepMHz)" title="相邻转发器的中心频率之差（上下行相同）"
                @input="dput('g.step', $event.target.value, (m) => { gen.stepMHz = m })" @blur="ddone" />
            </label>
            <label class="row2"><span>上行起始频率 {{ U }}</span>
              <input class="ci num" :value="dval('g.start', gen.startFMHz)" title="第一个转发器上行频带的下边沿（不是中心频率）"
                @input="dput('g.start', $event.target.value, (m) => { gen.startFMHz = m })" @blur="ddone" />
            </label>
            <label class="row2"><span>下行起始频率 {{ U }}</span>
              <input class="ci num" :value="dval('g.dnstart', genDnStartMHz)" :disabled="genLo == null" :placeholder="genLo == null ? '先选 LO' : ''"
                @input="dput('g.dnstart', $event.target.value, setGenDnStart)" @blur="ddone"
                title="第一个转发器下行频带的下边沿。与上行起始频率经所选 LO 互算：任一侧输入后另一侧随动" />
            </label>
            <label class="row2"><span>转发器带宽 {{ U }}</span>
              <input class="ci num" :value="dval('g.bw', gen.bwMHz)" placeholder="随波束组" title="留空 = 取所选上行波束组的标称带宽"
                @input="dput('g.bw', $event.target.value, (m) => { gen.bwMHz = m })" @blur="ddone" />
            </label>
          </div>
          <!-- 一排恒为同一个上行极化（见 gen 的注释）。第二个下拉管的是下行那一侧：批量生成过去
               一律把下行按正交铺，遇上「上下行同极化」的星就得回表里逐行改，故给在这儿选 -->
          <!-- 一行两个控件的排必须用 div：<label> 只绑第一个控件，在第二个框里拖选、
               指针划出框外时 click 落到 label 上，焦点会被转发回第一个框 -->
          <div class="row"><span>上行极化</span>
            <select class="ci nar" v-model="gen.pol"><option v-for="p in POLS" :key="p" :value="p">{{ p }}</option></select>
            <select class="ci" v-model="gen.dnPolMode" title="下行极化：正交 = 取上行的正交极化（转发器极化变换的常见接法）；同上行 = 上下行同一极化。生成后仍可在表内逐行修改">
              <option value="">下行正交（{{ POL_ORTHO[gen.pol] || 'V' }}）</option>
              <option value="same">下行同极化（{{ gen.pol }}）</option>
            </select>
          </div>
          <div class="row"><span>编号规则</span><input class="ci nar" v-model="gen.noPattern" title="编号模板：{n} 处替换为序号" /><input class="ci num xnar" v-model="gen.noStart" title="起始序号" /></div>
          <label class="row"><span>本振 LO</span>
            <select class="ci" v-model="gen.loId"><option value="">—</option><option v-for="l in plan.los" :key="l.id" :value="l.id" data-i18n-skip>{{ l.name }}</option></select>
          </label>
          <div class="row top"><span>上行波束</span>
            <BeamPicker mode="list" :beams="plan.beams" :unit="opt.unit" v-model="gen.beamUpIds" />
          </div>
          <div class="row top"><span>下行波束</span>
            <BeamPicker mode="list" :beams="plan.beams" :unit="opt.unit" v-model="gen.beamDnIds" :inherit="gen.beamUpIds" />
          </div>
          <button class="mini imp wide" @click="runGen">生成 {{ gen.count }} 个转发器</button>
          </div>
        </section>
      </aside>
    </div>

    <!-- 合成导出：左选（勾 + 排序）· 右预览，底栏落标题与格式 -->
    <div v-if="mergeOpen" class="mask" @click.self="mergeOpen = false">
      <div class="mdlg">
        <div class="mh">
          <span class="mt">合成导出</span>
          <span class="spacer"></span>
          <button class="mx" title="关闭" @click="mergeOpen = false"><Icon name="x" :size="12" /></button>
        </div>

        <div class="mbody">
          <div class="mleft">
            <div class="lq">
              <Icon name="search" :size="11" class="qi-ic" />
              <input class="qi" v-model="mergeQ" placeholder="筛选卫星 / 计划" />
              <button v-if="mergeQ" class="qx" title="清空" @click="mergeQ = ''"><Icon name="x" :size="10" /></button>
            </div>
            <div class="mscroll">
              <div v-if="!mergeTree.length" class="lnone">没有可合成的计划。</div>
              <section v-for="g in mergeTree" :key="g.key" class="mgrp">
                <div class="msat"><Icon class="si" name="satellite" :size="11" /> {{ g.label }}</div>
                <label v-for="e in g.items" :key="e.id" class="mrow" :class="{ on: mergeIds.includes(e.id) }">
                  <input type="checkbox" :checked="mergeIds.includes(e.id)" @change="toggleMerge(e.id)" />
                  <span class="mn" :title="e.name">{{ shortName(e, g) }}</span>
                  <span class="mm">{{ e.band }} · {{ e.transponderCount }} 转发器</span>
                </label>
                <div v-if="!g.items.length" class="mempty">该星下暂无计划</div>
              </section>
            </div>
            <div class="mordh">
              <span>叠放顺序（自上而下）</span>
              <span class="spacer"></span>
              <button class="mini ghost xs" :disabled="mergeIds.length < 2" title="按上行频率升序：C 在上、Ku 居中、Ka 在下"
                @click="sortMergeByFreq">按频率排序</button>
            </div>
            <div class="mord">
              <div v-if="!mergeIds.length" class="mempty">还没勾选计划。</div>
              <div v-for="(e, i) in mergeSelected" :key="e.id" class="mordrow">
                <span class="oi">{{ i + 1 }}</span>
                <span class="mn" :title="e.name" data-i18n-skip>{{ e.name }}</span>
                <span class="mm">{{ e.band }}</span>
                <button class="lop" :disabled="i === 0" title="上移" @click="moveMerge(i, -1)"><Icon name="chevron-up" :size="11" /></button>
                <button class="lop" :disabled="i === mergeSelected.length - 1" title="下移" @click="moveMerge(i, 1)"><Icon name="chevron-down" :size="11" /></button>
                <button class="lop del" title="移出" @click="toggleMerge(e.id)"><Icon name="x" :size="11" /></button>
              </div>
            </div>
          </div>

          <div class="mright">
            <div class="mprevh">
              <span>预览</span>
              <span class="dim">{{ mergePlans.length }} 段</span>
              <span class="spacer"></span>
              <label class="ck" title="开启 = 全图统一标尺，同带宽跨频段等宽（便于横向比对）；关闭 = 各频段分别铺满画布，段内展开更宽">
                <input type="checkbox" v-model="mergeShared" /> 统一比例尺
              </label>
              <label class="ck"><input type="checkbox" v-model="mergeSecTitles" /> 段头</label>
            </div>
            <div class="mprev" ref="prevBox">
              <div v-if="!mergePlans.length" class="mempty pad">暂无预览。</div>
              <div v-else class="mprevin" v-html="mergeSvg"></div>
            </div>
          </div>
        </div>

        <div class="mfoot">
          <label class="fld ttl">标题 <input class="ci" v-model="mergeTitle" placeholder="留空 = 不画标题" /></label>
          <select class="ci nar" v-model="mergeKind">
            <option value="png2">PNG 2×</option>
            <option value="png4">PNG 4×</option>
            <option value="png6">PNG 6×</option>
            <option value="pdf">PDF（矢量）</option>
            <option value="svg">SVG</option>
            <option value="json">JSON 数据</option>
          </select>
          <button class="mini ghost" @click="mergeOpen = false">取消</button>
          <button class="mini imp" :disabled="!mergePlans.length || !!busy" @click="exportMerge">导出合成图（{{ mergePlans.length }} 份）</button>
        </div>
      </div>
    </div>

    <div v-if="confirmMsg" class="mask">
      <div class="cdlg">
        <p>{{ confirmMsg }}</p>
        <div class="cops">
          <button class="mini ghost" @click="answer(false)">取消</button>
          <button class="mini imp" @click="answer(true)">确定</button>
        </div>
      </div>
    </div>

    <MiniSendDialog v-model:open="miniOpen" :build="buildMiniPack" :device-id="miniDeviceId" :configured="miniConfigured" @toast="flash" />
  </div>
</template>

<style scoped>
/* 根字号写死：本窗口的表格/检查器/工具栏字号全部逐处固定，跟 --lb-fs 联动等于只动一个
   谁也继承不到的根值——原先那个「界面字号」输入框正因如此调了没反应，已连同变量一起去掉。 */
.fp { height: 100vh; display: flex; flex-direction: column; background: var(--bg); color: var(--text); font-family: var(--font-serif); font-size: 13px; }
.tb { display: flex; align-items: center; gap: 7px; padding: 6px 10px; border-bottom: 1px solid var(--border-strong); background: var(--surface); flex-wrap: wrap; }
.brand { font-weight: 600; }
.sep { width: 1px; height: 16px; background: var(--border-strong); margin: 0 2px; }
.spacer { flex: 1; }
.busy { color: var(--text-muted); font-size: 12px; }
.msg { padding: 4px 10px; background: var(--surface-2); border-bottom: 1px solid var(--border); font-size: 12.5px; color: var(--text-muted); }

/* 五列（列宽由 :style 出，左右两栏都可拖）；两条 0 宽轨只用来挂拖宽手柄 */
.body { flex: 1; display: grid; grid-template-columns: 250px 0px minmax(0,1fr) 0px 396px; min-height: 0; }
/* 三栏的分界线走 --border-strong：栏与栏的边界不该与栏内的行线同一档（区分度的第一刀） */
.left { border-right: 1px solid var(--border-strong); display: flex; flex-direction: column; min-height: 0; }
.lh { display: flex; align-items: center; padding: 5px 8px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-muted); }
.lht { font-weight: 600; color: var(--text); }
/* 筛选条：卫星一多（一整个星座就是几十行）全列出来会很长，先筛再点 */
.lq { display: flex; align-items: center; gap: 4px; padding: 3px 8px; border-bottom: 1px solid var(--border); background: var(--surface); }
.lq .qi-ic { color: var(--text-faint); }
.qi { flex: 1; min-width: 0; background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 1px 4px; font: inherit; font-size: 12px; font-family: var(--font-serif); }
.qi:focus { border-color: var(--text); outline: none; }
.qx { flex: none; border: none; background: none; color: var(--text-faint); cursor: pointer; padding: 1px 2px; display: flex; }
.qx:hover { color: var(--text); }
.lscroll { flex: 1; overflow: auto; }
.lnone { padding: 14px 10px; color: var(--text-faint); font-size: 12px; line-height: 1.7; }
.grp { margin-bottom: 1px; }

/* ── 一级：卫星行 ── 灰底 + 粗体 + 强分隔线，且吸顶；与二级的白底缩进行拉开层次。
   三档灰是全窗仅有的三档（bg / surface / surface-2），分配上必须让相邻两级不同色：
   卫星行 surface-2（最深）· 空星 surface · 计划行 bg（白）· 选中的计划 surface + 黑色左标。 */
.sat { display: flex; align-items: center; gap: 4px; padding: 5px 6px 5px 4px; cursor: pointer;
  background: var(--surface-2); border-bottom: 1px solid var(--border-strong);
  font-size: 12px; font-weight: 600; color: var(--text); position: sticky; top: 0; z-index: 1; }
.sat:hover { background: var(--border); }
/* 还没有计划的星：同一层级但整体压暗（浅一档底色 + 常规字重），一眼看出「这颗还是空的」 */
.sat.bare { background: var(--surface); font-weight: 400; color: var(--text-muted); border-bottom-color: var(--border); }
.sat.cur { box-shadow: inset 3px 0 0 var(--text-faint); }   /* 折叠着也看得出当前计划在哪颗星下 */
.sat.orphan { color: var(--warn); }
.sat .tw { flex: none; width: 13px; display: flex; align-items: center; justify-content: center; color: var(--text-muted); }
.sat .si { flex: none; color: var(--text-faint); }
.sat.cur .si { color: var(--text); }            /* 当前打开的那份计划所属的星 */
.sat .sn { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sat .sc { flex: none; font-size: 10.5px; font-weight: 400; color: var(--text-muted); border: 1px solid var(--border-strong); padding: 0 3px; }
/* 新建入口：就骑在卫星名这一行，「建给哪颗星」由所在行说清楚。平时淡、悬停才实，不喧宾夺主 */
.sadd { flex: none; display: inline-flex; align-items: center; gap: 2px; font: inherit; font-size: 11px;
  padding: 0 3px; height: 17px; border: 1px solid transparent; background: none; color: var(--text-faint); cursor: pointer; }
.sadd.bare { color: var(--text-muted); }
.sat:hover .sadd { color: var(--text); border-color: var(--border-strong); background: var(--bg); }
.sat .sadd:hover { color: var(--text); border-color: var(--text); background: var(--bg); }   /* 与上一条同权重，写在后面才压得住 */

/* ── 二级：该星下的计划 ── 缩进 + 一条导引线，白底 */
.kids { margin-left: 10px; border-left: 1px solid var(--border); }
.li { padding: 4px 8px 4px 10px; border-bottom: 1px solid var(--border); cursor: pointer; position: relative; background: var(--bg); }
.li:hover { background: var(--surface); }
/* 选中：底色只提一档（不能用 surface-2，那是卫星行的底色，一撞父子两级就又糊成一片），
   靠导引线内侧那道 3px 黑标 + 加粗计划名认人 */
.li.on { background: var(--surface); box-shadow: inset 3px 0 0 var(--text); }
.li.on .ln { font-weight: 600; }
.ln { font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lm { font-size: 11px; color: var(--text-faint); margin-top: 1px; }
.lops { position: absolute; right: 4px; top: 5px; display: none; gap: 2px; }
.li:hover .lops { display: flex; }
.lop { border: none; background: var(--surface-2); color: var(--text-muted); cursor: pointer; padding: 2px 4px; }
.lop:hover { color: var(--text); }
.lop.del:hover { color: var(--danger); }

/* ── 三级：这份计划的频率分配表 ── 再缩一档、字更小，且不给自己的分隔线：
   它是计划的一部分，不是与计划并列的另一个条目。选中同样是那道 3px 黑标（与二级一套认法）。 */
.sub { display: flex; align-items: center; gap: 5px; padding: 3px 8px 3px 22px; cursor: pointer;
  background: var(--bg); border-bottom: 1px solid var(--border); color: var(--text-muted); font-size: 11.5px; }
.sub:hover { background: var(--surface); color: var(--text); }
.sub.on { background: var(--surface); color: var(--text); box-shadow: inset 3px 0 0 var(--text); }
.sub.on .sbn { font-weight: 600; }
.sbn { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sbc { flex: none; font-size: 10.5px; color: var(--text-faint); font-variant-numeric: tabular-nums; }

.center { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.mnone { padding: 40px; color: var(--text-muted); }
.mnone .dim { color: var(--text-faint); font-size: 12.5px; }
.chartbox { padding: 10px 12px; border-bottom: 1px solid var(--border-strong); overflow: auto; max-height: 52%; }
.tabs { display: flex; align-items: center; gap: 4px; padding: 4px 8px; border-bottom: 1px solid var(--border); background: var(--surface); }
.tb-b { font: inherit; font-size: 12.5px; padding: 3px 10px; border: 1px solid transparent; background: transparent; color: var(--text-muted); cursor: pointer; }
/* 经典连体文件页签：选中页与下方内容面同底，顶缘 2px 墨条 —— 页与它管的那片内容连成一体 */
.tb-b.on { background: var(--bg); border-color: var(--border-strong); color: var(--text); box-shadow: inset 0 2px 0 var(--accent); }
.tb-b i { font-style: normal; font-size: 11px; color: var(--text-faint); margin-left: 3px; }
.tb-b i.bad { color: var(--danger); }
.tabbody { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.tscroll { flex: 1; overflow: auto; }

/* ── 批量条 ── 只在有勾选时出现（常驻的话，没勾选时那一排下拉既无作用域又占着高度）。
   底色比表深一档、与表之间压一条强分隔线：它管的是「已选的这 N 条」，不是表本身。 */
.bbar {
  display: flex; align-items: center; flex-wrap: wrap; gap: 5px 6px;
  padding: 5px 8px; background: var(--surface-2); border-bottom: 1px solid var(--border-strong);
}
.bbar .bn { font-size: 12px; color: var(--text-muted); }
.bbar .bn b { color: var(--text); font-variant-numeric: tabular-nums; }
.bbar .fld { gap: 3px; }
/* 条上的下拉写全称（「逐条取上行的正交」这种），宽度随文字走 —— 不套表里那两档窄宽，
   否则就成了另一处「选项被切掉半个字」 */
.bbar .ci.bsl { flex: none; width: auto; max-width: 190px; }
.bsep { width: 1px; height: 15px; background: var(--border-strong); margin: 0 1px; }
.bdel:hover:not(:disabled) { color: var(--danger); border-color: var(--danger); }
.xxnar { max-width: 34px; }
/* 波束是多选，塞不进下拉 —— 点开一个小浮层照常勾选，勾完一次落到这 N 条上 */
.bwrap { position: relative; display: inline-flex; }
.bwrap .mini.on { background: var(--bg); border-color: var(--text); color: var(--text); }
.bpmask { position: fixed; inset: 0; z-index: 29; }
.bpop {
  position: absolute; left: 0; top: calc(100% + 4px); z-index: 30; min-width: 196px;
  background: var(--bg); border: 1px solid var(--border-strong); padding: 7px 8px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, .12);
}
.bph { font-size: 11.5px; color: var(--text-muted); margin-bottom: 5px; }
.bpo { display: flex; align-items: center; gap: 5px; margin-top: 7px; }
/* 「+ 转发器」旁那个下拉菜单：贴右缘展开（它在工具条右端，贴左缘会探出画布） */
.caret { padding-left: 5px; padding-right: 5px; }
.addpop { left: auto; right: 0; min-width: 118px; padding: 4px; }
.apo {
  display: flex; align-items: center; gap: 5px; width: 100%; padding: 5px 7px;
  background: none; border: 0; color: var(--text); font: inherit; font-size: 12px; text-align: left; cursor: pointer;
}
.apo:hover { background: var(--surface); }

.t { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.t thead th { position: sticky; top: 0; z-index: 1; background: var(--surface); border-bottom: 1px solid var(--border-strong); padding: 4px 6px; text-align: left; font-weight: 600; white-space: nowrap; }
/* 记下了但还没成段的那一端（另一端还没录，见 edgePend）：数照旧显示着，但它还没进模型、
   图上也还没有这条频带，故压成灰斜体与已落定的读数分开 */
.ci.num.pend { color: var(--text-faint); font-style: italic; }
/* 频率列口径的切换（中心 + 带宽 ⇄ 起 + 止）：开关就是列头本身，不另占一格工具栏 */
.t thead th.colsw { cursor: pointer; user-select: none; }
.t thead th.colsw:hover { color: var(--accent, var(--text)); }
.t thead th.colsw svg { vertical-align: -1px; opacity: .55; }
.t thead th.colsw:hover svg { opacity: 1; }
.t td { border-bottom: 1px solid var(--border); padding: 1px 5px; }
.t tbody tr { cursor: pointer; }
.t tbody tr:hover { background: var(--surface); }
/* 勾选行只提一档底色；当前行（.on，深一档 + 左侧黑标）写在后面才压得住，两者可同时成立 */
.t tbody tr.ckd { background: var(--surface); }
.t tbody tr.on { background: var(--surface-2); box-shadow: inset 2px 0 0 var(--text); }
/* 行头槽（Excel 的行号列）：勾选 + 行号，整格都是拖选的把手，故要有点宽度、且不参与文字选择。
   勾选框自己不收鼠标事件 —— 按下即切换的活由整格干，留着它自己那次 click 会再翻一次成来回抵消 */
.t th.ck, .t td.ck { width: 38px; padding-left: 6px; padding-right: 2px; white-space: nowrap; }
.t td.ck { cursor: pointer; user-select: none; }
.t td.ck:hover { background: var(--surface-2); }
.t .ck input { margin: 0; vertical-align: middle; }
.t td.ck input { pointer-events: none; }
.t .ck .rn { font-style: normal; font-size: 10.5px; color: var(--text-faint); margin-left: 3px; font-variant-numeric: tabular-nums; }
.t.dragsel { cursor: pointer; }        /* 拖选途中滑过输入框也不该变成文字光标 */
.t.dragsel .ci { pointer-events: none; }

.dnum input::placeholder { color: var(--text-faint); font-style: italic; }
/* 下行那格：输入框 + 一个只在「与 LO 解耦」时出现的复联按钮。联动是常态，常态不加标记——
   只把偏离常态的那几行标出来（断链图标是警色，一眼扫得出这一行的下行不跟着上行走）。 */
.lkc { display: flex; align-items: center; gap: 2px; }
.lkb { flex: none; display: flex; border: none; background: transparent; color: var(--warn); cursor: pointer; padding: 0 1px; }
.lkb:hover { color: var(--text); }
.ops { white-space: nowrap; }
.none { padding: 22px; text-align: center; color: var(--text-faint); font-size: 12.5px; line-height: 1.7; }

.chk { padding: 4px 0; }
.ci-item { display: flex; gap: 8px; padding: 4px 10px; border-bottom: 1px solid var(--border); font-size: 12.5px; cursor: pointer; }
.ci-item:hover { background: var(--surface); }
.sev { flex: none; width: 18px; text-align: center; font-size: 11px; border: 1px solid var(--border-strong); height: 16px; line-height: 14px; }
.ci-item.error .sev { color: var(--danger); border-color: var(--danger); }
.ci-item.warn .sev { color: var(--warn); border-color: var(--warn); }
.ci-item.info .sev { color: var(--text-muted); }
.cm { color: var(--text-muted); }

/* ── 右栏 = 检查器 ──
   底色给最深的一档，各分区自己是白面板 —— 分区之间那 4px 灰槽即由此而来（平台停靠面板的既定
   做法：灰槽 + 面板实边，不做浮动卡片、不加圆角）。从前分区界与栏内行线同为 1px --border，
   一栏读下来是一列连不断的表单，这正是「各分区区分度低」的根。 */
.right { border-left: 1px solid var(--border-strong); overflow: auto; min-width: 0; background: var(--surface-2); }
/* 骑在分界线上：7px 命中区靠 ±3.5px 负边距抵消，净占 0，拖时高亮 */
.rz { width: 7px; margin: 0 -3.5px; position: relative; z-index: 6; cursor: col-resize; }
.rz:hover, .rz.on { background: var(--accent); opacity: .35; }
/* 设置栏收起时：手柄自己占满那 7px 的轨（不再负边距），画成一道窄槽 —— 拖回来的地方得看得见 */
.rz.closed { margin: 0; border-left: 1px solid var(--border); background: var(--surface); }
.rz.closed:hover { background: var(--accent); }
.sec { background: var(--bg); border: 1px solid var(--border); border-width: 0 0 1px; margin-bottom: 4px; }
.sec:last-child { margin-bottom: 0; }
.sbd { padding: 5px 9px 8px; }
/* 分区标题栏：22px 细栏（灰底 + 强下线 + 字距），且吸顶 —— 右栏是一整条滚动区，
   滚到波束那一堆卡片中间时，顶上仍写着「波束/带宽」。点标题即折叠（状态存 localStorage）：
   94 波束的计划里，把这一区折起来才腾得出地方编转发器。 */
.sh { position: sticky; top: 0; z-index: 3; display: flex; align-items: center; gap: 5px;
  height: 22px; padding: 0 7px 0 3px; background: var(--surface); border-bottom: 1px solid var(--border-strong);
  font-size: 11.5px; font-weight: 600; letter-spacing: var(--ls-tight); color: var(--text-muted); cursor: pointer; user-select: none; }
.sh:hover { color: var(--text); }
.sh .shx { flex: none; color: var(--text-faint); }
.sht { flex: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.shn { flex: none; font-size: 10.5px; font-weight: 400; letter-spacing: 0; color: var(--text-faint); font-variant-numeric: tabular-nums; }
/* 当前这一条转发器：标题栏加深一档 + 左标；聚焦时整区左缘再压一条实心竖标。
   两者与图上选中块的描边（.fpc-blk.on）、表里那一行的左标（tr.on）同一套语言。 */
.sec.cur > .sh { background: var(--surface-2); color: var(--text); box-shadow: inset 3px 0 0 var(--text); }
.sec:focus-within { box-shadow: inset 3px 0 0 var(--text); }   /* 与区头那条同宽：焦点进来 = 那条标从区头一直长到区底 */
.sec:focus-within > .sh { background: var(--surface-2); color: var(--text); }
/* 检查器里翻条：‹ 7 / 18 › —— 逐条核对参数时不必回表点 */
.shnav { display: inline-flex; align-items: center; gap: 1px; font-weight: 400; letter-spacing: 0; }
.shnav i { font-style: normal; font-size: 10.5px; color: var(--text-muted); font-variant-numeric: tabular-nums; padding: 0 1px; }
.shb { flex: none; display: flex; align-items: center; border: 1px solid transparent; background: none;
  color: var(--text-muted); cursor: pointer; padding: 1px 2px; }
.shb:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); background: var(--bg); }
.shb:disabled { color: var(--text-faint); cursor: default; }
/* 区内分组头（↑ 上行 / ↓ 下行 / 转发器参数）：小号字距 + 题线，把一列 13 行的长表分成图上那三段。
   ★ 类名不叫 .gh —— BeamPicker 里 .gh 已是「继承态（随上行）」的修饰类。scoped CSS 今天挡得住
   （子组件内部不带父组件的 data-v），但同名两义迟早咬人，见 FpAlloc 那次 .ghost 撞车。 */
.fgrp { display: flex; align-items: center; gap: 5px; margin: 7px 0 3px; padding-bottom: 2px;
  border-bottom: 1px solid var(--border); font-size: 10.5px; letter-spacing: var(--ls-caps); color: var(--text-faint); }
.fgrp .fgrp-ar { font-style: normal; font-size: 12px; letter-spacing: 0; color: var(--text-muted); }
/* 变频那一步：图上是 UPLINK → DOWNLINK 之间的箭头，这里就是夹在两组之间的这一条 */
.hinge { background: var(--surface); border: 1px solid var(--border); border-width: 1px 0; padding: 2px 5px; margin: 6px -5px 2px; }
.row { display: flex; align-items: center; gap: 6px; padding: 1px 5px; margin: 0 -5px 2px; }
/* 正在录的是哪一格：标签转深加粗 + 整行提一档底色（格级的聚焦环见 .ci:focus） */
.row:focus-within { background: var(--surface); }
.row:focus-within > span { color: var(--text); font-weight: 600; }
/* 右侧是多行控件（波束多选那种）时标题贴顶，别把「上行波束」四个字吊在一列勾选框的正中 */
.row.top { align-items: flex-start; }
.row.top > span { padding-top: 4px; }
.row.top > :last-child { flex: 1; min-width: 0; }
/* 标题列按最长的那条（「间隔带宽 MHz」≈ 72px：宋体 4 个全角字 + Times 的「 MHz」）定宽，
   留一点余量并禁止折行——名称写全、单位跟在后面，字体回落变化时也不会掉成两行把整行撑高。
   ★ 从前是 104px：那时每个名字都得前缀「上行/下行」（上行中心频率 MHz）。侧别现在由分组头
   （↑ 上行 / ↓ 下行）说清，标题列因此收窄 26px，全落给数值格。 */
.row > span { flex: none; width: 78px; font-size: 11.5px; color: var(--text-muted); white-space: nowrap; }
/* 起止那行是两格输入夹一个「~」：这个波浪号是分隔符不是标题列，得从上面那条定宽里摘出来 */
.row > span.tw { width: auto; padding: 0 1px; color: var(--text-faint); }
.row2 { display: flex; flex-direction: column; gap: 1px; }
.row2 > span { font-size: 11px; color: var(--text-muted); }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 3px 6px; margin-bottom: 4px; }
.sum { font-size: 11px; color: var(--text-faint); margin-top: 4px; }
/* 勾选行：左缩进对齐输入框那一列（78px 标题 + 6px 间距），不与上面几行的标题列错开 */
.ck2 { display: flex; align-items: center; gap: 5px; margin: 2px 0 3px 84px; font-size: 11.5px; color: var(--text-muted); cursor: pointer; }
.lorow { display: flex; align-items: center; gap: 4px; margin-bottom: 3px; }
/* 波束一行：色块 · 名字 · 备注 · ↑ 上行带宽 · ↓ 下行带宽 · 删。与图例条目
   「■ 中国波束：36 MHz」同序，照着填完就是图上那一条。频率不在这里 —— 占哪一段是转发器的事。 */
/* 「从波束合成导入」浮层：一行一个波束组（组名 · 色数/波束数 · 色片）。
   ★ 贴【本区】的左右两边、不挂在那个按钮上：右栏可拖到 260px 窄，挂按钮上的浮层会探出栏外
   被 .right 的 overflow 裁掉（人只看到半个浮层）。故 .bmsec 起定位上下文，浮层跟着栏宽走。 */
.bmsec { position: relative; }
.spop {
  position: absolute; left: 9px; right: 9px; top: 23px; z-index: 30;
  max-height: 320px; overflow: auto; padding: 6px;
  background: var(--bg); border: 1px solid var(--border-strong); box-shadow: 0 4px 14px rgba(0, 0, 0, .12);
}
.sgrow {
  display: flex; align-items: center; gap: 5px; width: 100%; padding: 4px 5px;
  background: transparent; border: 1px solid transparent; color: var(--text);
  font: inherit; font-size: 12px; text-align: left; cursor: pointer;
}
.sgrow:hover:not(:disabled) { background: var(--surface); border-color: var(--border); }
.sgrow:disabled { color: var(--text-faint); cursor: not-allowed; }
.sgrow .sgn { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 别的星上的组才写星名（本星的不写——一整列同一个名字是噪声） */
.sgrow .sgsat { flex: none; max-width: 96px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10.5px; color: var(--text-muted); }
.sgrow .sgt { flex: none; font-size: 10.5px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
/* 色片一行排开：色数多到 16 个也不换行（挤窄一点即可，看的是「有几种色」而不是每一片多大） */
.sgrow .sgc { flex: none; display: flex; gap: 1px; max-width: 74px; overflow: hidden; }
.sgrow .sgc i { width: 7px; height: 12px; flex: none; }
.sgnone { color: var(--text-faint); font-size: 11.5px; margin: 2px 4px; }
/* 末列是那个 ×：定宽 15px，数格的宽度不因它变 */
.bmrow { display: grid; grid-template-columns: 26px minmax(0, 1.7fr) minmax(0, 1fr) 15px; gap: 4px; align-items: center; margin-bottom: 3px; }
.bmrow .ci { padding: 1px 3px; font-size: 11.5px; }
.bmrow .ci::placeholder { color: var(--text-faint); font-style: italic; }
/* 列名行：几格挤在一起，不写列名就分不出哪格是哪格 */
.bmrow.hd { margin-bottom: 1px; }
.bmrow.hd span { font-size: 10.5px; color: var(--text-faint); text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bmrow.hd span:first-of-type { text-align: left; }
/* 行尾的 ×：与整行同高、不撑格 */
.bmrow .lop { padding: 1px 2px; line-height: 0; }

/* 转发器占段表：一个波束一行（波束名 · 起始 · 终止 · 带宽），跟在该侧的「波束」多选之后。
   ★ 类名不能沿用浮层那套 .sg*（同一个组件里的同名类会互相盖，scoped 挡不住）。
   波束名那一列比三个数格窄：数格是要逐个 Tab 着录的，名字只用来认行。 */
.bsrow { display: grid; grid-template-columns: 78px repeat(3, minmax(0, 1fr)); gap: 4px; align-items: center; margin-bottom: 3px; padding-left: 6px; }
.bsrow .ci { padding: 1px 3px; font-size: 11.5px; }
.bsrow .ci::placeholder { color: var(--text-faint); font-style: italic; }
.bsrow .bsn { display: flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--text-muted); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bsrow .bsc { flex: none; width: 8px; height: 12px; }
.bsrow.hd { margin-bottom: 1px; }
.bsrow.hd span { font-size: 10.5px; color: var(--text-faint); text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bsrow.hd span:first-of-type { text-align: left; }

.ci { flex: 1; min-width: 0; background-color: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 2px 4px; font: inherit; font-size: 12.5px; font-family: var(--font-serif); }
/* 格级聚焦：1px 深边 + 一圈极淡的环。方角、无动效 —— 环只是把「光标在这一格」摆明，
   不是网页那种高亮。表内密排另给一套更收敛的（见下面 .t .ci:focus）。 */
.ci:focus { border-color: var(--text); outline: none; box-shadow: 0 0 0 2px color-mix(in srgb, var(--text) 14%, transparent); }
.ci:disabled { background-color: var(--surface); color: var(--text-faint); cursor: not-allowed; }
.ci.num { text-align: right; font-variant-numeric: tabular-nums; }
.ci.nar { max-width: 88px; }
.ci.xnar { max-width: 54px; }
.t .ci { border-color: transparent; background-color: transparent; width: 100%; }
/* 数字列随刻度加宽（--fp-numw 由 numColW 按当前刻度下最长的读数算）。写在 .nar 之后：
   min-width 压过 max-width 是 CSS 的既定顺序，Hz 档下那一列才不会把数截掉。
   +12px 是这个框自己的左右内边距与边框（box-sizing: border-box，min-width 连它们一起算） */
.t .ci.num { min-width: calc(var(--fp-numw, 0ch) + 12px); }
.t .ci:hover { border-color: var(--border); }
/* 表内的聚焦格：不外扩（密表里 2px 的环会顶到邻格），改用内侧再压一道 1px —— 双线即 Excel 的活动格 */
.t .ci:focus { border-color: var(--text); background-color: var(--bg); box-shadow: inset 0 0 0 1px var(--text); }

/* ── 表内下拉的宽度 ──
   （原先这里写着「必须写在上面三条之后：那三条用的是 background 简写，同权重下写在后面就会把
     这里的箭头背景图抹掉」。2026-08-22 全库的 select 底色已统一改用 background-color 长手，
     顺序不再是前提；这段仍留在原位，改动它时不必再迁就顺序。）
   原生下拉的箭头在 Chromium 里恒占约 16px，而这几列的列宽是按表头那两三个字定的
   —— select 用的是 width:100%，百分比宽不计入列的固有宽度，列于是被压到比内容还窄，
   箭头一挤就把「极化」的 H/V 与 LO 名切掉半个字（这两列显示不全的根因）。故表内下拉一律：
     · 自绘箭头（7px，比原生轻，密表里也不显吵），文字区由 padding-right 明确让出
     · 给各自的 min-width —— min-width 才算进列的固有宽度，这才是列不再被压窄的根子 */
.t .ci.selc {
  appearance: none; -webkit-appearance: none;
  /* !important 是冲着 styles/controls.css 里那条 `select { padding-right: 21px !important }` 去的：
     那条给全平台自绘的 10px 箭头留位，钉死是为了防组件用 padding 简写把它挤没。本表是全库唯一
     自绘了另一枚箭头（7px，right 3px）的地方，21px 会白白多让出 7px 把密表的列撑开——正是本段
     开头说的「列被压窄」的反面。故此处按自家箭头的实际占位覆盖回来。 */
  padding-right: 14px !important;
  background-color: transparent;
  background-image: url("data:image/svg+xml;charset=utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='7' height='4' viewBox='0 0 7 4'%3E%3Cpath d='M.6.6 3.5 3.4 6.4.6' fill='none' stroke='%238a8a84' stroke-width='1.1'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 3px center;
}
html[data-theme="dark"] .t .ci.selc {
  background-image: url("data:image/svg+xml;charset=utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='7' height='4' viewBox='0 0 7 4'%3E%3Cpath d='M.6.6 3.5 3.4 6.4.6' fill='none' stroke='%23a4a49e' stroke-width='1.1'/%3E%3C/svg%3E");
}
.t .ci.selc:focus { background-color: var(--bg); }     /* 聚焦仍给白底，但别再动背景图 */
.t .ci.selpol { min-width: 42px; max-width: 52px; }
.t .ci.sello { min-width: 62px; max-width: 108px; }
.t .ci.selkind { min-width: 86px; max-width: 96px; }

.mini { font: inherit; font-size: 12.5px; padding: 3px 9px; border: 1px solid var(--border-strong); background: var(--bg); color: var(--text); cursor: pointer; white-space: nowrap; }
.mini:hover:not(:disabled) { background: var(--surface-2); }
.mini:disabled { opacity: .45; cursor: default; }
.mini.imp { background: var(--text); color: var(--bg); border-color: var(--text); }
.mini.ghost { color: var(--text-muted); }
/* 分配表页的设置栏开合钮：只有一个图标，故按下态靠边框与墨色区分（同批量条那几个小钮的写法） */
.pnb { display: inline-flex; align-items: center; padding: 3px 7px; }
.pnb.on { border-color: var(--text); color: var(--text); }
.mini.xs { padding: 0 5px; font-size: 11px; }
.mini.wide { width: 100%; margin-top: 5px; }
.fld { font-size: 11.5px; color: var(--text-muted); display: inline-flex; align-items: center; gap: 4px; }
.fld .pct { margin-left: -2px; }   /* 百分号紧贴输入框，别被 .fld 的 gap 推开成一个独立词 */

.dd { position: relative; }
.dd:hover .ddm { display: block; }
.ddm { display: none; position: absolute; left: 0; top: 100%; z-index: 20; background: var(--bg); border: 1px solid var(--border-strong); min-width: 130px; }
.ddm button { display: block; width: 100%; text-align: left; font: inherit; font-size: 12.5px; padding: 4px 10px; border: none; background: transparent; color: var(--text); cursor: pointer; }
.ddm button:hover { background: var(--surface-2); }

.mask { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: flex; align-items: center; justify-content: center; z-index: 99; }
.cdlg { background: var(--bg); border: 1px solid var(--border-strong); padding: 16px 18px; max-width: 420px; }
.cdlg p { margin: 0 0 12px; line-height: 1.6; }
.cops { display: flex; gap: 8px; justify-content: flex-end; }
.dim { color: var(--text-faint); }

/* ── 合成导出 ── 左选右览：勾选与顺序都在左边一列（勾了才排得上号），右边整张预览 */
.mdlg { background: var(--bg); border: 1px solid var(--border-strong); width: min(1160px, 94vw); height: min(760px, 88vh); display: flex; flex-direction: column; }
.mh { display: flex; align-items: baseline; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--border-strong); background: var(--surface); }
.mt { font-weight: 600; }
.mx { align-self: center; border: none; background: none; color: var(--text-faint); cursor: pointer; display: flex; padding: 2px; }
.mx:hover { color: var(--text); }
.mbody { flex: 1; min-height: 0; display: grid; grid-template-columns: 312px minmax(0,1fr); }
.mleft { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--border); }
.mscroll { flex: 1; overflow: auto; min-height: 0; }
.mgrp { border-bottom: 1px solid var(--border); }
.msat { display: flex; align-items: center; gap: 4px; padding: 4px 8px; background: var(--surface-2); font-size: 11.5px; font-weight: 600; position: sticky; top: 0; z-index: 1; }
.msat .si { color: var(--text-faint); }
.mrow { display: flex; align-items: center; gap: 6px; padding: 3px 8px 3px 14px; cursor: pointer; font-size: 12px; }
.mrow:hover { background: var(--surface); }
.mrow.on { background: var(--surface); box-shadow: inset 3px 0 0 var(--text); }
.mrow .mn { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mrow .mm, .mordrow .mm { flex: none; font-size: 11px; color: var(--text-faint); }
.mempty { padding: 8px 14px; font-size: 11.5px; color: var(--text-faint); }
.mempty.pad { padding: 28px; text-align: center; }
/* 顺序列表：图上自上而下就是这里从上到下，所以它必须是一列而不是一行标签 */
.mordh { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-top: 1px solid var(--border-strong); background: var(--surface); font-size: 11.5px; color: var(--text-muted); }
.mord { max-height: 168px; overflow: auto; border-top: 1px solid var(--border); }
.mordrow { display: flex; align-items: center; gap: 5px; padding: 2px 6px; border-bottom: 1px solid var(--border); font-size: 12px; }
.mordrow .oi { flex: none; width: 15px; text-align: center; font-size: 10.5px; color: var(--text-muted); border: 1px solid var(--border-strong); }
.mordrow .mn { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mordrow .lop:disabled { opacity: .3; cursor: default; }
.mright { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.mprevh { display: flex; align-items: center; gap: 8px; padding: 4px 10px; border-bottom: 1px solid var(--border); background: var(--surface); font-size: 11.5px; color: var(--text-muted); }
.mprev { flex: 1; overflow: auto; background: var(--surface-2); padding: 10px; }
/* 预览按框宽实排（不缩放），故 SVG 原尺寸落进来即可 */
.mprevin :deep(svg) { display: block; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.18); }
.mfoot { display: flex; align-items: center; gap: 8px; padding: 7px 12px; border-top: 1px solid var(--border-strong); background: var(--surface); }
.mfoot .ttl { flex: 1; min-width: 0; }
.mfoot .ttl .ci { flex: 1; min-width: 0; }
.ddsep { height: 1px; background: var(--border); margin: 3px 0; }
</style>
