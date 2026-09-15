<script setup>
// 工具条下拉菜单（Office 式）：一个按钮，点开一列命令。项 = { key, label, icon?, dis?, sep?, head? }。
// 选中即 emit('pick', key) 并收起；点外部 / Esc 收起。菜单项的文字是界面文本，走 i18n 观察器；
// 用户数据（航迹名、城市组名）由调用方打 skip 标记（item.skip=true）。
import { ref, onMounted, onBeforeUnmount } from 'vue'
import Icon from '../components/Icon.vue'

const props = defineProps({
  label: { type: String, default: '' },
  icon: { type: String, default: '' },
  items: { type: Array, default: () => [] },
  title: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  align: { type: String, default: 'left' }    // 'left' | 'right'：菜单贴按钮的哪一边
})
const emit = defineEmits(['pick', 'open'])
const open = ref(false)
const root = ref(null)
function toggle() { if (props.disabled) return; open.value = !open.value; if (open.value) emit('open') }
function pick(it) { if (!it || it.dis || it.sep || it.head) return; open.value = false; emit('pick', it.key, it) }
function onDoc(e) { if (open.value && root.value && !root.value.contains(e.target)) open.value = false }
function onKey(e) { if (e.key === 'Escape') open.value = false }
onMounted(() => { document.addEventListener('mousedown', onDoc, true); document.addEventListener('keydown', onKey, true) })
onBeforeUnmount(() => { document.removeEventListener('mousedown', onDoc, true); document.removeEventListener('keydown', onKey, true) })
</script>

<template>
  <span ref="root" class="pwm-wrap">
    <span class="ptb pwm-btn" :class="{ on: open, dis: disabled }" :title="title" @click="toggle">
      <Icon v-if="icon" :name="icon" :size="12" /><span v-if="label">{{ label }}</span><Icon name="chevron-down" :size="10" class="pwm-caret" />
    </span>
    <div v-if="open" class="pwm" :class="{ r: align === 'right' }">
      <template v-for="(it, i) in items" :key="it.key || ('s' + i)">
        <div v-if="it.sep" class="pwm-sep"></div>
        <div v-else-if="it.head" class="pwm-h">{{ it.label }}</div>
        <div v-else class="pwm-i" :class="{ dis: it.dis }" :title="it.title || ''" @click="pick(it)">
          <Icon v-if="it.icon" :name="it.icon" :size="12" /><span :data-i18n-skip="it.skip ? '' : null">{{ it.label }}</span><em v-if="it.note" data-i18n-skip>{{ it.note }}</em>
        </div>
      </template>
      <div v-if="!items.length" class="pwm-h">（空）</div>
    </div>
  </span>
</template>
