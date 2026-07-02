<script setup>
// 星间链路 ISL：将用与星座地图相同的方式（你小程序 isl-visual 的真实渲染器 + coastline.js）忠实移植。
// 暂置占位，待星座地图验证通过后按同一套垫片方案搬运。
</script>

<template>
  <div class="ph">
    <h2>星间链路 ISL</h2>
    <p>待移植：将复用你小程序 <code>isl-visual</code> 的真实 2D-canvas 渲染器（与星座地图同源），忠实 1:1 搬运。</p>
    <p class="hint">先验证星座地图的忠实移植是否与小程序一致，再用同一套兼容垫片方案搬运本页与覆盖图。</p>
  </div>
</template>

<style scoped>
.ph { padding: 40px 32px; color: var(--text-muted); height: 100%; overflow-y: auto; }
.ph h2 { font-size: 18px; color: var(--text); margin-bottom: 10px; }
.ph p { margin: 6px 0; max-width: 560px; line-height: 1.7; }
.hint { color: var(--text-faint); font-size: 12.5px; }
code { font-family: var(--font-mono); background: var(--surface); padding: 1px 5px; }
</style>
