<script setup>
// 链路瀑布表渲染：直接吃 core.buildWaterfallSegments 输出的 segments[]，
// 与原仓库结果详情页/专业版导出同一口径（逐行可手算）。
defineProps({ segments: { type: Array, default: () => [] } })
</script>

<template>
  <div class="wf">
    <div v-for="(seg, si) in segments" :key="si" class="wf-seg">
      <div class="wf-title">{{ seg.title }}</div>

      <div v-if="seg.cols >= 2" class="wf-row wf-head" :class="'cols' + seg.cols">
        <span class="wf-sign"></span>
        <span class="wf-l"></span>
        <span class="wf-c">上行</span>
        <span class="wf-c">下行</span>
        <span v-if="seg.cols === 3" class="wf-c">合计</span>
        <span class="wf-u"></span>
      </div>

      <div v-for="(row, ri) in seg.rows" :key="ri" class="wf-row" :class="['cols' + seg.cols, 'k-' + row.kind]">
        <span class="wf-sign">{{ row.sign }}</span>
        <span class="wf-l">{{ row.label }}</span>
        <template v-if="seg.cols === 1">
          <span class="wf-c">{{ row.up }}</span>
        </template>
        <template v-else>
          <span class="wf-c">{{ row.up }}</span>
          <span class="wf-c">{{ row.down }}</span>
          <span v-if="seg.cols === 3" class="wf-c">{{ row.total }}</span>
        </template>
        <span class="wf-u">{{ row.unit }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wf { display: flex; flex-direction: column; gap: 14px; }
.wf-seg { border: 1px solid var(--border); border-radius: var(--r-box, 3px); overflow: hidden; }
.wf-title {
  padding: 6px 10px; font-size: 12px; font-weight: 600; color: var(--text);
  background: var(--surface-2); border-bottom: 1px solid var(--border);
}
.wf-row {
  display: grid; align-items: center; gap: 6px;
  padding: 4px 10px; font-size: 12px; border-top: 1px solid var(--border);
}
.wf-row:first-of-type { border-top: none; }
.wf-row.cols1 { grid-template-columns: 14px 1fr auto 52px; }
.wf-row.cols2 { grid-template-columns: 14px 1.4fr 1fr 1fr 52px; }
.wf-row.cols3 { grid-template-columns: 14px 1.4fr 1fr 1fr 1fr 52px; }
.wf-sign { color: var(--text-faint); font-family: var(--font-mono); text-align: center; }
.wf-l { color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wf-c { font-family: var(--font-mono); text-align: right; color: var(--text); }
.wf-u { color: var(--text-faint); font-size: 11px; }

/* 表头 */
.wf-head { background: var(--bg); border-top: none; }
.wf-head .wf-c { color: var(--text-faint); font-family: var(--font-sans); font-size: 11px; }

/* 行类型着色 */
.k-gain .wf-sign, .k-gain .wf-c { color: var(--ok); }
.k-loss .wf-sign, .k-loss .wf-c { color: var(--danger); }
.k-sub, .k-chk { background: var(--surface); font-weight: 600; }
.k-sub .wf-l, .k-chk .wf-l { color: var(--text); font-weight: 600; }
.k-kpi { background: var(--surface-2); font-weight: 600; }
.k-kpi .wf-l { color: var(--text); }
.k-margin { background: var(--surface-2); font-weight: 700; }
.k-margin .wf-l { color: var(--text); }
.k-margin .wf-c { color: var(--text); }
</style>
