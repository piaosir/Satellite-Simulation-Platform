<script setup>
import { ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
// 链路表（链路表/发信站群/收信站群/星间链路群）分区脚注，三窗共用（GSO / NGSO / 再生式）：「本行读数」＝当前聚焦行的计算结果。
// 存在意义：结果列多了要横滚才看得全，而用户看的往往就是刚点的那一行——
// 于是把该行的结果（口径/列序同「结果列」勾选）就地摊平在表脚，点哪行看哪行，不动表也不横滚。
// ★ 原先这里还有上一行「容量汇总」，2026-10-16 起搬进独立弹窗（功能区「导出 › 容量」，见 LbCapDialog）：
//   那一行把各转发器的功率带宽直接相加（多星时不对应任何一只转发器的功带平衡），也没有可用资源可对照。
// 样式见 styles/lbworkbench.css（.lbx-capblk / .lbx-rowline）。
const props = defineProps({
  // 本行读数 { no, name, err, items:[{ key, label, value, unit, tip, bad }] }；null = 不出读数行
  readout: { type: Object, default: null }
})

// 指标格的列宽按内容量出来：最宽的一格（标签 + 数值 + 引导线最短 8px + 两道 5px 间距）定整张网格的列宽，
// 挂成 --lbx-rr-w 喂给 grid 的 minmax（见 .lbx-rr-grid）——标签一律不裁、不缩。字号 / 语言 / 单位档一变，
// 标签或数值元素自己的尺寸就变，ResizeObserver 盯着它们重量；格宽变化不会反过来改这两个元素的尺寸
//（都是 flex:none，伸缩全在引导线上），故不成环。
const gridEl = ref(null)
let ro = null
function measure() {
  const g = gridEl.value
  if (!g) return
  let w = 0
  for (const it of g.querySelectorAll('.lbx-rr-i')) {
    const l = it.querySelector('.lbx-rr-l'), v = it.querySelector('.lbx-rr-v')
    const need = (l ? l.getBoundingClientRect().width : 0) + (v ? v.getBoundingClientRect().width : 0) + 8 + 10
    if (need > w) w = need
  }
  g.style.setProperty('--lbx-rr-w', Math.ceil(w + 1) + 'px')
}
function observe() {
  if (!ro) return
  ro.disconnect()
  const g = gridEl.value
  if (g) for (const el of g.querySelectorAll('.lbx-rr-l, .lbx-rr-v')) ro.observe(el)
}
onMounted(() => { ro = new ResizeObserver(measure); nextTick(() => { observe(); measure() }) })
onBeforeUnmount(() => { if (ro) { ro.disconnect(); ro = null } })
watch(() => props.readout, () => nextTick(() => { observe(); measure() }))
</script>

<template>
  <div v-if="readout" class="lbx-capblk lbx-capfoot">
    <!-- 左栏＝标题 + 行号/站对（定宽），右栏＝指标网格：等宽格「标签…数值」，次序同「结果列」 -->
    <div v-if="readout" class="lbx-rowline" title="表格中当前聚焦行的计算结果（指标随「结果列」勾选；点选另一行即切换）">
      <div class="lbx-rr-hd">
        <span class="lbx-cap-t">本行读数</span>
        <span class="lbx-rr-id" :title="readout.name || ''"><b class="lbx-rr-no">#{{ readout.no }}</b><em v-if="readout.name" data-i18n-skip>{{ readout.name }}</em></span>
      </div>
      <div v-if="readout.err" class="lbx-rr-err">{{ readout.err }}</div>
      <div v-else-if="readout.items.length" ref="gridEl" class="lbx-rr-grid">
        <span v-for="it in readout.items" :key="it.key" class="lbx-rr-i" :title="it.tip">
          <span class="lbx-rr-l">{{ it.label }}</span><span class="lbx-rr-ld"></span>
          <span class="lbx-rr-v" :class="{ bad: it.bad }">{{ it.value }}<i v-if="it.unit">{{ it.unit }}</i></span>
        </span>
      </div>
      <span v-else class="lbx-rr-none">该行尚未计算</span>
    </div>
  </div>
</template>
