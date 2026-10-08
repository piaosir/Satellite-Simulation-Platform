<script setup>
// 设计页文档标签条（2026-10-06，任务书 §3.1）：功能区下方横跨三栏，一个打开的文档一个签（顺序 = wb.st.docs，激活 = wb.st.activeDoc）。
//   · 签：类型图标（装配 boxes / 驱动装配 satellite / 模型 box）· 名称 · 状态（未保存点；模板签「模板」小签；只读模型锁）· 关闭 ×。
//     悬停 title = 类型 · 领域 · 来源（另起一行附运行时状态：入库中 / 未保存原因）。
//   · 单击激活；中键关闭；右键菜单：关闭 / 关闭其他 / 另存副本（wb.saveDocCopy：装配签 = 新 id「<名称> 副本」新签打开；模型签 = 元数据副本；
//     模板签 / STK 件等 wb.canSaveDocCopy 为假时禁用）。
//   · 窄窗：签按比例收缩到下限，再放不下横向滚动（不撑破三栏布局）；激活签自动滚进可见区。
// 视觉沿用设计页左栏页眉的连体页签（DesignSide .dsg-tabs）：选中签与内容面同底 + 底缘机位色。
import { inject, computed, ref, watch, nextTick, onMounted } from 'vue'
import Icon from '../../components/Icon.vue'
import { byLang, curLang } from '../../shared/i18n/lang.js'
import { onLangChange } from '../../shared/i18n/runtime.js'
import { sourceTag } from '../wbLogic.js'
import { DOMAIN_LABELS } from '../asmLogic.js'

const wb = inject('wb')
const { st } = wb
const langNow = ref(curLang())
onLangChange(() => { langNow.value = curLang() })

const entryOf = (d) => (d.kind === 'model' ? wb.byId(d.libId) : null)
/** 模型签只读：模板 / 星座精模 / 装配件（模型视图下只读）/ 没有桌面端接口 */
function readonly(d) {
  if (d.kind !== 'model') return false
  const e = entryOf(d)
  return !wb.api || !e || e.origin === 'template' || e.origin === 'entTemplate' || !!e.fleet || String(e.id).startsWith('asm:')
}
// 模板签显示模板名（文档名打开时已定成副本名，分叉后才显示它）；其余见 wb.docTitle
function nameOf(d) {
  void langNow.value; void d.name; void d.templateKey
  return wb.docTitle(d, langNow.value === 'en' ? 'en' : 'zh')
}
const iconOf = (d) => (d.kind === 'model' ? 'box' : d.driven ? 'satellite' : 'boxes')
const ORIGIN = { new: ['新建', 'New'], lib: ['库', 'Library'], template: ['模板', 'Template'], copy: ['副本', 'Copy'], draft: ['草稿', 'Draft'] }
const DOMAIN_EN = { spacecraft: 'Spacecraft', ground: 'Earth station', aircraft: 'Aircraft', ship: 'Ship', vehicle: 'Vehicle' }
function tipOf(d) {
  void langNow.value
  const type = d.kind === 'model' ? byLang('模型', 'Model') : d.driven ? byLang('驱动装配', 'Driven assembly') : byLang('装配', 'Assembly')
  const e = entryOf(d)
  const dom = d.kind === 'model' ? (e && e.kind) || '' : d.domain
  const domain = DOMAIN_LABELS[dom] ? byLang(DOMAIN_LABELS[dom], DOMAIN_EN[dom] || dom) : ''
  const o = ORIGIN[d.origin] || ORIGIN.lib
  const src = d.kind === 'model' ? ((e && sourceTag(e)) || byLang(o[0], o[1])) : byLang(o[0], o[1])
  const lines = [[type, domain, src].filter(Boolean).join(' · ')]
  if (d.saving) lines.push(byLang('入库中', 'Saving'))
  if (d.saveErr) lines.push(d.saveErr)
  return lines.join('\n')
}

// ── 激活 / 关闭 ──
function activate(d) { if (d.id !== st.activeDoc) wb.activateDoc(d.id) }
function close(d) { wb.closeDoc(d.id) }

// ── 右键菜单 ──
const ctx = ref(null)   // {x, y, id}
function openCtx(ev, d) {
  const w = 170, h = 110
  ctx.value = { x: Math.min(ev.clientX, window.innerWidth - w - 6), y: Math.min(ev.clientY, window.innerHeight - h - 6), id: d.id }
}
function ctxDo(fn) { const id = ctx.value && ctx.value.id; ctx.value = null; if (id) fn(id) }
const canCopy = computed(() => !!(ctx.value && wb.canSaveDocCopy(ctx.value.id)))

// ── 激活签滚进可见区（签多、窗窄时）──
const stripEl = ref(null)
function revealActive() {
  const el = stripEl.value
  const a = el && el.querySelector('.dtab.on')
  if (a) a.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}
watch(() => [st.activeDoc, st.docs.length], () => nextTick(revealActive))
onMounted(() => nextTick(revealActive))
// 竖滚轮横着翻签（签条只有一行）
function onWheel(ev) {
  const el = stripEl.value
  if (!el || el.scrollWidth <= el.clientWidth || Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) return
  el.scrollLeft += ev.deltaY
  ev.preventDefault()
}
</script>

<template>
  <div ref="stripEl" class="dtabs" role="tablist" data-doc-tabs @wheel="onWheel">
    <div v-for="d in st.docs" :key="d.id" class="dtab" role="tab" :class="{ on: d.id === st.activeDoc }" :aria-selected="d.id === st.activeDoc"
         :data-doc="d.id" :data-kind="d.kind" :title="tipOf(d)"
         @click="activate(d)" @mousedown.middle.prevent @mouseup.middle="close(d)" @contextmenu.prevent="openCtx($event, d)">
      <Icon class="dtab-ic" :name="iconOf(d)" :size="13" />
      <span class="dtab-n" data-i18n-skip>{{ nameOf(d) }}</span>
      <span v-if="d.templateKey" class="dtab-tag" title="编辑时自动创建副本">模板</span>
      <Icon v-if="readonly(d)" class="dtab-lock" name="lock" :size="11" />
      <i v-if="d.dirty || d.saveErr" class="dtab-dot" :class="{ err: !!d.saveErr }"></i>
      <button type="button" class="dtab-x" data-act="doc-close" title="关闭（Ctrl+W）" @click.stop="close(d)" @mousedown.middle.stop><Icon name="x" :size="12" /></button>
    </div>
  </div>
  <Teleport to="body">
    <div v-if="ctx" class="lb-ctx-mask" @mousedown="ctx = null" @contextmenu.prevent="ctx = null">
      <div class="lb-ctx" :style="{ left: ctx.x + 'px', top: ctx.y + 'px' }" @mousedown.stop>
        <button class="lb-ctx-i" data-act="doc-ctx-close" @click="ctxDo((id) => wb.closeDoc(id))">关闭</button>
        <button class="lb-ctx-i" data-act="doc-ctx-close-others" :disabled="st.docs.length < 2" @click="ctxDo((id) => wb.closeOtherDocs(id))">关闭其他</button>
        <div class="lb-ctx-sep"></div>
        <button class="lb-ctx-i" data-act="doc-ctx-copy" :disabled="!canCopy" @click="ctxDo((id) => wb.saveDocCopy(id))">另存副本</button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* 签条：与左栏页眉同一档底色与高度；签多时横向滚动（细滚动条），不换行、不撑宽 */
.dtabs {
  flex: none; display: flex; align-items: stretch; height: 30px; padding: 0 6px; min-width: 0;
  background: var(--surface-2); border-bottom: 1px solid var(--border);
  overflow-x: auto; overflow-y: hidden; scrollbar-width: thin;
}
.dtabs::-webkit-scrollbar { height: 4px; }
.dtabs::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--text) 22%, transparent); border-radius: 2px; }
/* 签：等分收缩到下限（96 px）后由签条横向滚动；名称省略号 */
.dtab {
  position: relative; flex: 0 1 200px; min-width: 96px; max-width: 240px; display: flex; align-items: center; gap: 5px;
  padding: 0 3px 0 10px; font-size: var(--fs-3); color: var(--text-muted); cursor: pointer; user-select: none; white-space: nowrap;
  border-left: 1px solid transparent; border-right: 1px solid transparent; transition: var(--t-state);
}
.dtab:hover:not(.on) { color: var(--text); background: var(--wash-hover); }
.dtab.on { color: var(--text); background: var(--bg); border-left-color: var(--border); border-right-color: var(--border); transition-duration: 0s; }
.dtab.on::after { content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; background: var(--accent-ui); }
.dtab:first-child.on { border-left-color: transparent; }
.dtab-ic { flex: none; color: var(--text-faint); }
.dtab.on .dtab-ic { color: var(--text-muted); }
.dtab-n { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.dtab.on .dtab-n { font-weight: 600; }
.dtab-tag { flex: none; padding: 0 4px; font-size: var(--fs-1); line-height: 14px; color: var(--text-muted); border: 1px solid var(--border-strong); border-radius: var(--r-ctl); }
.dtab-lock { flex: none; color: var(--text-faint); }
/* 未保存点：与功能区「保存」按钮上的那一点同一种（入库失败 / 草稿未写入 = 告警色） */
.dtab-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--text-muted); }
.dtab-dot.err { background: var(--warn); }
.dtab-x { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; padding: 0; cursor: pointer;
  color: var(--text-faint); background: transparent; border: 0; border-radius: var(--r-ctl); }
.dtab-x:hover { color: var(--text); background: var(--wash-hover); }
</style>
