<script setup>
// 数字输入框（全平台共用）—— 专治「输到一半跳回原值」。
//
// 根因有两条，都在本组件里堵死：
//   ① Vue 对 <input> 的 value 是「新旧不等就写」。页面因别的原因重渲染时（本仓最常见的是
//      1 Hz 的仿真时钟：一秒一跳，整页跟着重渲染），模型里还是旧值、框里是你正打的那串
//      —— 两者不等，于是旧值把输入盖掉。type=number 更狠：中间态（"-"、"1e"、"12."）读
//      el.value 是【空串】，必然不等，必然被盖。
//   ② 微调箭头的「台阶基准」取的是 value 属性（＝上次提交的值）。基准与显示不一致时，
//      浏览器按 基准 + k×step 吸附 —— 旧值 1002.1、输入 39680、点一下 ▲ 就成了 39682.1。
//
// 解法是本地草稿：编辑期间渲染出去的就是你正在打的那串 —— 无条件回写写的是同一个值
// （等值不落笔、光标不动），value 属性也随之跟到当前值上 → 箭头就是「当前值 ±step」。
// 只在 change / Enter / 失焦时提交；非法或空则退回原值（allowEmpty 时提交 null）。
//
// 用法：<NumBox class="ci" :model-value="x" :min="-180" :max="180" :step="0.5" @commit="setX" />
//   commit 收到的是【数字】（或 allowEmpty 下的 null），不是事件 —— 调用方不必再 $event.target.value。
//   v-model 也支持（update:modelValue 与 commit 同时发）。
import { ref, computed } from 'vue'

const props = defineProps({
  modelValue: { type: [Number, String], default: null },
  min: { type: [Number, String], default: null },
  max: { type: [Number, String], default: null },
  step: { type: [Number, String], default: null },
  placeholder: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  allowEmpty: { type: Boolean, default: false },   // 允许清空：提交 null（用于「留空＝自动」这类格子）
  clamp: { type: Boolean, default: true }          // 提交时夹到 [min, max]
})
const emit = defineEmits(['update:modelValue', 'commit'])

const draft = ref(null)          // 非 null ＝ 正在编辑，渲染取它
const shown = computed(() => (draft.value != null ? draft.value : (props.modelValue == null ? '' : String(props.modelValue))))

function onInput(e) { draft.value = e.target.value }
function commit() {
  const t = draft.value
  draft.value = null             // 先退草稿：非法/空输入靠这一步让显示回落原值
  if (t == null) return
  const s = String(t).trim()
  if (s === '') { if (props.allowEmpty) { emit('update:modelValue', null); emit('commit', null) } return }
  let v = Number(s)
  if (!Number.isFinite(v)) return
  if (props.clamp) {
    if (props.min != null && props.min !== '' && v < Number(props.min)) v = Number(props.min)
    if (props.max != null && props.max !== '' && v > Number(props.max)) v = Number(props.max)
  }
  emit('update:modelValue', v); emit('commit', v)
}
function onKey(e) {
  if (e.key === 'Enter') e.target.blur()
  else if (e.key === 'Escape') { draft.value = null; e.target.blur() }
}
// 滚轮：Chromium 在输入框带焦点时把滚轮当微调轮使，侧栏一滚数值就被悄悄改掉 → 焦点在本格时吃掉它
function onWheel(e) { if (e.target === document.activeElement) e.preventDefault() }
</script>

<template>
  <input type="number" :value="shown" :min="min" :max="max" :step="step" :placeholder="placeholder" :disabled="disabled"
    @input="onInput" @change="commit" @blur="commit" @keydown="onKey" @wheel="onWheel" />
</template>
