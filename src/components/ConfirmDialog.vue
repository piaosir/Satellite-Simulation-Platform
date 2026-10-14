<script setup>
// 确认框：shared/ui/useConfirm.js 的 askConfirm() 弹出的那一个。窗口根组件里挂一次。
import AppDialog from './AppDialog.vue'
import { confirmState, answerConfirm } from '../shared/ui/useConfirm.js'
</script>

<template>
  <AppDialog :open="confirmState.open" :title="confirmState.title" :width="400" initial-focus=".cfd-ok" @close="answerConfirm(false)">
    <div class="cfd-msg">{{ confirmState.msg }}</div>
    <template #footer>
      <button type="button" class="btn" @click="answerConfirm(false)">{{ confirmState.cancelText }}</button>
      <button type="button" class="btn primary cfd-ok" @click="answerConfirm(true)">{{ confirmState.okText }}</button>
    </template>
  </AppDialog>
</template>

<style>
.cfd-msg { white-space: pre-wrap; line-height: 1.55; word-break: break-word; }
</style>
