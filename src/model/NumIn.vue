<script setup>
// 数字输入（工作台统一件）：草稿字符串 + 失焦 / 回车落值 + 全角归一（shared/num.js）+ 夹取 + Esc 撤回。
// 为什么不用 v-model.number / type=number：前者在「−」「1.」这类中间态上把值改成 0（memory 输入框跳变陷阱），
// 后者吃不了全角「－」（读出来是空串）。表单外回车不发 change（memory sat-edit-live-apply 坑 1），故回车在 keydown 里自己落值；
// 落值只挂失焦 + 回车两处，不再挂 change（change 在失焦时也会发，挂上就是同一次改动提交两遍）。
import { ref, watch } from 'vue'
import { num } from '../shared/num.js'

const props = defineProps({
  modelValue: { type: Number, default: null },
  min: { type: Number, default: -Infinity },
  max: { type: Number, default: Infinity },
  sig: { type: Number, default: 7 },        // 显示有效数字（存的是原值，只影响显示）
  integer: { type: Boolean, default: false },
  allowEmpty: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  placeholder: { type: String, default: '' },
  bad: { type: Boolean, default: false },   // 描红（缺值 / 示意值）
  title: { type: String, default: '' }
})
const emit = defineEmits(['update:modelValue', 'commit'])

function fmt(v) {
  if (v == null || !Number.isFinite(v)) return ''
  if (props.integer) return String(Math.round(v))
  if (v === 0) return '0'
  const a = Math.abs(v)
  if (a >= 1e9 || a < 1e-6) return v.toExponential(Math.max(0, props.sig - 1)).replace(/\.?0+e/, 'e')
  return String(Number(v.toPrecision(props.sig)))
}
const draft = ref(fmt(props.modelValue))
let focused = false
watch(() => props.modelValue, (v) => { if (!focused) draft.value = fmt(v) })

function commit() {
  // 草稿还是显示值原样（只是点进来又点出去 / Esc）：不提交 —— 显示按 sig 位有效数字取整，拿它当新值会把
  // 1234.56789 悄悄改成 1234.568，还凭空压一条撤销、把质量特性的来源翻成「手填」
  if (draft.value === fmt(props.modelValue)) return
  let n = num(draft.value)
  if (n == null) {
    if (props.allowEmpty) { if (props.modelValue !== null) { emit('update:modelValue', null); emit('commit', null) } draft.value = ''; return }
    draft.value = fmt(props.modelValue)
    return
  }
  if (props.integer) n = Math.round(n)
  n = Math.min(props.max, Math.max(props.min, n))
  draft.value = fmt(n)
  if (n !== props.modelValue) { emit('update:modelValue', n); emit('commit', n) }
}
function onKey(e) {
  if (e.key === 'Enter') { commit(); e.target.select && e.target.select() }
  else if (e.key === 'Escape') { draft.value = fmt(props.modelValue); e.target.blur() }
}
</script>

<template>
  <input class="ci md-num" :class="{ bad }" type="text" inputmode="decimal" spellcheck="false" autocomplete="off"
         v-model="draft" :disabled="disabled" :placeholder="placeholder" :title="title || null"
         @focus="focused = true" @blur="focused = false; commit()" @keydown="onKey" />
</template>

<style scoped>
.md-num { font-family: var(--font-mono); text-align: right; min-width: 0; }
.md-num.bad { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 70%, var(--field-border)); background-color: color-mix(in srgb, var(--danger) 7%, var(--field-bg)); }
</style>
