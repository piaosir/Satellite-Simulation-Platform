<script setup>
// 卫星页（DESIGN2 §3「卫星」、任务书 §4.2 / §4.4 / §6.1）：给一颗星编辑绑定——模型、姿态律、挂点（mount）。
// 绑定键与来源见 satSources.js；工作副本、落盘、撤销在 satStore.js；预览联动在 useSatViewport.js。
// 3D 页「编辑…」会带 satKey 打开工作台并直接切到这一页（ModelApp.goTarget）。
import { computed, inject, onMounted, onBeforeUnmount } from 'vue'
import Icon from '../components/Icon.vue'
import SatPick from './sat/SatPick.vue'
import SatModel from './sat/SatModel.vue'
import SatAttitude from './sat/SatAttitude.vue'
import SatMounts from './sat/SatMounts.vue'

const wb = inject('wb')
const sat = inject('sat')
const S = sat.st
const locked = computed(() => !wb.api)

// Ctrl+Z / Ctrl+Y：焦点不在输入框 / 表格里时撤销绑定改动（表格自己的撤销也走同一个栈）
function onKey(e) {
  if (!(e.ctrlKey || e.metaKey) || wb.st.tab !== 'sat') return
  if (e.target && (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || (e.target.closest && e.target.closest('.eg-scroll')))) return
  const k = e.key.toLowerCase()
  if (k === 'z' && !e.shiftKey) { if (sat.undo()) e.preventDefault() }
  else if (k === 'y' || (k === 'z' && e.shiftKey)) { if (sat.redo()) e.preventDefault() }
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
async function clearBinding() {
  if (!S.binding) return
  const ok = await wb.askConfirm('清除「' + (S.label || S.satKey) + '」的绑定（模型、姿态律、挂点）？')
  if (!ok) return
  sat.edit((b) => { b.model = { id: 'auto' }; b.mounts = []; b.attitude = { law: 'nadir', params: {} }; delete b.massProps })
  S.mountSel = ''
}
</script>

<template>
  <div class="st">
    <div v-if="locked" class="md-state warn"><Icon name="alert-triangle" :size="12" />需在桌面客户端中运行</div>
    <SatPick />
    <template v-if="S.binding">
      <div class="st-top">
        <span class="st-name" :title="S.satKey" data-i18n-skip>{{ S.label }}</span>
        <span class="sp"></span>
        <span v-if="S.saving" class="md-state"><span class="st-spin"></span></span>
        <span v-else-if="S.saveErr" class="md-state bad" :title="S.saveErr"><Icon name="alert-triangle" :size="12" />未保存</span>
        <span v-if="S.errors.length" class="md-state warn" :title="S.errors.join('\n')"><Icon name="alert-triangle" :size="12" /><span data-i18n-skip>{{ S.errors.length }}</span></span>
        <button class="lb-mini lb-mini-ico" :disabled="!S.undoN" title="撤销（Ctrl+Z）" @click="sat.undo()"><Icon name="undo-2" :size="13" /></button>
        <button class="lb-mini lb-mini-ico" :disabled="!S.redoN" title="重做（Ctrl+Y）" @click="sat.redo()"><Icon name="redo-2" :size="13" /></button>
        <button class="lb-mini lb-mini-ico" title="清除这颗星的绑定" @click="clearBinding"><Icon name="trash" :size="13" /></button>
      </div>
      <SatModel />
      <SatAttitude />
      <SatMounts />
    </template>
    <div v-else class="lb-placeholder">未选卫星。</div>
  </div>
</template>

<style scoped>
.st { display: flex; flex-direction: column; gap: 2px; }
.st-top { display: flex; align-items: center; gap: 6px; min-height: 26px; margin: 2px 0 4px; }
.st-top .sp { flex: 1; }
.st-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: calc(var(--lb-fs, 11px) + 3px); font-weight: 700; letter-spacing: var(--ls-tight); color: var(--text); }
.st-spin { width: 10px; height: 10px; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--text) 18%, transparent); border-top-color: var(--accent-ui); animation: st-spin .7s linear infinite; }
@keyframes st-spin { to { transform: rotate(360deg); } }
</style>
