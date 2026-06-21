<script setup>
import { ref, onMounted } from 'vue'

const hasApi = typeof window !== 'undefined' && !!window.api
const rows = ref([])
const newName = ref('')

async function load() {
  if (!hasApi) return
  rows.value = await window.api.store.listConfigs()
}
async function add() {
  const name = newName.value.trim()
  if (!name) return
  await window.api.store.saveConfig({ name, params: {} })
  newName.value = ''
  await load()
}
async function del(id) {
  await window.api.store.deleteConfig(id)
  await load()
}
function fmt(iso) { try { return new Date(iso).toLocaleString() } catch { return iso } }
onMounted(load)
</script>

<template>
  <div class="cfg">
    <h2>配置管理</h2>
    <p class="hint">保存常用参数预设（GEO/NGSO 模板）。链路预算页可一键载入。</p>
    <div v-if="!hasApi" class="empty">需在 Electron 中运行。</div>
    <template v-else>
      <div class="add">
        <input v-model="newName" placeholder="新建预设名称，如「GEO Ku 标准站」" @keyup.enter="add" />
        <button @click="add">新建</button>
      </div>
      <div v-if="!rows.length" class="empty">暂无配置。</div>
      <table v-else>
        <thead><tr><th>名称</th><th>创建时间</th><th></th></tr></thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id">
            <td>{{ r.name }}</td>
            <td>{{ fmt(r.createdAt) }}</td>
            <td><button class="link" @click="del(r.id)">删除</button></td>
          </tr>
        </tbody>
      </table>
    </template>
  </div>
</template>

<style scoped>
.cfg { padding: 20px 24px; }
.cfg h2 { font-size: 18px; }
.hint { color: var(--text-faint); font-size: 12.5px; margin: 6px 0 16px; }
.add { display: flex; gap: 10px; margin-bottom: 16px; }
.add input { flex: 1; max-width: 360px; border: 1px solid var(--border); background: var(--bg); padding: 5px 8px; outline: none; }
.add button, .head button { border: 1px solid var(--border); background: var(--bg); padding: 4px 12px; cursor: pointer; }
.empty { color: var(--text-faint); padding: 14px 0; }
table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
th { text-align: left; color: var(--text-muted); font-weight: 500; border-bottom: 1px solid var(--border-strong); padding: 6px 8px; }
td { padding: 6px 8px; border-bottom: 1px solid var(--border); }
.link { border: 0; background: none; color: var(--danger); cursor: pointer; padding: 0; }
</style>
