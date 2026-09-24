<script setup>
// 模型工作台左栏的可折叠分节（.lbx-sec 的节头语言：粗题线 + 加粗节名；多一枚折叠箭头）。
// 折叠状态按 id 记在 localStorage（纯便利）；节级动作走 #actions 插槽，点它不触发折叠。
import { ref, watch } from 'vue'
import Icon from '../components/Icon.vue'

const props = defineProps({
  id: { type: String, required: true },
  title: { type: String, required: true },
  count: { type: [Number, String], default: null },     // 标题后的计数读数（运行时数据）
  summary: { type: String, default: '' },               // 折叠时也看得到的一行读数
  defaultOpen: { type: Boolean, default: true },
  tip: { type: String, default: '' }                    // 节名悬停口径
})
const KEY = 'model/sec/' + props.id
const open = ref((() => { try { const v = localStorage.getItem(KEY); return v == null ? props.defaultOpen : v === '1' } catch { return props.defaultOpen } })())
watch(open, (v) => { try { localStorage.setItem(KEY, v ? '1' : '0') } catch { /* 便利数据 */ } })
defineExpose({ open: () => { open.value = true } })
</script>

<template>
  <section class="md-sec" :class="{ closed: !open }" :data-sec="id">
    <header class="md-sec-hd" @click="open = !open">
      <Icon class="md-sec-chev" :name="open ? 'chevron-down' : 'chevron-right'" :size="12" />
      <span class="md-sec-t" :title="tip || null">{{ title }}</span>
      <span v-if="count != null && count !== ''" class="md-sec-n" data-i18n-skip>{{ count }}</span>
      <span v-if="summary" class="md-sec-sum" :title="summary" data-i18n-skip>{{ summary }}</span>
      <span class="md-sec-sp"></span>
      <span class="md-sec-acts" @click.stop><slot name="actions" /></span>
    </header>
    <div v-show="open" class="md-sec-bd"><slot /></div>
  </section>
</template>

<style scoped>
.md-sec { margin-bottom: 6px; }
.md-sec-hd {
  display: flex; align-items: center; gap: 6px; min-height: 26px; padding: 3px 1px 3px 0;
  border-bottom: 2px solid var(--lb-rule-strong); cursor: pointer; user-select: none;
}
.md-sec.closed .md-sec-hd { border-bottom-width: 1px; border-bottom-color: var(--lb-rule); }
.md-sec-chev { flex: none; color: var(--text-faint); }
.md-sec-hd:hover .md-sec-chev { color: var(--text); }
.md-sec-t { flex: none; font-size: calc(var(--lb-fs, 11px) + 2px); font-weight: 700; letter-spacing: var(--ls-tight); color: var(--text); white-space: nowrap; }
.md-sec-n { flex: none; font-size: calc(var(--lb-fs, 11px) - 1px); color: var(--text-muted); font-variant-numeric: tabular-nums; }
.md-sec-n::before { content: '('; }
.md-sec-n::after { content: ')'; }
.md-sec-sum { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: calc(var(--lb-fs, 11px) - 1px); color: var(--text-faint); font-variant-numeric: tabular-nums; }
.md-sec-sp { flex: 1; }
.md-sec-acts { display: inline-flex; align-items: center; gap: 4px; cursor: default; }
.md-sec-bd { padding: 7px 1px 6px; display: flex; flex-direction: column; gap: 5px; font-size: var(--fs-3); }
</style>
