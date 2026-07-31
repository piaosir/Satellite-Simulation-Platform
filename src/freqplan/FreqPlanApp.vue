<script setup>
// 转发器频率计划工作台（独立窗口）。
//
// 归属：频率计划挂在【卫星】下、与 GRD 天线平级，因此左栏按卫星分组——与覆盖分析那棵卫星树同源
// （shared/freqPlanSats 直读 localStorage，同 origin 无需 IPC）。
//
// 版式沿用平台既定范式：左列表（主从）· 中主体（图 + 页签）· 右检查器，同屏一个上下文。
// 存盘策略是「改即存」（debounce 600ms）——频率计划是「文件」不是「会话」，所以不设关窗守卫。
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import {
  newPlan, normalizePlan, newChannel, newLo, newBeam, genSeries, validatePlan, errorCount,
  resolveChannel, resolveAll, planSummary, POLS, POL_LABEL, CHANNEL_KINDS, KIND_LABEL,
  DEFAULT_BEAM_COLORS, POL_ORTHO, guessBand, BANDS, beamLabel, bwFromMHz, bwToMHz, FREQ_UNITS, DEFAULT_BW_MHZ,
  uplinkBw, planExtent, cleanFreq,
  setChannelFc, setDnDecoupled, isDnLinked, loValueOf, dnFromUp, upFromDn,
  channelEdges, setChannelEdge
} from '../shared/freqPlanModel.js'
import { loadSatNodes, satLabel } from '../shared/freqPlanSats.js'
import { num as parseNum } from '../shared/num.js'   // 全角容错：中文输入法下的全角数字也能落值
import { toPngDataUrl, toPdfDataUrl, toSvgText, toPngDataUrlMulti, toPdfDataUrlMulti, toSvgTextMulti } from './fpExport.js'
import { toSvgMulti } from '../shared/freqPlanRender.js'
import FpChart from './FpChart.vue'
import FpCapacity from './FpCapacity.vue'
import BeamPicker from './BeamPicker.vue'
import Icon from '../components/Icon.vue'

const api = typeof window !== 'undefined' ? window.api : null

// ---- 状态 ----
const index = ref([])              // 计划索引（左栏）
const plan = ref(null)             // 当前打开的计划全文
const currentId = ref('')
const selectedId = ref('')         // 选中通道
const tab = ref('table')           // table | capacity | check
const carriers = ref([])           // 容量规划的载波（随计划走，存在计划里）
const msg = ref('')
const busy = ref('')
const confirmMsg = ref('')
let _confirmResolve = null
const chartWrap = ref(null)
const chartW = ref(1240)

// 左右两栏宽度：右栏默认给足（转发器参数是两列、波束那组三个控件一行，旧的 316px 挤成一团）；
// 左栏也可拖（卫星名 + 轨位 + 缩进后的计划名，236px 常不够）。两个手柄都骑在分界线上
// （0 宽轨 + 负边距），不占版面；现调现存。
const LEFT_W_MIN = 190, LEFT_W_MAX = 460
const RIGHT_W_MIN = 260, RIGHT_W_MAX = 760
const clampW = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const leftW = ref(clampW(Number(localStorage.getItem('freqplan/leftWidth')) || 250, LEFT_W_MIN, LEFT_W_MAX))
const rightW = ref(clampW(Number(localStorage.getItem('freqplan/rightWidth')) || 396, RIGHT_W_MIN, RIGHT_W_MAX))
const resizing = ref('')
function startResize(side, e) {
  const box = side === 'left' ? leftW : rightW
  const [lo, hi] = side === 'left' ? [LEFT_W_MIN, LEFT_W_MAX] : [RIGHT_W_MIN, RIGHT_W_MAX]
  const startX = e.clientX, startW = box.value
  resizing.value = side; document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'
  // 右栏的手柄在栏的左缘，往左拖 = 变宽，故取负号；左栏相反
  const move = (ev) => { box.value = clampW(startW + (ev.clientX - startX) * (side === 'left' ? 1 : -1), lo, hi) }
  const up = () => {
    resizing.value = ''; document.body.style.cursor = ''; document.body.style.userSelect = ''
    window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up)
    try { localStorage.setItem(`freqplan/${side}Width`, String(box.value)) } catch (e2) { /* ignore */ }
  }
  window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
}

// 图的显示选项。只留单位与字号两项 —— 频率标注 / 图例 / LO / 断轴曾各有一个工具栏开关，
// 但没人会去关（一张频率计划图缺了标注或图例就不成图了），四个常开的勾占着工具栏还添歧义。
// 现在不写进 opt，layout/toSvg 各自按 DEFAULT_STYLE 取 true；渲染层的这四个开关保留（供导出
// 与 core 测试用），只是界面不再暴露。
const opt = ref({ unit: 'MHz', fontSize: 12 })
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
    // 载波跟着计划走（容量规划是这份计划的一部分，分开存会出现「计划改了载波还挂在旧转发器上」）
    const r = await api.freqPlan.save({ ...JSON.parse(JSON.stringify(plan.value)), id: currentId.value, carriers: JSON.parse(JSON.stringify(carriers.value)) })
    if (r?.ok) { dirty = false; await loadIndex() }
  } catch (e) { flash('保存失败：' + e.message) }
}
// 深监听：图/表/检查器三处都直接改 plan，逐处调 scheduleSave 迟早漏
watch(plan, () => { if (plan.value && !loading) scheduleSave() }, { deep: true })
watch(carriers, () => { if (plan.value && !loading) scheduleSave() }, { deep: true })

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
const rowsResolved = computed(() => (plan.value ? resolveAll(plan.value) : []))
const issues = computed(() => (plan.value ? validatePlan(plan.value) : []))
const errCount = computed(() => errorCount(issues.value))

function addChannel() {
  if (!plan.value) return
  const last = plan.value.channels[plan.value.channels.length - 1]
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
  plan.value.channels = plan.value.channels.filter((c) => c.id !== id)
  if (selectedId.value === id) selectedId.value = plan.value.channels[0]?.id || ''
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
// 该转发器从所属「波束/带宽」组继承来的带宽——带宽输入框留空时以灰字占位显示
function groupBw(ch) {
  // 多波束时取第一个给了标称带宽的波束 —— 与 uplinkBw 的继承口径一致
  const b = (ch.beamUpIds || []).map((id) => plan.value?.beams.find((x) => x.id === id))
    .find((x) => Number.isFinite(x?.bwMHz))
  return Number.isFinite(b?.bwMHz) ? String(b.bwMHz) : ''
}
function setNum(obj, key, v) {
  obj[key] = parseNum(v)
}

// ---- 上下行联动（等式与口径都在 freqPlanModel 那一段，这里只是接线）----
// 三处频率录入（表 / 检查器 / 批量生成）全走 setFc：LO 确定时改哪一边另一边都跟着变。
const setFc = (ch, side, v) => setChannelFc(plan.value, ch, side, v)
// 下行框里显示的数：联动态下它就是这条转发器的下行频率（由等式给出），不再是「灰字占位提示」。
// ★ 不四舍五入到 2 位：窄带计划里 0.01 MHz 以下是有效信息，而回写一个舍过的数会把正在敲的字改掉。
const dnDisp = (r) => (r?.dn ? r.dn.fc : '')
const dnLinked = (ch) => isDnLinked(plan.value, ch)
// 解耦态：挂着 LO 却又显式填了下行（cross-strap / 下行重排）——此时两侧各改各的，界面上要说清楚
const dnCut = (ch) => plan.value && loValueOf(plan.value, ch) != null && Number.isFinite(ch?.dn?.fcMHz)
const setCut = (ch, off) => setDnDecoupled(plan.value, ch, off)

// ---- 起止频率（频带两端）----
//
// 等式与四条分支都在 freqPlanModel 那一段，这里只管录入手感。
// ★ 与「中心 / 带宽」两格不同，这两格【不即时落值】：起止是相互约束的一对，敲到一半的前缀在等式里
//   同样成立 —— 把 14040 改成 14100 的中途会经过 141，即时落值先把带宽算成 13899 那样的荒唐数，
//   下一次按键又正好落在「越过另一端」那条分支上，整条转发器就被那个中间值定死。故走草稿 ref，
//   回车 / 离焦（change）才提交，与工具栏缩放那格同一套做法。
// 一次只可能有一格在编辑，草稿因此只存一份：{ 哪一格, 正在敲的字 }。
const edgeDraft = ref({ k: '', v: '' })
const edgeKey = (side, which) => `${side}.${which}`
const clearEdgeDraft = () => { edgeDraft.value = { k: '', v: '' } }
const selEdges = (side) => channelEdges(plan.value, selected.value, side)
function edgeVal(side, which) {
  if (edgeDraft.value.k === edgeKey(side, which)) return edgeDraft.value.v
  const e = selEdges(side)
  const x = which === 'f1' ? e.f1 : e.f2
  return x == null ? '' : x                    // 带宽未定 → 两端无从谈起，空着（占位字提示这格是哪一端）
}
const edgeInput = (side, which, v) => { edgeDraft.value = { k: edgeKey(side, which), v } }
function commitEdge(side, which, v) {
  const mode = setChannelEdge(plan.value, selected.value, side, which, v)
  clearEdgeDraft()                             // 清草稿 = 回到由中心/带宽算出的读数（没落值的输入也就被弹回）
  if (mode === 'shift') {
    flash(`${which === 'f1' ? '起始越过终止' : '终止越过起始'} —— 已按「带宽不变、整条频带平移」处理`)
  }
}
// 换一条转发器时丢掉没提交的字，免得它跟到下一条身上
watch(selectedId, clearEdgeDraft)
// 说明写全：「改一端另一端钉住」是这两格与中心频率的全部区别，不写清人只会把它们当两个只读读数
function edgeTitle(side, which) {
  const self = which === 'f1' ? '起始' : '终止'
  const other = which === 'f1' ? '终止' : '起始'
  const bwUndef = selEdges(side).bw == null
  return `${side === 'up' ? '上行' : '下行'}频带${which === 'f1' ? '下' : '上'}边沿。`
    + `改这里${other}钉住，中心与带宽一并重算（中心 =（起 + 止）/ 2 · 带宽 = 止 − 起）；`
    + `${self}越过${other}时改按「带宽不变、整条频带平移」处理。回车或离焦落值。`
    + (bwUndef ? '当前带宽未定 —— 此时改为中心钉住、由这一端定出带宽。'
      : '带宽随之落成本转发器自填值（不再随波束/带宽组）。')
    + (side === 'dn' && dnLinked(selected.value) ? '下行与 LO 联动：上行随等式反解，带宽两侧同宽故落在上行。' : '')
}

// 表上 LO 那格只写得下名字（列宽就那么点），数值补在 title 里
function loTitle(ch) {
  const l = plan.value?.los.find((x) => x.id === ch.loId)
  return l ? `${l.name}：${l.valueMHz ?? '—'} MHz` : '未挂 LO —— 上下行各自独立'
}
function sortChannels() {
  if (!plan.value) return
  plan.value.channels.sort((a, b) => (a.up.fcMHz ?? a.dn.fcMHz ?? 0) - (b.up.fcMHz ?? b.dn.fcMHz ?? 0))
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
const batch = ref({ bwMHz: '', shiftMHz: '', noPattern: 'C{n}', noStart: 1 })
const beamPop = ref('')                // '' | 'up' | 'dn'：波束批量赋值的浮层
const batchBeamIds = ref([])

function eachChecked(label, fn) {
  const list = checkedChannels.value
  if (!list.length) return
  list.forEach(fn)
  flash(`${list.length} 个转发器：${label}`)
}
function batchSet(key) {
  const v = bsel.value[key]
  if (v) {
    if (key === 'kind') eachChecked(`类型 → ${KIND_LABEL[v] || v}`, (c) => { c.kind = v })
    else if (key === 'upPol') eachChecked(`上行极化 → ${v}`, (c) => { c.up.pol = v })
    // 「正交」不是一个极化值而是一条规则：逐条按各自的上行取正交（同频复用的 B 面正是这么排的）
    else if (key === 'dnPol') {
      eachChecked(v === 'ortho' ? '下行极化 → 随上行取正交' : `下行极化 → ${v}`,
        (c) => { c.dn.pol = v === 'ortho' ? (POL_ORTHO[c.up.pol] || 'V') : v })
    } else if (key === 'lo') {
      const id = v === NO_LO ? '' : v
      const nm = id ? (plan.value?.los.find((l) => l.id === id)?.name || 'LO') : '不挂 LO'
      eachChecked(`本振 → ${nm}`, (c) => { c.loId = id })
    }
  }
  bsel.value[key] = ''                 // 动作不留痕：弹回「—」
}
// 带宽：填了数 = 各条单独指定；清 = 回到「随所属波束组的标称值」（与单行留空同一口径）
const batchBwOk = computed(() => Number.isFinite(parseNum(batch.value.bwMHz)))
function batchBw(clear) {
  if (clear) { eachChecked('带宽已清空（随波束组）', (c) => { c.up.bwMHz = null }); return }
  const v = parseNum(batch.value.bwMHz)
  if (v == null) return
  eachChecked(`带宽 → ${v} MHz`, (c) => { c.up.bwMHz = v })
}
// 频率平移：整条频带一起挪。联动态的下行由等式给出（不用动它），解耦态的下行不跟上行走，得自己挪一次
const batchShiftOk = computed(() => { const d = parseNum(batch.value.shiftMHz); return d != null && d !== 0 })
function batchShift() {
  const d = parseNum(batch.value.shiftMHz)
  if (d == null || !d) return
  eachChecked(`频率平移 ${d > 0 ? '+' : ''}${d} MHz`, (c) => {
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
    (c) => { if (side === 'up') c.beamUpIds = [...ids]; else c.beamDnIds = [...ids] })
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
  const b = parseNum(gen.value.bwMHz)
  if (Number.isFinite(b)) return b
  for (const id of gen.value.beamUpIds || []) {
    const bm = plan.value?.beams.find((x) => x.id === id)
    if (Number.isFinite(bm?.bwMHz)) return bm.bwMHz
  }
  return null
})
const genHalfBw = computed(() => (Number.isFinite(genBw.value) ? genBw.value / 2 : 0))
// 上下行两侧填的都是边沿：整条频带平移 LO，边沿之差与中心之差是同一个数，故仍走同一条等式
const genDnStart = computed(() => dnFromUp(parseNum(gen.value.startFMHz), genLo.value) ?? '')
function setGenDnStart(v) {
  if (genLo.value == null) return
  const x = parseNum(v)
  gen.value.startFMHz = x == null ? '' : upFromDn(x, genLo.value)
}
function runGen() {
  if (!plan.value) return
  // 带宽留空 → null（各通道随所属波束/带宽组走）。不能写成 Number('')，那会变成 0 宽转发器
  const bw = parseNum(gen.value.bwMHz)
  const startF = parseNum(gen.value.startFMHz) ?? 0
  const chs = genSeries({
    ...gen.value, count: parseNum(gen.value.count) || 0,
    startFcMHz: cleanFreq(startF + genHalfBw.value),   // 录入的是边沿，模型收的是中心
    stepMHz: parseNum(gen.value.stepMHz) ?? 0, bwMHz: bw, noStart: parseNum(gen.value.noStart) || 1,
    dnPol: gen.value.dnPolMode === 'same' ? gen.value.pol : null   // 模型收的是极化字母；null = 由它取正交
  })
  if (!chs.length) { flash('数量为 0'); return }
  plan.value.channels.push(...chs)
  selectedId.value = chs[0].id
  // 频段不在这儿设：自动档由 autoBand 那个监听按新的频率刷新，手选档则原样保留（见「---- 频段 ----」）
  flash(`已生成 ${chs.length} 个转发器`)
}

// ---- LO / 波束 ----
function addLo() { plan.value?.los.push(newLo({ name: `LO${(plan.value.los.length || 0) + 1}`, valueMHz: null })) }
function removeLo(id) {
  if (!plan.value) return
  plan.value.los = plan.value.los.filter((l) => l.id !== id)
  for (const c of plan.value.channels) if (c.loId === id) c.loId = ''
}
function addBeam() {
  const i = plan.value?.beams.length || 0
  // 带宽默认跟上一条（一份计划里多半是同一档带宽的几个波束）；上一条也没填就给 36 MHz 兜底
  const prev = plan.value?.beams[i - 1]
  plan.value?.beams.push(newBeam({
    name: `Beam ${i + 1}`,          // 波束名直接进图例，默认名走英文（人改中文名照画中文）
    color: DEFAULT_BEAM_COLORS[i % DEFAULT_BEAM_COLORS.length],
    bwMHz: Number.isFinite(prev?.bwMHz) ? prev.bwMHz : DEFAULT_BW_MHZ
  }))
}
// 带宽录入：显示按工具栏那一个单位、存进去一律 MHz。换单位只换刻度不动物理量，
// 故切 kHz/MHz/GHz 时数值自动改写（36 MHz ⇄ 36000 kHz），计划本身不变。
const beamBwDisp = (b) => { const v = bwFromMHz(b.bwMHz, opt.value.unit); return v == null ? '' : v }
function setBeamBw(b, v) { b.bwMHz = bwToMHz(v, opt.value.unit) }
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
    } else if (kind === 'svg') payload = composite ? toSvgTextMulti(list, style) : toSvgText(plan.value, style)
    else if (kind === 'pdf') payload = composite ? await toPdfDataUrlMulti(list, style) : await toPdfDataUrl(plan.value, style)
    else if (composite) {
      payload = await toPngDataUrlMulti(list, style, png, (sc) => { note = `（纸面过大，倍率已降到 ${sc}×）` })
    } else payload = await toPngDataUrl(plan.value, style, png)
    const ext = kind === 'json' ? 'json' : kind === 'svg' ? 'svg' : kind === 'pdf' ? 'pdf' : 'png'
    const r = await api.freqPlan.exportFile(ext, payload, opts.name || plan.value?.name || 'Frequency Plan')
    if (r?.canceled) return r
    flash(r?.ok ? '已导出：' + r.filePath + note : '导出失败：' + (r?.error || '未知错误'))
    return r
  } catch (e) { flash('导出失败：' + e.message); return null } finally { busy.value = '' }
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
  // 从文件区双击某份计划进来
  api?.freqPlan?.onOpenPlan?.((id) => { if (id) openPlan(id) })
  // 窗口失焦/关闭前把待存的落盘（debounce 尾巴不能丢）
  window.addEventListener('beforeunload', () => { if (dirty) doSave() })
})
watch(tab, () => nextTick(measure))
watch([leftW, rightW], () => nextTick(measure))   // 左右栏拖宽 = 中栏变窄，图跟着重算宽度
</script>

<template>
  <div class="fp">
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
          <button @click="openMerge" title="多选几份计划（一颗星的 C / Ku / Ka 各一份），自上而下叠成一张完整的频率计划">合成导出（多份）…</button>
        </div>
      </div>
      <span class="spacer"></span>
      <select class="ci nar" v-model="opt.unit" title="全图共用的单位：频率标注、图例带宽、波束那组的带宽录入都按这个刻度写。只换刻度，不改任何物理量">
        <option v-for="u in FREQ_UNITS" :key="u" :value="u">{{ u }}</option>
      </select>
      <label class="fld">图字号 <input class="ci num xnar" type="number" v-model.number="opt.fontSize" min="8" max="22" /></label>
      <label class="fld" title="10~800%，回车或离焦生效；Ctrl+滚轮同效。只放大屏上显示，导出倍率在「导出」菜单里选">缩放
        <input class="ci num xnar" :value="zoomPct" @input="zoomPct = $event.target.value"
          @change="commitZoom" @keydown.enter="commitZoom" /><span class="pct">%</span>
      </label>
      <span v-if="busy" class="busy">{{ busy }}</span>
    </header>
    <div v-if="msg" class="msg">{{ msg }}</div>

    <div class="body" :style="{ gridTemplateColumns: plan ? `${leftW}px 0px minmax(0,1fr) 0px ${rightW}px` : `${leftW}px 0px minmax(0,1fr)` }">
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
          <div v-if="!satNodes.length" class="lnone">
            卫星树为空 — 频率计划挂在卫星下（与 GRD 天线平级）。请先到主窗口「星座地图 3D · 覆盖分析」或「文件管理 · GRD 天线」添加卫星。
          </div>
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
              <!-- 二级：该星下的计划 -->
              <div class="kids" v-show="isOpen(g)">
                <div v-for="e in g.items" :key="e.id" class="li" :class="{ on: e.id === currentId }" :data-id="e.id" @click="openPlan(e.id)">
                  <div class="ln" :title="e.name">{{ shortName(e, g) }}</div>
                  <div class="lm">{{ e.band }} · {{ e.transponderCount }} 转发器<template v-if="e.beamCount"> · {{ e.beamCount }} 波束</template></div>
                  <div class="lops" @click.stop>
                    <button class="lop" title="复制" @click="duplicatePlan(e)"><Icon name="copy" :size="11" /></button>
                    <button class="lop del" title="删除" @click="removePlan(e)"><Icon name="trash" :size="11" /></button>
                  </div>
                </div>
              </div>
            </section>
            <div v-if="q && !shown" class="lnone">只匹配到卫星名，这些星下还没有频率计划——在卫星行右端点 ＋ 建一份。</div>
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
          <p class="dim">左栏「计划库」按卫星分层：点计划名打开；在卫星名右端点 <Icon name="plus" :size="11" /> 为那颗星新建一份。</p>
          <p class="dim">新建后用右侧「批量生成」按「起始频率 + 频率间隔 + 数量」铺一排转发器。</p>
        </div>
        <template v-else>
          <div class="chartbox" ref="chartWrap" @wheel="onWheelZoom">
            <FpChart :plan="plan" :selected-id="selectedId" :chart-style="opt" :width="chartW" :zoom="zoom"
              @select="selectedId = $event" />
          </div>

          <div class="tabs">
            <button class="tb-b" :class="{ on: tab === 'table' }" @click="tab = 'table'">转发器表 <i>{{ plan.channels.length }}</i></button>
            <button class="tb-b" :class="{ on: tab === 'capacity' }" @click="tab = 'capacity'">容量规划 <i v-if="carriers.length">{{ carriers.length }}</i></button>
            <button class="tb-b" :class="{ on: tab === 'check' }" @click="tab = 'check'">校验 <i v-if="issues.length" :class="{ bad: errCount }">{{ issues.length }}</i></button>
            <span class="spacer"></span>
            <template v-if="tab === 'table'">
              <!-- 拖选是这张表最省手的入口，但手势本身不可见 —— 没勾选时在这里写一句，勾上了就换成批量条 -->
              <span v-if="!checkedCount && plan.channels.length" class="hint">左端行号列按住划过几行 = 批量改</span>
              <button class="mini" @click="addChannel"><Icon name="plus" :size="12" /> 转发器</button>
              <button class="mini ghost" @click="sortChannels" title="按上行频率升序重排">排序</button>
            </template>
          </div>

          <div class="tabbody">
            <!-- 批量条：勾了才浮出。作用域写在最左边（「已选 N 个」），条上每一项选完即施加到这 N 条 -->
            <div v-if="tab === 'table' && checkedCount" class="bbar">
              <span class="bn">已选 <b>{{ checkedCount }}</b> 个</span>
              <button class="mini ghost xs" @click="clearChecked" title="取消全部勾选">取消选择</button>
              <span class="bsep"></span>

              <!-- 这四个下拉不另配文字标签：占位项本身就是标签（「类型…」），选完即施加、随即弹回。
                   一条批量条上七八组控件，每组再前置两三个字，窄栏下能折成三行 -->
              <select class="ci bsl" v-model="bsel.kind" @change="batchSet('kind')" title="把已选转发器的类型统一改成…">
                <option value="">类型…</option>
                <option v-for="k in CHANNEL_KINDS" :key="k.key" :value="k.key">{{ k.label }}</option>
              </select>
              <select class="ci bsl" v-model="bsel.upPol" @change="batchSet('upPol')" title="把已选转发器的上行极化统一改成…">
                <option value="">上行极化…</option>
                <option v-for="p in POLS" :key="p" :value="p">{{ POL_LABEL[p] }}</option>
              </select>
              <select class="ci bsl" v-model="bsel.dnPol" @change="batchSet('dnPol')" title="把已选转发器的下行极化统一改成…">
                <option value="">下行极化…</option>
                <option value="ortho">逐条取上行的正交</option>
                <option v-for="p in POLS" :key="p" :value="p">{{ POL_LABEL[p] }}</option>
              </select>
              <select class="ci bsl" v-model="bsel.lo" @change="batchSet('lo')" title="把已选转发器挂到同一个本振上（下行随之按等式重算）">
                <option value="">本振 LO…</option>
                <option :value="NO_LO">不挂 LO</option>
                <option v-for="l in plan.los" :key="l.id" :value="l.id">{{ l.name }} · {{ l.valueMHz ?? '—' }} MHz</option>
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

              <label class="fld" title="填值 = 这 N 条各自单独指定带宽；「清」= 回到随所属波束组的标称值">带宽
                <input class="ci num xnar" v-model="batch.bwMHz" placeholder="MHz" @keydown.enter="batchBw(false)" />
              </label>
              <button class="mini ghost xs" :disabled="!batchBwOk" @click="batchBw(false)">应用</button>
              <button class="mini ghost xs" @click="batchBw(true)" title="清空带宽 = 随所属波束组的标称值">清</button>
              <label class="fld" title="整条频带一起挪：联动态的下行由 LO 等式跟着走，解耦态的下行同量平移">平移
                <input class="ci num xnar" v-model="batch.shiftMHz" placeholder="±MHz" @keydown.enter="batchShift" />
              </label>
              <button class="mini ghost xs" :disabled="!batchShiftOk" @click="batchShift">应用</button>
              <label class="fld" title="按表上的先后顺次给号；{n} 处替换为序号">编号
                <input class="ci xnar" v-model="batch.noPattern" @keydown.enter="batchRenumber" />
                <input class="ci num xxnar" v-model="batch.noStart" title="起始序号" @keydown.enter="batchRenumber" />
              </label>
              <button class="mini ghost xs" @click="batchRenumber">重编号</button>
              <span class="bsep"></span>

              <button class="mini ghost" @click="batchDuplicate" title="复制这 N 条到表尾，勾选随之转到副本上（接着整批改极化/频率即为 B 面）">
                <Icon name="copy" :size="12" /> 复制
              </button>
              <button class="mini ghost bdel" @click="batchRemove"><Icon name="trash" :size="12" /> 删除</button>
            </div>

            <!-- 转发器表 -->
            <div v-if="tab === 'table'" class="tscroll" ref="tblScroll">
              <table class="t" :class="{ dragsel: dragging }">
                <thead>
                  <tr>
                    <!-- 波束两列：一列贴上行、一列贴下行。多波束是分方向的（几个波束收、一个波束发是常态），
                         并成一列就只能两边一样多 —— 各自落在自己那组字段旁边，读表时不必再想它管的是哪一侧 -->
                    <th class="ck">
                      <input type="checkbox" :checked="allChecked" :indeterminate="someChecked"
                        :disabled="!plan.channels.length" @change="toggleCheckAll"
                        title="全选 / 全不选" />
                    </th>
                    <th>编号</th><th>类型</th><th>上行中心 MHz</th><th>带宽 MHz</th><th>极化</th><th>上行波束</th>
                    <th>LO</th><th>下行中心 MHz</th><th>极化</th><th>下行波束</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(ch, i) in plan.channels" :key="ch.id" :data-idx="i"
                    :class="{ on: ch.id === selectedId, ckd: isChecked(ch.id) }" @click="selectedId = ch.id">
                    <!-- 行头槽：按住往下划即整片选中（Excel 行头那套）。勾选 = 批量作用域，
                         点行身 = 送进右栏检查器，两件事，故这一格不往上冒泡 -->
                    <td class="ck" @click.stop @mousedown="gutterDown(i, $event)"
                      title="按住往下（或往上）划 = 连选一片；单击 = 只选这一行；Shift 单击 = 从上次那行连选到这行">
                      <input type="checkbox" :checked="isChecked(ch.id)" @change.stop="toggleCheck(ch, $event)" />
                      <i class="rn">{{ i + 1 }}</i>
                    </td>
                    <td><input class="ci nar" v-model="ch.no" @click.stop /></td>
                    <td>
                      <select class="ci selc selkind" v-model="ch.kind" @click.stop>
                        <option v-for="k in CHANNEL_KINDS" :key="k.key" :value="k.key">{{ k.label }}</option>
                      </select>
                    </td>
                    <td><input class="ci num" :value="ch.up.fcMHz ?? ''" @input="setFc(ch, 'up', $event.target.value)" @click.stop
                      :title="dnLinked(ch) ? '与下行由 LO 联动：改这里下行跟着变' : ''" /></td>
                    <td class="dnum"><input class="ci num nar" :value="ch.up.bwMHz ?? ''" :placeholder="groupBw(ch)"
                      @input="setNum(ch.up, 'bwMHz', $event.target.value)" @click.stop
                      title="留空 = 取所属波束/带宽组的标称值（灰字为继承值）；填值 = 本转发器单独指定" /></td>
                    <td><select class="ci selc selpol" v-model="ch.up.pol" @click.stop :title="POL_LABEL[ch.up.pol]"><option v-for="p in POLS" :key="p" :value="p">{{ p }}</option></select></td>
                    <td>
                      <BeamPicker mode="chips" :beams="plan.beams" :unit="opt.unit" v-model="ch.beamUpIds" />
                    </td>
                    <td>
                      <!-- 这格只写得下 LO 名，数值放进 title（几个 LO 重名时也就这一处分得清） -->
                      <select class="ci selc sello" v-model="ch.loId" @click.stop :title="loTitle(ch)">
                        <option value="">—</option>
                        <option v-for="l in plan.los" :key="l.id" :value="l.id">{{ l.name }}</option>
                      </select>
                    </td>
                    <!-- 下行不再是「灰字占位的推算值」：LO 定了它就是可直接录的一侧，录进去上行反解跟着变 -->
                    <td class="dnum">
                      <div class="lkc">
                        <input class="ci num" :value="dnDisp(rowsResolved[i])" @click.stop
                          @input="setFc(ch, 'dn', $event.target.value)"
                          :title="dnLinked(ch) ? '与上行由 LO 联动：f下 = f上 − LO —— 改这里上行跟着变'
                            : (dnCut(ch) ? '下行已与 LO 解耦（cross-strap）：两侧各填各的。点右侧图标按 LO 重新联动'
                              : '未挂 LO —— 上下行各自独立；在左边 LO 列选一个即可联动')" />
                        <button v-if="dnCut(ch)" class="lkb" title="下行已与 LO 解耦（cross-strap）—— 点击按 LO 重新联动"
                          @click.stop="setCut(ch, false)"><Icon name="unlink-2" :size="11" /></button>
                      </div>
                    </td>
                    <td><select class="ci selc selpol" v-model="ch.dn.pol" @click.stop :title="POL_LABEL[ch.dn.pol]"><option v-for="p in POLS" :key="p" :value="p">{{ p }}</option></select></td>
                    <td>
                      <!-- 留空 = 随上行（灰色片示意），与带宽/下行频率两格的灰字继承值同一套读法 -->
                      <BeamPicker mode="chips" :beams="plan.beams" :unit="opt.unit" v-model="ch.beamDnIds" :inherit="ch.beamUpIds" />
                    </td>
                    <td class="ops" @click.stop>
                      <button class="lop" title="复制" @click="duplicateChannel(ch.id)"><Icon name="copy" :size="11" /></button>
                      <button class="lop del" title="删除" @click="removeChannel(ch.id)"><Icon name="x" :size="11" /></button>
                    </td>
                  </tr>
                </tbody>
              </table>
              <div v-if="!plan.channels.length" class="none">
                还没有转发器。用右侧「批量生成」按「起始频率 + 频率间隔 + 数量」一次铺一排，或点上方「转发器」逐个加。
              </div>
            </div>

            <!-- 容量规划 -->
            <FpCapacity v-else-if="tab === 'capacity'" :plan="plan" :carriers="carriers"
              @update:carriers="carriers = $event" @select-channel="selectedId = $event" />

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

      <!-- 中/右分界上的拖宽手柄 -->
      <div class="rz" :class="{ on: resizing === 'right' }" v-if="plan" title="拖动调整设置栏宽度"
        @mousedown.prevent="startResize('right', $event)"></div>

      <!-- 右：检查器 -->
      <aside class="right" v-if="plan">
        <div class="sec">
          <div class="sh">计划</div>
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
            <select class="ci" v-model="bandPick" title="自动 = 按图上最低的那个频率判定，改频率时跟着变；手选 = 钉死这个段名（频段只用于汇总与列表说明，不参与作图与校验）">
              <option value="">自动（{{ autoBand }}）</option>
              <option v-for="b in BANDS" :key="b" :value="b">{{ b }}</option>
            </select>
          </label>
          <div class="sum">{{ planSummary(plan) }}</div>
        </div>

        <div class="sec" v-if="selected">
          <div class="sh">转发器 {{ selected.no || '—' }}</div>
          <label class="row"><span>编号</span><input class="ci nar" v-model="selected.no" /></label>
          <label class="row"><span>类型</span>
            <select class="ci" v-model="selected.kind"><option v-for="k in CHANNEL_KINDS" :key="k.key" :value="k.key">{{ k.label }}</option></select>
          </label>
          <label class="row"><span>上行中心频率 MHz</span><input class="ci num" :value="selected.up.fcMHz ?? ''" @input="setFc(selected, 'up', $event.target.value)" /></label>
          <label class="row"><span>转发器带宽 MHz</span>
            <input class="ci num" :value="selected.up.bwMHz ?? ''" :placeholder="groupBw(selected) ? groupBw(selected) + '（本组）' : ''"
              @input="setNum(selected.up, 'bwMHz', $event.target.value)"
              title="留空 = 取所属波束/带宽组的标称值（灰字为继承值）；填值 = 本转发器单独指定" />
          </label>
          <!-- 起止：与上面两格是同一段频带的两种写法（中心 + 带宽 ⇄ 起始 + 终止）。手上的计划表多半
               直接给频带两端，照着录进去比让人先自己减掉半个带宽直白；改一端另一端钉住，中心与
               带宽一并重算（口径与四条分支见 freqPlanModel 的「频带两端」那一段） -->
          <div class="row"><span>上行起止 MHz</span>
            <input class="ci num" :value="edgeVal('up', 'f1')" placeholder="起始" :title="edgeTitle('up', 'f1')"
              @input="edgeInput('up', 'f1', $event.target.value)" @change="commitEdge('up', 'f1', $event.target.value)" />
            <span class="tw">~</span>
            <input class="ci num" :value="edgeVal('up', 'f2')" placeholder="终止" :title="edgeTitle('up', 'f2')"
              @input="edgeInput('up', 'f2', $event.target.value)" @change="commitEdge('up', 'f2', $event.target.value)" />
          </div>
          <label class="row"><span>上行极化</span>
            <select class="ci" v-model="selected.up.pol"><option v-for="p in POLS" :key="p" :value="p">{{ POL_LABEL[p] }}</option></select>
          </label>
          <label class="row"><span>本振 LO</span>
            <select class="ci" v-model="selected.loId">
              <option value="">—</option>
              <option v-for="l in plan.los" :key="l.id" :value="l.id">{{ l.name }} · {{ l.valueMHz ?? '—' }} MHz</option>
            </select>
          </label>
          <label class="row"><span>下行中心频率 MHz</span>
            <input class="ci num" :value="dnDisp(selectedResolved)"
              :placeholder="dnLinked(selected) ? '' : '未挂 LO'"
              :title="dnLinked(selected) ? '与上行由 LO 联动：f下 = f上 − LO —— 改这里上行跟着变'
                : (dnCut(selected) ? '下行已与 LO 解耦（cross-strap）：两侧各填各的' : '未挂 LO —— 上下行各自独立')"
              @input="setFc(selected, 'dn', $event.target.value)" />
          </label>
          <label class="ck2" v-if="loValueOf(plan, selected) != null"
            :title="dnCut(selected) ? `下行按本行自填值，不再跟随上行（LO 推算值为 ${dnFromUp(selected.up.fcMHz, loValueOf(plan, selected)) ?? '—'} MHz）`
              : '勾选后下行与 LO 解耦，两侧各填各的'">
            <input type="checkbox" :checked="dnCut(selected)" @change="setCut(selected, $event.target.checked)" />
            <span>下行频率独立（cross-strap）</span>
          </label>
          <div class="row"><span>下行起止 MHz</span>
            <input class="ci num" :value="edgeVal('dn', 'f1')" placeholder="起始" :title="edgeTitle('dn', 'f1')"
              @input="edgeInput('dn', 'f1', $event.target.value)" @change="commitEdge('dn', 'f1', $event.target.value)" />
            <span class="tw">~</span>
            <input class="ci num" :value="edgeVal('dn', 'f2')" placeholder="终止" :title="edgeTitle('dn', 'f2')"
              @input="edgeInput('dn', 'f2', $event.target.value)" @change="commitEdge('dn', 'f2', $event.target.value)" />
          </div>
          <label class="row"><span>下行极化</span>
            <select class="ci" v-model="selected.dn.pol"><option v-for="p in POLS" :key="p" :value="p">{{ POL_LABEL[p] }}</option></select>
          </label>
          <div class="row top"><span>上行波束</span>
            <BeamPicker mode="list" :beams="plan.beams" :unit="opt.unit" v-model="selected.beamUpIds" />
          </div>
          <div class="row top" title="留空 = 与上行同一组；勾任意一个即单独指定"><span>下行波束</span>
            <BeamPicker mode="list" :beams="plan.beams" :unit="opt.unit" v-model="selected.beamDnIds" :inherit="selected.beamUpIds" />
          </div>
          <div class="sh sub" title="填了的项在链路预算引用本转发器时一并带过去；留空则沿用卫星配置里的值">转发器参数（可留空）</div>
          <!-- 名称与单位逐项对齐链路预算卫星栏（params.js 的 sfdRef / sfdGtRef / BOi / BOo /
               xpdrIntermodFactor），引用过去时一一落位，不再需要人脑做一次名词映射。 -->
          <div class="grid2">
            <label class="row2"><span>SFDref dBW/m²</span><input class="ci num" :value="selected.sfdDbwm2 ?? ''" @input="setNum(selected, 'sfdDbwm2', $event.target.value)" /></label>
            <label class="row2"><span>G/Tref dB/K</span><input class="ci num" :value="selected.gtDbK ?? ''" @input="setNum(selected, 'gtDbK', $event.target.value)" /></label>
            <label class="row2"><span>IBO dB</span><input class="ci num" :value="selected.boiDb ?? ''" @input="setNum(selected, 'boiDb', $event.target.value)" /></label>
            <label class="row2"><span>OBO dB</span><input class="ci num" :value="selected.booDb ?? ''" @input="setNum(selected, 'booDb', $event.target.value)" /></label>
            <label class="row2"><span>C/IM dB</span><input class="ci num" :value="selected.cimDb ?? ''" @input="setNum(selected, 'cimDb', $event.target.value)" /></label>
          </div>
        </div>

        <div class="sec">
          <div class="sh">本振 LO <button class="mini ghost xs" @click="addLo"><Icon name="plus" :size="10" /></button></div>
          <div v-for="l in plan.los" :key="l.id" class="lorow">
            <input class="ci nar" v-model="l.name" />
            <input class="ci num" :value="l.valueMHz ?? ''" @input="setNum(l, 'valueMHz', $event.target.value)" placeholder="MHz" />
            <button class="lop del" @click="removeLo(l.id)"><Icon name="x" :size="10" /></button>
          </div>
        </div>

        <div class="sec">
          <div class="sh" title="一行即图例上的一条：颜色 + 波束名 + 标称带宽">波束/带宽 <button class="mini ghost xs" @click="addBeam"><Icon name="plus" :size="10" /></button></div>
          <div v-for="b in plan.beams" :key="b.id" class="bmrow">
            <input class="clr" type="color" v-model="b.color" title="色块与图例的颜色" />
            <input class="ci" v-model="b.name" placeholder="波束名" />
            <input class="ci num bw" :value="beamBwDisp(b)" @input="setBeamBw(b, $event.target.value)"
              placeholder="不定" :title="`本组标称带宽（${opt.unit}）：转发器那行的带宽留空即取这个值`" />
            <span class="unit">{{ opt.unit }}</span>
            <button class="lop del" @click="removeBeam(b.id)"><Icon name="x" :size="10" /></button>
          </div>
        </div>

        <div class="sec">
          <div class="sh">批量生成</div>
          <div class="grid2">
            <label class="row2"><span>转发器数量</span><input class="ci num" v-model="gen.count" /></label>
            <label class="row2"><span>频率间隔 MHz</span><input class="ci num" v-model="gen.stepMHz" title="相邻转发器的中心频率之差（上下行相同）" /></label>
            <label class="row2"><span>上行起始频率 MHz</span>
              <input class="ci num" v-model="gen.startFMHz" title="第一个转发器上行频带的下边沿（不是中心频率）" />
            </label>
            <label class="row2"><span>下行起始频率 MHz</span>
              <input class="ci num" :value="genDnStart" :disabled="genLo == null" :placeholder="genLo == null ? '先选 LO' : ''"
                @input="setGenDnStart($event.target.value)"
                title="第一个转发器下行频带的下边沿。与上行起始频率由下面选的 LO 互算：填哪一侧都行，另一侧跟着变" />
            </label>
            <label class="row2"><span>转发器带宽 MHz</span><input class="ci num" v-model="gen.bwMHz" placeholder="随波束组" title="留空 = 取所选上行波束组的标称带宽" /></label>
          </div>
          <!-- 一排恒为同一个上行极化（见 gen 的注释）。第二个下拉管的是下行那一侧：批量生成过去
               一律把下行按正交铺，遇上「上下行同极化」的星就得回表里逐行改，故给在这儿选 -->
          <label class="row"><span>上行极化</span>
            <select class="ci nar" v-model="gen.pol"><option v-for="p in POLS" :key="p" :value="p">{{ p }}</option></select>
            <select class="ci" v-model="gen.dnPolMode" title="下行极化：正交 = 取上行的正交极化（转发器翻极化的常见接法）；同上行 = 上下行一个极化。生成后仍可在表里逐行改">
              <option value="">下行正交（{{ POL_ORTHO[gen.pol] || 'V' }}）</option>
              <option value="same">下行同极化（{{ gen.pol }}）</option>
            </select>
          </label>
          <label class="row"><span>编号规则</span><input class="ci nar" v-model="gen.noPattern" title="编号模板：{n} 处替换为序号" /><input class="ci num xnar" v-model="gen.noStart" title="起始序号" /></label>
          <label class="row"><span>本振 LO</span>
            <select class="ci" v-model="gen.loId"><option value="">—</option><option v-for="l in plan.los" :key="l.id" :value="l.id">{{ l.name }}</option></select>
          </label>
          <div class="row top"><span>上行波束</span>
            <BeamPicker mode="list" :beams="plan.beams" :unit="opt.unit" v-model="gen.beamUpIds" />
          </div>
          <div class="row top"><span>下行波束</span>
            <BeamPicker mode="list" :beams="plan.beams" :unit="opt.unit" v-model="gen.beamDnIds" :inherit="gen.beamUpIds" />
          </div>
          <button class="mini imp wide" @click="runGen">生成 {{ gen.count }} 个转发器</button>
        </div>
      </aside>
    </div>

    <!-- 合成导出：左选（勾 + 排序）· 右预览，底栏落标题与格式 -->
    <div v-if="mergeOpen" class="mask" @click.self="mergeOpen = false">
      <div class="mdlg">
        <div class="mh">
          <span class="mt">合成导出</span>
          <span class="dim mhs">多份计划自上而下叠成一张完整的频率计划——每段各带各的上下行频带与图例（原计划不动）</span>
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
                <span class="mn" :title="e.name">{{ e.name }}</span>
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
              <span class="dim">{{ mergePlans.length }} 段 · 导出恒为浅色</span>
              <span class="spacer"></span>
              <label class="ck" title="打开 = 全图一把尺子，同带宽跨频段同宽（便于横向比对）；关 = 每段各自铺满画布，段内更宽更清楚">
                <input type="checkbox" v-model="mergeShared" /> 统一比例尺
              </label>
              <label class="ck"><input type="checkbox" v-model="mergeSecTitles" /> 段头</label>
            </div>
            <div class="mprev" ref="prevBox">
              <div v-if="!mergePlans.length" class="mempty pad">勾选左侧的计划后在此预览。</div>
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
.left { border-right: 1px solid var(--border); display: flex; flex-direction: column; min-height: 0; }
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

.center { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.mnone { padding: 40px; color: var(--text-muted); }
.mnone .dim { color: var(--text-faint); font-size: 12.5px; }
.chartbox { padding: 10px 12px; border-bottom: 1px solid var(--border); overflow: auto; max-height: 52%; }
.tabs { display: flex; align-items: center; gap: 4px; padding: 4px 8px; border-bottom: 1px solid var(--border); background: var(--surface); }
.tb-b { font: inherit; font-size: 12.5px; padding: 3px 10px; border: 1px solid transparent; background: transparent; color: var(--text-muted); cursor: pointer; }
.tb-b.on { background: var(--bg); border-color: var(--border-strong); color: var(--text); }
.tb-b i { font-style: normal; font-size: 11px; color: var(--text-faint); margin-left: 3px; }
.tb-b i.bad { color: var(--danger); }
.hint { font-size: 11.5px; color: var(--text-faint); }
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

.t { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.t thead th { position: sticky; top: 0; z-index: 1; background: var(--surface); border-bottom: 1px solid var(--border-strong); padding: 4px 6px; text-align: left; font-weight: 600; white-space: nowrap; }
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

.right { border-left: 1px solid var(--border); overflow: auto; min-width: 0; }
/* 骑在分界线上：7px 命中区靠 ±3.5px 负边距抵消，净占 0，拖时高亮 */
.rz { width: 7px; margin: 0 -3.5px; position: relative; z-index: 6; cursor: col-resize; }
.rz:hover, .rz.on { background: var(--accent); opacity: .35; }
.sec { border-bottom: 1px solid var(--border); padding: 7px 9px 9px; }
.sh { font-size: 12px; font-weight: 600; color: var(--text); margin-bottom: 5px; display: flex; align-items: center; gap: 6px; }
.sh.sub { margin-top: 8px; color: var(--text-muted); font-weight: 500; }
.row { display: flex; align-items: center; gap: 6px; margin-bottom: 3px; }
/* 右侧是多行控件（波束多选那种）时标题贴顶，别把「上行波束」四个字吊在一列勾选框的正中 */
.row.top { align-items: flex-start; }
.row.top > span { padding-top: 4px; }
.row.top > :last-child { flex: 1; min-width: 0; }
/* 标题列按最长的那条（「上行中心频率 MHz」≈ 96px：宋体 6 个全角字 + Times 的「 MHz」）定宽，
   留一点余量并禁止折行——名称写全、单位跟在后面，字体回落变化时也不会掉成两行把整行撑高。 */
.row > span { flex: none; width: 104px; font-size: 11.5px; color: var(--text-muted); white-space: nowrap; }
/* 起止那行是两格输入夹一个「~」：这个波浪号是分隔符不是标题列，得从上面那条 104px 里摘出来 */
.row > span.tw { width: auto; padding: 0 1px; color: var(--text-faint); }
.row2 { display: flex; flex-direction: column; gap: 1px; }
.row2 > span { font-size: 11px; color: var(--text-muted); }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 3px 6px; margin-bottom: 4px; }
.sum { font-size: 11px; color: var(--text-faint); margin-top: 4px; }
/* 勾选行：左缩进对齐输入框那一列（104px 标题 + 6px 间距），不与上面几行的标题列错开 */
.ck2 { display: flex; align-items: center; gap: 5px; margin: 2px 0 3px 110px; font-size: 11.5px; color: var(--text-muted); cursor: pointer; }
.lorow, .bmrow { display: flex; align-items: center; gap: 4px; margin-bottom: 3px; }
.clr { width: 26px; height: 21px; flex: none; border: 1px solid var(--border); background: none; padding: 0; cursor: pointer; }
/* 波束一行一组：色块 · 名称 · 带宽 · 单位 —— 与图例条目「■ 中国波束：36 MHz」同序，照着填完
   就是图上那一条。代号那格已去掉（与波束名是同一件事），空出的宽度正好让这一组回到一行里。 */
.bmrow .bw { flex: none; width: 66px; }
/* 单位只是跟读工具栏那个下拉的静态标签（本行不再能各改各的），故是文字不是控件。
   「THz」在衬线 11.5px 下约 26px，给 34px 让五档都不换行、也不把带宽格挤窄。 */
.bmrow .unit { flex: none; width: 34px; font-size: 11.5px; color: var(--text-faint); }
.bmrow .bw::placeholder { color: var(--text-faint); font-style: italic; }

.ci { flex: 1; min-width: 0; background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 2px 4px; font: inherit; font-size: 12.5px; font-family: var(--font-serif); }
.ci:focus { border-color: var(--text); outline: none; }
.ci:disabled { background: var(--surface); color: var(--text-faint); cursor: not-allowed; }
.ci.num { text-align: right; font-variant-numeric: tabular-nums; }
.ci.nar { max-width: 88px; }
.ci.xnar { max-width: 54px; }
.t .ci { border-color: transparent; background: transparent; width: 100%; }
.t .ci:hover { border-color: var(--border); }
.t .ci:focus { border-color: var(--text); background: var(--bg); }

/* ── 表内下拉的宽度 ──（必须写在上面三条之后：那三条用的是 background 简写，
   同权重下写在后面就会把这里的箭头背景图抹掉）
   原生下拉的箭头在 Chromium 里恒占约 16px，而这几列的列宽是按表头那两三个字定的
   —— select 用的是 width:100%，百分比宽不计入列的固有宽度，列于是被压到比内容还窄，
   箭头一挤就把「极化」的 H/V 与 LO 名切掉半个字（这两列显示不全的根因）。故表内下拉一律：
     · 自绘箭头（7px，比原生轻，密表里也不显吵），文字区由 padding-right 明确让出
     · 给各自的 min-width —— min-width 才算进列的固有宽度，这才是列不再被压窄的根子 */
.t .ci.selc {
  appearance: none; -webkit-appearance: none;
  padding-right: 14px;
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
.mhs { font-size: 11.5px; }
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
