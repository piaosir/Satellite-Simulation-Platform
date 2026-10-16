<script setup>
// 「数据」页签：脚本里 `data` 的树形浏览器（键 + 类型 / 值读数），点一行把它的取值路径插进编辑器光标处。
// 递归组件、只渲染展开的节点；大数组按 200 项一段展开（等值线点列动辄上千项）。
import { ref, computed } from 'vue'
import Icon from './Icon.vue'

defineOptions({ name: 'BeamDataTree' })
const props = defineProps({
  value: { type: null, default: undefined },
  name: { type: [String, Number], default: 'data' },
  path: { type: String, default: 'data' },
  depth: { type: Number, default: 0 },
  open: { type: Boolean, default: false }
})
const emit = defineEmits(['pick'])

const CHUNK = 200
const expanded = ref(props.open)
const shown = ref(CHUNK)
const isArr = computed(() => Array.isArray(props.value))
const isObj = computed(() => props.value !== null && typeof props.value === 'object')
// [lon, lat] 这类纯数值短数组就地显示，不再展开一层
const inlineArr = computed(() => isArr.value && props.value.length <= 4 && props.value.every((v) => typeof v === 'number'))
const container = computed(() => isObj.value && !inlineArr.value)
const keys = computed(() => (container.value ? (isArr.value ? props.value.map((_, i) => i) : Object.keys(props.value)) : []))
const kids = computed(() => keys.value.slice(0, shown.value))
const more = computed(() => Math.max(0, keys.value.length - shown.value))
const IDENT = /^[A-Za-z_$][\w$]*$/
const childPath = (k) => (typeof k === 'number' ? `${props.path}[${k}]` : IDENT.test(k) ? `${props.path}.${k}` : `${props.path}[${JSON.stringify(k)}]`)
const summary = computed(() => {
  const v = props.value
  if (inlineArr.value) return '[' + v.map((x) => +x.toFixed(6)).join(', ') + ']'
  if (isArr.value) return `Array(${v.length})`
  if (isObj.value) return '{…}'
  if (typeof v === 'string') return JSON.stringify(v.length > 120 ? v.slice(0, 120) + '…' : v)
  return String(v)
})
const kind = computed(() => (container.value ? 'obj' : typeof props.value === 'string' ? 'str' : (typeof props.value === 'number' ? 'num' : 'lit')))
function toggle() { if (container.value) expanded.value = !expanded.value }
</script>

<template>
  <div class="bdt">
    <div class="bdt-row" :style="{ paddingLeft: (depth * 14 + 4) + 'px' }" :title="path" @click="emit('pick', path)">
      <button v-if="container" type="button" class="bdt-tw" :aria-expanded="expanded" @click.stop="toggle">
        <Icon :name="expanded ? 'chevron-down' : 'chevron-right'" :size="12" />
      </button>
      <span v-else class="bdt-tw" />
      <span class="bdt-k" data-i18n-skip>{{ name }}</span>
      <span class="bdt-v" :class="'k-' + kind" data-i18n-skip>{{ summary }}</span>
    </div>
    <template v-if="container && expanded">
      <BeamDataTree v-for="k in kids" :key="k" :value="value[k]" :name="k" :path="childPath(k)" :depth="depth + 1" @pick="(p) => emit('pick', p)" />
      <div v-if="more" class="bdt-row bdt-more" :style="{ paddingLeft: ((depth + 1) * 14 + 22) + 'px' }" @click="shown += CHUNK">
        <span>… {{ more }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.bdt-row { display: flex; align-items: center; gap: 4px; height: 20px; padding-right: 8px; font-family: var(--font-code); font-size: var(--fs-3); white-space: nowrap; cursor: pointer; border-radius: var(--r-ctl); }
.bdt-row:hover { background: var(--wash-hover); }
.bdt-tw { flex: none; width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; padding: 0; border: 0; background: transparent; color: var(--text-faint); }
.bdt-k { flex: none; color: var(--text); }
.bdt-k::after { content: ':'; color: var(--text-faint); }
.bdt-v { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--text-muted); }
.bdt-v.k-str { color: var(--ok); }
.bdt-v.k-num { color: var(--accent-ui); }
.bdt-v.k-obj { color: var(--text-faint); }
.bdt-more { color: var(--text-faint); }
</style>
