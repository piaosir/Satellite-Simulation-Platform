<script setup>
// 「导出报告」对话框（GSO / NGSO / 再生式三窗共用）。
//
// 它管两件事：① 封面与页眉页脚要写的那几行元信息（报告编号 / 项目 / 编制单位 / 编制·校核·审核 /
// 密级），② 这一次导出的口径（出哪几种文件、带不带图）。元信息按窗口记在本地，下次打开就在——
// 同一个项目的报告要连着出好几份，每份都重填一遍编号和单位是不能忍的。
//
// 报告语言不在这里选：它是功能区的「语言」，屏幕上的详细预算与导出的文件一起切换
//（见 memory「详细预算区语言联动」），在这儿再放一个开关就会出现「屏幕是中文、导出是英文」。
import { reactive, computed, watch, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
import { DOC_FIELDS, defaultDocInfo, schemeOf, schemeName, schemeSub, translate } from '../shared/lbReport.js'

const props = defineProps({
  open: { type: Boolean, default: false },
  lang: { type: String, default: 'zh' },
  orbitType: { type: String, default: 'GEO' },
  regenMode: { type: String, default: 'uplink' },
  satName: { type: String, default: '' },
  linkCount: { type: Number, default: 0 },
  // 图表区当前是否显示：关着的时候图取不到（组件根本没挂），据此提示并默认不勾「含图」
  vizAvailable: { type: Boolean, default: true },
  storeKey: { type: String, default: 'lb' },
  busy: { type: Boolean, default: false },
  // { text, done, total }：导出过程中的进度，由上层逐条链路推进
  progress: { type: Object, default: null }
})
const emit = defineEmits(['close', 'submit'])

const t = computed(() => (s) => translate(s, props.lang))
const scheme = computed(() => schemeOf(props.orbitType, props.regenMode))
const schemeText = computed(() => schemeName(scheme.value, props.lang) + (schemeSub(scheme.value, props.lang) ? '　·　' + schemeSub(scheme.value, props.lang) : ''))

const KEY = computed(() => props.storeKey + '/report/doc')
const OPT_KEY = computed(() => props.storeKey + '/report/opt')

const doc = reactive(defaultDocInfo(scheme.value, props.satName, props.lang))
const opt = reactive({ xlsx: true, docx: true, pdf: true, figures: true })

function loadSaved() {
  const base = defaultDocInfo(scheme.value, props.satName, props.lang)
  let saved = null
  try { saved = JSON.parse(localStorage.getItem(KEY.value) || 'null') } catch (e) { saved = null }
  for (const f of DOC_FIELDS) {
    // 日期每次取今天；其余（编号、项目、单位、签署）沿用上次填的
    doc[f.key] = (f.key === 'title' || f.key === 'date') ? base[f.key] : ((saved && saved[f.key]) || base[f.key])
  }
  // 报告名称按「自动命名」的规矩走（同资源库条目名，见 shared/lbAutoName.js）：用户没改过就随
  // 当前卫星/体制重算，改过一次就钉死。存的时候一并存下「当时的默认名」，据此判断改没改过。
  if (saved && saved.title) doc.title = (saved.title === saved.titleDefault) ? base.title : saved.title
  try {
    const o = JSON.parse(localStorage.getItem(OPT_KEY.value) || 'null')
    if (o) { opt.xlsx = o.xlsx !== false; opt.docx = o.docx !== false; opt.pdf = o.pdf !== false; opt.figures = o.figures !== false }
  } catch (e) { /* 用默认 */ }
  if (!props.vizAvailable) opt.figures = false
}

// 元信息落盘。提交时要存，关闭时也要存——十栏填完手一滑关掉了，再打开还在，不用从头填。
function persist() {
  try {
    const def = defaultDocInfo(scheme.value, props.satName, props.lang)
    localStorage.setItem(KEY.value, JSON.stringify(Object.assign({}, doc, { titleDefault: def.title })))
    localStorage.setItem(OPT_KEY.value, JSON.stringify({ xlsx: opt.xlsx, docx: opt.docx, pdf: opt.pdf, figures: opt.figures }))
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

const canSubmit = computed(() => (opt.xlsx || opt.docx || opt.pdf) && props.linkCount > 0 && !props.busy)
const figHint = computed(() => {
  if (!props.vizAvailable) return t.value('图表区已关闭（功能区「视图 → 图表」），本次导出没有图')
  return t.value('逐条链路生成地理场图与链路视图（每条都要重跑一次网格扫描，链路多时较慢）')
})

function submit() {
  if (!canSubmit.value) return
  persist()
  emit('submit', {
    doc: JSON.parse(JSON.stringify(doc)),
    formats: [opt.xlsx ? 'xlsx' : null, opt.docx ? 'docx' : null, opt.pdf ? 'pdf' : null].filter(Boolean),
    withFigures: !!opt.figures && props.vizAvailable
  })
}
const labelOf = (f) => (props.lang === 'en' ? f.labelEn : f.label)
</script>

<template>
  <div v-if="open" class="rd-mask">
    <div class="rd" role="dialog" aria-modal="true">
      <div class="rd-hd">
        <Icon name="file-down" :size="13" />{{ t('导出报告') }}
        <span class="rd-sp"></span>
        <span class="rd-scheme">{{ schemeText }}</span>
        <button class="rd-x" :disabled="busy" :title="t('关闭')" :aria-label="t('关闭')" @click="close">
          <Icon name="x" :size="13" />
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

        <div class="rd-sec">{{ t('输出') }}</div>
        <div class="rd-opts">
          <label class="rd-ck" :title="t('第一张表为总报告，其后每条链路一张详情表')">
            <input v-model="opt.xlsx" type="checkbox" :disabled="busy" />Excel（.xlsx）
          </label>
          <label class="rd-ck" :title="t('公文格式：封面 · 文档控制 · 目录 · 五级标题正文（可在 Word 里继续编辑）')">
            <input v-model="opt.docx" type="checkbox" :disabled="busy" />Word（.docx）
          </label>
          <label class="rd-ck" :title="t('封面 / 目录 / 总报告为 A4 纵向，逐链路详情为 A4 横向')">
            <input v-model="opt.pdf" type="checkbox" :disabled="busy" />PDF（.pdf）
          </label>
          <label class="rd-ck" :class="{ off: !vizAvailable }" :title="figHint">
            <input v-model="opt.figures" type="checkbox" :disabled="busy || !vizAvailable" />{{ t('包含图件') }}
          </label>
        </div>
        <div class="rd-hint">{{ figHint }}</div>
        <div class="rd-hint">{{ linkCount }} {{ t('条链路') }}　·　{{ t('字体') }} Times New Roman　·　{{ t('语言') }} {{ lang === 'en' ? 'English' : '中文' }}</div>

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
  background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--r-modal, 3px);
  box-shadow: 0 8px 24px rgba(0,0,0,.18); overflow: hidden;
}
.rd-hd {
  display: flex; align-items: center; gap: 6px; padding: 10px 12px;
  font-size: 11px; font-weight: 600; letter-spacing: 1px; text-transform: uppercase; color: var(--text-muted);
  background: var(--surface-2); border-bottom: 1px solid var(--border);
}
.rd-sp { flex: 1; }
.rd-scheme { letter-spacing: normal; text-transform: none; color: var(--text-faint); font-size: 11px; }
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
.rd-l { font-size: 11px; color: var(--text-muted); }
.rd-in {
  font: inherit; font-size: 12px; padding: 3px 6px; min-width: 0;
  background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px);
}
.rd-in:focus { outline: none; border-color: var(--accent); }
.rd-area { resize: vertical; line-height: 1.45; }
.rd-sec {
  margin: 12px 0 6px; padding-bottom: 3px; font-size: 11px; font-weight: 700; color: var(--text);
  border-bottom: 1px solid var(--lb-rule, var(--border));
}
.rd-opts { display: flex; gap: 16px; flex-wrap: wrap; }
.rd-ck { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--text); cursor: pointer; }
.rd-ck.off { color: var(--text-faint); cursor: not-allowed; }
.rd-ck input { margin: 0; accent-color: var(--accent); }
.rd-hint { margin-top: 5px; font-size: 11px; color: var(--text-faint); line-height: 1.5; }
.rd-prog { margin-top: 10px; }
.rd-bar { height: 3px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 2px; overflow: hidden; }
.rd-bar i { display: block; height: 100%; background: var(--accent); transition: width .2s linear; }
.rd-ptext { margin-top: 4px; font-size: 11px; color: var(--text-muted); }
.rd-ft { display: flex; justify-content: flex-end; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--border); background: var(--surface); }
.rd-btn {
  font: inherit; font-size: 11px; line-height: 1; padding: 4px 12px; cursor: pointer;
  background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px);
}
.rd-btn:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.rd-btn:disabled { opacity: .45; cursor: not-allowed; }
.rd-btn.primary { background: var(--accent); color: var(--bg); border-color: var(--accent); }
.rd-btn.primary:hover:not(:disabled) { opacity: .88; }
</style>
