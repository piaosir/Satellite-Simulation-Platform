<script setup>
// 性能指标表窗口内的模态对话框：外壳是 AppDialog（×、页脚按钮、Esc 关；Esc 判输入法组字）。
// 点遮罩不关：改设置时常要点到外面看表，且在输入框里拖选文字松手落在遮罩上时 click 会落到遮罩本身
// （click 的目标是 mousedown 与 mouseup 的公共祖先）——「点遮罩即关」在这两种情形下都表现为失焦即关。
// 对调用方的接口不变：title / sub / width、默认插槽 = 正文、#foot = 页脚。正文仍包一层 .sdbody（perfwin.css 的正文规则挂在它下面）。
import AppDialog from '../components/AppDialog.vue'

const props = defineProps({
  title: { type: String, default: '' },
  sub: { type: String, default: '' },          // 标题右侧的小字（天线名一类用户数据，打 skip）
  width: { type: Number, default: 460 }
})
const emit = defineEmits(['close'])
</script>

<template>
  <AppDialog :width="width" flush dialog-class="pwd" @close="emit('close')">
    <template #title>{{ title }}<em v-if="sub" class="pwd-sub" data-i18n-skip>{{ sub }}</em></template>
    <div class="sdbody"><slot /></div>
    <template v-if="$slots.foot" #footer><slot name="foot" /></template>
  </AppDialog>
</template>

<style>
/* 题条小字（天线名一类用户数据） */
.pwd-sub { margin-left: 8px; font-style: normal; font-weight: 400; font-family: var(--font-mono); font-size: var(--fs-3); color: var(--text-faint); }
/* 页脚左端：「恢复默认」推到左端，主钮留在右端（dialogClass 落在 AppDialog 内部元素上，故不 scoped） */
.adlg.pwd .adlg-ft > .po-reset { margin-right: auto; }
</style>
