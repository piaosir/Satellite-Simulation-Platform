<script setup>
// 配置管理：跨工作台的配置总览。
//
// 配置库已按工作台分家（configs.<ns>.json，见 electron/services/storage.js），各窗只读写自己那份。
// 本页是唯一能同时看到五份的地方，故只做两件事：列出归属、删除。
// 「新建预设」入口已撤：它产出的是既无 state 也无 orbitType 的空壳，没有任何工作台能载入它，
// 却因 GEO 的白名单过滤（无 state ⇒ 算 GEO）常年混在 GSO 的配置列表里。要新建请到对应工作台里建。
import { ref, computed, onMounted } from 'vue'

const hasApi = typeof window !== 'undefined' && !!window.api
const groups = ref([])

const WORKBENCH = { geo: 'GSO 链路预算', ngso: 'NGSO 链路预算', regen: '再生式链路预算', e2e: '端到端链路预算', rain: '雨衰计算' }

async function load() {
  if (!hasApi) return
  const all = (await window.api.store.listAllConfigs()) || []
  // 文件夹只是分组容器，本页无级联删除，列出来只会让人误删成孤儿——过滤掉
  groups.value = all.map((g) => ({ ...g, items: (g.items || []).filter((r) => r && r.type !== 'folder') }))
}
const rows = computed(() => groups.value.flatMap((g) => g.items.map((r) => ({ ...r, ns: g.ns }))))
async function del(ns, id) {
  await window.api.store.deleteConfig(ns, id)
  await load()
}
function fmt(iso) { try { return new Date(iso).toLocaleString() } catch { return iso } }
onMounted(load)
</script>

<template>
  <div class="cfg">
    <h2>配置管理</h2>
    <div v-if="!hasApi" class="empty">需在桌面客户端中运行。</div>
    <template v-else>
      <div v-if="!rows.length" class="empty">暂无配置。</div>
      <table v-else>
        <thead><tr><th>名称</th><th>所属工作台</th><th>创建时间</th><th></th></tr></thead>
        <tbody>
          <tr v-for="r in rows" :key="r.ns + ':' + r.id">
            <td data-i18n-skip>{{ r.name }}</td>
            <td class="ns">{{ WORKBENCH[r.ns] || r.ns }}</td>
            <td>{{ fmt(r.createdAt) }}</td>
            <td><button class="link" @click="del(r.ns, r.id)">删除</button></td>
          </tr>
        </tbody>
      </table>
    </template>
  </div>
</template>

<style scoped>
.cfg { padding: 20px 24px; height: 100%; overflow-y: auto; }   /* 外层 .content 已 overflow:hidden，滚动由页内承担 */
.cfg h2 { font-size: var(--fs-6); }
.empty { color: var(--text-faint); padding: 14px 0; }
table { width: 100%; border-collapse: collapse; font-size: var(--fs-4); }
th { text-align: left; color: var(--text-muted); font-weight: 500; border-bottom: 1px solid var(--border-strong); padding: 6px 8px; }
td { padding: 6px 8px; border-bottom: 1px solid var(--border); }
.ns { color: var(--text-muted); }
.link { border: 0; background: none; color: var(--danger); cursor: pointer; padding: 0; }
</style>
