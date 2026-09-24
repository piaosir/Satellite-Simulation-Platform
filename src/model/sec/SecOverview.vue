<script setup>
// 概况：名称（中 / 英）、类别、细节档、来源（只读：来源与授权以库里为准，渲染端改不了）、尺寸核定 / 装配核定状态。
import { computed, inject } from 'vue'
import Icon from '../../components/Icon.vue'
import MdSec from '../MdSec.vue'
import { CATEGORIES, fmtInt, SOURCE_LABEL as SRC } from '../wbLogic.js'

const wb = inject('wb')
const { cur } = wb
const m = computed(() => cur.meta)
const ro = computed(() => !cur.editable)
const FIDS = [
  { key: 'outreach', label: '科普美术', tip: '外形示意，尺寸与质量不作工程依据' },
  { key: 'parametric', label: '参数化', tip: '平台尺寸有出处，细节为示意值' },
  { key: 'cad', label: 'CAD', tip: 'STEP / IGES / BREP 工程几何' },
  { key: 'engineering', label: '工程级', tip: '尺寸与质量特性已核定' }
]
function setText(key, v) {
  const s = String(v || '').trim()
  if (!m.value || s === (m.value[key] || '')) return
  wb.edit((x) => { x[key] = s })
}
function setField(key, v) { if (m.value && m.value[key] !== v) wb.edit((x) => { x[key] = v }) }
// 类别：kind 与 NASA 分组 group 同步（显示按 group 优先；group 没有「其他」这一档）
function setKind(v) {
  if (!m.value) return
  wb.edit((x) => { x.kind = v; if (v === 'other') delete x.group; else if (x.group) x.group = v })
}
const srcTip = computed(() => { const s = m.value && m.value.source; return s ? [s.credit, s.license, s.url].filter(Boolean).join('\n') : '' })
const sizeOk = computed(() => !!(m.value && m.value.units && m.value.units.sizeVerified))
const frameOk = computed(() => !!(m.value && m.value.frame && m.value.frame.verified))
</script>

<template>
  <MdSec id="m-overview" title="概况">
    <template v-if="m">
      <div class="srow"><label title="英文名（导出件的场景名、STK 里显示的名字）">名称</label>
        <input class="ci" type="text" :value="m.title" :disabled="ro" data-i18n-skip @change="setText('title', $event.target.value)" @keydown.enter="$event.target.blur()" /></div>
      <div class="srow"><label>中文名</label>
        <input class="ci" type="text" :value="m.titleZh" :disabled="ro" data-i18n-skip @change="setText('titleZh', $event.target.value)" @keydown.enter="$event.target.blur()" /></div>
      <div class="srow"><label>类别</label>
        <select class="ci" :value="m.group || m.kind" :disabled="ro" @change="setKind($event.target.value)">
          <option v-for="c in CATEGORIES" :key="c.key" :value="c.key">{{ c.label }}</option>
        </select></div>
      <div class="srow"><label title="模型可信程度的档位（属性，不是判定）">细节档</label>
        <select class="ci" :value="m.fidelity" :disabled="ro" @change="setField('fidelity', $event.target.value)">
          <option v-for="f in FIDS" :key="f.key" :value="f.key" :title="f.tip">{{ f.label }}</option>
        </select></div>
      <div class="md-kvs ov-kvs">
        <div class="md-kv" :title="srcTip"><span class="k">来源</span><span class="v ov-src">{{ SRC[m.source && m.source.kind] || '—' }}</span></div>
        <div class="md-kv" :title="m.id"><span class="k">编号</span><span class="v ov-id" data-i18n-skip>{{ m.id }}</span></div>
        <div v-if="m.source && m.source.credit" class="md-kv" :title="srcTip"><span class="k">署名</span><span class="v ov-src" data-i18n-skip>{{ m.source.credit }}</span></div>
        <div class="md-kv"><span class="k">三角形</span><span class="v" data-i18n-skip>{{ fmtInt(m.geometry && m.geometry.tris) }}</span></div>
      </div>
      <div class="md-acts ov-flags">
        <span class="md-ico" :class="sizeOk ? 'good' : 'poor'" :title="sizeOk ? '尺寸已核定（有出处）' : '尺寸未核定：在「单位」节用已知尺寸反算并注明出处'">
          <Icon :name="sizeOk ? 'check' : 'ruler'" :size="12" />尺寸
        </span>
        <span class="md-ico" :class="frameOk ? 'good' : 'poor'" :title="frameOk ? '本体轴已核定' : '本体轴未核定：在「本体轴」节核对后勾选'">
          <Icon :name="frameOk ? 'check' : 'axis-3d'" :size="12" />装配
        </span>
        <span v-if="m.source && m.source.redistributable === false" class="md-ico poor" :title="(m.source.license || '') + '：不可导出、不可分发'"><Icon name="lock" :size="12" />不可分发</span>
      </div>
    </template>
  </MdSec>
</template>

<style scoped>
.ov-kvs { margin-top: 2px; }
.ov-src { font-family: var(--font-ui) !important; overflow: hidden; text-overflow: ellipsis; max-width: 170px; }
.ov-id { overflow: hidden; text-overflow: ellipsis; max-width: 170px; }
.ov-flags { gap: 12px; }
</style>
