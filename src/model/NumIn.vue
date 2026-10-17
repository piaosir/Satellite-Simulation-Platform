<script setup>
// 数字输入（工作台统一件）：草稿字符串 + 失焦 / 回车落值 + 全角归一（shared/num.js）+ 夹取 + Esc 撤回。
// 为什么不用 v-model.number / type=number：前者在「−」「1.」这类中间态上把值改成 0（memory 输入框跳变陷阱），
// 后者吃不了全角「－」（读出来是空串）。表单外回车不发 change（memory sat-edit-live-apply 坑 1），故回车在 keydown 里交还焦点、
// 由失焦落值；落值只挂失焦一处，不挂 change（change 在失焦时也会发，挂上就是同一次改动提交两遍）。
// 同一份量多个写入方（属性面板 / gizmo / 撤销 / 换签 / 驱动参数联动，2026-10-06 任务书 §3.3.3）时的三条规则：
//   ① 只有本次聚焦内键入过（input 事件）才在失焦 / 回车时提交——点进来又点出去、Tab 穿过，一律不提交；
//   ② 外部值变了（聚焦中也一样）→ 丢弃草稿、显示新值、清掉「键入过」：失焦时不会把旧草稿写回去（撤销后被写回、换签后写进新文档）；
//   ③ 禁用（只读 / 拖动中）或组件已卸载时不提交：卸载时浏览器补发的 blur 落不到别的件上。
import { ref, watch, onBeforeUnmount } from 'vue'
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
let typed = false, dead = false
// 规则 ②：外部值变了 → 草稿作废（聚焦中也一样）
watch(() => props.modelValue, (v) => { draft.value = fmt(v); typed = false })
onBeforeUnmount(() => { dead = true })

function commit() {
  if (dead) return
  // 规则 ①③：没键入过 / 禁用 → 只把显示对齐当前值
  if (!typed || props.disabled) { typed = false; draft.value = fmt(props.modelValue); return }
  typed = false
  // 草稿还是显示值原样（键入后又改回去）：不提交 —— 显示按 sig 位有效数字取整，拿它当新值会把
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
function onInput() { typed = true }
// 回车 = 落值并交还焦点（失焦处理器落值，只落一次）——同框里其它文字框「回车即失焦」一个口径（体检 2026-10-16 二.22）。
// 原来回车后焦点留在框里：接着按 Ctrl+Z 撤的是框里的字（框里变回旧值、画面不动），失焦时旧值又被当成一次新改动提交、重做被清；
// 设计页的方向键微调同样落不到件上（全局快捷键一律不管输入框里的按键）
function onKey(e) {
  if (e.isComposing) return   // 输入法组字中的回车 / Esc 归输入法（确认 / 取消组字），不是落值 / 撤回
  if (e.key === 'Enter') e.target.blur()
  else if (e.key === 'Escape') { typed = false; draft.value = fmt(props.modelValue); e.target.blur() }
  else if (!typed && isUndoKey(e)) handBack(e)
}
const isUndoKey = (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return false
  const k = String(e.key || '').toLowerCase()
  return k === 'z' || k === 'y' || e.code === 'KeyZ' || e.code === 'KeyY'
}
// 本次聚焦没键入过时的撤销 / 重做归模型：框里没有要撤的输入（浏览器自带的撤销栈只会把框里改回以前键入过的旧值）。
// 拦下自带的撤销、交还焦点，再把同一组按键交给页面的全局快捷键（工作台 / 装配会话 / 3D 页的撤销都挂在 window 上、只认非输入框目标）
function handBack(e) {
  e.preventDefault()
  e.stopPropagation()
  e.target.blur()
  document.body.dispatchEvent(new KeyboardEvent('keydown', {
    key: e.key, code: e.code, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, repeat: e.repeat, bubbles: true, cancelable: true
  }))
}
</script>

<template>
  <input class="ci md-num" :class="{ bad }" type="text" inputmode="decimal" spellcheck="false" autocomplete="off"
         v-model="draft" :disabled="disabled" :placeholder="placeholder" :title="title || null"
         @input="onInput" @blur="commit" @keydown="onKey" />
</template>

<style scoped>
.md-num { font-family: var(--font-mono); text-align: right; min-width: 0; }
.md-num.bad { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 70%, var(--field-border)); background-color: color-mix(in srgb, var(--danger) 7%, var(--field-bg)); }
</style>
