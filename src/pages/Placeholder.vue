<script setup>
defineProps({ title: { type: String, default: '' } })
</script>

<template>
  <div class="ph">
    <h2>{{ title }}</h2>
    <p>该模块待实现。</p>
  </div>
</template>

<style scoped>
.ph { padding: 40px 32px; color: var(--text-muted); height: 100%; overflow-y: auto; }
.ph h2 { font-size: var(--fs-6); color: var(--text); margin-bottom: 10px; }
.ph p { margin: 6px 0; }
.hint { max-width: 520px; line-height: 1.7; color: var(--text-faint); font-size: var(--fs-4); }
</style>
