<script setup>
import { ref, onMounted } from 'vue'

const hasApi = typeof window !== 'undefined' && !!window.api
const rows = ref([])

async function load() {
  if (!hasApi) return
  rows.value = await window.api.store.listHistory()
}
async function del(id) {
  await window.api.store.deleteHistory(id)
  await load()
}
async function clearAll() {
  await window.api.store.clearHistory()
  await load()
}
function fmt(iso) {
  try { return new Date(iso).toLocaleString() } catch { return iso }
}
onMounted(load)
</script>

<template>
  <div class="hist">
    <div class="head">
      <h2>历史记录</h2>
      <button v-if="rows.length" @click="clearAll">清空</button>
    </div>
    <div v-if="!hasApi" class="empty">需在 Electron 中运行。</div>
    <div v-else-if="!rows.length" class="empty">暂无记录。在「链路预算」页计算后点「保存到历史」。</div>
    <table v-else>
      <thead>
        <tr><th>时间</th><th>卫星</th><th>频段</th><th>合成 C/N</th><th>余量</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.id">
          <td>{{ fmt(r.createdAt) }}</td>
          <td>{{ r.satelliteName || '—' }}</td>
          <td>{{ r.frequencyBand || '—' }}</td>
          <td class="mono">{{ r.cnTotal ?? '—' }}</td>
          <td class="mono">{{ r.margin ?? '—' }}</td>
          <td><button class="link" @click="del(r.id)">删除</button></td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.hist { padding: 20px 24px; }
.head { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; }
.head h2 { font-size: 18px; }
.head button { border: 1px solid var(--border); background: var(--bg); padding: 3px 10px; cursor: pointer; }
.empty { color: var(--text-faint); padding: 20px 0; }
table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
th { text-align: left; color: var(--text-muted); font-weight: 500; border-bottom: 1px solid var(--border-strong); padding: 6px 8px; }
td { padding: 6px 8px; border-bottom: 1px solid var(--border); }
.link { border: 0; background: none; color: var(--danger); cursor: pointer; padding: 0; }
</style>
