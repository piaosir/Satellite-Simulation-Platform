<script setup>
// 链路表（链路表/发信站群/收信站群/星间链路群）分区脚注，三窗共用（GSO / NGSO / 再生式）。
// 两行：上行「容量汇总」＝本批次总账；下行「本行读数」＝当前聚焦行的计算结果。
// 后者的存在意义：结果列多了要横滚才看得全，而用户看的往往就是刚点的那一行——
// 于是把该行的结果（口径/列序同「结果列」勾选）就地摊平在表脚，点哪行看哪行，不动表也不横滚。
// 两行各自按需出现：cap 缺省（如激光星间，容量口径不适用）就只剩本行读数。
// 样式见 styles/lbworkbench.css（.lbx-capblk / .lbx-capline / .lbx-rowline）。
const props = defineProps({
  cap: { type: Object, default: null },        // 容量汇总 { count, failed, avgEff }；null = 不出汇总行
  capMain: { type: Object, default: null },    // 总容量 { v, u }（单位自适应）
  bwMain: { type: Object, default: null },     // 总带宽 { v, u }
  // 总功率带宽 { v, u }：转发器资源占用的另一维，与总带宽并列（Σ功率带宽 = Σ载波带宽 即整批功带平衡）。
  // null = 本体制无此口径（再生式星上解调再调制，不存在多载波共享转发器功率）→ 该项不出现。
  pbwMain: { type: Object, default: null },
  // 本行读数 { no, name, err, items:[{ key, label, value, unit, tip, bad }] }；null = 不出读数行
  readout: { type: Object, default: null }
})
const hasCap = () => !!(props.cap && props.cap.count)
</script>

<template>
  <div v-if="hasCap() || readout" class="lbx-capblk lbx-capfoot">
    <div v-if="hasCap()" class="lbx-capline" title="汇总本批次全部已计算链路">
      <span class="lbx-cap-t">容量汇总</span>
      <span class="lbx-cap-big">{{ capMain.v }}<i>{{ capMain.u }}</i></span>
      <span class="lbx-cap-item"><span class="lbx-cap-l">总带宽</span><span class="lbx-cap-v">{{ bwMain.v }}<i>{{ bwMain.u }}</i></span></span>
      <span v-if="pbwMain" class="lbx-cap-item" title="Σ 各链路功率带宽（功率占用 × 转发器带宽）：与总带宽相比即整批的功带平衡状况——大于＝整体超发（受功率限），小于＝整体欠发（受带宽限）">
        <span class="lbx-cap-l">总功率带宽</span><span class="lbx-cap-v">{{ pbwMain.v }}<i>{{ pbwMain.u }}</i></span></span>
      <span class="lbx-cap-item" title="带宽加权平均"><span class="lbx-cap-l">频谱效率</span><span class="lbx-cap-v">{{ cap.avgEff.toFixed(3) }}<i>bps/Hz</i></span></span>
      <span class="lbx-cap-n">{{ cap.count }} 条<template v-if="cap.failed"> · {{ cap.failed }} 失败</template></span>
    </div>
    <div v-if="readout" class="lbx-rowline" title="表格中当前聚焦行的计算结果（指标随「结果列」勾选；点选另一行即切换）">
      <span class="lbx-cap-t">本行读数</span>
      <span class="lbx-rr-id">#{{ readout.no }}<em v-if="readout.name" data-i18n-skip>{{ readout.name }}</em></span>
      <span v-if="readout.err" class="lbx-rr-err">{{ readout.err }}</span>
      <template v-else-if="readout.items.length">
        <span v-for="it in readout.items" :key="it.key" class="lbx-rr-i" :title="it.tip">
          <span class="lbx-rr-l">{{ it.label }}</span>
          <span class="lbx-rr-v" :class="{ bad: it.bad }">{{ it.value }}<i v-if="it.unit">{{ it.unit }}</i></span>
        </span>
      </template>
      <span v-else class="lbx-rr-none">该行尚未计算</span>
    </div>
  </div>
</template>
