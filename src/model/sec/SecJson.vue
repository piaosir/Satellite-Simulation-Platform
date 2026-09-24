<script setup>
// JSON 进出（任务书 §5.5）：整份 ModelMeta（.satsim.json 同口径）或只挂点子集。
//   导出：主进程另存对话框（file:save）；复制：剪贴板。
//   导入：文件或剪贴板 → wbLogic.applyJsonImport（id / source / files 永远以库里为准，只覆盖 JSON_FIELDS）→ 确认后整份替换这些字段。
//   轴向 / 单位也在可覆盖字段里：换了就按几何改动重算包围盒（geom）。
import { ref, computed, inject } from 'vue'
import Icon from '../../components/Icon.vue'
import MdSec from '../MdSec.vue'
import { applyJsonImport, metaForExport, attachSubset } from '../wbLogic.js'

const wb = inject('wb')
const { cur } = wb
const m = computed(() => cur.meta)
const ro = computed(() => !cur.editable)
const api = typeof window !== 'undefined' ? window.api : null
const state = ref(null)   // {kind:'ok'|'bad', text}
const FIELD_LABEL = { title: '名称', titleZh: '中文名', kind: '类别', group: '分组', fidelity: '细节档', units: '单位', frame: '本体轴', parts: '部件',
  massProps: '质量特性', attachPoints: '挂点', articulations: '关节', solarPanelGroups: '太阳翼组', noObscurationNodes: '不遮挡节点', tags: '标签', aliases: '别名' }
const safeName = () => String(wb.displayTitle(m.value) || 'model').replace(/[\\/:*?"<>|]+/g, '_')

async function saveText(text, name) {
  if (!api || typeof api.exportFile !== 'function') return
  try {
    const r = await api.exportFile({ defaultName: name, filters: [{ name: 'JSON', extensions: ['json'] }], data: text })
    if (r && r.locked) return
    if (r && r.ok) state.value = { kind: 'ok', text: r.filePath }
    else if (r && !r.canceled) state.value = { kind: 'bad', text: r.error || '保存失败' }
  } catch (e) { state.value = { kind: 'bad', text: (e && e.message) || String(e) } }
}
function exportMeta() { if (m.value) saveText(JSON.stringify(metaForExport(m.value), null, 2), safeName() + '.satsim.json') }
function exportAttach() { if (m.value) saveText(JSON.stringify(attachSubset(m.value), null, 2), safeName() + '.attach.json') }
async function copyMeta() {
  if (!m.value) return
  try { await navigator.clipboard.writeText(JSON.stringify(metaForExport(m.value), null, 2)); state.value = { kind: 'ok', text: '已复制。' } }
  catch (e) { state.value = { kind: 'bad', text: (e && e.message) || String(e) } }
}

async function applyText(text) {
  let json
  try { json = JSON.parse(text) } catch (e) { state.value = { kind: 'bad', text: 'JSON 解析失败：' + ((e && e.message) || '') }; return }
  const r = applyJsonImport(JSON.parse(JSON.stringify(m.value)), json)
  if (!r.ok) { state.value = { kind: 'bad', text: r.error }; return }
  const names = r.fields.map((k) => FIELD_LABEL[k] || k).join('、')
  const ok = await wb.askConfirm(`覆盖当前模型的：${names}？`)
  if (!ok) return
  const geom = r.fields.includes('frame') || r.fields.includes('units')
  wb.edit((x) => { for (const k of r.fields) x[k] = r.meta[k] }, { geom })
  state.value = { kind: 'ok', text: '已导入：' + names }
}
const fileEl = ref(null)
function pickFile() { if (fileEl.value) { fileEl.value.value = ''; fileEl.value.click() } }
async function onFile(ev) {
  const f = ev.target.files && ev.target.files[0]
  if (!f) return
  try { await applyText(await f.text()) } catch (e) { state.value = { kind: 'bad', text: (e && e.message) || String(e) } }
}
async function pasteJson() {
  try { await applyText(await navigator.clipboard.readText()) } catch (e) { state.value = { kind: 'bad', text: (e && e.message) || String(e) } }
}
</script>

<template>
  <MdSec id="m-json" title="JSON" :default-open="false" tip="ModelMeta（与导出件同名 .satsim.json 同口径）；导入只覆盖元数据字段，编号、来源、文件以库里为准">
    <template v-if="m">
      <div class="md-acts">
        <button class="lb-mini" :disabled="!api" title="整份元数据另存为 .satsim.json" @click="exportMeta"><Icon name="file-down" :size="12" />导出…</button>
        <button class="lb-mini" :disabled="!api || !(m.attachPoints && m.attachPoints.length)" title="只导出挂点 {attachPoints:[…]}" @click="exportAttach"><Icon name="locate-fixed" :size="12" />导出挂点…</button>
        <button class="lb-mini" title="整份元数据复制到剪贴板" @click="copyMeta"><Icon name="copy" :size="12" />复制</button>
      </div>
      <div class="md-acts">
        <button class="lb-mini" :disabled="ro" title="从 .satsim.json / 挂点 JSON 文件导入（整份元数据或只挂点）" @click="pickFile"><Icon name="upload" :size="12" />导入…</button>
        <button class="lb-mini" :disabled="ro" title="从剪贴板导入" @click="pasteJson"><Icon name="clipboard" :size="12" />粘贴</button>
        <input ref="fileEl" type="file" accept=".json,application/json" hidden @change="onFile" />
      </div>
      <div v-if="state" class="md-state" :class="state.kind === 'bad' ? 'bad' : 'ok'" :title="state.text">
        <Icon :name="state.kind === 'bad' ? 'alert-triangle' : 'check'" :size="12" /><span class="js-t" data-i18n-skip>{{ state.text }}</span>
      </div>
    </template>
  </MdSec>
</template>

<style scoped>
.js-t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
