<script setup>
// 「SLA 建议」对话框（GSO / NGSO / 再生式 / 端到端 四窗共用）。
//
// 外壳是 AppDialog，宽一档 —— 条款表 + 参数条 + 档位扫描表三块要并排。内容整个交给 LbSlaPane，本组件不算任何数。
//
// ★ 头部的链路下拉是这次弹窗化的关键：分区式的时候「看的是哪条链路」由详细预算的上下文给，
//   进了弹窗就没有那个上下文了；下拉既回答「现在填的是哪条」，也免得填十二条链要关开十二次。
//   选择只在弹窗内生效（不动链路表的聚焦行）—— 反过来动会把详细预算/图表一起拽走。
import { computed } from 'vue'
import Icon from './Icon.vue'
import AppDialog from './AppDialog.vue'
import LbSlaPane from './LbSlaPane.vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  options: { type: Array, default: () => [] },   // [{ i, label }]（label 含站名，呈现层不翻）
  index: { type: Number, default: 0 },
  derived: { type: Object, default: null },
  rowSla: { type: Object, default: null },
  params: { type: Object, default: null },
  adaptive: { type: Boolean, default: false },
  allOn: { type: Boolean, default: true },
  error: { type: String, default: '' },          // 整批计算的报错（与详细预算同一句）
  linkError: { type: String, default: '' },      // 选中那条链路自己的报错
  linkName: { type: String, default: '' },       // 「发信站 → 收信站」，只用于报错那一行
  slaCount: { type: Number, default: 0 }         // 有「列入」条款的链路数：为 0 时「导出报告」不可点
})
const emit = defineEmits(['close', 'pick', 'adopt', 'include', 'param', 'toggle-all', 'clear', 'export'])

const has = computed(() => !!props.derived)
// 外壳是 AppDialog（Esc 关且判输入法组字、点遮罩不关）
</script>

<template>
  <AppDialog :open="open" width="min(1120px, 94vw)" flush @close="emit('close')">
      <template #title><span class="sd-t"><Icon name="file-text" :size="12" />SLA 建议</span></template>
      <template #head>
        <span class="sd-head">
          <select v-if="options.length > 1" class="sd-pick" :value="index"
            @change="emit('pick', Number($event.target.value))">
            <option v-for="o in options" :key="o.i" :value="o.i" data-i18n-skip>{{ o.label }}</option>
          </select>
          <span v-else-if="options.length === 1" class="sd-one" data-i18n-skip>{{ options[0].label }}</span>
        </span>
      </template>

      <div class="sd-bd">
        <div v-if="error" class="lb-err">{{ error }}</div>
        <div v-else-if="linkError" class="lb-err">链路 {{ linkName }} 计算失败：{{ linkError }}</div>
        <LbSlaPane v-else :derived="derived" :row-sla="rowSla" :params="params" :adaptive="adaptive"
          @adopt="emit('adopt', $event)" @include="emit('include', $event)" @param="emit('param', $event)" />
      </div>

      <template #footer>
        <span class="adlg-ft-l">
          <button class="btn" :disabled="!has" :title="allOn ? '本条链路的全部条款都不列入报告' : '本条链路的全部条款都列入报告'"
            @click="emit('toggle-all', !allOn)">{{ allOn ? '全部不列入' : '全部列入' }}</button>
          <button class="btn" :disabled="!has" title="清空本条链路的采用值（各项回到建议值），SLA 参数回到缺省"
            @click="emit('clear')">重置</button>
          <!-- 独立的《服务等级指标（SLA）》报告：不出 PDF、不带图，只印条款与档位 -->
          <button class="btn" :disabled="!has || !slaCount"
            :title="slaCount ? '按各链路勾选的条款单出一份《服务等级指标（SLA）》报告（Excel / Word）' : '尚无 SLA 条款'"
            @click="emit('export')"><Icon name="file-export" :size="12" />导出报告</button>
        </span>
        <button class="btn primary" @click="emit('close')">关闭</button>
      </template>
  </AppDialog>
</template>

<style scoped>
/* 外壳归 AppDialog，宽一档：条款表与右侧参数/扫描表要并排。
   ★ 字体走 var(--font-ui)（设置 → 界面字体），不跟报告那条衬线栈 —— 这是界面不是交付文档。 */
.sd-t { display: inline-flex; align-items: center; gap: 6px; }
/* 题条里关闭钮前的链路下拉 / 单条链路名 */
.sd-head { flex: 0 1 auto; min-width: 0; display: flex; align-items: center; padding: 0 10px; }
.sd-pick {
  max-width: 32em; font: inherit; font-size: var(--fs-2);
  padding: 2px 4px; color: var(--text); background: var(--field-bg);
  border: 1px solid var(--field-border); border-radius: var(--r-ctl, 2px);
}
.sd-one { font-size: var(--fs-2); color: var(--text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sd-bd { padding: 12px; }
</style>
