<script setup>
// 模型页（DESIGN §7 / 任务书 §5.5）：当前模型的工程属性，各节可折叠。改动立即反映在预览（wb.edit → viewport.setModel 同根重喂），
// 500 ms 防抖落盘。预览里的「点选」同一时刻只归一个节（挂点点表面 / 部件点选），切走页签即收回。
import { ref, computed, inject, provide, onActivated, onDeactivated, onMounted, onBeforeUnmount } from 'vue'
import Icon from '../components/Icon.vue'
import SecOverview from './sec/SecOverview.vue'
import SecUnits from './sec/SecUnits.vue'
import SecFrame from './sec/SecFrame.vue'
import SecMass from './sec/SecMass.vue'
import SecParts from './sec/SecParts.vue'
import SecAttach from './sec/SecAttach.vue'
import SecArtic from './sec/SecArtic.vue'
import SecSolar from './sec/SecSolar.vue'
import SecObsc from './sec/SecObsc.vue'
import SecJson from './sec/SecJson.vue'

const wb = inject('wb')
const getVp = inject('viewport')
const { cur } = wb

// ============ 预览点选的归属（一次只一个节）============
const owner = ref(null)
const pick = {
  owner,
  start(who, kind, cb) {
    const vp = getVp()
    if (!vp) return
    owner.value = who
    vp.pickMode(kind, cb)
  },
  stop(who) {
    if (who && owner.value !== who) return
    owner.value = null
    const vp = getVp()
    if (vp) vp.pickMode(null)
  }
}
provide('pick', pick)
// 节间共享的选中态（部件 / 挂点表的选中联动预览高亮）
const hl = { parts: ref([]), nodes: ref(null), ap: ref(null) }
provide('hl', hl)
function clearHighlights() {
  const vp = getVp()
  if (!vp) return
  vp.highlightParts(null); vp.highlightNodes(null); vp.setAttachHighlight(null)
}
onDeactivated(() => { pick.stop(); clearHighlights() })
onActivated(() => { wb.ensureFullDetail() })

// 只读说明（状态本身）：参数化模板 / 生成页的临时星不落盘；没有桌面端接口时也改不了
const roText = computed(() => {
  if (!cur.meta) return ''
  if (cur.kind === 'tpl' || cur.kind === 'gen') return '参数化模板只读。'
  if (cur.asm) return '装配件只读。'
  if (!wb.api) return '需在桌面客户端中运行'
  return ''
})
const lodPending = computed(() => cur.kind === 'glb' && cur.lod && cur.lod !== 'lod0')

// Ctrl+Z / Ctrl+Y：焦点不在输入框 / 表格里时撤销元数据改动（表格自己的撤销也走同一个栈）
function onKey(e) {
  if (!(e.ctrlKey || e.metaKey) || wb.st.tab !== 'model') return
  if (e.target && (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || (e.target.closest && e.target.closest('.eg-scroll')))) return
  const k = e.key.toLowerCase()
  if (k === 'z' && !e.shiftKey) { if (wb.undo()) e.preventDefault() }
  else if (k === 'y' || (k === 'z' && e.shiftKey)) { if (wb.redo()) e.preventDefault() }
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => { window.removeEventListener('keydown', onKey); pick.stop() })
</script>

<template>
  <div class="mdl">
    <div v-if="!cur.meta" class="lb-placeholder">未选中模型。</div>
    <template v-else>
      <div class="mdl-top">
        <span v-if="roText" class="md-state warn"><Icon name="lock" :size="12" />{{ roText }}</span>
        <span v-if="lodPending" class="md-state"><span class="mdl-spin"></span><span data-i18n-skip>{{ cur.lod }} → lod0</span></span>
        <span class="sp"></span>
        <span v-if="cur.saving" class="md-state"><span class="mdl-spin"></span></span>
        <span v-else-if="cur.saveErr" class="md-state bad" :title="cur.saveErr"><Icon name="alert-triangle" :size="12" />未保存</span>
        <button class="lb-mini lb-mini-ico" :disabled="!cur.undoN" title="撤销（Ctrl+Z）" @click="wb.undo()"><Icon name="undo-2" :size="13" /></button>
        <button class="lb-mini lb-mini-ico" :disabled="!cur.redoN" title="重做（Ctrl+Y）" @click="wb.redo()"><Icon name="redo-2" :size="13" /></button>
      </div>
      <SecOverview />
      <SecUnits />
      <SecFrame />
      <SecMass />
      <SecParts />
      <SecAttach />
      <SecArtic />
      <SecSolar />
      <SecObsc />
      <SecJson />
    </template>
  </div>
</template>

<style scoped>
.mdl { display: flex; flex-direction: column; gap: 2px; }
.mdl-top { display: flex; align-items: center; gap: 6px; min-height: 24px; margin-bottom: 2px; }
.mdl-top .sp { flex: 1; }
.mdl-spin { width: 10px; height: 10px; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--text) 18%, transparent); border-top-color: var(--accent-ui); animation: mdl-spin .7s linear infinite; }
@keyframes mdl-spin { to { transform: rotate(360deg); } }
</style>
