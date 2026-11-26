<script setup>
import { computed, nextTick, ref } from 'vue'
import LinkNodeIcon from './LinkNodeIcon.vue'

const props = defineProps({
  id: { type: String, required: true },
  modelValue: { type: String, required: true },
  groups: { type: Array, required: true },
  title: { type: String, default: '' }
})
const emit = defineEmits(['update:modelValue'])
const trigger = ref(null), list = ref(null), open = ref(false), active = ref('')
const options = computed(() => props.groups.flatMap(group => group.items))
const selected = computed(() => options.value.find(item => item.value === props.modelValue)
  ?? props.groups.find(group => group.key === 'none')?.items[0])
const optionId = value => props.id + '-opt-' + value
let prefix = '', typedAt = 0

function reveal(value) {
  active.value = value
  nextTick(() => document.getElementById(optionId(value))?.scrollIntoView({ block: 'nearest' }))
}
function onToggle(event) {
  open.value = event.newState === 'open'
  if (!open.value) return
  const rect = trigger.value.getBoundingClientRect()
  const below = window.innerHeight - rect.bottom - 4, above = rect.top - 4
  const up = below < 300 && above > below
  Object.assign(list.value.style, {
    left: rect.left + 'px', width: rect.width + 'px',
    top: up ? 'auto' : rect.bottom + 2 + 'px',
    bottom: up ? window.innerHeight - rect.top + 2 + 'px' : 'auto',
    maxHeight: Math.min(340, up ? above : below) + 'px'
  })
  reveal(selected.value?.value ?? options.value[0]?.value)
}
function pick(value) {
  emit('update:modelValue', value)
  list.value.hidePopover()
}
function onKey(event) {
  const items = options.value
  if (event.isComposing || !items.length || event.ctrlKey || event.metaKey) return
  const key = event.key
  if (key === 'Tab') { list.value.hidePopover(); return }
  if (key === 'Escape' && open.value) list.value.hidePopover()
  else if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(key) && !open.value) list.value.showPopover()
  else if ((key === 'Enter' || key === ' ') && open.value) pick(active.value)
  else {
    let index = items.findIndex(item => item.value === (open.value ? active.value : props.modelValue))
    if (key === 'Home') index = 0
    else if (key === 'End') index = items.length - 1
    else if (key === 'ArrowDown') index = Math.min(items.length - 1, index + 1)
    else if (key === 'ArrowUp') index = Math.max(0, index - 1)
    else if (key.length === 1 && !event.altKey) {
      const now = Date.now()
      prefix = (now - typedAt < 700 ? prefix : '') + key.toLowerCase()
      typedAt = now
      index = items.findIndex(item => document.getElementById(optionId(item.value))?.textContent.trim().toLowerCase().startsWith(prefix))
    } else return
    if (index >= 0) {
      if (open.value) reveal(items[index].value)
      else pick(items[index].value)
    }
  }
  event.preventDefault()
  event.stopPropagation()
}
</script>

<template>
  <button ref="trigger" :id="id" type="button" class="vis-object-select" role="combobox"
          :title="title" :aria-expanded="open" :aria-controls="id + '-list'" :popovertarget="id + '-list'"
          :aria-activedescendant="open ? optionId(active) : undefined" @keydown="onKey">
    <LinkNodeIcon v-if="selected?.kind" :kind="selected.kind" :object-id="selected.objectId" :size="18" />
    <span class="value" :data-i18n-skip="selected?.userLabel ? '' : null">{{ selected?.label }}</span>
  </button>
  <div ref="list" :id="id + '-list'" class="vis-object-list" popover="auto" role="listbox"
       :aria-labelledby="id + '-label'" @beforetoggle="onToggle" @mousedown.prevent>
    <div v-for="group in groups" :key="group.key" role="group" :aria-label="group.label">
      <div v-if="group.label" class="group-label">{{ group.label }}</div>
      <div v-for="item in group.items" :key="item.value" :id="optionId(item.value)" role="option"
           :aria-selected="item.value === selected?.value" :class="{ active: item.value === active }"
           @pointermove="active = item.value" @click="pick(item.value)">
        <LinkNodeIcon v-if="item.kind" :kind="item.kind" :object-id="item.objectId" :size="18" />
        <span :data-i18n-skip="item.userLabel ? '' : null">{{ item.label }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vis-object-select, [role="option"] { display: flex; align-items: center; gap: 6px; color: var(--text); font: inherit; font-size: var(--fs-3); text-align: left; cursor: pointer; }
.vis-object-select { flex: 1; min-width: 0; height: var(--h-ctl); padding: 0 21px 0 7px; border: 1px solid var(--field-border); border-radius: var(--r-ctl); background: var(--field-bg) var(--ctl-caret) no-repeat right 6px center / 10px; }
.vis-object-select:hover { border-color: var(--field-border-hover); }
.value, [role="option"] > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vis-object-list { position: fixed; inset: auto; box-sizing: border-box; margin: 0; padding: 3px; overflow-y: auto; overscroll-behavior: contain; background: var(--surface); color: var(--text); border: 1px solid var(--field-border); border-radius: var(--r-ctl); }
.group-label { padding: 3px 6px; color: var(--text-muted); font-size: var(--fs-2); font-weight: 600; }
[role="option"] { padding: 3px 6px; border-radius: var(--r-box); }
[role="option"][aria-selected="true"] { background: var(--accent-ui-weak); }
[role="option"].active { background: var(--accent-fill); color: var(--accent-on); }
</style>
