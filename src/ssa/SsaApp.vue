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
import { ref, reactive, shallowRef, computed, watch, nextTick, onMounted } from 'vue'
import ActivationLock from '../components/ActivationLock.vue'
import ConfigTree from '../components/ConfigTree.vue'
import ConfigTreeMenu from '../components/ConfigTreeMenu.vue'
import Icon from '../components/Icon.vue'
import LbFontCtl from '../components/LbFontCtl.vue'
import SsaDoc from './SsaDoc.vue'
import SsaReportDialog from './SsaReportDialog.vue'
import { useSsaData, srcLabel } from './ssaData.js'
import { useConfigTree } from '../shared/useConfigTree.js'
import { stableStringify } from '../shared/configDirty.js'
// 报告名与文件名走 ssaReport 那一份（模型里的 doc.title 也由它兜底）：两处各拼一遍必然漂移
import { buildSsaModel, ssaReportTitle, ssaReportFileName, filterBrief } from '../shared/ssaReport.js'
import { CONST_PATTERNS, REGIME_ORDER, TYPE_ORDER, normFilters, hasFilters } from '../shared/ssaStats.js'
import { OWNER, ownerName, objectTypeName } from '../shared/satcatCodes.js'
import { byLang, curLang } from '../shared/i18n/lang.js'
import { onLangChange } from '../shared/i18n/runtime.js'
import { normTzMode, tzParts, tzTag } from '../shared/tz.js'
import { composeReportFonts, normReportFontSel } from '../shared/lbReportFont.js'
import { loadLogo } from '../shared/reportLogo.js'   // 台标（全局键 lb/report/logo）：与导出对话框读同一枚
import { halfStr } from '../shared/num.js'

const api = (typeof window !== 'undefined') ? window.api : null
const langNow = ref(curLang())
onLangChange(() => { langNow.value = curLang() })
const ORBIT = 'SSA'
// 五窗共用的写法：useConfigTree 内部那份 errText 没有导出，各窗自带一份（端到端漏了这一份，
// 关窗守卫一旦抛错就是 ReferenceError —— 表现为「点了保存，窗口既不关也没动静」）。
const errText = (e) => (e && e.message) || String(e)

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

// ============ 窗内提示（唯一出口）============
const notice = ref('')
let _noticeT = null
function toast(msg) { notice.value = msg; clearTimeout(_noticeT); _noticeT = setTimeout(() => (notice.value = ''), 4000) }

// ============ 报告设置（= 配置 state）============
// 章节 key 与次序＝报告模型的章节表（shared/ssaReport.js 的 §3 契约）。meta 不可关：
// 一份不写数据时间与判据的统计报告没法交付，故它在界面上是「勾着且点不动」。
const SECTIONS = [
  { key: 'meta', zh: '数据来源与口径', en: 'Data Sources and Definitions', fixed: true },
  { key: 'catalog', zh: '编目总览', en: 'Catalog Overview' },
  { key: 'regime', zh: '轨道区制', en: 'Orbital Regimes' },
  { key: 'owner', zh: '所有者', en: 'Owners' },
  { key: 'launch', zh: '发射与陨落', en: 'Launches and Decays' },
  { key: 'constellation', zh: '大型星座部署', en: 'Large Constellation Deployment' },
  { key: 'geo', zh: 'GEO 轨道弧', en: 'GEO Orbital Arc' },
  { key: 'epoch', zh: '星历时效', en: 'Ephemeris Currency' },
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
const satcatSrc = computed(() => srcLabel(data.meta.satcatSource))
const gpSrc = computed(() => srcLabel(data.meta.gpSource))
const gpGroupText = computed(() => (data.meta.gpTotal ? `${data.meta.gpGroups}/${data.meta.gpTotal}` : String(data.meta.gpGroups || 0)))
// 两行读数的悬停口径拼在这儿：模板里内联模板串每次渲染重拼一遍，界面词典（按整串查表）也只会
// 看到带反引号的整块，对不上表。
const satcatTitle = computed(() => `SATCAT 卫星编目的数据时间（${tzNote.value}）与来源；条数在报告「数据来源与口径」一章`)
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

// 报告元信息：与导出对话框共用同一批存储键（对话框改了什么，下次「生成」出来的抬头就是什么）。
// 台标不在这三个键里 —— 它是一家单位的东西，存全局键、由 shared/reportLogo.js 统一读写。
const DOC_KEY = 'ssa/report/doc', TITLE_KEY = 'ssa/report/title', FONT_KEY = 'ssa/report/font'
const readLS = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null') } catch (e) { return null } }
function docInfo() {
  const saved = readLS(DOC_KEY) || {}
  // 导出对话框存的是 { title, titleDefault }：两者相等＝用户没改过，此处照它的规矩让位给自动名
  const ttl = readLS(TITLE_KEY)
  const pinnedTitle = (ttl && ttl.title && ttl.title !== ttl.titleDefault) ? ttl.title : ''
  const dt = new Date()
  return {
    // 标题三级取值：配置里写死的报告名 > 导出对话框改过并钉住的名 > 留空交 buildSsaModel 按范围自动命名
    title: (reportName.value || '').trim() || pinnedTitle || '',
    docNo: saved.docNo || '',
    classification: saved.classification || '',
    org: saved.org || '',
    date: saved.date || `${dt.getFullYear()}-${p2(dt.getMonth() + 1)}-${p2(dt.getDate())}`,
    logo: loadLogo().logo,
    fonts: composeReportFonts(normReportFontSel(readLS(FONT_KEY))),
    appVersion: appVersion.value,
    generatedAt: ''
  }
}

async function generate() {
  if (generating.value) return
  if (!canGenerate.value) { toast(scope.value === 'groups' && !selGroups.value.length ? byLang('请先勾选卫星组', 'Select at least one satellite group') : byLang('尚无编目与星历数据', 'No catalogue or ephemeris data yet')); return }
  generating.value = true
  try {
    // 三步各自先把读数画出来再干活（双 rAF 等一帧真正绘出）：解析 6.6 万行编目约 300 ms，
    // 统计与排版各数百毫秒，中间不给读数的话界面就是一段无声的卡顿。
    genStep.value = byLang('解析编目…', 'Parsing catalogue…')
    await raf()
    const rows = data.satcatRows()
    genStep.value = byLang('统计…', 'Computing statistics…')
    await raf()
    const asOf = new Date().toISOString()
    const doc = docInfo()
    doc.generatedAt = asOf
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
    genStep.value = byLang('排版…', 'Laying out…')
    await raf()
    model.value = m
    modelAt.value = asOf
    await nextTick()
    curSec.value = (m.sections && m.sections[0] && m.sections[0].key) || ''
    scrollFlowTop()
  } catch (e) {
    toast(byLang('生成失败：', 'Generation failed: ') + errText(e))
  } finally {
    generating.value = false
    genStep.value = ''
  }
}

// 报告与数据谁新：联网版数据在报告之后落定 → 功能区右缘出一行读数（报告不自动重排，见文件头注）
const modelAt = ref('')
const dataNewer = computed(() => !!(model.value && modelAt.value && data.dataAt.value && data.dataAt.value > modelAt.value))

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
function openReportDialog() {
  if (!model.value) { toast(byLang('请先生成报告', 'Generate the report first')); return }
  reportOpen.value = true
}
const reportFile = computed(() => ssaReportFileName(scope.value, scopeGroups.value, (model.value && model.value.data && model.value.data.asOf) || '', langNow.value, brief.value))
function onReportDone(r) { toast(byLang('已生成：', 'Saved: ') + (((r && r.files) || []).join('　') || '')) }
function onReportError(msg) { toast(byLang('导出失败：', 'Export failed: ') + (msg || '')) }

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
const STATE_KEY = 'ssa/last'
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
    types: o.types
  }
}
function applyState(st) {
  if (!st || typeof st !== 'object') return
  reportName.value = typeof st.name === 'string' ? st.name : ''
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
  // 报告不入库：换一份配置就把屏上那份撤掉，免得设置与文档对不上（重新点「生成」即可，秒级）
  model.value = null
  modelAt.value = ''
  curSec.value = ''
}
function blankState() {
  return {
    orbitType: ORBIT, name: '', scope: 'all', groupIds: [], sections: allSections(),
    recentDays: 30, topN: 15, geoArc: [60, 150], months: 24, rowCap: 500,
    constellations: [], owners: [], regimes: [], types: []
  }
}

// —— 脏态 ——
function fingerprint() { return stableStringify(serializeState()) }
let activeBaseline = ''
const dirtyFlag = ref(false)
function setBaseline() { activeBaseline = fingerprint(); dirtyFlag.value = false }
function isDirty() { return !!cfgTree.activeId.value && fingerprint() !== activeBaseline }

// —— 工作状态（与配置无关的「上次看到的样子」）——
let _stateT = null
function flushSaveState() {
  clearTimeout(_stateT)
  try { localStorage.setItem(STATE_KEY, JSON.stringify({ ...serializeState(), activeId: cfgTree.activeId.value })) } catch (e) { /* ignore */ }
}
function scheduleSaveState() {
  clearTimeout(_stateT)
  _stateT = setTimeout(() => { flushSaveState(); dirtyFlag.value = isDirty() }, 600)
}
// ★ filt 必须在这张表里：serializeState 已经把四道筛选写进指纹，漏了它就会「改了筛选、
//   保存按钮没脏点、ssa/last 也不落盘」—— 指纹与触发源必须同进同出。
watch([scope, groupIds, sections, reportName, d, filt], scheduleSaveState, { deep: true })

// —— 三个对话框（保存为新配置 / 离开已改动配置 / 确认）——
const confirmDlg = reactive({ open: false, msg: '' })
let _confirmResolve = null
function askConfirm(msg) { confirmDlg.msg = msg; confirmDlg.open = true; return new Promise((res) => { _confirmResolve = res }) }
function answerConfirm(ok) { confirmDlg.open = false; const r = _confirmResolve; _confirmResolve = null; if (r) r(ok) }
const leaveDlg = reactive({ open: false, name: '' })
let _leaveResolve = null
function leaveAnswer(ans) { leaveDlg.open = false; const r = _leaveResolve; _leaveResolve = null; if (r) r(ans) }
async function guardedLeave() {
  if (!isDirty()) return true
  const ans = await new Promise((res) => { leaveDlg.name = cfgTree.activeName(); leaveDlg.open = true; _leaveResolve = res })
  if (ans === 'cancel') return false
  // 选了「保存」而没存进去就不放行：改动还在窗口里，用户看到失败提示后可重试或改选「不保存」
  if (ans === 'save') return await updateConfig()
  return true
}

// 新配置的出厂名 = 报告名 + 存盘时刻（「空间态势报告 09-16 23:40」/「中国 载荷 空间态势报告 09-16 23:40」）。
// 不走 lbAutoName.newCfgName() 的序号名（配置 1 / 配置 2…）：这里一份配置就是「一份报告的出法」，
// 范围与筛选一变报告就换了个东西，序号名在列表里全长一个样，隔天自己都认不出来。
// 时刻过显示时区档（与功能区读数同一套），只到分 —— 同一分钟里连存两份由配置树自己去重。
function defaultCfgName() {
  const t = tzParts(Date.now(), tzMode.value)
  const stamp = `${p2(t.mo)}-${p2(t.d)} ${p2(t.h)}:${p2(t.mi)}`
  const title = (reportName.value || '').trim() || autoTitle.value
  return `${title} ${stamp}`
}

const cfgTree = useConfigTree({
  ns: 'ssa', orbitType: ORBIT, api, storageKey: 'ssa/cfgExpanded',
  toast, blankState, serializeState, applyState, setBaseline, guardedLeave, askConfirm, defaultCfgName
})
const {
  configs, activeId, focusId, expandedFolders, editing, cfgClip, cfgDlg, ctxMenu,
  loadConfigs, selectConfig,
  openSaveDlg, confirmCfgDlg, updateConfig, saveCurrent,
  toggleFolder, expandAll, collapseAll,
  addFolder, addBlankConfig, onDeleteItem, onMove, moveToRoot,
  startRename, commitRename, cancelRename,
  copyItem, cutItem, pasteConfig, ctxItem, ctxIsFolder, openCtx, closeCtx, onCfgKey
} = cfgTree

const appVersion = ref('')
const deviceId = ref('')

onMounted(async () => {
  try { appVersion.value = (api && await api.app.version()) || '' } catch (e) { appVersion.value = '' }
  await loadConfigs()
  try {
    const raw = localStorage.getItem(STATE_KEY)
    if (raw) {
      const st = JSON.parse(raw)
      const c = st.activeId && configs.value.find((x) => x.id === st.activeId)
      if (c) { activeId.value = c.id; applyState(c.state); setBaseline(); applyState(st) }
      else applyState(st)                                  // 无归属配置：仍恢复上次的设置，不聚焦任何配置
      dirtyFlag.value = isDirty()
    }
  } catch (e) { /* ignore */ }
  try { deviceId.value = (api && await api.app.deviceId()) || '' } catch (e) { deviceId.value = '' }
  data.load()                                              // 缓存先到、联网在后：一律不 await
  // 关窗序：守卫（可保存 / 取消）→ 冲刷工作状态 → 放行关闭
  api?.ssa?.onCloseRequested?.(async () => {
    let go = false
    try { go = await guardedLeave() } catch (e) { toast(byLang('关闭前保存失败：', 'Save before close failed: ') + errText(e)); return }
    if (!go) return
    flushSaveState(); api.ssa.confirmClose()
  })
  // 本窗口自己刷新时（开发态）也把工作状态落下
  window.addEventListener('beforeunload', flushSaveState)
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
      :menu="ctxMenu" :item="ctxItem" :is-folder="ctxIsFolder" :clip="cfgClip" :has-api="!!api"
      @close="closeCtx" @rename="startRename" @new-folder="addFolder" @new-config="addBlankConfig"
      @save-new="openSaveDlg" @cut="cutItem" @copy="copyItem" @paste="pasteConfig" @move-root="moveToRoot"
      @delete="onDeleteItem" @expand-all="expandAll" @collapse-all="collapseAll" @hide="sideView = ''"
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
              <button class="lbr-big primary" :disabled="generating || !canGenerate" :title="canGenerate ? '按当前数据与报告设置生成电子报告' : '尚无编目与星历数据'" @click="generate">
                <svg viewBox="0 0 16 16" class="lbr-svg fill"><path d="M4 2.5 13 8 4 13.5z" /></svg>
                {{ generating ? '生成中…' : '生成' }}
              </button>
              <button class="lbr-big" :disabled="!model" :title="model ? '导出 Word（封面 · 目录 · 正文 · 附录）' : '尚无报告'" @click="openReportDialog">
                <Icon name="file-down" :size="16" />导出 Word
              </button>
              <button class="lbr-big" :disabled="!api" :title="activeId ? '保存修改到当前配置' : '保存为新配置'" @click="saveCurrent">
                <svg viewBox="0 0 16 16" class="lbr-svg"><path d="M2.5 2.5h8l3 3v8h-11z" /><path d="M5 2.5v4h5v-4" /><rect x="5" y="9" width="6" height="4.5" /></svg>
                保存<span v-if="dirtyFlag" class="lbx-dirty" title="有未保存的修改"></span>
              </button>
              <button class="lbr-big" :disabled="!api" title="另存为新配置" @click="openSaveDlg">
                <svg viewBox="0 0 16 16" class="lbr-svg"><path d="M2.5 2.5h8l3 3v8h-11z" /><path d="M5 2.5v4h5v-4" /><path d="M8 8.5v4.5" /><path d="M5.8 10.7 8 8.5l2.2 2.2" /></svg>
                另存
              </button>
              <button class="lbr-big" :class="{ on: sideView === 'configs' }" title="左侧栏显示「配置列表」" @click="toggleSide('configs')"><Icon name="panel-left" :size="16" />配置列表</button>
            </div>
            <div class="lbr-cap">报告</div>
          </div>

          <div class="lbr-g">
            <div class="lbr-items">
              <button class="lbr-big" :class="{ spin: data.busy.value }" :disabled="!api || data.busy.value" title="重新联网取编目与星历（清熔断、绕过「今天已试过直连」的记账）" @click="data.refresh">
                <svg viewBox="0 0 16 16" class="lbr-svg"><path d="M13 8a5 5 0 1 1-1.46-3.54" /><path d="M13 2.6v2.6h-2.6" /></svg>
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

          <div class="lbr-status">
            <span v-if="notice" class="lb-note">{{ notice }}</span>
            <span v-if="data.err.value" class="lb-hint"><Icon name="alert-triangle" :size="12" /> <span data-i18n-skip>{{ data.err.value }}</span></span>
            <span v-if="!api" class="lb-hint"><Icon name="alert-triangle" :size="12" /> 需在桌面客户端中运行</span>
            <span v-if="dataNewer" class="lbx-stale" title="联网版数据已到，报告仍是按旧数据排的；点「生成」按新数据重出">
              <span>报告</span><span data-i18n-skip>{{ fmtHm(modelAt) }}</span><span data-i18n-skip>·</span><span>数据</span><span data-i18n-skip>{{ fmtHm(data.dataAt.value) }}</span>
            </span>
          </div>
        </div>

        <div class="ssa-main">
          <!-- 目录导轨：点击滚动、滚动高亮（章节锚点由 SsaDoc 打在 data-sec 上） -->
          <nav v-if="toc.length" class="ssa-toc">
            <button v-for="it in toc" :key="it.key" class="ssa-toc-i" :class="{ on: curSec === it.key }" :title="it.title" @click="gotoSec(it.key)">
              <span class="ssa-toc-no" data-i18n-skip>{{ it.no }}</span>
              <span class="ssa-toc-t" data-i18n-skip>{{ it.title }}</span>
            </button>
          </nav>
          <div ref="flowEl" class="lbx-flow ssa-flow" @scroll="onFlowScroll">
            <div v-if="genStep" class="lb-placeholder" data-i18n-skip>{{ genStep }}</div>
            <div v-else-if="!model" class="lb-placeholder">尚无报告。</div>
            <SsaDoc v-else ref="docRef" :model="model" />
          </div>
        </div>
      </section>

      <!-- ③ 右：报告设置 -->
      <aside class="lb-col lb-side lb-insp" :class="{ resizing: inspResizing }" :style="{ width: inspWidth + 'px' }">
        <div class="lb-col-hd"><span class="lb-cfg-hd-t">报告设置</span></div>
        <div class="lb-col-bd">
          <div class="srow"><label title="留空＝按报告主体与筛选自动命名；导出对话框里还可再改这一次的名字">报告名称</label>
            <input class="ci" type="text" v-model="reportName" :placeholder="autoTitle" />
          </div>

          <div class="lbx-sla-cap ssa-cap-row">
            <span>统计范围</span>
            <button v-if="anyFilter" class="lb-mini ssa-cap-btn" title="四道筛选全部清空，回到整份编目；报告主体与卫星组不动" @click="clearFilters">清空筛选</button>
          </div>
          <div class="srow"><label title="全量编目＝整份编目一份通用统计；卫星组＝只讲勾选的那几个组，每组一章">报告主体</label>
            <div class="lbu-seg">
              <button :class="{ on: scope === 'all' }" title="整份编目：8 章通用统计" @click="scope = 'all'">全量编目</button>
              <button :class="{ on: scope === 'groups' }" title="只讲勾选的那几个卫星组，一组一章" @click="scope = 'groups'">卫星组</button>
            </div>
          </div>
          <div v-if="scope === 'groups' && data.groups.value.length" class="srow ssa-pickrow"><label title="卫星组由「星座 3D」页的组管理器维护，本窗口只读">卫星组</label>
            <button class="lb-mini ssa-pickbtn" :class="{ on: groupIds.length }" @click="openGroupPick">
              <span data-i18n-skip>{{ groupBtnText }}</span><Icon name="chevron-down" :size="11" />
            </button>
          </div>
          <div v-else-if="scope === 'groups'" class="lb-placeholder">还没有卫星组。</div>
          <div class="srow ssa-pickrow"><label title="按卫星名称前缀近似归类（STARLINK / ONEWEB / …），与 CelesTrak 的 GROUP 名单不完全等价">典型星座</label>
            <button class="lb-mini ssa-pickbtn" :class="{ on: filt.constellations.length }" data-i18n-skip @click="openPick('constellations', $event)">
              {{ filtBtnText('constellations') }}
            </button>
          </div>
          <div class="srow ssa-pickrow"><label title="SATCAT 的 OWNER 代码；与 ITU 申报国、外空物体登记国都不是一回事">所有者</label>
            <button class="lb-mini ssa-pickbtn" :class="{ on: filt.owners.length }" data-i18n-skip @click="openPick('owners', $event)">
              {{ filtBtnText('owners') }}
            </button>
          </div>
          <div class="srow ssa-chips"><label title="按 classifyOrbit 的结果比对；勾了任一档之后，根数为空、判不出区制的对象一律落选">轨道区制</label>
            <div class="ssa-chipbox">
              <button class="ssa-chip any" :class="{ on: !filt.regimes.length }" data-i18n-skip @click="filt.regimes.splice(0)">{{ anyText }}</button>
              <label v-for="r in regimeOptions" :key="r.key" class="ssa-chip" :class="{ on: filterOn('regimes', r.key) }">
                <input type="checkbox" :checked="filterOn('regimes', r.key)" @change="toggleFilter('regimes', r.key)" />
                <span>{{ r.label }}</span>
              </label>
            </div>
          </div>
          <div class="srow ssa-chips"><label title="SATCAT 的 OBJECT_TYPE 字段">对象类型</label>
            <div class="ssa-chipbox">
              <button class="ssa-chip any" :class="{ on: !filt.types.length }" data-i18n-skip @click="filt.types.splice(0)">{{ anyText }}</button>
              <label v-for="t in typeOptions" :key="t.key" class="ssa-chip" :class="{ on: filterOn('types', t.key) }">
                <input type="checkbox" :checked="filterOn('types', t.key)" @change="toggleFilter('types', t.key)" />
                <span>{{ t.label }}</span>
              </label>
            </div>
          </div>

          <div class="lbx-sla-cap">章节</div>
          <label v-for="s in SECTIONS" :key="s.key" class="ssa-chk"
                 :title="scope === 'groups' ? '卫星组范围的章节由所选的组决定：一组一章，前有「数据来源与口径」、后有「附录」' : (s.fixed ? '数据时间、来源与判据：一份交付报告必须写明，故不可关' : '关掉整章不进报告')">
            <input type="checkbox" :checked="sections[s.key]" :disabled="s.fixed || scope === 'groups'" @change="sections[s.key] = $event.target.checked" />
            <span class="ssa-chk-t">{{ secLabel(s) }}</span>
          </label>

          <div class="lbx-sla-cap">参数</div>
          <div class="srow"><label title="「近期新发射 / 陨落明细」两张表回溯的天数（按 UTC 日历日）">近期明细</label>
            <input class="ci" type="number" min="1" max="365" step="1" v-model="d.recentDays" @change="commitNum('recentDays', { min: 1, max: 365, def: 30, int: true })" />
            <span class="u">天</span>
          </div>
          <div class="srow"><label title="所有者表与排名条图各列出多少条（按在轨载荷降序）">所有者榜</label>
            <input class="ci" type="number" min="1" max="50" step="1" v-model="d.topN" @change="commitNum('topN', { min: 1, max: 50, def: 15, int: true })" />
            <span class="u">项</span>
          </div>
          <div class="srow"><label title="「近 24 个月逐月发射与陨落」表回溯的月数；「在轨对象累计」图不受它约束，恒从 1957 年画起">逐月序列</label>
            <input class="ci" type="number" min="1" max="120" step="1" v-model="d.months" @change="commitNum('months', { min: 1, max: 120, def: 24, int: true })" />
            <span class="u">月</span>
          </div>
          <div class="srow"><label title="成员表、近期明细这类大表最多印多少行；超出的不印，题注后给出「共 N 条」。屏上与 Word 同一个上限">大表行数</label>
            <input class="ci" type="number" min="10" max="5000" step="10" v-model="d.rowCap" @change="commitNum('rowCap', { min: 10, max: 5000, def: 500, int: true })" />
            <span class="u">行</span>
          </div>
          <div class="srow"><label title="GEO 轨道弧的重点区间：报告第 7 章按这一段单列一张卫星清单。输入按东经为正、西经为负，右侧角标即当前值落在东经还是西经">GEO 弧段</label>
            <input class="ci" type="text" inputmode="decimal" v-model="d.arcLo" @change="commitArc" />
            <span class="u">{{ lonTag(d.arcLo) }}</span>
            <input class="ci" type="text" inputmode="decimal" v-model="d.arcHi" @change="commitArc" />
            <span class="u">{{ lonTag(d.arcHi) }}</span>
          </div>
        </div>
        <div class="lb-cfg-resizer ssa-insp-resizer" title="拖动调整栏宽" @mousedown.prevent="startResize('insp', $event)"></div>
      </aside>
    </div>

    <!-- 卫星组多选下拉 -->
    <div v-if="groupPick.open" class="lb-ctx-mask" @click="groupPick.open = false" @contextmenu.prevent="groupPick.open = false">
      <div class="lb-ctx ssa-pick" :style="{ left: groupPick.x + 'px', top: groupPick.y + 'px' }" @click.stop>
        <div v-if="!data.groups.value.length" class="lb-placeholder">还没有卫星组。</div>
        <label v-for="g in data.groups.value" :key="g.id" class="ssa-chk">
          <input type="checkbox" :checked="groupIds.indexOf(g.id) > -1" @change="toggleGroup(g.id)" />
          <span class="ssa-chk-t" :title="g.name" data-i18n-skip>{{ g.name }}</span>
          <span class="ssa-chk-n" data-i18n-skip>{{ g.sats.length }}</span>
        </label>
      </div>
    </div>

    <!-- 典型星座 / 所有者 多选浮层（所有者有 136 个代码，带即打即筛的搜索框）-->
    <div v-if="pick.open" class="lb-ctx-mask" @click="pick.open = false" @contextmenu.prevent="pick.open = false">
      <div class="lb-ctx ssa-pick" :style="{ left: pick.x + 'px', top: pick.y + 'px' }" @click.stop>
        <input v-if="pick.dim === 'owners'" ref="pickKwEl" class="ci ssa-pickkw" type="text" v-model="pick.kw" placeholder="代码或名称" />
        <div v-if="!pickList.length" class="lb-placeholder">没有匹配项。</div>
        <label v-for="it in pickList" :key="it.key" class="ssa-chk">
          <input type="checkbox" :checked="filterOn(pick.dim, it.key)" @change="toggleFilter(pick.dim, it.key)" />
          <span class="ssa-chk-t" :title="it.label">{{ it.label }}</span>
        </label>
      </div>
    </div>

    <SsaReportDialog
      :open="reportOpen" :model="model" :lang="langNow" store-key="ssa"
      :default-name="reportFile" :busy="generating"
      @close="reportOpen = false" @done="onReportDone" @error="onReportError"
    />

    <div v-if="cfgDlg.open" class="lb-mask" @click="cfgDlg.open = false">
      <div class="lb-dlg" @click.stop>
        <div class="lb-dlg-hd">保存为新配置</div>
        <div class="lb-dlg-bd"><input v-model="cfgDlg.name" class="lb-input" placeholder="配置名称" @keyup.enter="confirmCfgDlg" /></div>
        <div class="lb-dlg-ft">
          <button class="lb-mini" @click="cfgDlg.open = false">取消</button>
          <button class="lb-mini primary" @click="confirmCfgDlg">保存</button>
        </div>
      </div>
    </div>

    <div v-if="leaveDlg.open" class="lb-mask" @click="leaveAnswer('cancel')">
      <div class="lb-dlg" @click.stop>
        <div class="lb-dlg-hd">配置已修改</div>
        <div class="lb-dlg-bd"><div class="lb-share-row">「<b data-i18n-skip>{{ leaveDlg.name }}</b>」有未保存的修改，是否保存？</div></div>
        <div class="lb-dlg-ft">
          <button class="lb-mini" @click="leaveAnswer('cancel')">取消</button>
          <button class="lb-mini" @click="leaveAnswer('discard')">不保存</button>
          <button class="lb-mini primary" @click="leaveAnswer('save')">保存</button>
        </div>
      </div>
    </div>

    <div v-if="confirmDlg.open" class="lb-mask" @click="answerConfirm(false)">
      <div class="lb-dlg" @click.stop>
        <div class="lb-dlg-hd">确认</div>
        <div class="lb-dlg-bd"><div class="lb-share-row" data-i18n-skip>{{ confirmDlg.msg }}</div></div>
        <div class="lb-dlg-ft">
          <button class="lb-mini" @click="answerConfirm(false)">取消</button>
          <button class="lb-mini primary" @click="answerConfirm(true)">确定</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* —— 工作台外壳（.lb-* 一族）——
   这套类是各工作台窗口共用的「壳」，但它们从来是各 App 在自己的 <style scoped> 里各写一份
   （scoped 会给选择器缀上 data-v-，别的组件根本吃不到）。少了这一层，深色主题下按钮退回浏览器
   默认样式——UA 给浅灰实底、字色继承 .lb-shell 的近白墨色，于是「白底白字」。
   故照 E2eLinkBudgetApp 的同名规则原样抄来（改动须与另四窗同步）。 */
.lb-shell {
  display: flex; flex-direction: column; height: 100vh;
  background: var(--bg); color: var(--text); font-family: var(--font-ui);
  --ok: #4a7a62; --warn: #8a7038; --danger: #9c5751;
}
html[data-theme='dark'] .lb-shell { --ok: #6f9d85; --warn: #b59a5e; --danger: #c08079; }

/* 功能区「数据」组的刷新按钮：取数中图标旋转（按钮本体走公共 .lbr-big） */
.lbr-big.spin .lbr-svg { animation: lb-spin .7s linear infinite; transform-origin: 50% 50%; }
@keyframes lb-spin { to { transform: rotate(360deg); } }
.lb-hint { color: var(--warn); font-size: var(--fs-2); display: inline-flex; align-items: center; gap: 4px; }
.lb-note { color: var(--ok); font-size: var(--fs-2); max-width: 380px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.lb-body { flex: 1; display: flex; min-height: 0; }
.lb-col { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--border); }
.lb-col:last-child { border-right: none; }
/* 栏宽不过渡：拖宽是逐帧跟手的，过渡只会让栏宽落后指针一截 */
.lb-side { flex: none; position: relative; }
.lb-side.resizing { transition: none; user-select: none; }
.lb-cfg-resizer { position: absolute; top: 0; right: 0; width: 6px; height: 100%; cursor: col-resize; z-index: 6; }
.lb-cfg-resizer:hover, .lb-side.resizing .lb-cfg-resizer { background: var(--accent); opacity: .35; }
/* 检查器的拖宽缝在【左】缘：它贴在窗口右沿，往右拖是收窄（见 startResize 的取负） */
.ssa-insp-resizer { right: auto; left: 0; }
.lb-configs .lb-col-hd { padding: 0 8px; gap: 6px; }
/* 不写标准的滚动条宽度 / 颜色属性：Chromium 121+ 见到它就整条忽略 ::-webkit-scrollbar，滚动条退回系统粗条 */
.lb-configs .lb-col-bd { padding: 10px 8px; }
.lb-insp { border-right: none; border-left: 1px solid var(--border); }
.lb-insp .lb-col-bd { padding: 10px 10px 16px; display: flex; flex-direction: column; gap: 5px; font-size: var(--fs-3); }
.lb-insp .lbx-sla-cap { margin-top: 8px; }
.lb-cfg-hd-t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lb-build { flex: 1; min-width: 460px; }

.lb-col-hd { display: flex; align-items: center; justify-content: space-between; gap: 8px; height: 30px; flex: none; padding: 0 12px; font-size: var(--fs-2); font-weight: 600; letter-spacing: var(--ls-label); text-transform: uppercase; background: var(--surface-2); border-bottom: 1px solid var(--border); color: var(--text-muted); }
.lb-col-bd { flex: 1; overflow: auto; padding: 12px; }
.lb-mini { font: inherit; font-size: var(--fs-2); line-height: 1; padding: 3px 8px; cursor: pointer; background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl); display: inline-flex; align-items: center; justify-content: center; gap: 4px; }
.lb-mini:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.lb-mini:disabled { opacity: .45; cursor: not-allowed; }
.lb-mini.primary { background: var(--accent-ui); color: var(--bg); border-color: var(--accent-ui); }
/* 机位色主按钮悬停（P1）：换深一档底色，字色显式写 --bg——半透明悬停会把底下的纸色透上来 */
.lb-mini.primary:hover:not(:disabled) { color: var(--bg); background: var(--accent-ui-hover); border-color: var(--accent-ui-hover); }
.lb-mini-ico { display: inline-flex; align-items: center; justify-content: center; height: var(--h-ctl); white-space: nowrap; padding: 0 5px; }
.lb-placeholder { color: var(--text-faint); font-size: var(--fs-3); text-align: center; line-height: 1.7; padding: 10px 0; }
.lb-cfg-acts { display: flex; gap: 4px; }
.lb-myid { flex: none; display: flex; align-items: center; gap: 4px; padding: 6px 12px; font-size: var(--fs-2); color: var(--text-muted); border-top: 1px solid var(--border); background: var(--surface); white-space: nowrap; overflow: hidden; }
.lb-myid b { font-family: var(--font-code); color: var(--text); letter-spacing: var(--ls-tight); overflow: hidden; text-overflow: ellipsis; }

/* 遮罩全软件一档（--scrim），瞬时出现；框体 160ms 入场，出场瞬时 */
.lb-mask { position: fixed; inset: 0; z-index: 300; display: flex; align-items: center; justify-content: center; background: var(--scrim); }
.lb-dlg { width: 380px; display: flex; flex-direction: column; background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--r-card); box-shadow: var(--shadow-3); overflow: hidden; animation: ui-dlg-in var(--dur-3) var(--ease-out); }
.lb-dlg-hd { display: flex; align-items: center; gap: 8px; padding: 10px 12px; font-size: var(--fs-2); font-weight: 600; letter-spacing: var(--ls-label); text-transform: uppercase; color: var(--text-muted); background: var(--surface-2); border-bottom: 1px solid var(--border); }
.lb-dlg-bd { padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.lb-dlg-ft { display: flex; justify-content: flex-end; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--border); background: var(--surface); }
.lb-input { font: inherit; font-size: var(--fs-3); padding: 6px 9px; background: var(--field-bg); color: var(--text); border: 1px solid var(--field-border); border-radius: var(--r-ctl); }
.lb-input:focus { outline: none; border-color: var(--accent-ui); }
.lb-share-row { font-size: var(--fs-3); color: var(--text-muted); }

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
.ssa-toc-i:hover { color: var(--text); background: var(--bg); }
.ssa-toc-i.on { color: var(--text); background: var(--bg); border-color: var(--border); box-shadow: inset 2px 0 0 var(--accent-ui); }
.ssa-toc-no { flex: none; min-width: 16px; font-family: var(--font-mono); color: var(--text-faint); font-variant-numeric: tabular-nums; }
.ssa-toc-i.on .ssa-toc-no { color: var(--text); }
.ssa-toc-t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ssa-flow { padding: 10px 16px 24px; }

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
