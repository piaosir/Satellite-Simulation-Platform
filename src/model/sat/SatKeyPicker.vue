<script setup>
// 目标星选择（姿态律 target 的「另一颗星」、分析页万向节的对星目标）：搜目录星共享候选池，点一行得到绑定键（norad:<号> …）。
// v-model = 绑定键；label = 显示名（选中时回写）。
import { ref, shallowRef, computed, watch } from 'vue'
import Icon from '../../components/Icon.vue'
import { catalogPool, searchPool } from '../satSources.js'
import { keyLabel } from '../satStore.js'

const props = defineProps({ modelValue: { type: String, default: '' }, label: { type: String, default: '' } })
const emit = defineEmits(['update:modelValue', 'update:label', 'pick'])
const q = ref('')
const open = ref(false)
const pool = shallowRef(null)
const busy = ref(false)
async function ensure() { if (pool.value || busy.value) return; busy.value = true; try { pool.value = await catalogPool() } catch { pool.value = [] } busy.value = false }
watch(q, (v) => { if (v.trim()) { open.value = true; ensure() } })
const hits = computed(() => (pool.value && q.value.trim() ? searchPool(pool.value, q.value, 12) : []))
function pick(x) {
  emit('update:modelValue', x.key); emit('update:label', x.name); emit('pick', { satKey: x.key, label: x.name, poolRec: x.rec })
  q.value = ''; open.value = false
}
function onBlur() { setTimeout(() => { open.value = false }, 150) }
</script>

<template>
  <div class="skp">
    <label class="skp-in">
      <Icon name="search" :size="12" />
      <input v-model="q" type="text" spellcheck="false" :placeholder="modelValue ? (label || keyLabel(modelValue)) : '搜索目标星'" :title="modelValue || '名称 / NORAD'"
             @focus="q.trim() && (open = true)" @blur="onBlur" />
    </label>
    <div v-if="open && (hits.length || busy)" class="skp-pop">
      <div v-if="busy" class="skp-busy"><span class="skp-spin"></span></div>
      <button v-for="x in hits" :key="x.key" type="button" class="skp-row" :title="x.key" @mousedown.prevent="pick(x)">
        <span data-i18n-skip>{{ x.name }}</span><span class="skp-s" data-i18n-skip>{{ x.norad && Number(x.norad) < 800000 ? x.norad : x.group }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.skp { position: relative; flex: 1 1 150px; min-width: 0; }
.skp-in { display: flex; align-items: center; gap: 4px; height: var(--h-ctl); padding: 0 6px; color: var(--text-faint); background: var(--field-bg); border: 1px solid var(--field-border); border-radius: var(--r-ctl); }
.skp-in:focus-within { border-color: var(--accent-ui); }
.skp-in input { flex: 1; min-width: 0; height: 100%; border: 0 !important; background: transparent !important; outline: none; padding: 0 !important; font-size: var(--fs-3); color: var(--text); box-shadow: none !important; }
.skp-in input::placeholder { color: var(--text-muted); }
.skp-pop { position: absolute; left: 0; right: 0; top: calc(100% + 2px); z-index: 40; max-height: 220px; overflow-y: auto; background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--r-ctl); box-shadow: var(--shadow-2); animation: ui-float-in var(--dur-2) var(--ease-out); }
.skp-row { display: flex; width: 100%; gap: 6px; align-items: baseline; justify-content: space-between; padding: 3px 7px; border: 0; background: transparent; color: var(--text); font: inherit; font-size: var(--fs-3); text-align: left; cursor: pointer; }
.skp-row:hover { background: var(--wash-hover, var(--surface)); }
.skp-s { flex: none; font-size: var(--fs-1); color: var(--text-faint); font-family: var(--font-mono); }
.skp-busy { display: flex; justify-content: center; padding: 8px 0; }
.skp-spin { width: 11px; height: 11px; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--text) 18%, transparent); border-top-color: var(--accent-ui); animation: skp-spin .7s linear infinite; }
@keyframes skp-spin { to { transform: rotate(360deg); } }
</style>
