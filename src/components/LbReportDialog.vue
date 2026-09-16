<script setup>
// 「导出报告」对话框（GSO / NGSO / 再生式三窗共用）。
//
// 它管两件事：① 封面与页眉页脚要写的那几行元信息（报告编号 / 项目 / 编制单位 / 编制·校核·审核 /
// 密级），② 这一次导出的口径（出哪几种文件、带不带图）。元信息按窗口记在本地，下次打开就在——
// 同一个项目的报告要连着出好几份，每份都重填一遍编号和单位是不能忍的。
//
// 报告语言不在这里选：它跟随平台语言（设置▸语言），屏幕上的详细预算与导出的文件一起切换。
// 在这儿再放一个开关就会出现「屏幕是中文、导出是英文」。
import { reactive, ref, computed, watch, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
import { DOC_FIELDS, defaultDocInfo, schemeOf, schemeName, schemeSub, translate } from '../shared/lbReport.js'
import { slaReportTitle } from '../shared/lbSlaReport.js'
import { REPORT_FONT_DEF, reportFontOf, normReportFontSel, reportFontOptions, composeReportFonts, reportFontLabel } from '../shared/lbReportFont.js'
// 台标的栅格化与存取（2026-09-16 从本文件搬进 shared/reportLogo.js，零行为改动）：
// 空间态势报告那个导出对话框要用同一枚台标——它存的是全局键，抄一份必然漂移。
import { fileToPng, urlToPng, saveLogo, loadLogo } from '../shared/reportLogo.js'
import appLogoUrl from '../assets/logo.png'

const props = defineProps({
  open: { type: Boolean, default: false },
  // 'full' = 链路预算报告（原样）；'sla' = 独立的《服务等级指标（SLA）》报告：
  // 只出 Excel / Word（不出 PDF、不取图、没有「含服务等级指标」那个开关），标题另走 slaReportTitle。
  // 元信息（编号 / 密级 / 单位 / logo）与全报告【共用同一存储键】——同一个项目连着出两份文件，
  // 不该填两遍；只有标题的自动命名各存一份（改过一次就钉死，两份报告的名字本就不同）。
  variant: { type: String, default: 'full' },
  lang: { type: String, default: 'zh' },
  orbitType: { type: String, default: 'GEO' },
  // 再生式：一个 key（只讲一段链路）或一组 key（一份配置装了几个计算模块，报告按模块分节；抬头把各段并列）
  regenMode: { type: [String, Array], default: 'uplink' },
  // 分节读数 [{ key, label, count }]：装了哪些模块、各几条链路（再生式多模块时给；其余窗口不传）
  sections: { type: Array, default: null },
  satName: { type: String, default: '' },
  // 频段：只用来拼默认报告名（「CS10R 卫星 Ku 频段链路预算报告」）
  band: { type: String, default: '' },
  linkCount: { type: Number, default: 0 },
  // 图表区当前是否显示：关着的时候图取不到（组件根本没挂），据此提示并默认不勾「含图」
  vizAvailable: { type: Boolean, default: true },
  // 有「列入」条款的链路数：为 0 时「含服务等级指标（SLA）」整项不出现
  slaCount: { type: Number, default: 0 },
  storeKey: { type: String, default: 'lb' },
  busy: { type: Boolean, default: false },
  // { text, done, total }：导出过程中的进度，由上层逐条链路推进
  progress: { type: Object, default: null }
})
const emit = defineEmits(['close', 'submit'])

const t = computed(() => (s) => translate(s, props.lang))
const scheme = computed(() => schemeOf(props.orbitType, props.regenMode))
const schemeText = computed(() => schemeName(scheme.value, props.lang) + (schemeSub(scheme.value, props.lang) ? '　·　' + schemeSub(scheme.value, props.lang) : ''))

const isSla = computed(() => props.variant === 'sla')
const KEY = computed(() => props.storeKey + '/report/doc')
const OPT_KEY = computed(() => props.storeKey + (isSla.value ? '/sla/opt' : '/report/opt'))
// 标题的自动命名两份各存一份：全报告叫「…链路预算报告」、这一份叫「…服务等级指标（SLA）」
const TITLE_KEY = computed(() => props.storeKey + (isSla.value ? '/report/slaTitle' : '/report/title'))
const defTitle = () => (isSla.value
  ? slaReportTitle(props.satName, props.band, props.lang, scheme.value.orbitType)
  : defaultDocInfo(scheme.value, props.satName, props.lang, props.band).title)
// logo 存**全局**键（'lb/report/logo'，见 shared/reportLogo.js）：台标是一家单位的，
// 不是某个体制窗口的——传一次以后各窗口都认，除非用户自己换掉或移除。
// 报告字体（三档：西文与数字 / 中文正文 / 中文标题与题注）：按窗口各存各的、与本窗的元信息同前缀——
// GSO / NGSO / 再生式 / 端到端互相独立（用户 2026-09-07 定的）；全报告与 SLA 报告共用（同一个窗口
// 交出去的文件一套字体）。出厂 = 模板口径（Times New Roman / 宋体 / 黑体），见 shared/lbReportFont.js。
const FONT_KEY = computed(() => props.storeKey + '/report/font')
const font = reactive({ ...REPORT_FONT_DEF })
const fontOpts = ref({ latin: [], cjk: [] })   // 打开时再列（要探一遍本机装了哪些字体）

const doc = reactive(defaultDocInfo(scheme.value, props.satName, props.lang, props.band))
const opt = reactive({ xlsx: true, docx: true, pdf: true, figures: true, sla: true })

// —— 右上角 logo ——
// 贴在三份文件的右上角：Excel 每张工作表，Word 与 PDF 的每一页页眉。选图 → PNG dataURL 的
// 栅格化与存取都在 shared/reportLogo.js（矢量图也在那里转成 PNG：xlsx 与 docx 的图只吃位图）。
const logoErr = ref('')
const logoInput = ref(null)
const logoName = ref('')

async function pickLogo(e) {
  const file = e.target.files && e.target.files[0]
  if (e.target) e.target.value = ''      // 同一个文件连选两次也要触发 change
  if (!file) return
  logoErr.value = ''
  try {
    doc.logo = await fileToPng(file)
    logoName.value = file.name || ''
    saveLogo(doc.logo, logoName.value)
  } catch (err) {
    doc.logo = null
    logoName.value = ''
    logoErr.value = t.value('图片读取失败') + '：' + ((err && err.message) || String(err))
  }
}
const clearLogo = () => { doc.logo = null; logoName.value = ''; logoErr.value = ''; saveLogo(doc.logo, logoName.value) }
// 「用平台标志」：台标槽位空着时报告右上角就是空的，而多数场合用户要的只是「先放个能看的」。
// 用的是本软件自己的标志（src/assets/logo.png，同「关于」窗口那一枚），不涉任何第三方品牌；
// 换成本单位的台标仍走「选择图片」，两个入口写的是同一个全局键 lb/report/logo。
async function useAppLogo() {
  logoErr.value = ''
  try {
    doc.logo = await urlToPng(appLogoUrl, 'logo.png')
    logoName.value = t.value('平台标志')
    saveLogo(doc.logo, logoName.value)
  } catch (err) {
    logoErr.value = t.value('图片读取失败') + '：' + ((err && err.message) || String(err))
  }
}

function loadSaved() {
  const base = defaultDocInfo(scheme.value, props.satName, props.lang, props.band)
  base.title = defTitle()
  let saved = null
  try { saved = JSON.parse(localStorage.getItem(KEY.value) || 'null') } catch (e) { saved = null }
  for (const f of DOC_FIELDS) {
    // 日期每次取今天；其余（编号、项目、单位、签署）沿用上次填的
    doc[f.key] = (f.key === 'title' || f.key === 'date') ? base[f.key] : ((saved && saved[f.key]) || base[f.key])
  }
  // logo 从全局键取（与本窗口的元信息分开存），各窗口共用同一枚
  const lg = loadLogo()
  doc.logo = lg.logo
  logoName.value = lg.name
  logoErr.value = ''
  // 报告名称按「自动命名」的规矩走（同资源库条目名，见 shared/lbAutoName.js）：用户没改过就随
  // 当前卫星/体制重算，改过一次就钉死。存的时候一并存下「当时的默认名」，据此判断改没改过。
  let ttl = null
  try { ttl = JSON.parse(localStorage.getItem(TITLE_KEY.value) || 'null') } catch (e) { ttl = null }
  if (ttl && ttl.title) doc.title = (ttl.title === ttl.titleDefault) ? base.title : ttl.title
  try {
    const o = JSON.parse(localStorage.getItem(OPT_KEY.value) || 'null')
    if (o) { opt.xlsx = o.xlsx !== false; opt.docx = o.docx !== false; opt.pdf = o.pdf !== false; opt.figures = o.figures !== false; opt.sla = o.sla !== false }
  } catch (e) { /* 用默认 */ }
  if (!props.vizAvailable) opt.figures = false
  if (!props.slaCount) opt.sla = false
  if (isSla.value) opt.pdf = false      // 这一份不出 PDF
  // 报告字体：本窗上次选的（键认不出就回出厂档）；候选表按本机可用性现列（三个出厂档恒在列）
  let fs = null
  try { fs = JSON.parse(localStorage.getItem(FONT_KEY.value) || 'null') } catch (e) { fs = null }
  Object.assign(font, normReportFontSel(fs))
  fontOpts.value = reportFontOptions()
}

// 元信息落盘。提交时要存，关闭时也要存——十栏填完手一滑关掉了，再打开还在，不用从头填。
function persist() {
  try {
    // logo 不进这一份（它在全局键里，见 saveLogo）——否则三个窗口各存一份同样的图，白白撑爆配额。
    // 标题另存（两份报告的自动命名各走各的），故这一份里把它剔掉。
    localStorage.setItem(KEY.value, JSON.stringify(Object.assign({}, doc, { logo: null, title: undefined })))
    localStorage.setItem(TITLE_KEY.value, JSON.stringify({ title: doc.title, titleDefault: defTitle() }))
    localStorage.setItem(OPT_KEY.value, JSON.stringify({ xlsx: opt.xlsx, docx: opt.docx, pdf: opt.pdf, figures: opt.figures, sla: opt.sla }))
    localStorage.setItem(FONT_KEY.value, JSON.stringify(normReportFontSel(font)))
  } catch (e) { /* 存不下不影响导出 */ }
}

// 关闭只走这一条路：右上角 ✕ / 取消 / Esc。点遮罩不关——在输入框里选中文字拖到框外松手、
// 或拽「备注」右下角的缩放把手拖出边界，都会让 click 落在遮罩上，一关就是十栏白填。
function close() {
  if (props.busy) return
  persist()
  emit('close')
}
// 捕获阶段收 Esc：对话框在最上层，这一下就该是它的，不该再漏给下面的表格去取消单元格编辑
function onKey(e) {
  if (e.key !== 'Escape' || e.isComposing || props.busy) return   // 组字中的 Esc 是取消组字，不是关窗
  e.stopPropagation()
  close()
}
const KEY_OPT = { capture: true }
watch(() => props.open, (v) => {
  if (v) { loadSaved(); window.addEventListener('keydown', onKey, KEY_OPT) }
  else window.removeEventListener('keydown', onKey, KEY_OPT)
}, { immediate: true })
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, KEY_OPT))

const canSubmit = computed(() => (opt.xlsx || opt.docx || (!isSla.value && opt.pdf))
  && props.linkCount > 0 && !props.busy && (!isSla.value || props.slaCount > 0))
const figHint = computed(() => {
  if (!props.vizAvailable) return t.value('图表区已关闭（功能区「视图 → 图表」），本次导出没有图')
  return t.value('逐条链路生成地理场图与链路视图（每条都要重跑一次网格扫描，链路多时较慢）')
})
const slaHint = computed(() => {
  if (!props.slaCount) return t.value('没有任何链路勾选了 SLA 条款')
  return t.value('按各链路勾选的条款出「服务等级指标」一节：总报告一张矩阵，逐链路详情一张明细表')
})

function submit() {
  if (!canSubmit.value) return
  persist()
  emit('submit', {
    variant: props.variant,
    // 报告字体随元信息一起进模型（三档都是出厂值时为 null：主进程走模板默认）
    doc: Object.assign(JSON.parse(JSON.stringify(doc)), { fonts: composeReportFonts(font) }),
    formats: [opt.xlsx ? 'xlsx' : null, opt.docx ? 'docx' : null, (!isSla.value && opt.pdf) ? 'pdf' : null].filter(Boolean),
    withFigures: !isSla.value && !!opt.figures && props.vizAvailable,
    withSla: isSla.value ? true : (!!opt.sla && props.slaCount > 0)
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
        <Icon name="file-down" :size="12" />{{ t(isSla ? '导出 SLA 报告' : '导出报告') }}
        <span class="rd-sp"></span>
        <span class="rd-scheme">{{ schemeText }}</span>
        <button class="rd-x" :disabled="busy" :title="t('关闭')" :aria-label="t('关闭')" @click="close">
          <Icon name="x" :size="12" />
        </button>
      </div>

      <div class="rd-bd">
        <!-- 元信息：封面与页眉页脚照此写 -->
        <div class="rd-grid">
          <label v-for="f in DOC_FIELDS" :key="f.key" class="rd-f" :class="{ wide: f.wide }">
            <span class="rd-l">{{ labelOf(f) }}</span>
            <textarea v-if="f.area" v-model="doc[f.key]" class="rd-in rd-area" rows="2" :disabled="busy"></textarea>
            <input v-else v-model="doc[f.key]" class="rd-in" type="text" :disabled="busy" />
          </label>
        </div>

        <!-- 台标：贴在三份文件的右上角（Excel 每张工作表 / Word 与 PDF 的每一页页眉）。
             选过一次就记住，三个窗口共用，下次打开直接在。 -->
        <div class="rd-sec">LOGO</div>
        <div class="rd-logo">
          <div class="rd-logo-box" :title="t('贴在每一页右上角')">
            <img v-if="doc.logo && doc.logo.dataUrl" :src="doc.logo.dataUrl" alt="" />
            <Icon v-else name="image" :size="16" />
          </div>
          <button class="rd-btn" :disabled="busy" @click="logoInput && logoInput.click()">{{ t(doc.logo ? '更换' : '选择图片') }}</button>
          <button class="rd-btn" :disabled="busy" :title="t('用本软件自己的标志（与「关于」窗口同一枚）')" @click="useAppLogo">{{ t('平台标志') }}</button>
          <button class="rd-btn" :disabled="busy || !doc.logo" @click="clearLogo">{{ t('移除') }}</button>
          <span v-if="doc.logo" class="rd-logo-name">{{ logoName }}<template v-if="logoName">　</template>{{ doc.logo.w }} × {{ doc.logo.h }} px</span>
          <input
            ref="logoInput" class="rd-file" type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml,.svg" @change="pickLogo" />
        </div>
        <div v-if="logoErr" class="rd-err">{{ logoErr }}</div>

        <!-- 报告字体：三档各选一款，按窗口记住（GSO / NGSO / 再生式 / 端到端互相独立） -->
        <div class="rd-sec" :title="t('Excel 与 Word 只写字体名；PDF 用本机字体')">{{ t('字体') }}</div>
        <div class="rd-fonts">
          <label class="rd-f">
            <span class="rd-l">{{ t('西文') }}</span>
            <select v-model="font.latin" class="rd-in rd-sel" data-i18n-skip :disabled="busy">
              <option v-for="f in fontOpts.latin" :key="f.key" :value="f.key" :style="{ fontFamily: f.stack }">{{ fontName(f) }}</option>
            </select>
          </label>
          <label class="rd-f">
            <span class="rd-l">{{ t('中文正文') }}</span>
            <select v-model="font.cjkBody" class="rd-in rd-sel" data-i18n-skip :disabled="busy">
              <option v-for="f in fontOpts.cjk" :key="f.key" :value="f.key" :style="{ fontFamily: f.stack }">{{ fontName(f) }}</option>
            </select>
          </label>
          <label class="rd-f">
            <span class="rd-l">{{ t('中文标题') }}</span>
            <select v-model="font.cjkHead" class="rd-in rd-sel" data-i18n-skip :disabled="busy">
              <option v-for="f in fontOpts.cjk" :key="f.key" :value="f.key" :style="{ fontFamily: f.stack }">{{ fontName(f) }}</option>
            </select>
          </label>
        </div>

        <div class="rd-sec">{{ t('输出') }}</div>
        <div class="rd-opts">
          <label class="rd-ck" :title="t('第一张表为总报告，其后每条链路一张详情表')">
            <input v-model="opt.xlsx" type="checkbox" :disabled="busy" />Excel（.xlsx）
          </label>
          <label class="rd-ck" :title="t('公文格式：封面 · 文档控制 · 目录 · 五级标题正文（可在 Word 里继续编辑）')">
            <input v-model="opt.docx" type="checkbox" :disabled="busy" />Word（.docx）
          </label>
          <label v-if="!isSla" class="rd-ck" :title="t('封面 / 目录 / 总报告为 A4 纵向，逐链路详情为 A4 横向')">
            <input v-model="opt.pdf" type="checkbox" :disabled="busy" />PDF（.pdf）
          </label>
          <label v-if="!isSla" class="rd-ck" :class="{ off: !vizAvailable }" :title="figHint">
            <input v-model="opt.figures" type="checkbox" :disabled="busy || !vizAvailable" />{{ t('包含图件') }}
          </label>
          <!-- 一条条款都没勾时整项不出现：留一个永远点不动的灰选项在这儿，只会让人反复去点它 -->
          <label v-if="!isSla && slaCount" class="rd-ck" :title="slaHint">
            <input v-model="opt.sla" type="checkbox" :disabled="busy" />{{ t('含服务等级指标（SLA）') }}
          </label>
        </div>
        <!-- 分节读数：各模块几条链路（模块名单独成节点，DOM 翻译按整串查表才对得上） -->
        <div v-if="sections && sections.length" class="rd-hint rd-secs">
          <span v-for="(s, i) in sections" :key="s.key || i" class="rd-sec-i"><span>{{ s.label }}</span> <b>{{ s.count }}</b></span>
        </div>
        <div class="rd-hint">{{ linkCount }} {{ t('条链路') }}　·　{{ t('字体') }} {{ fontText }}　·　{{ t('语言') }} {{ lang === 'en' ? 'English' : '中文' }}</div>

        <div v-if="progress" class="rd-prog">
          <div class="rd-bar"><i :style="{ width: (progress.total ? Math.round(progress.done / progress.total * 100) : 0) + '%' }"></i></div>
          <div class="rd-ptext">{{ progress.text }}<span v-if="progress.total"> · {{ progress.done }}/{{ progress.total }}</span></div>
        </div>
      </div>

      <div class="rd-ft">
        <button class="rd-btn" :disabled="busy" @click="close">{{ t('取消') }}</button>
        <button class="rd-btn primary" :disabled="!canSubmit" @click="submit">
          {{ busy ? t('生成中…') : t('生成报告') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 与工作台其它对话框同一套控件语言（方角、细边、衬线数字），只是宽一档——元信息有十栏要填 */
.rd-mask { position: fixed; inset: 0; z-index: 320; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.28); }
.rd {
  width: 560px; max-height: 88vh; display: flex; flex-direction: column;
  font-family: var(--lb-serif, var(--font-serif));
  background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--r-card, 3px);
  box-shadow: var(--shadow-3); overflow: hidden;
}
.rd-hd {
  display: flex; align-items: center; gap: 6px; padding: 10px 12px;
  font-size: var(--fs-2); font-weight: 600; letter-spacing: var(--ls-label); text-transform: uppercase; color: var(--text-muted);
  background: var(--surface-2); border-bottom: 1px solid var(--border);
}
.rd-sp { flex: 1; }
.rd-scheme { letter-spacing: 0; text-transform: none; color: var(--text-faint); font-size: var(--fs-2); }
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
.rd-area { resize: vertical; line-height: 1.45; }
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
.rd-hint { margin-top: 5px; font-size: var(--fs-2); color: var(--text-faint); line-height: 1.5; }
.rd-secs { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 8px; }
.rd-sec-i { white-space: nowrap; }
.rd-sec-i b { font-weight: 600; color: var(--text-muted); font-variant-numeric: tabular-nums; }
.rd-prog { margin-top: 10px; }
.rd-bar { height: 3px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-ctl); overflow: hidden; }
.rd-bar i { display: block; height: 100%; background: var(--accent); transition: width .2s linear; }
.rd-ptext { margin-top: 4px; font-size: var(--fs-2); color: var(--text-muted); }
.rd-ft { display: flex; justify-content: flex-end; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--border); background: var(--surface); }
.rd-btn {
  font: inherit; font-size: var(--fs-2); line-height: 1; padding: 4px 12px; cursor: pointer;
  background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px);
}
.rd-btn:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.rd-btn:disabled { opacity: .45; cursor: not-allowed; }
.rd-btn.primary { background: var(--accent-ui); color: var(--bg); border-color: var(--accent-ui); }
.rd-btn.primary:hover:not(:disabled) { opacity: .88; }
</style>
