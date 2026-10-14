<script setup>
// 计算窗口通知条的渲染（配 shared/useNotice.js）。
// 普通状态：一行绿字；导出完成：附「打开 · 在文件夹中显示」；失败：红字常驻 + ×。
// 打开 / 显示走主进程白名单（只认本会话写过的文件），见 electron/services/exportedPaths.js。
import Icon from './Icon.vue'
const props = defineProps({ n: { type: Object, required: true } })
const api = typeof window !== 'undefined' ? window.api : null
const canFile = !!(api && api.files)
function openFile() { if (canFile && props.n.noticeFile.value) api.files.open(props.n.noticeFile.value).catch(() => {}) }
function revealFile() { if (canFile && props.n.noticeFile.value) api.files.reveal(props.n.noticeFile.value).catch(() => {}) }
</script>

<template>
  <span v-if="n.notice.value" class="nl" :class="{ err: n.noticeLevel.value === 'error' }" :title="n.notice.value">
    <span class="nl-t">{{ n.notice.value }}</span>
    <template v-if="n.noticeFile.value && canFile">
      <button type="button" class="nl-a" @click="openFile">打开</button><button type="button" class="nl-a" @click="revealFile">在文件夹中显示</button>
    </template>
    <button v-if="n.noticeLevel.value === 'error'" type="button" class="nl-x ibtn sm" title="关闭" aria-label="关闭" @click="n.clearNotice()"><Icon name="x" :size="12" /></button>
  </span>
</template>

<style scoped>
.nl { display: inline-flex; align-items: center; gap: 8px; min-width: 0; max-width: 520px; color: var(--ok); font-size: var(--fs-2); }
.nl.err { color: var(--danger); }
.nl-t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.nl-a { flex: none; padding: 0; border: 0; background: none; font: inherit; color: var(--accent-ui, var(--accent)); cursor: pointer; text-decoration: none; white-space: nowrap; }
.nl-a:hover { text-decoration: underline; }
.nl-x { flex: none; height: 18px; width: 18px; }
</style>
