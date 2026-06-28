<script setup>
import { computed, watch } from 'vue'
import { BAND_FREQ, BAND_LABEL } from './satPresets.js'

// 卫星模块：从「卫星树」选星（星座3D 页导入的 GRD 卫星）→ 给「卫星EIRP / 卫星G/T」匹配天线 →
// 按各发/收信站经纬度取该天线多波束的最大 Parameter，回填到站表（联动逻辑在父组件 LinkBudgetApp）。
// 本组件只负责：选星/选天线 UI（写入 sel）+ 完整卫星参数表单。
const props = defineProps({
  form: { type: Object, required: true },
  fields: { type: Array, required: true },
  satTree: { type: Array, default: () => [] },   // [{ folder, satName, lon, antennas:[{name,beams}] }]
  sel: { type: Object, required: true }           // { satFolder, eirpKey, gtKey } —— 父组件持有，本组件就地写入
})

// 当前选中的卫星树节点 + 其天线列表
const curSat = computed(() => props.satTree.find((s) => s.folder === props.sel.satFolder) || null)
const antKey = (a) => (curSat.value ? curSat.value.folder + '|' + a.name : '')

// 选星：写入卫星名称/轨道位置；切换卫星时清空已匹配天线（不同星天线不同）
function onPickSat() {
  const s = curSat.value
  if (s) { props.form.satelliteName = s.satName; props.form.orbitPosition = String(s.lon) }
  props.sel.eirpKey = ''
  props.sel.gtKey = ''
}

// 选完工作频段，上/下行频率跟随预设变（与小程序一致）
watch(() => props.form.frequencyBand, (band) => {
  const f = BAND_FREQ[band]; if (!f) return
  props.form.centerFrequency = String(f.up)
  props.form.rxCenterFrequency = String(f.dn)
})
const bandLabel = (o) => BAND_LABEL[o] || o

// 字段按行分组：相邻同 pair 的两字段（频率+极化）并到一行，其余单独成行（保序）
const rows = computed(() => {
  const out = [], fs = props.fields
  for (let i = 0; i < fs.length; i++) {
    if (fs[i].pair && fs[i + 1] && fs[i + 1].pair === fs[i].pair) { out.push([fs[i], fs[i + 1]]); i++ }
    else out.push([fs[i]])
  }
  return out
})
</script>

<template>
  <div class="sp">
    <!-- 从卫星树选星 + 为「卫星EIRP / 卫星G/T」匹配天线 -->
    <div class="sp-grd">
      <label class="pf"><span class="pf-l">选择卫星</span>
        <select v-model="sel.satFolder" class="pf-i" @change="onPickSat">
          <option value="" disabled>从卫星树选择…</option>
          <option v-for="s in satTree" :key="s.folder" :value="s.folder">{{ s.satName }}（{{ s.lon }}°E）</option>
        </select>
        <i class="pf-u"></i>
      </label>
      <div v-if="!satTree.length" class="sp-tip">卫星树为空：请先在「星座3D」页导入 GRD 天线</div>
      <template v-else-if="curSat">
        <label class="pf"><span class="pf-l" title="按各收信站经纬度取该天线多波束最大 Parameter → 卫星EIRP">卫星EIRP 天线</span>
          <select v-model="sel.eirpKey" class="pf-i">
            <option value="">— 未匹配 —</option>
            <option v-for="a in curSat.antennas" :key="a.name" :value="antKey(a)">{{ a.name }}（{{ a.beams }} 波束）</option>
          </select>
          <i class="pf-u"></i>
        </label>
        <label class="pf"><span class="pf-l" title="按各发信站经纬度取该天线多波束最大 Parameter → 卫星G/T">卫星G/T 天线</span>
          <select v-model="sel.gtKey" class="pf-i">
            <option value="">— 未匹配 —</option>
            <option v-for="a in curSat.antennas" :key="a.name" :value="antKey(a)">{{ a.name }}（{{ a.beams }} 波束）</option>
          </select>
          <i class="pf-u"></i>
        </label>
        <div class="sp-tip">匹配后按站经纬度自动回填：收信站「卫星EIRP」、发信站「卫星G/T」（多波束取 Parameter 最大者）</div>
      </template>
    </div>

    <!-- 卫星参数表单（频率+极化成对一行） -->
    <div class="form">
      <div v-for="(row, ri) in rows" :key="ri" class="sp-row2" :class="{ pair: row.length === 2 }">
        <label v-for="f in row" :key="f.key" class="pf">
          <span class="pf-l" :title="f.tip || f.label">{{ f.label }}</span>
          <select v-if="f.type === 'select'" v-model="form[f.key]" class="pf-i">
            <option v-for="o in f.options" :key="o" :value="o">{{ f.key === 'frequencyBand' ? bandLabel(o) : o }}</option>
          </select>
          <input v-else v-model="form[f.key]" class="pf-i mono" :placeholder="f.ph || ''" />
          <i class="pf-u">{{ f.unit || '' }}</i>
        </label>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sp { max-width: 520px; }
.sp-grd { margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px dashed var(--border); }
.sp-grd .pf { margin-bottom: 6px; }
.sp-tip { font-size: 11px; color: var(--text-faint); line-height: 1.5; margin-top: 2px; }

.sp-row2 { margin-bottom: 6px; }
.sp-row2.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.sp-row2 .pf { margin-bottom: 0; }
/* 标签固定宽度 → 单列行与成对行左列的输入框左边缘对齐（参数框对齐） */
.sp-row2.pair .pf { grid-template-columns: 96px 110px 30px; }
.pf { display: grid; grid-template-columns: 96px 110px 36px; align-items: center; gap: 6px; margin-bottom: 6px; }
.pf-l { font-size: 12px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pf-i { font: inherit; font-size: 12px; padding: 4px 7px; width: 100%; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 2px; }
.pf-i:focus { outline: none; border-color: var(--accent); }
.pf-i.mono { font-family: var(--font-mono); }
.pf-u { font-size: 11px; color: var(--text-faint); font-style: normal; }
</style>
