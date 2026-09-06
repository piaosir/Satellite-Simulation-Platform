<script setup>
// 「SLA 建议」对话框（GSO / NGSO / 再生式 / 端到端 四窗共用）。
//
// 壳层照 LbReportDialog 那一套（同一批窗口里的兄弟对话框：方角、细边、衬线数字），只是宽一档
// —— 条款表 + 参数条 + 档位扫描表三块要并排。内容整个交给 LbSlaPane，本组件不算任何数。
//
// ★ 头部的链路下拉是这次弹窗化的关键：分区式的时候「看的是哪条链路」由详细预算的上下文给，
//   进了弹窗就没有那个上下文了；下拉既回答「现在填的是哪条」，也免得填十二条链要关开十二次。
//   选择只在弹窗内生效（不动链路表的聚焦行）—— 反过来动会把详细预算/图表一起拽走。
import { computed, watch, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
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
function onKey(e) { if (e.key === 'Escape') emit('close') }
watch(() => props.open, (v) => {
  if (v) window.addEventListener('keydown', onKey)
  else window.removeEventListener('keydown', onKey)
}, { immediate: true })
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div v-if="open" class="sd-mask" @mousedown.self="emit('close')">
    <div class="sd" role="dialog" aria-modal="true">
      <div class="sd-hd">
        <Icon name="file-text" :size="12" />SLA 建议
        <select v-if="options.length > 1" class="sd-pick" :value="index"
          @change="emit('pick', Number($event.target.value))">
          <option v-for="o in options" :key="o.i" :value="o.i" data-i18n-skip>{{ o.label }}</option>
        </select>
        <span v-else-if="options.length === 1" class="sd-one" data-i18n-skip>{{ options[0].label }}</span>
        <span class="sd-sp"></span>
        <button class="sd-x" title="关闭" aria-label="关闭" @click="emit('close')"><Icon name="x" :size="12" /></button>
      </div>

      <div class="sd-bd">
        <div v-if="error" class="lb-err">{{ error }}</div>
        <div v-else-if="linkError" class="lb-err">链路 {{ linkName }} 计算失败：{{ linkError }}</div>
        <LbSlaPane v-else :derived="derived" :row-sla="rowSla" :params="params" :adaptive="adaptive"
          @adopt="emit('adopt', $event)" @include="emit('include', $event)" @param="emit('param', $event)" />
      </div>

      <div class="sd-ft">
        <button class="sd-btn" :disabled="!has" :title="allOn ? '本条链路的全部条款都不列入报告' : '本条链路的全部条款都列入报告'"
          @click="emit('toggle-all', !allOn)">{{ allOn ? '全部不列入' : '全部列入' }}</button>
        <button class="sd-btn" :disabled="!has" title="清空本条链路的采用值（各项回到建议值），SLA 参数回到缺省"
          @click="emit('clear')">重置</button>
        <!-- 独立的《服务等级指标（SLA）》报告：不出 PDF、不带图，只印条款与档位 -->
        <button class="sd-btn" :disabled="!has || !slaCount"
          :title="slaCount ? '按各链路勾选的条款单出一份《服务等级指标（SLA）》报告（Excel / Word）' : '尚无 SLA 条款'"
          @click="emit('export')"><Icon name="file-down" :size="11" />导出报告</button>
        <span class="sd-sp"></span>
        <button class="sd-btn primary" @click="emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 与 LbReportDialog 同一套控件语言，宽一档：条款表与右侧参数/扫描表要并排。
   ★ 字体走 var(--font-ui)（设置 → 界面字体），不跟报告那条衬线栈 —— 这是界面不是交付文档。 */
.sd-mask { position: fixed; inset: 0; z-index: 320; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.28); }
.sd {
  width: min(1120px, 94vw); max-height: 90vh; display: flex; flex-direction: column;
  font-family: var(--font-ui);
  background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--r-card, 3px);
  box-shadow: var(--shadow-3); overflow: hidden;
}
.sd-hd {
  display: flex; align-items: center; gap: 8px; padding: 10px 12px;
  font-size: var(--fs-2); font-weight: 600; letter-spacing: var(--ls-label); text-transform: uppercase; color: var(--text-muted);
  background: var(--surface-2); border-bottom: 1px solid var(--border);
}
.sd-sp { flex: 1; }
.sd-pick {
  max-width: 32em; font: inherit; font-size: var(--fs-2); letter-spacing: 0; text-transform: none;
  padding: 2px 4px; color: var(--text); background: var(--field-bg);
  border: 1px solid var(--field-border); border-radius: var(--r-ctl, 2px);
}
.sd-one { letter-spacing: 0; text-transform: none; color: var(--text-faint); }
.sd-x {
  display: inline-flex; align-items: center; justify-content: center; margin: -4px -4px -4px 0;
  padding: 3px; font: inherit; color: var(--text-faint); cursor: pointer;
  background: transparent; border: 1px solid transparent; border-radius: var(--r-ctl, 2px);
}
.sd-x:hover { color: var(--text); background: var(--bg); border-color: var(--border); }
.sd-bd { padding: 12px; overflow: auto; }
.sd-ft { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--border); background: var(--surface); }
.sd-btn {
  display: inline-flex; align-items: center; gap: 4px;
  font: inherit; font-size: var(--fs-2); line-height: 1; padding: 4px 12px; cursor: pointer;
  background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px);
}
.sd-btn:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.sd-btn:disabled { opacity: .45; cursor: not-allowed; }
.sd-btn.primary { background: var(--accent-ui); color: var(--bg); border-color: var(--accent-ui); }
.sd-btn.primary:hover { opacity: .88; }
</style>
