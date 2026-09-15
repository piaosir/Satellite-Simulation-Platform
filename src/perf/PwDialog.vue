<script setup>
// 窗口内模态对话框外壳：遮罩 + 标题条 + 正文插槽 + 页脚插槽。只认 ×、页脚按钮与 Esc 关闭。
// 点遮罩不关：改设置时常要点到外面看表，且在输入框里拖选文字松手落在遮罩上时 click 会落到遮罩本身
// （click 的目标是 mousedown 与 mouseup 的公共祖先）——原先的「点遮罩即关」在这两种情形下都表现为失焦即关。
import { onMounted, onBeforeUnmount } from 'vue'
import Icon from '../components/Icon.vue'

const props = defineProps({
  title: { type: String, default: '' },
  sub: { type: String, default: '' },          // 标题右侧的小字（天线名一类用户数据，打 skip）
  width: { type: Number, default: 460 }
})
const emit = defineEmits(['close'])
function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); emit('close') } }
onMounted(() => document.addEventListener('keydown', onKey, true))
onBeforeUnmount(() => document.removeEventListener('keydown', onKey, true))
</script>

<template>
  <div class="pw-mask">
    <div class="pw-dlg" :style="{ width: width + 'px' }">
      <div class="sdh"><span>{{ title }}</span><em v-if="sub" data-i18n-skip>{{ sub }}</em><span class="csx" @click="emit('close')"><Icon name="x" :size="12" /></span></div>
      <div class="sdbody"><slot /></div>
      <div v-if="$slots.foot" class="sdfoot"><slot name="foot" /></div>
    </div>
  </div>
</template>
