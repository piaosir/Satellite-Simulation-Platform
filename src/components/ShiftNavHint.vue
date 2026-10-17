<script setup>
// 地图工具态横幅里的按键提示，所有工具态同一枚：按住 Shift 拖动＝操作地图（2D 平移 / 3D 转地球），口径见 shared/mapToolNav.js。
// 竖发丝线与横幅标题隔开，按键画成键帽（VS Code / Figma 快捷键提示同款）；按住 Shift 时键帽「按下」（实底 + 下沉 1px）、文字点亮
defineProps({ on: { type: Boolean, default: false } })
</script>

<template>
  <span class="bn-hint" :class="{ on }"><kbd class="bn-kbd">Shift</kbd><span class="bn-plus">+</span><span>拖动地图</span></span>
</template>

<style scoped>
.bn-hint { display: inline-flex; align-items: center; gap: 5px; margin-left: 12px; padding-left: 12px; border-left: 1px solid var(--border); color: var(--text-muted); font-size: var(--fs-2); white-space: nowrap; vertical-align: 1px; transition: color var(--dur-1); }
.bn-kbd { display: inline-block; height: 16px; padding: 0 5px; box-sizing: border-box; border: 1px solid var(--border-strong); border-bottom-width: 2px; border-radius: 3px; background: var(--bg); color: var(--text); font: 600 var(--fs-1)/13px var(--font-ui); letter-spacing: .02em; transition: background var(--dur-1), color var(--dur-1), border-color var(--dur-1), transform var(--dur-1); }
.bn-plus { color: var(--text-faint); }
.bn-hint.on { color: var(--text); }
.bn-hint.on .bn-kbd { background: var(--sel-fill); border-color: var(--sel-fill); color: var(--sel-on); border-bottom-width: 1px; transform: translateY(1px); }
</style>
