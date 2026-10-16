<script setup>
// 空间态势报告 独立窗口 —— CelesTrak 卫星编目（SATCAT）与 GP 星历的统计报告。
//
// 三栏（照四个链路预算窗口的 .lb-* 外壳）：左「配置列表」（configs.ssa.json，ns='ssa'）、
// 中「报告」（目录导轨 + 文档区）、右「报告设置」检查器。所有的数只在 shared/ssaStats.js 与
// shared/ssaReport.js 里算一次，屏上文档与导出的 Word 吃的是同一份 buildSsaModel 产物 ——
// 本组件只管采集设置、装载数据、把模型交给 SsaDoc 显示 / 交给主进程写盘。
//
// 数据与报告分家（memory 未记，口径见任务书 §8.2）：后台联网版星历到达【不重排已生成的报告】，
// 只把功能区读数变成「报告 09:37 · 数据 10:12」，要不要按新数据重出由用户点「生成」决定 ——
// 一份正在读的报告在眼皮底下自己换一套数字，比数据旧几分钟糟得多。
import { ref, reactive, shallowRef, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { askConfirm } from '../shared/ui/useConfirm.js'   // 确认框（全平台一份）
import ConfirmDialog from '../components/ConfirmDialog.vue'
import ActivationLock from '../components/ActivationLock.vue'
import ConfigTree from '../components/ConfigTree.vue'
import ConfigTreeMenu from '../components/ConfigTreeMenu.vue'
import Icon from '../components/Icon.vue'
import LbFontCtl from '../components/LbFontCtl.vue'
import SsaDoc from './SsaDoc.vue'
import SsaReportDialog from './SsaReportDialog.vue'
import TzPicker from '../components/TzPicker.vue'
import WinStatusBar from '../components/WinStatusBar.vue'
import LbVersionsDialog from '../components/LbVersionsDialog.vue'
import { useNotice } from '../shared/useNotice.js'
import { reportError } from '../shared/reportError.js'
import { useSsaData, srcLabel } from './ssaData.js'
import { useConfigTree } from '../shared/useConfigTree.js'
import { useConfigAutosave } from '../shared/useConfigAutosave.js'
import { useConfigVersions } from '../shared/useConfigVersions.js'
import { stableStringify } from '../shared/configDirty.js'
// 报告名与文件名走 ssaReport 那一份（模型里的 doc.title 也由它兜底）：两处各拼一遍必然漂移
import { buildSsaModel, ssaReportTitle, ssaReportFileName, filterBrief } from '../shared/ssaReport.js'
import { CONST_PATTERNS, REGIME_ORDER, TYPE_ORDER, normFilters, hasFilters } from '../shared/ssaStats.js'
import { OWNER, ownerName, objectTypeName } from '../shared/satcatCodes.js'
import { byLang, curLang } from '../shared/i18n/lang.js'
import { onLangChange } from '../shared/i18n/runtime.js'
import { normTzMode, tzParts, tzTag } from '../shared/tz.js'
import { normGeoT0ISO, t0InputValue, parseT0Input } from '../shared/geoT0.js'   // datetime-local ⇄ ISO（按显示时区），与 NGSO「起点 = 指定」同一对咽喉
import { composeReportFonts, normReportFontSel } from '../shared/lbReportFont.js'
import { loadLogo } from '../shared/reportLogo.js'   // 台标（全局键 lb/report/logo）：与导出对话框读同一枚
import { halfStr } from '../shared/num.js'

const api = (typeof window !== 'undefined') ? window.api : null
const langNow = ref(curLang())
onLangChange(() => { langNow.value = curLang() })
const ORBIT = 'SSA'
// 失败一律走 shared/reportError（通知条常驻 + 剥 IPC 英文前缀），不再各窗自带一份 errText。

// ============ 左侧栏：配置列表（可拖宽 / 可收起）============
const SIDE_KEY = 'ssa/sideView'
const sideView = ref((() => { try { const v = localStorage.getItem(SIDE_KEY); return (v === 'configs' || v === '') ? v : 'configs' } catch (e) { return 'configs' } })())
watch(sideView, (v) => { try { localStorage.setItem(SIDE_KEY, v) } catch (e) { /* ignore */ } })
function toggleSide(v) { sideView.value = sideView.value === v ? '' : v }
const CFG_W_MIN = 180, CFG_W_MAX = 520, INSP_W_MIN = 240, INSP_W_MAX = 560
const numLS = (k, def) => { try { const n = Number(localStorage.getItem(k)); return Number.isFinite(n) && n > 0 ? n : def } catch (e) { return def } }
const configsWidth = ref(Math.min(CFG_W_MAX, Math.max(CFG_W_MIN, numLS('ssa/configsWidth', 240))))
const inspWidth = ref(Math.min(INSP_W_MAX, Math.max(INSP_W_MIN, numLS('ssa/inspWidth', 320))))
const sideResizing = ref(false)
const inspResizing = ref(false)
// 拖宽：两条竖缝共用一段逻辑，差别只在「往右拖是加宽还是减宽」（检查器在右缘，故取负）
function startResize(which, e) {
  const right = which === 'insp'
  const w = right ? inspWidth : configsWidth
  const min = right ? INSP_W_MIN : CFG_W_MIN, max = right ? INSP_W_MAX : CFG_W_MAX
  const startX = e.clientX, startW = w.value
  const flag = right ? inspResizing : sideResizing
  flag.value = true; document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'
  const move = (ev) => { const d = (ev.clientX - startX) * (right ? -1 : 1); w.value = Math.min(max, Math.max(min, startW + d)) }
  const up = () => {
    flag.value = false; document.body.style.cursor = ''; document.body.style.userSelect = ''
    window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up)
    try { localStorage.setItem(right ? 'ssa/inspWidth' : 'ssa/configsWidth', String(w.value)) } catch (e2) { /* ignore */ }
  }
  window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
}

// ============ 窗内提示（唯一出口；shared/useNotice：普通 4 s · 导出带「打开 · 在文件夹中显示」· 失败常驻）============
const N = useNotice()
const { toast, toastFile } = N
// 主进程保存处理器回的实际写入路径（新字段 path / paths；兼容旧的 filePath）
const outPath = (r) => (r && (r.path || (Array.isArray(r.paths) && r.paths[0]) || r.filePath)) || ''

// ============ 报告设置（= 配置 state）============
// 章节 key 与次序＝报告模型的章节表（shared/ssaReport.js 的 §3 契约）。meta 不可关：
// 一份不写数据时间与判据的统计报告没法交付，故它在界面上是「勾着且点不动」。
// ★ 2026-10-15 二期重排：关键指标在前；「编目总览」「轨道区制」并成一章；「星历时效」并入「数据与方法」；
//   新增「碎片与解体」。老存档里 regime / epoch 两个键读到即忽略（applyState 只认本表里的 key）。
const SECTIONS = [
  { key: 'summary', zh: '关键指标', en: 'Key Figures' },
  { key: 'meta', zh: '数据与方法', en: 'Data and Methods', fixed: true },
  { key: 'catalog', zh: '编目与轨道区制', en: 'Catalogue and Orbital Regimes' },
  { key: 'owner', zh: '所有者', en: 'Owners' },
  { key: 'launch', zh: '发射与陨落', en: 'Launches and Decays' },
  { key: 'debris', zh: '碎片与解体', en: 'Debris and Fragmentation' },
  { key: 'constellation', zh: '大型星座', en: 'Large Constellations' },
  { key: 'geo', zh: 'GEO 带', en: 'The Geostationary Belt' },
  { key: 'appendix', zh: '附录', en: 'Appendix' }
]
const secLabel = (s) => byLang(s.zh, s.en)
const allSections = () => Object.fromEntries(SECTIONS.map((s) => [s.key, true]))

const scope = ref('all')                  // 'all' 全量 | 'groups' 卫星组（决定报告【结构】）
const groupIds = ref([])                  // 选中的卫星组 id
// ============ 筛选（四道，可叠加＝交集；决定报告【统计哪一批对象】）============
// 检查器里「统计范围」是一个区、两层：上层的报告主体（scope）定报告长什么样（8 章通用统计 vs
// 一组一章），下面四道筛选定这些章统计谁。两种主体下筛选都生效，判据与边界由 ssaStats.filterRows
// 一处收口，报告第 1 章逐维列出来。
// ★ 2026-09-17 合区：原先「范围」（主体）与「范围筛选」（四道）分作两区、加上功能区里重复的第三处，
//   「范围」二字在一屏上出现三次而每次所指不同 —— 现在功能区那组已删，界面上只剩这一个区名。
const filt = reactive({ constellations: [], owners: [], regimes: [], types: [] })
const CONST_LABEL = {
  starlink: ['Starlink', 'Starlink'], oneweb: ['OneWeb', 'OneWeb'], kuiper: ['Kuiper', 'Kuiper'],
  qianfan: ['千帆星座', 'Qianfan'], guowang: ['中国星网', 'Guowang'], iridium: ['铱星', 'Iridium NEXT'],
  globalstar: ['Globalstar', 'Globalstar'], planet: ['Planet', 'Planet'], spire: ['Spire', 'Spire'],
  o3b: ['O3b', 'O3b'], gps: ['GPS', 'GPS'], beidou: ['北斗', 'BeiDou'],
  galileo: ['Galileo', 'Galileo'], glonass: ['GLONASS', 'GLONASS']
}
const constOptions = computed(() => {
  const en = langNow.value === 'en'
  return CONST_PATTERNS.map((c) => ({ key: c.key, label: (CONST_LABEL[c.key] || [c.key, c.key])[en ? 1 : 0] }))
})
// 区制含「—」：判不出区制的那批（根数为空）。想单看它们得显式勾，勾了别的档它们一律落选。
const regimeOptions = computed(() => REGIME_ORDER.map((r) => ({ key: r, label: r === '—' ? (langNow.value === 'en' ? 'Undetermined' : '判不出') : r })))
const typeOptions = computed(() => TYPE_ORDER.map((t) => ({ key: t, label: objectTypeName(t, langNow.value) })))
function toggleFilter(dim, key) {
  const a = filt[dim]
  const i = a.indexOf(key)
  if (i > -1) a.splice(i, 1); else a.push(key)
}
const filterOn = (dim, key) => filt[dim].indexOf(key) > -1
const clearFilters = () => { for (const k of ['constellations', 'owners', 'regimes', 'types']) filt[k].splice(0) }
const anyFilter = computed(() => hasFilters(filt))
// 筛选按钮 / 芯片上的字自己出，不交给 DOM 呈现层（那一层按整串查 uiDict）：
//   · 「3 项」是运行时拼的串，词典里没有这一条，英文界面下会原样留着中文；
//   · 「不限」词典里有，但那一条是给显示画质的帧率档用的（译 Unlimited），筛选语境要的是 Any。
// 故两处都走 langNow 现算 + 模板上打 data-i18n-skip。
const anyText = computed(() => (langNow.value === 'en' ? 'Any' : '不限'))
const filtBtnText = (dim) => {
  const n = filt[dim].length
  if (!n) return anyText.value
  return langNow.value === 'en' ? `${n} selected` : `${n} 项`
}
const sections = reactive(allSections())
const reportName = ref('')                // 报告名称（state.name）：留空＝按范围自动命名
// 抬头其余四项（state.head）：编号 / 密级 / 编制单位 / 日期。随配置存 —— 一份配置就是一份报告，
// 编号与日期本就各份各的；日期留空＝生成当天（按显示时区）。
// ★ 不进 curSig：抬头不参与计算，改了直接上屏（SsaDoc 的 head 读的是 docHead），不亮「输入已变」。
const head = reactive({ docNo: '', classification: '', org: '', date: '' })
const HEAD_KEYS = ['docNo', 'classification', 'org', 'date']
// 数字参数一律「草稿串 + change 落值」：直接 v-model.number 会在「−」「1.」这类中间态上把值改成 0
// （memory「输入框跳变陷阱」——西经打一半变东经就是这么来的），GEO 弧段两头恰恰可以是负数。
const d = reactive({ recentDays: '30', topN: '15', months: '24', arcLo: '60', arcHi: '150', rowCap: '500' })
const numOf = (v, def) => { const n = parseFloat(halfStr(String(v))); return Number.isFinite(n) ? n : def }
function commitNum(key, { min, max, def, int }) {
  let n = numOf(d[key], def)
  if (int) n = Math.round(n)
  n = Math.min(max, Math.max(min, n))
  d[key] = String(n)
}
// GEO 重点弧段：两头各自夹进 [−180, 180]，**不再对调**。
// ★ 对调是错的：经度是个环，[150, −150] 说的是跨 180° 接缝那一段太平洋弧（60° 宽），
//   对调成 [−150, 150] 就成了它的补集（300° 宽）—— 用户想看的那段恰好被排除在外，
//   而标题还照印「150.0°W – 150.0°E」，一点提示都没有。引擎侧 ssaStats.inArc 本来就写了
//   from > to 按跨接缝解释的分支，是界面把它掐掉了。
function commitArc() {
  commitNum('arcLo', { min: -180, max: 180, def: 60 })
  commitNum('arcHi', { min: -180, max: 180, def: 150 })
}
// —— 基准时刻（报告「截至」哪一刻）——
// 'now' 生成时：每次出报告取那一刻（出厂与老配置缺省）；'fixed' 指定：固定一个过去的时刻（月报截至月末），
// 随配置存 —— 同一份配置何时重出都是同一个基准，编目按发射 / 陨落日期倒推（ssaStats.backdateRows）。
// 存档只在非缺省时写 refTime 键：老配置载入再序列化逐字不变，指纹不平白翻动（同 geoT0State）。
// 时刻框按显示时区读写（换时区不改所指的瞬间）；草稿只在回车 / 失焦提交（datetime-local 年份段键到一半是 0002）。
// 下界 1957-10-04（编目第一个对象），上界此刻：晚于此刻的「未来报告」没有数据可报，提交时就夹回此刻。
const REF_MIN_MS = Date.UTC(1957, 9, 4)
const refTime = reactive({ mode: 'now', iso: '' })
const refDraft = ref(null)
const floorMin = (ms) => new Date(Math.floor(ms / 60000) * 60000).toISOString()
function clampRef(iso) {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  return floorMin(Math.min(Date.now(), Math.max(REF_MIN_MS, ms)))
}
const refVal = computed(() => (refDraft.value != null ? refDraft.value : t0InputValue(refTime.iso, tzMode.value)))
function setRefMode(m) {
  if (m === 'fixed' && !refTime.iso) refTime.iso = floorMin(Date.now())
  refTime.mode = m === 'fixed' ? 'fixed' : 'now'
}
function refCommit() {
  const typed = refDraft.value; refDraft.value = null
  const iso = typed == null ? null : parseT0Input(typed, tzMode.value)
  if (iso) refTime.iso = clampRef(iso)
}
// 这一次生成的基准时刻（genAt＝生成那一刻）：指定档晚于生成时刻的按生成时刻（夹的是存档里手改出来的未来时刻）
function asOfFor(genAt) {
  if (refTime.mode !== 'fixed') return genAt
  const t = Date.parse(refTime.iso)
  return Number.isFinite(t) && t < Date.parse(genAt) ? new Date(t).toISOString() : genAt
}
function refTimeState() {
  const iso = normGeoT0ISO(refTime.iso)
  return (refTime.mode === 'fixed' || iso) ? { refTime: { mode: refTime.mode, iso } } : {}
}
const optsNow = () => ({
  recentDays: numOf(d.recentDays, 30),
  topN: numOf(d.topN, 15),
  geoArc: [numOf(d.arcLo, 60), numOf(d.arcHi, 150)],
  months: numOf(d.months, 24),
  rowCap: numOf(d.rowCap, 500),
  // 出 IPC / 进模型前现造纯数组：reactive 的 Proxy 过不了结构化克隆
  constellations: filt.constellations.slice(),
  owners: filt.owners.slice(),
  regimes: filt.regimes.slice(),
  types: filt.types.slice(),
  sections: { ...sections }
})
// 经度输入框的角标：按当前值现算 °E / °W —— 只写个「°」的话，60 与 −60 在界面上长得一样，
// 而 GEO 弧段恰恰是最容易被读反的一个参数（报告里那一行印的是「60.0°E – 150.0°E」）。
// 0 归东经、180 归东经（与 ssaReport 的 fmtLonEdge 同口径：右端点恒印 180.0°E）。
function lonTag(v) {
  const n = numOf(v, NaN)
  if (!Number.isFinite(n)) return '°'
  const w = ((n % 360) + 540) % 360 - 180
  return (w < 0 && n !== 180) ? '°W' : '°E'
}

// 所有者下拉：代码 + 本地化名（查不到的代码 ownerName 原样回退代码本身）
const ownerOptions = computed(() => {
  const lang = langNow.value
  return Object.keys(OWNER).sort().map((c) => ({ code: c, label: `${c}　${ownerName(c, lang)}` }))
})

// ============ 数据装载 ============
const data = useSsaData()
const selGroups = computed(() => data.groups.value.filter((g) => groupIds.value.indexOf(g.id) > -1))
// 报告名 / 文件名只认 { id, name, count } 这三项（与模型 scope.groups 同形）
const scopeGroups = computed(() => selGroups.value.map((g) => ({ id: g.id, name: g.name, count: g.sats.length })))
// 报告名 / 文件名里的筛选摘要（「中国 载荷 空间态势报告」）——与模型里那份是同一个函数，不各拼各的
const brief = computed(() => filterBrief(normFilters(filt), langNow.value))
const autoTitle = computed(() => ssaReportTitle(scope.value, scopeGroups.value, langNow.value, brief.value))
// 范围选了卫星组却一个组都没勾：按「没得可报」办，不偷偷回落成全量
const canGenerate = computed(() => !!(data.meta.satcatRows || data.meta.gpRows || data.meta.satcatAt || data.meta.gpAt) && (scope.value !== 'groups' || selGroups.value.length > 0))

// 读数时刻：显示时区档与平台其余读数同一套口径（shared/tz.js），只改显示不参与任何计算
const TZ_KEY = 'ssa/tz'
const tzMode = ref(normTzMode((() => { try { return localStorage.getItem(TZ_KEY) } catch (e) { return null } })(), 'local'))
watch(tzMode, (v) => { try { localStorage.setItem(TZ_KEY, String(v)) } catch (e) { /* ignore */ } })
const p2 = (n) => String(n).padStart(2, '0')
function fmtStamp(iso) {
  if (!iso) return '—'
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return '—'
  const t = tzParts(ms, tzMode.value)
  return `${t.y}-${p2(t.mo)}-${p2(t.d)} ${p2(t.h)}:${p2(t.mi)}`
}
const fmtHm = (iso) => { const s = fmtStamp(iso); return s === '—' ? s : s.slice(11) }
const tzNote = computed(() => tzTag(tzMode.value, Date.now()))
// 检查器里随语言现出的短串（数字框两侧的「近 / 天」之类）：整串不在词典里，模板上打 data-i18n-skip
const L = (zh, en) => (langNow.value === 'en' ? en : zh)
const satcatSrc = computed(() => srcLabel(data.meta.satcatSource))
const gpSrc = computed(() => srcLabel(data.meta.gpSource))
const gpGroupText = computed(() => (data.meta.gpTotal ? `${data.meta.gpGroups}/${data.meta.gpTotal}` : String(data.meta.gpGroups || 0)))
// 两行读数的悬停口径拼在这儿：模板里内联模板串每次渲染重拼一遍，界面词典（按整串查表）也只会
// 看到带反引号的整块，对不上表。
const satcatTitle = computed(() => `SATCAT 卫星编目的数据时间（${tzNote.value}）与来源；条数在报告「数据与方法」一章`)
const gpTitle = computed(() => `GP 星历并集的数据时间（${tzNote.value}，取各组中最旧的一份）、来源与取到的组数`)

// ============ 报告模型 ============
const model = shallowRef(null)            // buildSsaModel 的产物（纯数据，不进深代理）
const genStep = ref('')                   // 生成中的进度读数
const generating = ref(false)
const lang = () => curLang()
// 让出一帧，好让进度读数真绘出来再接着算。双 rAF 等的是「这一帧画完了」，但 rAF 只是【尽力】——
// 窗口被最小化 / 被别的窗口整个盖住时浏览器会把它挂起（Electron 也一样），纯等 rAF 的话点了「生成」
// 再切走，回来发现还停在「解析编目…」。故与一个定时器赛跑：看得见时按帧走（读数准点出现），
// 看不见时 60 ms 后照样往下算 —— 反正那会儿也没人在看这行读数。
const raf = () => new Promise((resolve) => {
  let done = false
  const fin = () => { if (!done) { done = true; clearTimeout(t); resolve() } }
  const t = setTimeout(fin, 60)
  requestAnimationFrame(() => requestAnimationFrame(fin))
})

// —— 报告抬头 ——
// 五项的家：标题＝state.name、其余四项＝state.head，都随配置存。
// 屏上封面与导出对话框两处改的是同一份，Word 封面在导出那一刻照它印。
// （2026-10-16 检查器里的「报告名称」一行删了：封面上就地可改，两处同一个值只会让人以为是两样东西。）
// ★ 2026-10-15 之前抬头存在窗口级键里、只有导出对话框改得了，且要重新「生成」才上屏；
//   日期还被对话框打开那天钉死落盘（屏上一直印着上回导出那天）。两个旧键现在只用来迁移：
//   · ssa/report/doc   → 改作「上次填的密级 / 编制单位」，新建配置照它预填（单位一般不变）；
//                        没有 head 的老配置照它补齐编号 / 密级 / 单位（老版本每份报告印的就是它）。
//   · ssa/report/title → 导出对话框钉住的标题，迁进当时打开的那份配置后删除。
// 台标不在这里 —— 它是一家单位的东西，存全局键、由 shared/reportLogo.js 统一读写；字体按窗口存。
const DOC_KEY = 'ssa/report/doc', TITLE_KEY = 'ssa/report/title', FONT_KEY = 'ssa/report/font'
const readLS = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null') } catch (e) { return null } }
const str = (v) => (v == null ? '' : String(v))
// 新建配置的抬头：密级 / 单位沿用上次填的，编号与日期留空
function newHead() {
  const s = readLS(DOC_KEY) || {}
  return { docNo: '', classification: str(s.classification), org: str(s.org), date: '' }
}
// 没有 head 的老配置：照旧版行为补齐（旧日期是被钉死的那一天，不迁，回到自动）
function legacyHead() {
  const s = readLS(DOC_KEY) || {}
  return { docNo: str(s.docNo), classification: str(s.classification), org: str(s.org), date: '' }
}
// 合并写回：同一键里旧版留下的 docNo 等是 legacyHead 迁移老配置的来源，只更新密级 / 单位两项
function rememberHead() {
  const s = readLS(DOC_KEY)
  const prev = (s && typeof s === 'object' && !Array.isArray(s)) ? s : {}
  try { localStorage.setItem(DOC_KEY, JSON.stringify({ ...prev, classification: head.classification, org: head.org })) } catch (e) { /* 存不下不影响 */ }
}
// 生成时刻 → 「YYYY-MM-DD」（显示时区档）：日期留空时的取值
const dateOf = (iso) => { const s = fmtStamp(iso); return s === '—' ? '' : s.slice(0, 10) }
// 屏上这份报告的自动名：按【生成那一刻】的范围拼（文档没重出之前，标题不该跟着检查器先变）
const genTitle = computed(() => {
  const g = genSnap.value
  return g ? ssaReportTitle(g.scope, g.groups, g.lang, g.brief) : autoTitle.value
})
const genDate = computed(() => dateOf((model.value && model.value.doc && model.value.doc.generatedAt) || new Date().toISOString()))
// 抬头的显示值（留空项已换成自动值）：SsaDoc 与导出对话框都吃这一份
const docHead = computed(() => ({
  title: (reportName.value || '').trim() || genTitle.value,
  docNo: head.docNo,
  classification: head.classification,
  org: head.org,
  date: head.date || genDate.value
}))
// 屏上抬头 / 导出对话框改了一项。标题与日期：清空或改回自动值＝回到自动（之后随范围 / 生成日走）
function onHeadEdit({ key, value }) {
  const v = str(value).trim()
  if (key === 'title') reportName.value = (v === genTitle.value) ? '' : v
  else if (key === 'date') head.date = (v === genDate.value) ? '' : v
  else if (HEAD_KEYS.indexOf(key) > -1) {
    head[key] = v
    if (key === 'classification' || key === 'org') rememberHead()
  }
}
function docInfo(genAt) {
  return {
    // 留空交 buildSsaModel 按范围自动命名
    title: (reportName.value || '').trim(),
    docNo: head.docNo,
    classification: head.classification,
    org: head.org,
    date: head.date || dateOf(genAt),
    logo: loadLogo().logo,
    fonts: composeReportFonts(normReportFontSel(readLS(FONT_KEY))),
    appVersion: appVersion.value,
    generatedAt: ''
  }
}

// 返回 true = 按当前设置与数据生成成功（导出前的补算据此决定放不放行）
// ★ 2026-10-15 起改设置即重出（live）：真编目上解析 116 ms（之后走缓存）+ 建模 180 ms，不必再让用户点「生成」。
//   重出时不换成进度占位（旧文档留在屏上直到新的一份排好），并按当前章把阅读位置放回原处；
//   生成中又来一次改动就排队，排完再按最新设置出一遍（最后一次改动说了算）。
//   数据到达仍【不】自动换数（文件头注的口径）：状态栏那条「报告 · 数据」读数点一下才按新数据重出。
let regenQueued = false
async function generate(o) {
  const live = !!(o && o.live)
  if (generating.value) { regenQueued = true; return false }
  if (!canGenerate.value) {
    if (!live) toast(scope.value === 'groups' && !selGroups.value.length ? byLang('未选择卫星组。', 'No satellite group selected.') : byLang('尚无编目与星历数据', 'No catalogue or ephemeris data yet'))
    return false
  }
  generating.value = true
  const first = !model.value
  const anchor = first ? null : captureAnchor()
  try {
    // 首次生成三步各自先把读数画出来再干活（双 rAF 等一帧真正绘出），中间不给读数的话界面就是一段无声的卡顿；
    // 重出时屏上有旧文档，不换成占位
    if (first) { genStep.value = byLang('解析编目…', 'Parsing catalogue…'); await raf() }
    const rows = data.satcatRows()
    if (first) { genStep.value = byLang('统计…', 'Computing statistics…'); await raf() }
    // 生成时刻与基准时刻分开：生成时刻印在附录与「报告 hh:mm」读数上、日期留空时作报告日期；
    // 基准时刻是统计截至的那一刻（「生成时」档两者相同）
    const genAt = new Date().toISOString()
    const asOf = asOfFor(genAt)
    const doc = docInfo(genAt)
    doc.generatedAt = genAt
    // 建模那一刻的设置签名与文件名口径（与下面读设置的是同一拍）：之后再改设置，「输入已变」按它比，
    // 导出的文件名也按它出
    const sig = curSig.value
    const snap = { scope: scope.value, groups: scopeGroups.value.map((g) => ({ ...g })), brief: brief.value, lang: langNow.value }
    const m = buildSsaModel({
      satcat: rows,
      gp: data.gpRecords(),
      groups: scope.value === 'groups' ? JSON.parse(JSON.stringify(selGroups.value)) : [],
      scope: scope.value,
      opts: optsNow(),
      lang: lang(),
      // 报告里的时刻与功能区读数同一个显示时区档（ssa/tz）；模型层零 DOM，档位只能从这里传进去
      tz: tzMode.value,
      doc,
      dataMeta: {
        satcatAt: data.meta.satcatAt, satcatSource: data.meta.satcatSource, satcatRows: data.meta.satcatRows,
        gpAt: data.meta.gpAt, gpSource: data.meta.gpSource, gpRows: data.meta.gpRows, gpGroups: data.meta.gpGroups,
        asOf
      }
    })
    if (first) { genStep.value = byLang('排版…', 'Laying out…'); await raf() }
    if (noGroupSel.value) return false     // 排版途中组被全部取消：不把这份放回屏上
    model.value = m
    modelAt.value = genAt
    modelSig.value = sig
    genSnap.value = snap
    await nextTick()
    if (anchor) restoreAnchor(anchor)
    else { curSec.value = (m.sections && m.sections[0] && m.sections[0].key) || ''; scrollFlowTop() }
    return true
  } catch (e) {
    reportError(byLang('生成失败', 'Generation failed'), e)
    return false
  } finally {
    generating.value = false
    genStep.value = ''
    if (regenQueued) { regenQueued = false; scheduleRegen(0) }
  }
}

// 阅读位置：当前章的 <section> 离滚动面顶的距离。重出后同一章还在就按同一距离放回；那一章没了
// （筛选让它整章不出）就不动滚动位置
function captureAnchor() {
  const box = flowEl.value, key = curSec.value
  const el = key ? secEl(key) : null
  return (box && el) ? { key, off: el.getBoundingClientRect().top - box.getBoundingClientRect().top } : null
}
function restoreAnchor(a) {
  const box = flowEl.value, el = secEl(a.key)
  if (!box || !el) return
  box.scrollTop += (el.getBoundingClientRect().top - box.getBoundingClientRect().top) - a.off
  curSec.value = a.key
}
let regenTimer = 0
function scheduleRegen(ms) {
  if (regenTimer) clearTimeout(regenTimer)
  regenTimer = setTimeout(() => { regenTimer = 0; generate({ live: true }) }, ms)
}
onBeforeUnmount(() => { if (regenTimer) clearTimeout(regenTimer) })

// 报告与数据谁新：联网版数据在报告之后落定 → 功能区右缘出一行读数（报告不自动重排，见文件头注）
const modelAt = ref('')
const dataNewer = computed(() => !!(model.value && modelAt.value && data.dataAt.value && data.dataAt.value > modelAt.value))

// 报告与设置是否还对得上（D2）：签名 = 决定报告内容的全部设置 —— 报告主体、所选卫星组（组名与成员）、
// 章节与参数、四道筛选（optsNow 全收）、语言、显示时区（报告里的时刻按它印）。
// 抬头五项（含报告名）/ 台标 / 字体不在其中：抬头就地上屏（docHead），台标与字体在导出那一刻覆盖进模型。
// 生成时记下签名；之后签名一变就亮「输入已变」，导出前自动重新生成（数据更新同此口径，见 dataNewer）。
const curSig = computed(() => stableStringify({
  scope: scope.value,
  groups: scope.value === 'groups'
    ? selGroups.value.map((g) => ({ id: g.id, name: g.name, sats: (g.sats || []).map((x) => String(x.id) + '|' + (x.name || '')) }))
    : [],
  opts: optsNow(),
  // 生成时档不进签名（基准随每次生成走，签名里放它就永远对不上）；指定档放进去，改了时刻即重出
  ref: refTime.mode === 'fixed' ? refTime.iso : '',
  lang: langNow.value,
  tz: tzMode.value
}))
const modelSig = ref('')
const inputStale = computed(() => !!(model.value && modelSig.value && curSig.value !== modelSig.value))
// 文件名口径的快照（生成那一刻的范围 / 组 / 筛选摘要 / 语言）：导出的文件名与文档内容是同一次生成
const genSnap = shallowRef(null)
// 抬头同步进屏上那份模型（导出对话框深拷的就是它）。模型是 shallowRef，就地改不触发重排。
// （放在 genSnap 声明之后：watch 建立时就要求值一次 docHead，而它读 genSnap）
watch(docHead, (h) => { const m = model.value; if (m && m.doc) Object.assign(m.doc, h) })
// 改设置即重出：决定报告内容的设置一变（curSig），约 350 ms 后按最新设置重出（连点几个芯片只出最后一份）；
// 数据第一次到位时出第一份。数据到达之后的更新不在这里（见 generate 头注）。
watch(curSig, () => { if (canGenerate.value) scheduleRegen(350) })
watch(canGenerate, (v) => { if (v && !model.value) scheduleRegen(0) }, { immediate: true })
// 卫星组模式下一个组都没勾：撤掉屏上那份（多半是全量）旧文档，界面落到空态；再勾上组时 canGenerate 转真即首出
const noGroupSel = computed(() => scope.value === 'groups' && !selGroups.value.length)
function dropModel() {
  if (regenTimer) { clearTimeout(regenTimer); regenTimer = 0 }
  model.value = null
  modelSig.value = ''
  modelAt.value = ''
  genSnap.value = null
}
watch(noGroupSel, (v) => { if (v) dropModel() }, { immediate: true })

// ============ 目录导轨（scrollspy）============
// 章节元素由 SsaDoc 渲染，本组件只按 data-sec 找它们 —— 与链路预算分节（LbSection 渲染
// <section class="lbx-sec" data-sec="…">）同一枚锚点标记。找不到就退化成「点了不动」，不报错。
const flowEl = ref(null)
const docRef = ref(null)
const curSec = ref('')
const toc = computed(() => ((model.value && model.value.sections) || []).map((s) => ({ key: s.key, no: s.no, title: s.title })))
// 取某章的 <section>：优先用 SsaDoc 暴露的 secEl（它按 dataset.sec 逐个比，组章 key 是 g:<组 id>、
// 组 id 是外来串，拼进选择器还得转义）；组件还没挂上时退回本层同法扫一遍。
function secEl(key) {
  const doc = docRef.value
  if (doc && typeof doc.secEl === 'function') return doc.secEl(key)
  if (!flowEl.value) return null
  return Array.from(flowEl.value.querySelectorAll('[data-sec]')).find((x) => x.dataset.sec === key) || null
}
function gotoSec(key) {
  const el = secEl(key)
  if (!el || !flowEl.value) return
  flowEl.value.scrollTop += el.getBoundingClientRect().top - flowEl.value.getBoundingClientRect().top - 6
  curSec.value = key
}
function scrollFlowTop() { if (flowEl.value) flowEl.value.scrollTop = 0 }
let _spyRaf = 0
function onFlowScroll() {
  if (_spyRaf) return
  _spyRaf = requestAnimationFrame(() => {
    _spyRaf = 0
    const box = flowEl.value
    if (!box || !toc.value.length) return
    const top = box.getBoundingClientRect().top + 8
    let hit = toc.value[0].key
    for (const it of toc.value) {
      const el = secEl(it.key)
      if (el && el.getBoundingClientRect().top <= top) hit = it.key
    }
    curSec.value = hit
  })
}

// ============ 导出 Word ============
// 对话框是「自带引擎」的那一类（元信息 / 台标 / 字体 / 含图 → 取图 → report:exportReport 只出 .docx）：
// 本窗口只负责把模型与缺省文件名交过去，再把它的结果播成一句提示。
const reportOpen = ref(false)
// 导出讲【当前设置与数据】（口径同日凌 / 雨衰 / 链路预算的导出前补算）：还没生成、设置已变或有新数据，
// 先按当前设置重新生成一遍；生不成就不导，原因 generate 已就地报出。
async function openReportDialog() {
  if (generating.value) return
  if (!model.value || inputStale.value || dataNewer.value) {
    if (!(await generate()) || !model.value) return
  }
  reportOpen.value = true
}
const reportFile = computed(() => {
  const g = genSnap.value
  const asOf = (model.value && model.value.data && model.value.data.asOf) || ''
  return g ? ssaReportFileName(g.scope, g.groups, asOf, g.lang, g.brief)
    : ssaReportFileName(scope.value, scopeGroups.value, asOf, langNow.value, brief.value)
})
function onReportDone(r) { toastFile(byLang('已生成：', 'Saved: ') + (((r && r.files) || []).join('　') || ''), outPath(r)) }
function onReportError(msg) { reportError(byLang('导出失败', 'Export failed'), msg || '') }

// ============ 卫星组多选（功能区下拉）============
const groupPick = reactive({ open: false, x: 0, y: 0 })
// 典型星座 / 所有者的多选浮层（共用一个壳，dim 说明这次挑的是哪一维）
const pick = reactive({ open: false, dim: '', x: 0, y: 0, kw: '' })
const pickKwEl = ref(null)
function openPick(dim, e) {
  const r = e.currentTarget.getBoundingClientRect()
  pick.dim = dim
  pick.kw = ''
  pick.x = Math.min(r.left, window.innerWidth - 280)
  pick.y = Math.min(r.bottom + 2, window.innerHeight - 360)
  pick.open = true
  nextTick(() => { try { pickKwEl.value && pickKwEl.value.focus() } catch (e2) { /* ignore */ } })
}
// 所有者 136 个代码：按关键词现筛（代码或本地化名，大小写不敏感），已勾上的恒在表内
// —— 否则输了关键词之后看不到自己勾过什么，取消勾选都无从下手。
const pickList = computed(() => {
  if (pick.dim === 'constellations') return constOptions.value
  const kw = String(pick.kw || '').trim().toLowerCase()
  const all = ownerOptions.value.map((o) => ({ key: o.code, label: o.label }))
  if (!kw) return all
  return all.filter((o) => o.key.toLowerCase().indexOf(kw) > -1 || o.label.toLowerCase().indexOf(kw) > -1 || filt.owners.indexOf(o.key) > -1)
})
function openGroupPick(e) {
  const r = e.currentTarget.getBoundingClientRect()
  groupPick.x = Math.min(r.left, window.innerWidth - 260)
  // 纵向也要夹（与 openPick 同）：这个按钮现在在检查器里，栏底附近点开会把浮层顶出屏外
  groupPick.y = Math.min(r.bottom + 2, window.innerHeight - 360)
  groupPick.open = true
}
function toggleGroup(id) {
  const i = groupIds.value.indexOf(id)
  const next = groupIds.value.slice()
  if (i > -1) next.splice(i, 1); else next.push(id)
  groupIds.value = next
}
const groupBtnText = computed(() => `${selGroups.value.length}/${data.groups.value.length}`)

// ============ 配置持久化（configs.ssa.json，ns='ssa'）============
const STATE_KEY = 'ssa/last'   // 只记「上次打开的是哪一份」；v1.5.1 及以前存的是整份设置（见 onMounted 的迁移）
function serializeState() {
  const o = optsNow()
  return {
    orbitType: ORBIT,
    name: (reportName.value || '').trim(),
    scope: scope.value,
    groupIds: groupIds.value.slice(),
    sections: o.sections,
    recentDays: o.recentDays,
    topN: o.topN,
    geoArc: o.geoArc,
    months: o.months,
    rowCap: o.rowCap,
    constellations: o.constellations,
    owners: o.owners,
    regimes: o.regimes,
    types: o.types,
    head: { ...head },
    ...refTimeState()
  }
}
function applyState(st) {
  if (!st || typeof st !== 'object') return
  reportName.value = typeof st.name === 'string' ? st.name : ''
  // 抬头：老配置（2026-10-15 之前存的）没有 head，照旧版窗口级键补齐 —— 补进来的值不算改动
  // （autosave.attach 以 applyState 之后的内容为基线），下次真改时随整份写回。
  const h = (st.head && typeof st.head === 'object') ? st.head : legacyHead()
  for (const k of HEAD_KEYS) head[k] = str(h[k])
  const rt = (st.refTime && typeof st.refTime === 'object') ? st.refTime : null
  refTime.iso = normGeoT0ISO(rt && rt.iso)
  refTime.mode = (rt && rt.mode === 'fixed' && refTime.iso) ? 'fixed' : 'now'
  refDraft.value = null
  scope.value = st.scope === 'groups' ? 'groups' : 'all'
  groupIds.value = Array.isArray(st.groupIds) ? st.groupIds.filter((x) => typeof x === 'string') : []
  const secs = (st.sections && typeof st.sections === 'object') ? st.sections : null
  for (const s of SECTIONS) sections[s.key] = s.fixed ? true : (secs ? secs[s.key] !== false : true)
  if (st.recentDays != null) d.recentDays = String(st.recentDays)
  if (st.topN != null) d.topN = String(st.topN)
  if (st.months != null) d.months = String(st.months)
  if (st.rowCap != null) d.rowCap = String(st.rowCap)
  if (Array.isArray(st.geoArc) && st.geoArc.length === 2) { d.arcLo = String(st.geoArc[0]); d.arcHi = String(st.geoArc[1]) }
  // 老存档里的 pinOwner（1.4.10 的「重点所有者」，2026-09-17 删）读到就丢：serializeState 不再产它，
  // 指纹两侧形状一致，故不会把老配置一进窗口就判成「已修改」；那个死键在下次保存时自然消失。
  // 四道筛选：老存档没有这四个键（本模块 1.4.10 首发时只有全量 / 卫星组两档），一律按「不筛」读
  for (const k of ['constellations', 'owners', 'regimes', 'types']) {
    filt[k].splice(0)
    if (Array.isArray(st[k])) for (const v of st[k]) if (typeof v === 'string' && v) filt[k].push(v)
  }
  // 报告不入库：换一份配置就把屏上那份撤掉、按新配置重出（设置签名恰好相同时 curSig 不变，故这里自己排一次）
  model.value = null
  modelAt.value = ''
  modelSig.value = ''
  genSnap.value = null
  curSec.value = ''
  if (canGenerate.value) scheduleRegen(0)
}
function blankState() {
  return {
    orbitType: ORBIT, name: '', scope: 'all', groupIds: [], sections: allSections(),
    recentDays: 30, topN: 15, geoArc: [60, 150], months: 24, rowCap: 500,
    constellations: [], owners: [], regimes: [], types: [],
    head: newHead()
  }
}

// —— 配置自动保存（与链路预算四窗同口径，2026-10-15 起取消「保存 / 另存」）——
// 工作区恒对应配置列表里的一份配置，改动约 1 s 后写回；后悔药是历史版本。
function fingerprintOf(st) { return stableStringify(st) }
function setBaseline() { autosave.attach() }
async function guardedLeave() {
  if (await autosave.flush()) return true
  return await askConfirm(`「${cfgTree.activeName()}」的改动未能写入磁盘（${saveError.value}）。仍要离开？`)
}
// 自动名（名字随内容的配置用）= 报告名：范围与筛选一变报告就换了个东西，名字跟着走
function defaultCfgName() { return (reportName.value || '').trim() || autoTitle.value }
// 报告名在 state 里的键是 name（见 serializeState）
function cfgLabelOf(st) { return (st && String(st.name || '').trim()) || '' }

const cfgTree = useConfigTree({
  ns: 'ssa', orbitType: ORBIT, api, storageKey: 'ssa/cfgExpanded',
  toast, blankState, serializeState, applyState, setBaseline, guardedLeave, askConfirm, defaultCfgName,
  autosave: true, onNameAuto: (id) => { if (id === activeId.value) autosave.flush() }
})
const {
  configs, activeId, focusId, expandedFolders, editing, cfgClip, ctxMenu,
  loadConfigs, uniqueCfgName, selectConfig, ensureActive, duplicateItem,
  toggleFolder, expandAll, collapseAll,
  addFolder, addBlankConfig, onDeleteItem, onMove, moveToRoot,
  startRename, commitRename, cancelRename,
  copyItem, cutItem, pasteConfig, ctxItem, ctxIsFolder, openCtx, closeCtx, onCfgKey
} = cfgTree
const autosave = useConfigAutosave({
  ns: 'ssa', api, activeId, itemById: cfgTree.itemById, serialize: serializeState, fingerprint: fingerprintOf,
  autoName: defaultCfgName, uniqueName: uniqueCfgName, summarize: (st) => ({ label: cfgLabelOf(st) }), toast
})
const { error: saveError } = autosave
let stopAutosaveListen = null
onBeforeUnmount(() => { if (stopAutosaveListen) stopAutosaveListen(); autosave.dispose() })
const { verDlg, openVersions, restoreVersion, duplicateVersion } = useConfigVersions({
  ns: 'ssa', api, tree: cfgTree, autosave, applyState, summarize: (st) => ({ label: cfgLabelOf(st) }), fingerprint: fingerprintOf, toast
})
// ★ filt 必须在这张表里：serializeState 已经把四道筛选写进指纹，漏了它就会「改了筛选、不落盘」—— 指纹与触发源同进同出
watch([scope, groupIds, sections, reportName, d, filt, head, refTime], () => autosave.touch(), { deep: true })
watch(activeId, (id) => { try { localStorage.setItem(STATE_KEY, JSON.stringify({ activeId: id || null })) } catch (e) { /* 配额满等忽略 */ } })
// Ctrl+Enter = 生成（全部计算窗同一个键）
function onGlobalKey(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.isComposing && !generating.value && canGenerate.value) { e.preventDefault(); generate() }
}
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKey))

const appVersion = ref('')
const deviceId = ref('')

onMounted(async () => {
  try { appVersion.value = (api && await api.app.version()) || '' } catch (e) { appVersion.value = '' }
  await loadConfigs()
  // 打开上次那份配置；它没了就开树上第一份，一份都没有就新建一份空白配置（工作区恒对应一份配置）。
  // 迁移：v1.5.1 及以前「上次会话」存的是整份设置——对应的配置还在就接上那份改动；不属于任何配置、
  // 又不是出厂空白的存成一份新配置，免得升级后丢了。
  let last = null
  try { last = JSON.parse(localStorage.getItem(STATE_KEY) || 'null') } catch (e) { last = null }
  const hasScene = !!(last && typeof last === 'object' && Object.keys(last).some((k) => k !== 'activeId'))
  if (hasScene && !last.activeId) {
    const { activeId: _a, ...st } = last
    // 比对不带抬头：那一版的存档里还没有 head，而出厂空白现在带着（预填的密级 / 单位）
    const { head: _h, ...blank } = blankState()
    if (fingerprintOf(st) !== fingerprintOf(blank)) await cfgTree.createAndOpen({ state: st, nameAuto: true })
  }
  await ensureActive(last && last.activeId)
  if (hasScene && last.activeId && last.activeId === activeId.value) { const { activeId: _a, ...st } = last; applyState(st); autosave.touch() }
  // 导出对话框钉住过的标题（旧窗口级键）：迁进当前这份配置（它没起过名时），旧键随即作废
  const pinned = readLS(TITLE_KEY)
  if (pinned && pinned.title && pinned.title !== pinned.titleDefault && activeId.value && !(reportName.value || '').trim()) reportName.value = String(pinned.title)
  try { localStorage.removeItem(TITLE_KEY) } catch (e) { /* ignore */ }
  try { localStorage.setItem(STATE_KEY, JSON.stringify({ activeId: activeId.value || null })) } catch (e) { /* 配额满等忽略 */ }
  try { deviceId.value = (api && await api.app.deviceId()) || '' } catch (e) { deviceId.value = '' }
  data.load()                                              // 缓存先到、联网在后：一律不 await
  // 关窗：把挂起的写盘冲掉即放行；只有写不进磁盘时才问一句
  api?.ssa?.onCloseRequested?.(async () => {
    const ok = await autosave.flush()
    if (!ok && !(await askConfirm(`「${cfgTree.activeName()}」的改动未能写入磁盘（${saveError.value}）。仍要关闭窗口？`))) return
    api.ssa.confirmClose()
  })
  stopAutosaveListen = autosave.listen()   // 窗口失焦 / 页面隐藏时立即写盘
  window.addEventListener('keydown', onGlobalKey)
  // 回到本窗口时重读一次卫星组：3D 页在本窗口没有焦点时改的组，storage 事件已经接了；
  // 同一进程内两窗互不触发 storage，故补这一道。
  window.addEventListener('focus', data.reloadGroups)
})
</script>

<template>
  <div class="lb-shell">
    <ActivationLock />
    <!-- 配置右键菜单（五窗共用一份，条目与快捷键一致） -->
    <ConfigTreeMenu
      :menu="ctxMenu" :item="ctxItem" :is-folder="ctxIsFolder" :clip="cfgClip" :has-api="!!api" autosave
      @close="closeCtx" @rename="startRename" @new-folder="addFolder" @new-config="addBlankConfig"
      @cut="cutItem" @copy="copyItem" @paste="pasteConfig" @move-root="moveToRoot"
      @delete="onDeleteItem" @expand-all="expandAll" @collapse-all="collapseAll" @hide="sideView = ''"
      @duplicate="duplicateItem" @versions="(it) => openVersions(it.id)"
    />
    <div class="lb-body">
      <!-- ① 左：配置列表 -->
      <aside v-show="sideView === 'configs'" class="lb-col lb-side lb-configs" :class="{ resizing: sideResizing }" :style="{ width: configsWidth + 'px' }">
        <div class="lb-col-hd">
          <span class="lb-cfg-hd-t">配置列表</span>
          <span class="lb-cfg-acts">
            <button class="lb-mini lb-mini-ico" title="新建文件夹" :disabled="!api" @click="addFolder(null)"><Icon name="folder-plus" :size="12" /></button>
            <button class="lb-mini lb-mini-ico" title="添加空白配置" :disabled="!api" @click="addBlankConfig(null)"><Icon name="plus" :size="12" /></button>
            <button class="lb-mini lb-mini-ico" title="隐藏配置列表" @click="sideView = ''"><Icon name="x" :size="12" /></button>
          </span>
        </div>
        <div class="lb-col-bd" tabindex="0" @keydown="onCfgKey" @contextmenu="openCtx($event, null)">
          <ConfigTree
            :items="configs" :active-id="activeId" :focus-id="focusId" :editing-id="editing.id" :editing-name="editing.name"
            :expanded="expandedFolders"
            :cut-id="cfgClip && cfgClip.mode === 'cut' ? cfgClip.id : null"
            @select="selectConfig" @toggle="toggleFolder" @delete="onDeleteItem" @move="onMove" @focus="focusId = $event.id"
            @add-folder="addFolder" @add-config="addBlankConfig" @context="openCtx"
            @rename-start="startRename" @rename-input="editing.name = $event" @rename-commit="commitRename" @rename-cancel="cancelRename"
          />
        </div>
        <div v-if="deviceId" class="lb-myid" title="本机用户 ID">本机标识：<b data-i18n-skip>{{ deviceId }}</b></div>
        <div class="lb-cfg-resizer" title="拖动调整栏宽" @mousedown.prevent="startResize('cfg', $event)"></div>
      </aside>

      <!-- ② 中：功能区 + 目录导轨 + 报告文档 -->
      <section class="lb-col lb-build">
        <div class="lbr">
          <div class="lbr-g">
            <div class="lbr-items">
              <button class="lbr-big" :disabled="!api || !activeId" title="历史版本：自动留存于打开时、编辑中每 10 分钟、还原前" @click="openVersions(activeId)"><Icon name="history" :size="16" />历史版本</button>
              <button v-if="saveError" class="lbr-big lbx-savefail" :title="'配置未能写入磁盘：' + saveError + '。单击重试'" @click="autosave.flush()"><Icon name="alert-triangle" :size="16" />未写入</button>
              <button class="lbr-big" :class="{ on: sideView === 'configs' }" :aria-pressed="(sideView === 'configs') ? 'true' : 'false'" title="左侧栏显示「配置列表」" @click="toggleSide('configs')"><Icon name="panel-left" :size="16" />配置列表</button>
            </div>
            <div class="lbr-cap">文件</div>
          </div>
          <div class="lbr-g">
            <div class="lbr-items">
              <button class="lbr-big" :disabled="generating || (!model && !canGenerate)" :title="(model || canGenerate) ? '导出 Word（封面 · 目录 · 正文 · 附录）' : '尚无报告'" @click="openReportDialog">
                <Icon name="file-export" :size="16" />Word
              </button>
            </div>
            <div class="lbr-cap">导出</div>
          </div>

          <div class="lbr-g">
            <div class="lbr-items">
              <button class="lbr-big" :class="{ spin: data.busy.value }" :disabled="!api || data.busy.value" title="重新联网取编目与星历（清熔断、绕过「今天已试过直连」的记账）" @click="data.refresh">
                <Icon name="refresh-cw" :size="16" />
                刷新
              </button>
              <div class="ssa-reads">
                <div class="ssa-read" :title="satcatTitle">
                  <span class="ssa-read-k">SATCAT</span>
                  <span class="ssa-read-v" data-i18n-skip>{{ fmtStamp(data.meta.satcatAt) }}</span>
                  <template v-if="satcatSrc"><span class="ssa-read-d" data-i18n-skip>·</span><span class="ssa-read-s">{{ satcatSrc }}</span></template>
                </div>
                <div class="ssa-read" :title="gpTitle">
                  <span class="ssa-read-k">星历</span>
                  <span class="ssa-read-v" data-i18n-skip>{{ fmtStamp(data.meta.gpAt) }}</span>
                  <template v-if="gpSrc"><span class="ssa-read-d" data-i18n-skip>·</span><span class="ssa-read-s">{{ gpSrc }}</span></template>
                  <span class="ssa-read-d" data-i18n-skip>·</span><span class="ssa-read-v" data-i18n-skip>{{ gpGroupText }}</span><span class="ssa-read-s">组</span>
                </div>
              </div>
            </div>
            <div class="lbr-cap">数据</div>
          </div>

          <LbFontCtl />

        </div>

        <div class="ssa-main">
          <!-- 目录导轨：点击滚动、滚动高亮（章节锚点由 SsaDoc 打在 data-sec 上） -->
          <nav v-if="toc.length" class="ssa-toc">
            <button v-for="it in toc" :key="it.key" class="ssa-toc-i" :class="{ on: curSec === it.key }" :aria-pressed="(curSec === it.key) ? 'true' : 'false'" :title="it.title" @click="gotoSec(it.key)">
              <span class="ssa-toc-no" data-i18n-skip>{{ it.no }}</span>
              <span class="ssa-toc-t" data-i18n-skip>{{ it.title }}</span>
            </button>
          </nav>
          <div ref="flowEl" class="lbx-flow ssa-flow" @scroll="onFlowScroll">
            <div v-if="genStep" class="lb-placeholder" data-i18n-skip>{{ genStep }}</div>
            <div v-else-if="noGroupSel" class="lb-placeholder">未选择卫星组。</div>
            <div v-else-if="!model" class="lb-placeholder">尚无报告。</div>
            <SsaDoc v-else ref="docRef" :model="model" :head="docHead" @edit-head="onHeadEdit" />
          </div>
        </div>
      </section>

      <!-- ③ 右：报告设置。四区按「要回答的问题」排：范围（讲谁）· 时间（截至何时、按哪个时区印）·
           章节（讲哪些，章专属参数就挂在该章下面）· 表格（排名 / 成员表印几行）。
           只列当前报告里真起作用的参数：逐月 / 排名 / 重点弧段只在全量报告里用，成员表行数只在卫星组报告里用。
           报告名称不在这里：封面上就地改（SsaDoc 的抬头），两处是同一个值。 -->
      <aside class="lb-col lb-side lb-insp" :class="{ resizing: inspResizing }" :style="{ width: inspWidth + 'px' }">
        <div class="lb-col-hd"><span class="lb-cfg-hd-t">报告设置</span></div>
        <div class="lb-col-bd">
          <div class="lbx-sla-cap ssa-cap-row">
            <span>范围</span>
            <button v-if="anyFilter" class="lb-mini ssa-cap-btn" title="四道筛选全部清空，回到整份编目；报告主体与卫星组不动" @click="clearFilters">清空筛选</button>
          </div>
          <div class="srow"><label title="全量编目＝整份编目一份通用统计；卫星组＝仅包含勾选的卫星组，每组一章">报告主体</label>
            <div class="lbu-seg">
              <button :class="{ on: scope === 'all' }" :aria-pressed="(scope === 'all') ? 'true' : 'false'" title="整份编目：8 章通用统计" @click="scope = 'all'">全量编目</button>
              <button :class="{ on: scope === 'groups' }" :aria-pressed="(scope === 'groups') ? 'true' : 'false'" title="仅包含勾选的卫星组，每组一章" @click="scope = 'groups'">卫星组</button>
            </div>
          </div>
          <div v-if="scope === 'groups' && data.groups.value.length" class="srow ssa-pickrow"><label title="卫星组由主窗口「星座」视图的组管理器维护，本窗口只读">卫星组</label>
            <button class="lb-mini ssa-pickbtn" :class="{ on: groupIds.length }" :aria-pressed="groupIds.length ? 'true' : 'false'" @click="openGroupPick">
              <span data-i18n-skip>{{ groupBtnText }}</span><Icon name="chevron-down" :size="12" />
            </button>
          </div>
          <div v-else-if="scope === 'groups'" class="lb-placeholder">暂无卫星组。</div>
          <div class="srow ssa-pickrow"><label title="按卫星名称前缀近似归类（STARLINK / ONEWEB / …），与 CelesTrak 的 GROUP 名单不完全等价">典型星座</label>
            <button class="lb-mini ssa-pickbtn" :class="{ on: filt.constellations.length }" :aria-pressed="filt.constellations.length ? 'true' : 'false'" data-i18n-skip @click="openPick('constellations', $event)">
              {{ filtBtnText('constellations') }}
            </button>
          </div>
          <div class="srow ssa-pickrow"><label title="SATCAT 的 OWNER 代码；与 ITU 申报国、外空物体登记国都不是一回事">所有者</label>
            <button class="lb-mini ssa-pickbtn" :class="{ on: filt.owners.length }" :aria-pressed="filt.owners.length ? 'true' : 'false'" data-i18n-skip @click="openPick('owners', $event)">
              {{ filtBtnText('owners') }}
            </button>
          </div>
          <div class="srow ssa-chips"><label title="按 classifyOrbit 的结果比对；勾了任一档之后，根数为空、判不出区制的对象一律落选">轨道区制</label>
            <div class="ssa-chipbox">
              <button class="ssa-chip any" :class="{ on: !filt.regimes.length }" :aria-pressed="(!filt.regimes.length) ? 'true' : 'false'" data-i18n-skip @click="filt.regimes.splice(0)">{{ anyText }}</button>
              <label v-for="r in regimeOptions" :key="r.key" class="ssa-chip" :class="{ on: filterOn('regimes', r.key) }">
                <input type="checkbox" :checked="filterOn('regimes', r.key)" @change="toggleFilter('regimes', r.key)" />
                <span>{{ r.label }}</span>
              </label>
            </div>
          </div>
          <div class="srow ssa-chips"><label title="SATCAT 的 OBJECT_TYPE 字段">对象类型</label>
            <div class="ssa-chipbox">
              <button class="ssa-chip any" :class="{ on: !filt.types.length }" :aria-pressed="(!filt.types.length) ? 'true' : 'false'" data-i18n-skip @click="filt.types.splice(0)">{{ anyText }}</button>
              <label v-for="t in typeOptions" :key="t.key" class="ssa-chip" :class="{ on: filterOn('types', t.key) }">
                <input type="checkbox" :checked="filterOn('types', t.key)" @change="toggleFilter('types', t.key)" />
                <span>{{ t.label }}</span>
              </label>
            </div>
          </div>

          <div class="lbx-sla-cap">时间</div>
          <div class="srow"><label title="统计截至的时刻。生成时＝每次出报告的那一刻；指定＝固定一个过去的时刻（如月末），编目按发射 / 陨落日期倒推到该时刻">基准时刻</label>
            <div class="lbu-seg">
              <button :class="{ on: refTime.mode === 'now' }" :aria-pressed="(refTime.mode === 'now') ? 'true' : 'false'" title="每次出报告取当时的时刻" @click="setRefMode('now')">生成时</button>
              <button :class="{ on: refTime.mode === 'fixed' }" :aria-pressed="(refTime.mode === 'fixed') ? 'true' : 'false'" title="固定一个时刻，随配置保存" @click="setRefMode('fixed')">指定</button>
            </div>
          </div>
          <div v-if="refTime.mode === 'fixed'" class="srow ssa-under">
            <input type="datetime-local" step="60" class="ci ssa-dt" title="基准时刻（按显示时区；晚于此刻的按此刻）" :value="refVal" @input="refDraft = $event.target.value" @blur="refCommit" @keyup.enter="refCommit" />
          </div>
          <div class="srow"><label title="报告与本窗口里所有时刻的显示时区，也是「指定」时刻的输入时区；统计口径不随它变（按 UTC 日历日）">显示时区</label>
            <TzPicker v-model="tzMode" class="ssa-tz" title="本机 / UTC / UTC±N">
              <span v-if="tzMode === 'local'">本机</span><span data-i18n-skip>{{ tzNote }}</span><Icon name="chevron-down" :size="12" />
            </TzPicker>
          </div>
          <div class="srow"><label title="近期发射、近期陨落、近期新编目碎片与星座「近 N 天」部署回溯的天数（按 UTC 日历日）">近期窗口</label>
            <span class="u ssa-pre" data-i18n-skip>{{ L('近', 'Last') }}</span>
            <input class="ci ssa-num" type="number" min="1" max="365" step="1" v-model="d.recentDays" @change="commitNum('recentDays', { min: 1, max: 365, def: 30, int: true })" />
            <span class="u" data-i18n-skip>{{ L('天', 'days') }}</span>
          </div>

          <template v-if="scope === 'all'">
            <div class="lbx-sla-cap">章节</div>
            <template v-for="s in SECTIONS" :key="s.key">
              <label class="ssa-chk" :title="s.fixed ? '数据时间、来源与判据：一份交付报告必须写明，故不可关' : '关掉整章不进报告'">
                <input type="checkbox" :checked="sections[s.key]" :disabled="s.fixed" @change="sections[s.key] = $event.target.checked" />
                <span class="ssa-chk-t">{{ secLabel(s) }}</span>
              </label>
              <div v-if="s.key === 'launch' && sections.launch" class="srow sub"><label title="「逐月发射与陨落」表回溯的月数；在轨对象累计图不受它约束，恒从 1957 年画起">逐月统计</label>
                <span class="u ssa-pre" data-i18n-skip>{{ L('近', 'Last') }}</span>
                <input class="ci ssa-num" type="number" min="1" max="120" step="1" v-model="d.months" @change="commitNum('months', { min: 1, max: 120, def: 24, int: true })" />
                <span class="u" data-i18n-skip>{{ L('个月', 'months') }}</span>
              </div>
              <div v-if="s.key === 'geo' && sections.geo" class="srow sub ssa-arc"><label title="GEO 带一章单列卫星清单的经度区间。东经为正、西经为负，角标即当前值落在东经还是西经；起点大于终点＝跨 180° 经线的那一段">重点弧段</label>
                <input class="ci ssa-num" type="text" inputmode="decimal" v-model="d.arcLo" @change="commitArc" />
                <span class="u ssa-pre" data-i18n-skip>{{ lonTag(d.arcLo) }}</span>
                <span class="u ssa-pre" data-i18n-skip>{{ L('至', 'to') }}</span>
                <input class="ci ssa-num" type="text" inputmode="decimal" v-model="d.arcHi" @change="commitArc" />
                <span class="u ssa-pre" data-i18n-skip>{{ lonTag(d.arcHi) }}</span>
              </div>
            </template>
          </template>

          <div class="lbx-sla-cap">表格</div>
          <div v-if="scope === 'all'" class="srow"><label title="所有者、碎片母体、GEO 拥挤轨位三张排名表列出的条数（按数量降序）">排名条数</label>
            <span class="u ssa-pre" data-i18n-skip>{{ L('前', 'Top') }}</span>
            <input class="ci ssa-num" type="number" min="1" max="50" step="1" v-model="d.topN" @change="commitNum('topN', { min: 1, max: 50, def: 15, int: true })" />
            <span v-if="langNow !== 'en'" class="u" data-i18n-skip>位</span>
          </div>
          <div v-else class="srow"><label title="每组成员表最多印多少行；超出的不印，题注给出「共 N 条」。屏上与 Word 同一个上限">成员表行数</label>
            <span class="u ssa-pre" data-i18n-skip>{{ L('最多', 'Up to') }}</span>
            <input class="ci ssa-num" type="number" min="10" max="5000" step="10" v-model="d.rowCap" @change="commitNum('rowCap', { min: 10, max: 5000, def: 500, int: true })" />
            <span class="u" data-i18n-skip>{{ L('行', 'rows') }}</span>
          </div>
        </div>
        <div class="lb-cfg-resizer ssa-insp-resizer" title="拖动调整栏宽" @mousedown.prevent="startResize('insp', $event)"></div>
      </aside>
    </div>

    <!-- 卫星组多选下拉 -->
    <div v-if="groupPick.open" class="lb-ctx-mask menu-mask" @click="groupPick.open = false" @contextmenu.prevent="groupPick.open = false">
      <div class="lb-ctx ssa-pick menu" :style="{ left: groupPick.x + 'px', top: groupPick.y + 'px' }" @click.stop>
        <div v-if="!data.groups.value.length" class="lb-placeholder">暂无卫星组。</div>
        <label v-for="g in data.groups.value" :key="g.id" class="ssa-chk">
          <input type="checkbox" :checked="groupIds.indexOf(g.id) > -1" @change="toggleGroup(g.id)" />
          <span class="ssa-chk-t" :title="g.name" data-i18n-skip>{{ g.name }}</span>
          <span class="ssa-chk-n" data-i18n-skip>{{ g.sats.length }}</span>
        </label>
      </div>
    </div>

    <!-- 典型星座 / 所有者 多选浮层（所有者有 136 个代码，带即打即筛的搜索框）-->
    <div v-if="pick.open" class="lb-ctx-mask menu-mask" @click="pick.open = false" @contextmenu.prevent="pick.open = false">
      <div class="lb-ctx ssa-pick menu" :style="{ left: pick.x + 'px', top: pick.y + 'px' }" @click.stop>
        <input v-if="pick.dim === 'owners'" ref="pickKwEl" class="ci ssa-pickkw search-field" type="text" v-model="pick.kw" placeholder="代码或名称" />
        <div v-if="!pickList.length" class="lb-placeholder">无匹配项。</div>
        <label v-for="it in pickList" :key="it.key" class="ssa-chk">
          <input type="checkbox" :checked="filterOn(pick.dim, it.key)" @change="toggleFilter(pick.dim, it.key)" />
          <span class="ssa-chk-t" :title="it.label">{{ it.label }}</span>
        </label>
      </div>
    </div>

    <WinStatusBar :n="N" :busy="generating ? '生成中…' : ''">
      <span v-if="data.err.value" class="lb-hint"><Icon name="alert-triangle" :size="12" /> <span data-i18n-skip>{{ data.err.value }}</span></span>
      <span v-if="!api" class="lb-hint"><Icon name="alert-triangle" :size="12" /> 需在桌面客户端中运行</span>
      <span v-if="dataNewer" class="ssa-newer" role="button" tabindex="0" title="联网版数据已到，报告仍是按旧数据排的；单击按新数据重出" @click="generate()" @keydown.enter="generate()">
        <span>报告</span><span data-i18n-skip>{{ fmtHm(modelAt) }}</span><span data-i18n-skip>·</span><span>数据</span><span data-i18n-skip>{{ fmtHm(data.dataAt.value) }}</span>
      </span>
    </WinStatusBar>

    <SsaReportDialog
      :open="reportOpen" :model="model" :lang="langNow" store-key="ssa"
      :default-name="reportFile" :busy="generating" :head="docHead"
      @close="reportOpen = false" @done="onReportDone" @error="onReportError" @head="onHeadEdit"
    />

    <LbVersionsDialog v-model:open="verDlg.open" ns="ssa" :cfg-id="verDlg.id" :cfg-name="verDlg.name" @restore="restoreVersion" @duplicate="duplicateVersion" />
    <ConfirmDialog />
  </div>
</template>

<style scoped>
/* 窗口骨架（.lb-shell / .lb-body / .lb-col / .lb-side / .lb-mini / .lb-dlg…）在 styles/lbworkbench.css，此处只留本窗的变体 */

/* 功能区「数据」组的刷新按钮：取数中图标旋转（按钮本体走公共 .lbr-big） */
.lbr-big.spin .app-icon { animation: ui-spin .7s linear infinite; transform-origin: 50% 50%; }
/* 状态栏：报告时刻落后于数据时刻（琥珀，与「输入已变」同一色） */
.ssa-newer { display: inline-flex; gap: 4px; color: var(--warn); cursor: pointer; }
.lb-note { color: var(--ok); font-size: var(--fs-2); max-width: 380px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 检查器的拖宽缝在【左】缘：它贴在窗口右沿，往右拖是收窄（见 startResize 的取负） */
.ssa-insp-resizer { right: auto; left: 0; }
.lb-configs .lb-col-hd { padding: 0 8px; gap: 6px; }
.lb-insp { border-right: none; border-left: 1px solid var(--border); }
.lb-insp .lb-col-bd { padding: 10px 10px 16px; display: flex; flex-direction: column; gap: 5px; font-size: var(--fs-3); }
.lb-insp .lbx-sla-cap { margin-top: 8px; }
/* 栏体是纵向 flex 且可滚：子项默认 flex-shrink 1，内容超出栏高时两行高的芯片行会被压成一行高、与下一行叠在一起 */
.lb-insp .lb-col-bd > * { flex-shrink: 0; }

.lb-placeholder { color: var(--text-faint); font-size: var(--fs-3); text-align: center; line-height: 1.7; padding: 10px 0; }


/* —— 功能区「数据」组的两行读数（全是运行时数据）—— */
.ssa-reads { display: flex; flex-direction: column; justify-content: center; gap: 2px; padding: 0 4px; }
.ssa-read { display: flex; align-items: baseline; gap: 5px; font-size: var(--fs-2); white-space: nowrap; }
.ssa-read-k { color: var(--text-muted); min-width: 44px; }
.ssa-read-v { color: var(--text); font-variant-numeric: tabular-nums; }
.ssa-read-s { color: var(--text-muted); }
.ssa-read-d { color: var(--text-faint); }

/* —— 中栏：目录导轨 + 文档面 —— */
.ssa-main { flex: 1; min-height: 0; display: flex; }
.ssa-toc {
  flex: none; width: 168px; min-width: 0; display: flex; flex-direction: column; gap: 1px;
  padding: 10px 6px; overflow-y: auto; background: var(--surface); border-right: 1px solid var(--border);
}
.ssa-toc-i {
  display: flex; align-items: baseline; gap: 6px; padding: 3px 7px; cursor: pointer; text-align: left; font: inherit;
  font-size: var(--fs-2); color: var(--text-muted); background: transparent; border: 1px solid transparent; border-radius: var(--r-ctl, 2px);
}
.ssa-toc-i:hover { color: var(--text); background: var(--wash-hover); }
.ssa-toc-i.on { color: var(--text); background: var(--bg); border-color: var(--border); box-shadow: inset 2px 0 0 var(--accent-ui); }
.ssa-toc-no { flex: none; min-width: 16px; font-family: var(--font-mono); color: var(--text-faint); font-variant-numeric: tabular-nums; }
.ssa-toc-i.on .ssa-toc-no { color: var(--text); }
.ssa-toc-t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 桌面（样式规范 §I.1）：随主题；纸在 SsaDoc 里恒为浅色 */
.ssa-flow { padding: 8px 16px 24px; background: var(--surface); }

/* —— 勾选行（章节 / 卫星组）：它们是参数不是图层，故用复选框而不是拨杆 —— */
.ssa-chk { display: flex; align-items: center; gap: 6px; padding: 2px 1px; font-size: var(--fs-3); color: var(--text); cursor: pointer; min-height: var(--h-ctl); }
.ssa-chk:hover { color: var(--text); }
/* 侧栏那份仍单行 + 省略号（栏宽可拖到 240 px 下限，多行会把勾选列表撑得没法扫），
   但一律挂 :title —— 截断之后至少有处看全名。浮层那份宽度自主，直接换行显示全名。 */
.ssa-chk-t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ssa-pick .ssa-chk { align-items: flex-start; }
.ssa-pick .ssa-chk-t { overflow: visible; text-overflow: clip; white-space: normal; line-height: 1.35; }
.ssa-chk-n { flex: none; font-family: var(--font-mono); font-size: var(--fs-2); color: var(--text-faint); font-variant-numeric: tabular-nums; }
.ssa-chk input:disabled + .ssa-chk-t { color: var(--text-faint); }
/* 卫星组 / 典型星座 / 所有者的多选下拉：借右键菜单的浮层壳（.lb-ctx 在公共表里，非 scoped） */
.ssa-pick { min-width: 240px; max-height: 340px; overflow-y: auto; padding: 6px 8px; }
.ssa-pickkw { width: 100%; margin-bottom: 4px; }
/* 分区标题那一行右端挂个「清空」：标题本身仍是标题，按钮只在真筛了东西时出现 */
.ssa-cap-row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.ssa-cap-btn { flex: none; }
/* 筛选行：左标签 + 右「n 项 / 不限」按钮。用 .lb-mini 而不是 .ci —— .ci 的选择器是
   input.ci/select.ci/textarea.ci，套在 button 上一条都拿不到，看着不像控件。 */
/* 与同栏的输入框（.ci）同高同字号：.lb-mini 的 3px 内距 + 行高 1 只有 19px，比邻行矮一截 */
.ssa-pickrow .ssa-pickbtn { flex: 1; min-width: 0; justify-content: flex-start; height: var(--h-ctl); padding: 0 7px; font-size: var(--fs-3); }
.ssa-pickbtn.on { color: var(--accent-ui); border-color: var(--accent-ui); }
/* 「报告主体」两档：复用功能区「单位」那件分段控件（lbworkbench.css 的 .lbu-seg），两档同时在屏上，
   不必拉开下拉才知道另一档是什么 —— 这一行正是整个窗口最容易读错的一处。铺满参数行、段内等分。 */
.srow > input.ci[inputmode="decimal"] { text-align: right; font-variant-numeric: tabular-nums; }
.srow > .lbu-seg { flex: 1 1 auto; min-width: 0; }
.srow > .lbu-seg > button { flex: 1 1 auto; height: var(--h-ctl); padding-top: 0; padding-bottom: 0; font-size: var(--fs-3); }
/* 参数读成一句话：「近 [30] 天」「前 [15] 位」「[60]°E 至 [150]°E」—— 数字框短定宽、右对齐，
   框前的「近 / 前 / 最多 / 至」不吃 .u 的 30px 下限（那是给单位列对齐用的，放在框前只会空出一截） */
.srow > input.ci.ssa-num { flex: 0 1 64px; text-align: right; font-variant-numeric: tabular-nums; }
.srow > .u.ssa-pre { min-width: 0; }
/* 弧段一行要装下两框两角标一个「至」：框收到 52、行内间距收到 5，栏宽 240 的下限也排得下 */
.srow.ssa-arc { gap: 4px 5px; }
.srow.ssa-arc > input.ci.ssa-num { flex-basis: 52px; }
.srow.ssa-arc > label { margin-right: 3px; }   /* 补回标签后那 3px：控件列仍与上下行对齐 */
/* 「指定」时刻框落在控件列上（与上一行分段控件左沿对齐），不另起标签 */
.srow.ssa-under { padding-left: calc(var(--srow-lab) + 8px); }
.srow > input.ci.ssa-dt { flex: 1 1 auto; font-variant-numeric: tabular-nums; }
/* 显示时区：TzPicker 的触发器（单根 span，scoped 样式落得到）做成与字段同高同框的下拉钮 */
.ssa-tz {
  flex: 1; min-width: 0; display: inline-flex; align-items: center; gap: 5px; height: var(--h-ctl); padding: 0 7px;
  border: 1px solid var(--field-border); border-radius: var(--r-ctl, 2px); background: var(--field-bg);
  color: var(--text); font-size: var(--fs-3); font-variant-numeric: tabular-nums;
}
.ssa-tz:hover, .ssa-tz.open { border-color: var(--field-border-hover); }
.ssa-tz .app-icon { margin-left: auto; color: var(--text-faint); }
/* 区制 / 类型这两维只有四到六个取值，整行铺开比再点开一层浮层快 —— 它们是参数不是图层，故仍是复选框 */
.ssa-chips { align-items: flex-start; }
.ssa-chipbox { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; gap: 3px; }
.ssa-chip { display: inline-flex; align-items: center; gap: 3px; padding: 0 6px; height: var(--h-ctl-sm); border: 1px solid var(--border); border-radius: var(--r-ctl); font-size: var(--fs-2); color: var(--text-muted); cursor: pointer; white-space: nowrap; }
.ssa-chip:hover { color: var(--text); border-color: var(--border-strong); }
/* 取值芯片是 <label> 不是 <button>，吃不到全局按钮的过渡与按下罩，就地补（P8） */
label.ssa-chip { transition: var(--t-state); }
label.ssa-chip:active { box-shadow: var(--press); transition-duration: 0s; }
.ssa-chip.on { color: var(--accent-ui); border-color: var(--accent-ui); }
.ssa-chip input { margin: 0; }
/* 每一维排头的「不限」：一个都没勾时亮的就是它（芯片全灭与「全选」在屏上长得一样，分不出），
   点它＝这一维归零。走中性墨色不走机位色 —— 它是「没筛」，不是一档筛选值。
   ★ 不给它挂 title：这枚按钮打了 data-i18n-skip（字由 langNow 自己出），而 inSkip 是整棵子树生效、
   连 title 一起跳过，挂上去英文界面下就是一条翻不动的中文。口径写在这一行的 label title 里。 */
button.ssa-chip.any { font: inherit; font-size: var(--fs-2); background: transparent; }
.ssa-chip.any.on { color: var(--text); border-color: var(--border-strong); background: var(--surface-2); }
</style>
