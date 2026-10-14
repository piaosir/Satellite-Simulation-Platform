<script setup>
// 历史版本对话框（链路预算四窗共用）：列出一份配置的自动留档（打开时 / 定时 / 还原前），选一档还原或另建副本。
// 留档口径见 shared/useConfigAutosave.js；清单与整份 state 走 store.listVersions / getVersion（主进程 versions.<ns>.json）。
// 选中那一档的 state 经 restore / duplicate 回传，落盘与载入在 shared/useConfigVersions.js。
import { ref, watch } from 'vue'
import Icon from './Icon.vue'
import AppDialog from './AppDialog.vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  ns: { type: String, required: true },
  cfgId: { type: String, default: null },
  cfgName: { type: String, default: '' }
})
const emit = defineEmits(['update:open', 'restore', 'duplicate'])
const api = typeof window !== 'undefined' ? window.api : null

const list = ref([])
const loading = ref(false)
const selId = ref(null)
const busy = ref(false)
const KIND = { open: '打开时', auto: '自动', restore: '还原前' }
const p2 = (n) => String(n).padStart(2, '0')
function fmt(iso) {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
}

async function load() {
  list.value = []; selId.value = null
  if (!api || !props.cfgId) return
  loading.value = true
  try {
    const r = await api.store.listVersions(props.ns, props.cfgId)
    list.value = Array.isArray(r) ? r : []
  } catch (e) { list.value = [] }
  loading.value = false
  if (list.value.length) selId.value = list.value[0].id
}
const close = () => emit('update:open', false)
async function act(kind) {
  const v = list.value.find((x) => x.id === selId.value)
  if (!v || busy.value || !api) return
  busy.value = true
  try {
    const full = await api.store.getVersion(props.ns, props.cfgId, v.id)
    if (full && full.state) emit(kind, { state: full.state, t: v.t, kind: v.kind })
  } catch (e) { /* 取不到就不动 */ } finally { busy.value = false }
}
function onRowKey(e) {
  const i = list.value.findIndex((x) => x.id === selId.value)
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const j = Math.min(list.value.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))
    if (list.value[j]) selId.value = list.value[j].id
    e.preventDefault()
  } else if (e.key === 'Enter') { act('restore'); e.preventDefault() }
}
// 外壳是 AppDialog（Esc / 关闭钮关、点遮罩不关、打开聚焦版本列表）
watch(() => props.open, (v) => { if (v) load() }, { immediate: true })
</script>

<template>
  <AppDialog :open="open" :width="560" flush initial-focus=".lbv-list" @close="close">
      <template #title><span class="lbv-hd"><Icon name="history" :size="12" /><span class="lbv-hd-t">历史版本</span><span class="lbv-nm" data-i18n-skip :title="cfgName">{{ cfgName }}</span></span></template>
      <div class="lbv-bd">
        <div v-if="!loading && !list.length" class="lbv-empty">暂无历史版本。</div>
        <div v-else class="lbv-list" tabindex="0" @keydown="onRowKey">
          <table class="lbv-tbl">
            <thead><tr><th class="c-t">时间</th><th class="c-k">类型</th><th>内容</th></tr></thead>
            <tbody>
              <tr v-for="v in list" :key="v.id" :class="{ on: v.id === selId }" @click="selId = v.id" @dblclick="selId = v.id; act('restore')">
                <td class="c-t">{{ fmt(v.t) }}</td>
                <td class="c-k">{{ KIND[v.kind] || v.kind }}</td>
                <td class="c-m" data-i18n-skip>{{ (v.meta && v.meta.label) || v.name }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <template #footer>
        <span class="adlg-ft-l"><button class="btn" :disabled="!selId || busy" @click="act('duplicate')"><Icon name="copy" :size="12" />创建副本</button></span>
        <button class="btn" @click="close">关闭</button>
        <button class="btn primary" :disabled="!selId || busy" @click="act('restore')">还原</button>
      </template>
  </AppDialog>
</template>

<style scoped>
/* 外壳归 AppDialog。类名统一 lbv- 前缀，不与各 App 的 scoped 类冲突。选中行与资源库列表同一口径（surface-2 底 + 左缘 2px 机位色）。 */
.lbv-hd { display: flex; align-items: center; gap: 7px; min-width: 0; }
.lbv-hd-t { flex: none; }
.lbv-nm { flex: 1; min-width: 0; font-size: var(--fs-3); font-weight: 400; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lbv-bd { padding: 10px 12px 12px; display: flex; flex-direction: column; }
.lbv-empty { padding: 18px 4px; font-size: var(--fs-3); color: var(--text-faint); text-align: center; }
.lbv-list { flex: 1; min-height: 160px; max-height: 52vh; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--r-box, 3px); outline: none; }
.lbv-list:focus-visible { border-color: var(--accent-ui); }
.lbv-tbl { width: 100%; table-layout: fixed; border-collapse: collapse; font-size: var(--fs-3); font-variant-numeric: tabular-nums; }
.lbv-tbl th { position: sticky; top: 0; z-index: 1; text-align: left; font-weight: 600; font-size: var(--fs-2); color: var(--text-muted); padding: 4px 8px 4px 9px; background: var(--surface-2); border-bottom: 1px solid var(--border); white-space: nowrap; }
.lbv-tbl td { padding: 4px 8px 4px 9px; border-bottom: 1px solid color-mix(in srgb, var(--border) 45%, transparent); white-space: nowrap; cursor: pointer; }
.lbv-tbl .c-t { width: 168px; font-family: var(--font-mono); }
.lbv-tbl .c-k { width: 92px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; }
.lbv-tbl .c-m { overflow: hidden; text-overflow: ellipsis; }
.lbv-tbl tbody tr:hover { background: var(--surface); }
.lbv-tbl tbody tr.on { background: var(--surface-2); }
.lbv-tbl tbody tr.on td:first-child { box-shadow: inset 2px 0 0 var(--accent-ui); }
.lbv-tbl tbody tr.on .c-k { color: var(--text); }
</style>
