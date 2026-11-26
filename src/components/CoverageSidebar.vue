<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import CoveragePaneSplit from './CoveragePaneSplit.vue'
import CoverageAngleFields from './CoverageAngleFields.vue'
import Icon from './Icon.vue'

const props = defineProps({
  treeId: { type: String, required: true },
  grd: { type: Object, required: true },
  lines: { type: Object, required: true },
  shells: Array,
  legacyName: { type: String, default: '' },
  satellite: Object,
  selectedCount: { type: Number, default: 0 }
})
const emit = defineEmits(['close-legacy', 'close-satellite'])
const line = computed(() => props.lines.rows.value.find(row => row.id === props.lines.editing.value))
const lineName = computed(() => props.legacyName || (line.value && (line.value.name || (line.value.kind === 'elevation' ? '仰角线' : '波束角线'))))
async function revealLine() {
  const folder = line.value?.key.split('|')[0]
  if (folder && !props.grd.isExpanded(folder)) props.grd.toggleExpand(folder)
  await nextTick()
  tree.value?.querySelector('.angle-child.editing, .gsat-el.editing')?.scrollIntoView({ block: 'nearest' })
}
function closeLine() {
  props.lines.editing.value = ''
  emit('close-legacy')
}
const tree = ref(null)
const renameKey = ref(''), draft = ref(''), invalid = ref(false), field = ref(null)
const edited = computed(() => {
  const key = props.grd.active.value
  if (!key) return null
  const folder = key.split('|')[0]
  const sat = props.grd.sats.value.find(item => item.folder === folder)
  return sat && { folder, satellite: sat.satName || folder, antenna: props.grd.activeName() }
})
async function revealEdited() {
  if (!edited.value) return
  const { folder } = edited.value
  if (!props.grd.isExpanded(folder)) props.grd.toggleExpand(folder)
  await nextTick()
  tree.value?.querySelector('.gant.foc')?.scrollIntoView({ block: 'nearest' })
}
async function startRename() {
  renameKey.value = props.grd.active.value
  draft.value = edited.value.antenna
  invalid.value = false
  await nextTick()
  field.value?.focus()
  field.value?.select()
}
function cancelRename() { renameKey.value = ''; invalid.value = false }
function commitRename() {
  if (!renameKey.value || renameKey.value !== props.grd.active.value || !edited.value) return
  const { folder, antenna } = edited.value
  if (props.grd.renameAntenna(folder, antenna, draft.value) === false) invalid.value = true
  else cancelRename()
}
watch([() => props.grd.active.value, () => props.satellite, () => props.lines.editing.value, () => props.legacyName],
  cancelRename, { flush: 'sync' })
</script>

<template>
  <div class="coverage-sidebar">
    <CoveragePaneSplit :pane-id="treeId + '-pane'" label="卫星 / 天线" :min-upper="104" :min-lower="190">
      <template #upper>
        <div class="tree-heading sect">
          <slot name="heading" />
          <span v-if="selectedCount" class="tree-count">{{ selectedCount }} 已选</span>
          <div class="tree-tools"><slot name="actions" /></div>
        </div>
        <div ref="tree" class="tree-view"><slot name="tree" /></div>
        <div v-if="satellite" class="edit-path">
          <span>{{ satellite.folder ? '编辑中' : '添加卫星' }}</span>
          <button v-if="satellite.folder" type="button" class="path-link" :title="satellite.name || '卫星'"
                  @click="tree?.querySelector('.gsat.sat-editing')?.scrollIntoView({ block: 'nearest' })">
            <strong class="path-part" data-i18n-skip>{{ satellite.name || '卫星' }}</strong>
          </button>
          <strong v-else class="path-part sat-draft-name" data-i18n-skip>{{ satellite.name }}</strong>
          <button type="button" class="ibtn sm" title="关闭设置" @click="emit('close-satellite')"><Icon name="x" :size="12" /></button>
        </div>
        <div v-else-if="lineName" class="edit-path">
          <span>编辑中</span>
          <button type="button" class="path-link" :title="lineName" @click="revealLine"><strong class="path-part">{{ lineName }}</strong></button>
          <button type="button" class="ibtn sm" title="关闭设置" @click="closeLine"><Icon name="x" :size="12" /></button>
        </div>
        <div v-else-if="edited" class="edit-path">
          <span>编辑中</span>
          <template v-if="renameKey">
            <span class="path-part rename-parent" :title="edited.satellite" data-i18n-skip>{{ edited.satellite }}</span><span>/</span>
            <input ref="field" v-model="draft" aria-label="天线名称" :aria-invalid="invalid" @input="invalid = false"
                   @keydown.stop @keydown.enter.prevent="commitRename" @keydown.esc.prevent="cancelRename" @blur="commitRename" />
            <button type="button" class="ibtn sm" title="确认重命名" @mousedown.prevent @click="commitRename"><Icon name="check" :size="12" /></button>
          </template>
          <template v-else>
            <button type="button" class="path-link" @click="revealEdited" :title="edited.satellite + ' / ' + edited.antenna">
              <span class="path-part" data-i18n-skip>{{ edited.satellite }}</span><span>/</span><strong class="path-part" data-i18n-skip>{{ edited.antenna }}</strong>
            </button>
            <button type="button" class="ibtn sm" title="重命名天线" @click="startRename"><Icon name="pencil" :size="12" /></button>
          </template>
        </div>
        <div v-if="invalid" class="rename-error" role="alert">天线名为空或与同星其他天线重名</div>
      </template>
      <slot v-if="satellite" name="satellite" />
      <div v-else-if="lineName" class="line-inspector">
        <slot v-if="legacyName" name="legacy" />
        <CoverageAngleFields v-else :key="line.id" :line="line" :display="grd.s" :shells="shells" />
      </div>
      <div v-show="!lineName && !satellite" class="antenna-inspector"><slot /></div>
    </CoveragePaneSplit>
    <slot name="footer" />
  </div>
</template>

<style scoped>
.coverage-sidebar { display: flex; flex-direction: column; flex: 1; height: 100%; min-height: 0; overflow: hidden; background: var(--surface); font-size: var(--fs-3); }
.tree-heading { flex: none; display: flex; align-items: center; gap: 4px 8px; flex-wrap: wrap; padding: 8px 16px 4px; }
.tree-heading :deep([data-sec]) { font-weight: 600; }
.tree-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-inline-start: auto; }
.tree-count, .edit-path { color: var(--text-muted); font-size: var(--fs-2); }
.tree-view { padding: 0 10px 3px; flex: 1 1 auto; min-height: 0; overflow: auto; overscroll-behavior: contain; }
.tree-view :deep(.gtree) { overflow: visible; max-height: none; min-height: 100%; }
.edit-path { flex: none; display: flex; align-items: center; gap: 6px; padding: 2px 12px; min-height: 26px; background: var(--surface-2); }
.path-link { flex: 1; min-width: 0; display: flex; align-items: center; gap: 5px; padding: 2px 0; border: 0; background: none; color: inherit; font: inherit; cursor: pointer; }
.path-link:hover strong { text-decoration: underline; }
.rename-parent { max-width: 30%; }
.edit-path input { flex: 1; min-width: 0; font: inherit; }
.edit-path input[aria-invalid="true"] { border-color: var(--danger); }
.rename-error { padding: 2px 12px; color: var(--danger); font-size: var(--fs-2); }
.edit-path > :first-child { flex: none; }
.path-part { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
.edit-path strong { color: var(--accent); }
.sat-draft-name { flex: 1; }
.coverage-sidebar :deep(.gsat.sat-editing) { background: var(--accent-ui-wash); box-shadow: inset 2px 0 var(--accent-ui); }
.coverage-sidebar :deep(button.gsname) { border: 0; background: transparent; text-align: start; padding: 0; font: inherit; color: inherit; cursor: pointer; }
.coverage-sidebar :deep(.coverage-settings) { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
.coverage-sidebar :deep(.csfoot) { flex: none; }
.antenna-inspector { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.line-inspector { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
</style>
