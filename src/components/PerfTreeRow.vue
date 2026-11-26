<script setup>
import { ref, nextTick } from 'vue'
import Icon from './Icon.vue'

const props = defineProps({ name: String, open: Boolean, confirmDelete: Boolean })
const emit = defineEmits(['open', 'rename', 'remove', 'menu'])
const editing = ref(false), draft = ref(''), field = ref(null)
function startEdit() {
  draft.value = props.name
  editing.value = true
  nextTick(() => { field.value?.focus(); field.value?.select() })
}
function finish(save) {
  if (!editing.value) return
  editing.value = false
  const name = draft.value.trim()
  if (save && name && name !== props.name) emit('rename', name)
}
</script>

<template>
  <div class="perf-tree-row" :class="{ open }" @contextmenu.prevent.stop="emit('menu', $event)">
    <input v-if="editing" ref="field" v-model="draft" class="ci" aria-label="指标表名称" @contextmenu.stop
           @keydown.enter.stop.prevent="!$event.isComposing && finish(true)" @keydown.esc.stop="finish(false)" @blur="finish(true)" />
    <button v-else type="button" class="table-name" :title="name" @click="emit('open')" @keydown.f2.prevent="startEdit">
      <Icon name="table" :size="13" /><span data-i18n-skip>{{ name }}</span>
    </button>
    <button v-if="!editing" type="button" class="ibtn sm rename" title="重命名指标表" @click="startEdit"><Icon name="pencil" :size="12" /></button>
    <slot />
    <button v-if="!editing" type="button" class="ibtn sm danger" :class="{ armed: confirmDelete }"
            :title="confirmDelete ? '确认删除' : '删除性能指标表'" @click.stop="emit('remove')">
      <template v-if="confirmDelete">确认删除</template><Icon v-else name="x" :size="12" />
    </button>
  </div>
</template>

<style scoped>
.perf-tree-row { display: flex; align-items: center; gap: 2px; margin: 0 0 2px 22px; padding: 0 6px; border-radius: var(--r-box); color: var(--text-muted); }
.perf-tree-row:hover { background: var(--wash-hover); }
.perf-tree-row.open { background: var(--sel-fill); color: var(--sel-on); }
.table-name { display: flex; flex: 1; align-items: center; gap: 6px; min-width: 0; padding: 3px 0; background: transparent; border: 0; color: inherit; font: inherit; font-size: var(--fs-2); cursor: pointer; }
.table-name span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.table-name svg { flex: none; }
.ci { flex: 1; min-width: 0; }
.ibtn.armed { width: auto; white-space: nowrap; }
.rename { opacity: .65; }
.perf-tree-row:hover .rename, .rename:focus-visible { opacity: 1; }
</style>
