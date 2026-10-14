<script setup>
// 「绑定小程序账号」独立弹窗（主窗口 工具 菜单，与「设置」平级）。
//
// 为什么独立于设置：绑定不是偏好设置，是一份【收件人名册】—— 会经常回来加人、改备注、解绑，
// 而设置是配一次就不再进的地方。埋在设置第四节里等于让人找不到。
//
// 管理面板本体是共享组件（MiniBindingsPanel），发送弹窗里也嵌着同一个，改一处两处都变。
import { ref } from 'vue'
import Icon from './Icon.vue'
import AppDialog from './AppDialog.vue'
import MiniBindingsPanel from './MiniBindingsPanel.vue'

const emit = defineEmits(['close', 'toast'])

// 提交只有一处：底栏「绑定」（面板的行内键关掉）。原先行内「添加」+ 底栏「完成」两个键，
// 粘完码顺手点「完成」就是关窗、码白粘了。绑定后不关窗：新账号出现在名册里就是回执
// （toast 只进默认收起的日志窗格，关了窗什么都看不到）；关窗走 ✕ / Esc / 点遮罩。
const panel = ref(null)

// 外壳是 AppDialog（Esc / 关闭钮关、点遮罩不关）。打开聚焦正文首个控件：这扇窗的正事是粘贴认证码
</script>

<template>
  <AppDialog :width="520" @close="emit('close')">
      <template #title><span class="dt"><Icon name="wechat" :size="16" />绑定小程序账号</span></template>
      <div class="body">
        <MiniBindingsPanel ref="panel" :add-btn="false" @toast="(m) => emit('toast', m)" />
      </div>

      <template #footer>
        <button class="btn primary" :disabled="!panel?.canAdd" @click="panel?.add()">绑定</button>
      </template>
  </AppDialog>
</template>

<style scoped>
/* 外壳归 AppDialog；题条里图标 + 字（字体 / 字号跟 AppDialog 题条） */
.dt { display: inline-flex; align-items: center; gap: 8px; }
.body { display: flex; flex-direction: column; gap: 12px; }
</style>
