<script setup>
defineProps({ title: { type: String, default: '' } })
</script>

<template>
  <div class="ph">
    <h2>{{ title }}</h2>
    <p>该模块待实现。</p>
    <p class="hint">
      下一步将接入：星座地图 / 星间链路（CesiumJS 全精度 3D 地球）、覆盖图（高德
      JsAPI）、配置管理与历史记录（SQLite）。
    </p>
  </div>
</template>

<style scoped>
.ph { padding: 40px 32px; color: var(--text-muted); }
.ph h2 { font-size: 18px; color: var(--text); margin-bottom: 10px; }
.ph p { margin: 6px 0; }
.hint { max-width: 520px; line-height: 1.7; color: var(--text-faint); font-size: 12.5px; }
</style>
