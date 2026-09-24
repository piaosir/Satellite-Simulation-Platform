<script setup>
// 「导出空间态势报告」对话框。
//
// 与链路预算那个对话框（components/LbReportDialog.vue）是同一族观感与同一套存储口径，但只出一种
// 文件：.docx。没有 Excel / PDF 开关 —— 这份报告是给人读的公文，表格与图都排在 Word 里。
//
// 分工：数全在模型里（shared/ssaReport.js 的 buildSsaModel），本对话框只收一次导出的口径 ——
// 封面与页眉要写的五项元信息 + 台标 + 报告字体 + 含不含图。
//
// 两条出口，按有没有 model 这个 prop 分流，**只能走一条**（都走会导出两遍）：
//   · 给了 model（SsaApp 现在走的就是这条）：本对话框自己走完全程 —— 深拷模型 → 换元信息 →
//     逐图按印刷档栅格化 → report.exportReport（见下 runSelf），完事发 done / error；
//   · 不给 model：只发 submit，写盘由调用方接着做。
//     submit 载荷 = { doc: { …五项, logo, fonts }, withFigures, formats: ['docx'] }。
// ★ 自走那条路上的「模型落成纯数据」不是洁癖：模型在窗口里是 Vue 的响应式代理，结构化克隆过不去，
//   ipcRenderer.invoke 会抛且静默（memory「IPC 不能收响应式代理」）。
import { reactive, ref, computed, watch, onBeforeUnmount } from 'vue'
import Icon from '../components/Icon.vue'
import { DOC_FIELDS } from '../shared/lbReport.js'
// 台标读写走公共件（从 LbReportDialog 搬出来的那份）：全局键 lb/report/logo，与链路预算三窗共用
// 同一枚台标。svgSize 顺带用来读 chartSvg 出的那幅 SVG 的内在高度（栅格化要按它定 PNG 尺寸）。
import { svgSize, fileToPng, urlToPng, saveLogo, loadLogo } from '../shared/reportLogo.js'
import appLogoUrl from '../assets/logo.png'
import { REPORT_FONT_DEF, reportFontOf, normReportFontSel, reportFontOptions, composeReportFonts, reportFontLabel } from '../shared/lbReportFont.js'
import { chartSvg } from '../shared/ssaChartSvg.js'
import { svgToPngDataUrl } from '../shared/freqPlanRender.js'

const props = defineProps({
  open: { type: Boolean, default: false },
  lang: { type: String, default: 'zh' },
  // 报告名的出厂值（窗口按范围拼：「空间态势报告」/「<组名> 空间态势报告」）。用户改过一次就钉死，
  // 没改过就随它走 —— 判据是「上次存的名 === 上次存的出厂名」，见 loadSaved。
  defaultTitle: { type: String, default: '' },
  // 'all' | 'groups'：只用来在抬头右侧出一行范围读数
  scope: { type: String, default: '' },
  // 本份报告有几幅图：为 0 时「含图」点不动
  figCount: { type: Number, default: 0 },
  // 元信息 / 标题 / 字体的存储前缀：本窗口一律 'ssa'（台标另走全局键，见 reportLogo.js）
  storeKey: { type: String, default: 'ssa' },
  // 外部占着（窗口正在取图 / 写盘）：与本对话框自己的 busy 合并成一把锁
  busy: { type: Boolean, default: false },
  // { text, done, total }：窗口壳推进的进度。自走那条路上由本组件自己填。
  progress: { type: Object, default: null },
  // ★ 给了它就是「自己走完全程」（栅格化 + 发 IPC），见文件头。SsaApp 不传。
  model: { type: Object, default: null },
  // 自走时的缺省文件名（任务书 §7.2）；不给按模型自带的、再不行按报告名 + 日期兜底
  defaultName: { type: String, default: '' }
})
const emit = defineEmits(['close', 'submit', 'done', 'error'])

const errText = (e) => (e && e.message) || String(e)
const L = (zh, en) => (props.lang === 'en' ? en : zh)

const KEY = computed(() => props.storeKey + '/report/doc')
const OPT_KEY = computed(() => props.storeKey + '/report/opt')
const TITLE_KEY = computed(() => props.storeKey + '/report/title')
// 报告字体（三档：西文与数字 / 中文正文 / 中文标题与题注）：按窗口各存各的，与本窗的元信息同前缀
const FONT_KEY = computed(() => props.storeKey + '/report/font')

const font = reactive({ ...REPORT_FONT_DEF })
const fontOpts = ref({ latin: [], cjk: [] })     // 打开时再列（要探一遍本机装了哪些字体）
const doc = reactive({ title: '', docNo: '', classification: '', org: '', date: '', logo: null })
const opt = reactive({ figures: true })

const logoErr = ref('')
const logoInput = ref(null)
const logoName = ref('')
const err = ref('')
const busyOwn = ref(false)
const lock = computed(() => props.busy || busyOwn.value)
const prog = reactive({ text: '', done: 0, total: 0 })

// 报告名的出厂值：窗口给的那份；没给就退到模型里的报告名，再没有才用通名
const defTitle = () => props.defaultTitle
  || (props.model && props.model.doc && props.model.doc.title)
  || L('空间态势报告', 'Space Situational Awareness Report')
const today = () => {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// 图数：窗口给的优先（它握着模型），自走时按模型里有 spec 的那几幅数
const figIds = computed(() => Object.keys((props.model && props.model.figures) || {})
  .filter((k) => props.model.figures[k] && props.model.figures[k].spec))
const figN = computed(() => (props.model ? figIds.value.length : Math.max(0, props.figCount | 0)))
const scopeText = computed(() => {
  const s = props.model && props.model.scope
  const mode = (s && s.mode) || props.scope
  if (!mode) return ''
  if (mode !== 'groups') return L('全量编目', 'Full catalog')
  const names = ((s && s.groups) || []).map((g) => g.name).filter(Boolean)
  if (!names.length) return L('卫星组', 'Satellite groups')
  return names.length > 3 ? names.slice(0, 3).join('、') + ' …' : names.join('、')
})
// 进度读数：窗口壳推的优先，自走时用自己那份
const progress = computed(() => props.progress || (prog.text ? prog : null))

// 文件名：非法字符换 _（Windows 的保存对话框不接受它们）
const fileName = computed(() => {
  if (props.defaultName) return props.defaultName
  if (props.model && props.model.defaultName) return props.model.defaultName
  const base = String(doc.title || defTitle()).replace(/[\\/:*?"<>|]/g, '_').trim()
  return base + '_' + String(doc.date || today()).replace(/-/g, '')
})

// —— 台标（与链路预算三窗共用同一枚，存全局键 lb/report/logo）——
async function pickLogo(e) {
  const file = e.target.files && e.target.files[0]
  if (e.target) e.target.value = ''      // 同一个文件连选两次也要触发 change
  if (!file) return
  logoErr.value = ''
  try {
    doc.logo = await fileToPng(file)
    logoName.value = file.name || ''
    saveLogo(doc.logo, logoName.value)
  } catch (e2) {
    doc.logo = null
    logoName.value = ''
    logoErr.value = L('图片读取失败', 'Failed to read image') + '：' + errText(e2)
  }
}
const clearLogo = () => { doc.logo = null; logoName.value = ''; logoErr.value = ''; saveLogo(null, '') }
// 「用平台标志」：台标槽位空着时报告右上角就是空的，而多数场合用户要的只是「先放个能看的」。
// 用的是本软件自己的标志（src/assets/logo.png，同「关于」窗口那一枚），不涉任何第三方品牌；
// 换成本单位的台标仍走上面的「选择图片」，两个入口写的是同一个全局键。
const useAppLogo = async () => {
  logoErr.value = ''
  try {
    doc.logo = await urlToPng(appLogoUrl, 'logo.png')
    logoName.value = L('平台标志', 'Platform mark')
    saveLogo(doc.logo, logoName.value)
  } catch (e2) {
    logoErr.value = L('图片读取失败', 'Failed to read image') + '：' + errText(e2)
  }
}

// 本次打开时认下的「出厂名」（落盘时原样写回，见 loadSaved 里那段 ★）
let titleDefAtLoad = ''

function loadSaved() {
  let saved = null
  try { saved = JSON.parse(localStorage.getItem(KEY.value) || 'null') } catch (e) { saved = null }
  for (const f of DOC_FIELDS) {
    // 日期每次取今天；编号 / 密级 / 单位沿用上次填的
    if (f.key === 'title') doc.title = defTitle()
    else if (f.key === 'date') doc.date = today()
    else doc[f.key] = (saved && saved[f.key]) || ''
  }
  // 报告名按「自动命名」的规矩走（同资源库条目名）：用户没改过就随当前范围重算，改过一次就钉死。
  // 存的时候一并存下「当时的出厂名」，据此判断改没改过。
  // ★ 钉住之后不许再拿当前的出厂名去覆盖那一栏：没给 defaultTitle 时出厂名取自模型的报告名，
  //   而模型的报告名本身又可能是从这个钉住的名读来的（窗口建模型时会把钉住的名填进 doc.title）。
  //   一来一回两者就相等了，下次打开会被判成「没改过」，用户起的名当场丢。故一旦认出是钉住的，
  //   原样留着当时存下的那个出厂名。
  let ttl = null
  try { ttl = JSON.parse(localStorage.getItem(TITLE_KEY.value) || 'null') } catch (e) { ttl = null }
  const pinned = !!(ttl && ttl.title && ttl.titleDefault && ttl.title !== ttl.titleDefault)
  titleDefAtLoad = pinned ? ttl.titleDefault : defTitle()
  if (ttl && ttl.title) doc.title = (ttl.title === ttl.titleDefault) ? defTitle() : ttl.title
  const lg = loadLogo()
  doc.logo = lg.logo
  logoName.value = lg.name
  logoErr.value = ''
  err.value = ''
  try {
    const o = JSON.parse(localStorage.getItem(OPT_KEY.value) || 'null')
    if (o) opt.figures = o.figures !== false
  } catch (e) { /* 用默认 */ }
  if (!figN.value) opt.figures = false
  let fs = null
  try { fs = JSON.parse(localStorage.getItem(FONT_KEY.value) || 'null') } catch (e) { fs = null }
  Object.assign(font, normReportFontSel(fs))
  fontOpts.value = reportFontOptions()
}

// 元信息落盘。提交时要存，关闭时也要存——填完手一滑关掉了，再打开还在。
function persist() {
  try {
    // 台标不进这一份（它在全局键里，见 reportLogo.saveLogo）；标题另存（自动命名要认出厂名）
    localStorage.setItem(KEY.value, JSON.stringify(Object.assign({}, doc, { logo: null, title: undefined })))
    localStorage.setItem(TITLE_KEY.value, JSON.stringify({ title: doc.title, titleDefault: titleDefAtLoad || defTitle() }))
    localStorage.setItem(OPT_KEY.value, JSON.stringify({ figures: opt.figures }))
    localStorage.setItem(FONT_KEY.value, JSON.stringify(normReportFontSel(font)))
  } catch (e) { /* 存不下不影响导出 */ }
}

// 关闭只走这一条路：右上角 ✕ / 取消 / Esc。点遮罩不关——在输入框里选中文字拖到框外松手就会
// 让 click 落在遮罩上，一关就是几栏白填。
function close() {
  if (lock.value) return
  persist()
  emit('close')
}
function onKey(e) {
  if (e.key !== 'Escape' || e.isComposing || lock.value) return   // 组字中的 Esc 是取消组字，不是关窗
  e.stopPropagation()
  close()
}
const KEY_OPT = { capture: true }
watch(() => props.open, (v) => {
  if (v) { loadSaved(); window.addEventListener('keydown', onKey, KEY_OPT) }
  else window.removeEventListener('keydown', onKey, KEY_OPT)
}, { immediate: true })
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, KEY_OPT))

// —— 图件栅格化 ——
// 印刷档图宽 1200 px，栅格倍率 2（与 useLbReport 的 FIG_SCALE 同口径）：Word 里的图位限宽 82 mm，
// 2400 px 已合 700 dpi 以上，再往上只是把模型撑大几十兆过 IPC，印不出任何差别。
const FIG_W = 1200
const FIG_SCALE = 2
async function renderFigures(m) {
  const ids = Object.keys(m.figures || {})
  const cf = composeReportFonts(font)
  // chartSvg 的 print 档要两个**字体族名**（写进每个 <text> 的 font-family）：出厂档给 null，
  // 由它自己落到 Times New Roman / 宋体
  const fonts = cf ? { latin: cf.latin, cjkBody: cf.cjkBody } : null
  prog.total = ids.length
  for (let i = 0; i < ids.length; i++) {
    const f = m.figures[ids[i]]
    prog.done = i
    prog.text = L('出图', 'Rendering figures')
    if (!f) continue
    if (!f.spec) { f.png = null; continue }
    try {
      const svg = chartSvg(f.spec, { theme: 'print', width: FIG_W, fonts, lang: m.lang })
      const size = svgSize(svg)
      const w = (size && size.w) || FIG_W
      const h = (size && size.h) || Math.round(FIG_W * 0.6)
      f.png = await svgToPngDataUrl(svg, Math.round(w * FIG_SCALE), Math.round(h * FIG_SCALE))
    } catch (e) {
      // 一幅图出不来只少这一幅：Word 端见 png 为 null 整块跳过，不该连累整份报告
      f.png = null
      console.warn('[ssa] 图栅格化失败：' + ids[i], e)
    }
  }
  prog.done = ids.length
}

function fail(msg) { err.value = msg; emit('error', msg) }

const canSubmit = computed(() => !lock.value && (!props.model || !!(props.model.sections || []).length))

// 「自己走完全程」那条路（只在给了 model 时走，见文件头）：栅格化 → 落纯数据 → 发 IPC
async function runSelf() {
  const api = typeof window !== 'undefined' ? window.api : null
  if (!api || !api.report || !api.report.exportReport) { fail(L('导出需在桌面客户端中运行', 'Export requires the desktop client')); return }
  busyOwn.value = true
  err.value = ''
  prog.text = ''; prog.done = 0; prog.total = 0
  try {
    // 深拷一份再改：模型是屏上那篇报告正在用的那份，png 不该写回它（也过不了 IPC，见文件头）
    const m = JSON.parse(JSON.stringify(props.model))
    // 元信息以对话框里填的为准，但 appVersion / generatedAt 是建模时写进去的，整份覆盖会把它们抹掉
    m.doc = Object.assign({}, m.doc, JSON.parse(JSON.stringify(doc)), { fonts: composeReportFonts(font) })
    if (opt.figures) await renderFigures(m)
    else for (const k of Object.keys(m.figures || {})) { if (m.figures[k]) m.figures[k].png = null }
    prog.text = L('排版与写盘…', 'Laying out and writing files…'); prog.done = 1; prog.total = 1
    const r = await api.report.exportReport({ model: m, formats: ['docx'], defaultName: fileName.value })
    if (r && r.ok) { emit('done', r); emit('close') }
    else if (r && !r.canceled) fail(L('导出失败：', 'Export failed: ') + (r.error || L('未知错误', 'unknown error')))
  } catch (e) {
    fail(L('导出失败：', 'Export failed: ') + errText(e))
  } finally {
    busyOwn.value = false
    prog.text = ''; prog.done = 0; prog.total = 0
  }
}

function submit() {
  if (!canSubmit.value) return
  persist()
  err.value = ''
  // 给了 model 就自己走完，且**不再发 submit** —— 否则接了 submit 的调用方会把同一份报告再导一遍
  if (props.model) { runSelf(); return }
  // 交出去的那一份：元信息 + 台标 + 三档字体（三档都是出厂值时 fonts 为 null，主进程走模板默认）
  emit('submit', {
    doc: Object.assign(JSON.parse(JSON.stringify(doc)), { fonts: composeReportFonts(font) }),
    withFigures: !!opt.figures && figN.value > 0,
    formats: ['docx']
  })
}

const labelOf = (f) => (props.lang === 'en' ? f.labelEn : f.label)
const fontName = (f) => reportFontLabel(f, props.lang)
// 页脚那一行的读数：「Times New Roman + 宋体 / 黑体」（西文 + 中文正文 / 中文标题）
const fontText = computed(() => `${fontName(reportFontOf('latin', font.latin))} + ${fontName(reportFontOf('cjkBody', font.cjkBody))} / ${fontName(reportFontOf('cjkHead', font.cjkHead))}`)
</script>

<template>
  <div v-if="open" class="rd-mask">
    <div class="rd" role="dialog" aria-modal="true">
      <div class="rd-hd">
        <Icon name="file-down" :size="12" />导出空间态势报告
        <span class="rd-sp"></span>
        <span v-if="scopeText" class="rd-scheme" data-i18n-skip>{{ scopeText }}</span>
        <button class="rd-x" :disabled="lock" title="关闭" aria-label="关闭" @click="close">
          <Icon name="x" :size="12" />
        </button>
      </div>

      <div class="rd-bd">
        <!-- 元信息：封面与页眉页脚照此写 -->
        <div class="rd-grid">
          <label v-for="f in DOC_FIELDS" :key="f.key" class="rd-f" :class="{ wide: f.wide }">
            <span class="rd-l">{{ labelOf(f) }}</span>
            <input v-model="doc[f.key]" class="rd-in" type="text" :disabled="lock" />
          </label>
        </div>

        <!-- 台标：与链路预算三窗共用同一枚（全局键），选过一次下次直接在 -->
        <div class="rd-sec">LOGO</div>
        <div class="rd-logo">
          <div class="rd-logo-box" title="贴在每一页右上角">
            <img v-if="doc.logo && doc.logo.dataUrl" :src="doc.logo.dataUrl" alt="" />
            <Icon v-else name="image" :size="16" />
          </div>
          <button class="rd-btn" :disabled="lock" @click="logoInput && logoInput.click()">{{ doc.logo ? '更换' : '选择图片' }}</button>
          <button class="rd-btn" :disabled="lock" title="用本软件自己的标志（与「关于」窗口同一枚）" @click="useAppLogo">平台标志</button>
          <button class="rd-btn" :disabled="lock || !doc.logo" @click="clearLogo">移除</button>
          <span v-if="doc.logo" class="rd-logo-name" data-i18n-skip>{{ logoName }}<template v-if="logoName">　</template>{{ doc.logo.w }} × {{ doc.logo.h }} px</span>
          <input
            ref="logoInput" class="rd-file" type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml,.svg" @change="pickLogo" />
        </div>
        <div v-if="logoErr" class="rd-err">{{ logoErr }}</div>

        <!-- 报告字体：三档各选一款，按窗口记住 -->
        <div class="rd-sec" title="Word 只写字体名，排版在打开文档的机器上成形">字体</div>
        <div class="rd-fonts">
          <label class="rd-f">
            <span class="rd-l">西文</span>
            <select v-model="font.latin" class="rd-in rd-sel" data-i18n-skip :disabled="lock">
              <option v-for="f in fontOpts.latin" :key="f.key" :value="f.key" :style="{ fontFamily: f.stack }">{{ fontName(f) }}</option>
            </select>
          </label>
          <label class="rd-f">
            <span class="rd-l">中文正文</span>
            <select v-model="font.cjkBody" class="rd-in rd-sel" data-i18n-skip :disabled="lock">
              <option v-for="f in fontOpts.cjk" :key="f.key" :value="f.key" :style="{ fontFamily: f.stack }">{{ fontName(f) }}</option>
            </select>
          </label>
          <label class="rd-f">
            <span class="rd-l">中文标题</span>
            <select v-model="font.cjkHead" class="rd-in rd-sel" data-i18n-skip :disabled="lock">
              <option v-for="f in fontOpts.cjk" :key="f.key" :value="f.key" :style="{ fontFamily: f.stack }">{{ fontName(f) }}</option>
            </select>
          </label>
        </div>

        <div class="rd-sec">输出</div>
        <div class="rd-opts">
          <label class="rd-ck" :class="{ off: !figN }" title="图按印刷档重画一遍再贴进 Word（与屏上同一份 spec）">
            <input v-model="opt.figures" type="checkbox" :disabled="lock || !figN" />含图
          </label>
        </div>
        <div class="rd-hint">
          Word（.docx）　·　{{ figN }} 图　·　字体 <span data-i18n-skip>{{ fontText }}</span>　·　语言 {{ lang === 'en' ? 'English' : '中文' }}
        </div>
        <div v-if="model" class="rd-hint" data-i18n-skip>{{ fileName }}.docx</div>

        <div v-if="err" class="rd-err">{{ err }}</div>

        <div v-if="progress" class="rd-prog">
          <div class="rd-bar"><i :style="{ width: (progress.total ? Math.round(progress.done / progress.total * 100) : 0) + '%' }"></i></div>
          <div class="rd-ptext" data-i18n-skip>{{ progress.text }}<span v-if="progress.total"> · {{ progress.done }}/{{ progress.total }}</span></div>
        </div>
      </div>

      <div class="rd-ft">
        <button class="rd-btn" :disabled="lock" @click="close">取消</button>
        <button class="rd-btn primary" :disabled="!canSubmit" @click="submit">
          {{ lock ? '生成中…' : '生成报告' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* .rd-* 这一族与 components/LbReportDialog.vue 同名同值 —— 那份是 <style scoped>（选择器缀了
   data-v-，别的组件根本吃不到），故照抄一份本窗用得上的规则（改动须与那份同步）。 */
/* 遮罩瞬时出现（全软件一档 --scrim）；框体 160ms 升入，出场瞬时 */
.rd-mask { position: fixed; inset: 0; z-index: 320; display: flex; align-items: center; justify-content: center; background: var(--scrim); }
.rd {
  width: 560px; max-height: 88vh; display: flex; flex-direction: column;
  font-family: var(--lb-serif, var(--font-serif));
  background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--r-card, 3px);
  box-shadow: var(--shadow-3); overflow: hidden;
  animation: ui-dlg-in var(--dur-3) var(--ease-out);
}
.rd-hd {
  display: flex; align-items: center; gap: 6px; padding: 10px 12px;
  font-size: var(--fs-2); font-weight: 600; letter-spacing: var(--ls-label); text-transform: uppercase; color: var(--text-muted);
  background: var(--surface-2); border-bottom: 1px solid var(--border);
}
.rd-sp { flex: 1; }
.rd-scheme { letter-spacing: 0; text-transform: none; color: var(--text-faint); font-size: var(--fs-2); max-width: 15em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rd-x {
  display: inline-flex; align-items: center; justify-content: center; margin: -4px -4px -4px 4px;
  padding: 3px; font: inherit; color: var(--text-faint); cursor: pointer;
  background: transparent; border: 1px solid transparent; border-radius: var(--r-ctl, 2px);
}
.rd-x:hover:not(:disabled) { color: var(--text); background: var(--bg); border-color: var(--border); }
.rd-x:disabled { opacity: .35; cursor: not-allowed; }
.rd-bd { padding: 12px; overflow: auto; }
.rd-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 7px 10px; }
.rd-f { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.rd-f.wide { grid-column: 1 / -1; }
.rd-l { font-size: var(--fs-2); color: var(--text-muted); }
.rd-in {
  font: inherit; font-size: var(--fs-3); padding: 3px 6px; min-width: 0;
  background: var(--field-bg); color: var(--text); border: 1px solid var(--field-border); border-radius: var(--r-ctl, 2px);
}
.rd-in:focus { outline: none; border-color: var(--accent-ui); }
.rd-sec {
  margin: 12px 0 6px; padding-bottom: 3px; font-size: var(--fs-2); font-weight: 700; color: var(--text);
  border-bottom: 1px solid var(--lb-rule, var(--border));
}
.rd-logo { display: flex; align-items: center; gap: 8px; }
.rd-fonts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px 10px; }
.rd-sel { padding: 2px 4px; }
.rd-logo-box {
  display: flex; align-items: center; justify-content: center;
  width: 92px; height: 34px; padding: 2px; flex: 0 0 auto;
  color: var(--text-faint); background: var(--surface-2);
  border: 1px solid var(--border); border-radius: var(--r-ctl, 2px);
}
.rd-logo-box img { max-width: 100%; max-height: 100%; object-fit: contain; }
.rd-logo-name { font-size: var(--fs-2); color: var(--text-faint); font-variant-numeric: tabular-nums; }
.rd-file { display: none; }
.rd-err { margin-top: 5px; font-size: var(--fs-2); color: var(--danger, #b00000); }
.rd-opts { display: flex; gap: 16px; flex-wrap: wrap; }
.rd-ck { display: inline-flex; align-items: center; gap: 5px; font-size: var(--fs-3); color: var(--text); cursor: pointer; }
.rd-ck.off { color: var(--text-faint); cursor: not-allowed; }
.rd-ck input { margin: 0; }
.rd-hint { margin-top: 5px; font-size: var(--fs-2); color: var(--text-faint); line-height: 1.5; font-variant-numeric: tabular-nums; }
.rd-prog { margin-top: 10px; }
.rd-bar { height: 3px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-ctl); overflow: hidden; }
.rd-bar i { display: block; height: 100%; background: var(--accent); transition: width .2s linear; }
.rd-ptext { margin-top: 4px; font-size: var(--fs-2); color: var(--text-muted); }
.rd-ft { display: flex; justify-content: flex-end; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--border); background: var(--surface); }
/* 定高 --h-ctl（原靠内距撑出 21px）；主钮机位色，悬停压深一档、字色显式 --bg（通用悬停会把字染成 --text） */
.rd-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: var(--h-ctl);
  font: inherit; font-size: var(--fs-2); line-height: 1; padding: 0 12px; cursor: pointer;
  background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px);
}
.rd-btn:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.rd-btn:disabled { opacity: .45; cursor: not-allowed; }
.rd-btn.primary { background: var(--accent-ui); color: var(--bg); border-color: var(--accent-ui); }
.rd-btn.primary:hover:not(:disabled) { opacity: 1; color: var(--bg); background: var(--accent-ui-hover); border-color: var(--accent-ui-hover); }
</style>
