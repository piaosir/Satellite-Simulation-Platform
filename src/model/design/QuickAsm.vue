<script setup>
// 快速设置 · 普通装配件（2026-10 统一设计）：没有整星驱动参数的装配文档（实体模板副本、手工搭的卫星 / 地球站 / 飞机 / 船 / 车）。
// 名称、整体质量之后，按结构树顺序把每一件的「主要参数」（asmLogic.KEY_PARAMS：口径、座架、翼展、船长…）摊成一张表，
// 一处就能把整件东西的尺度定下来；细节参数、安装、位置、质量与材质、对称在右栏属性面板。
// 点件名 = 在视口 / 结构树里选中它。模板示意值红色标示、出处进悬停（与属性面板同一套来源标记 wb.asm.prov）。
import { inject, computed } from 'vue'
import Icon from '../../components/Icon.vue'
import NumIn from '../NumIn.vue'
import { getComponent } from '@core/models/components/index.mjs'
import { flattenTree, paramRows, compById, encOpt, decOpt, DOMAIN_LABELS, wholeMassLabel } from '../asmLogic.js'

const asm = inject('asm')
const wb = inject('wb')
const ui = asm.ui
const doc = computed(() => asm.doc.value)
const ro = computed(() => ui.posePreview || ui.dragging)

const blocks = computed(() => {
  const d = doc.value
  if (!d) return []
  return flattenTree(d, new Set()).map((r) => {
    const c = compById(d, r.id), def = c && getComponent(c.type)
    const rows = def ? paramRows(def, c.params, { compId: c.id, prov: wb.asm.prov }).filter((x) => x.main) : []
    return { id: r.id, depth: r.depth, label: r.label, icon: r.icon, sym: r.sym, locked: c ? c.locked : false, rows }
  }).filter((b) => b.rows.length)
})
function rename(ev) { const v = String(ev.target.value || '').trim(); if (doc.value && v !== doc.value.name) asm.cmd({ type: 'setDoc', patch: { name: v } }) }
const setMass = (v) => asm.cmd({ type: 'setDoc', patch: { massTargetKg: v } })
function setP(id, key, v) { if (!ro.value) { asm.setParams(id, { [key]: v }); wb.asmTouch(`${id}.${key}`) } }
const sel = (id) => asm.select([id])
const selSet = computed(() => new Set(ui.selIds))
</script>

<template>
  <div v-if="doc" class="asm qk" data-quick="asm">
    <div class="sec qk-head">
      <div class="srow"><label>名称</label>
        <input :key="doc.name" class="ci asm-txt" type="text" spellcheck="false" :value="doc.name" data-i18n-skip @change="rename" @keydown.enter="$event.target.blur()" />
      </div>
      <div class="srow"><label title="指定后由主结构体（星体 / 机身 / 船体 / 车体）承担「整体 − 其余组件」的质量差额；留空按密度估算">{{ wholeMassLabel(doc.domain) }}</label>
        <NumIn :model-value="doc.massTargetKg" :min="0.01" :max="1e9" :sig="6" allow-empty placeholder="按密度" :disabled="ro" @commit="setMass" />
        <span class="u">kg</span>
      </div>
      <div class="qk-src"><span class="qk-tag">{{ DOMAIN_LABELS[doc.domain] || doc.domain }}</span></div>
    </div>
    <div v-if="!blocks.length" class="asm-empty">暂无组件。</div>
    <div v-for="b in blocks" :key="b.id" class="sec qk-blk" :class="{ on: selSet.has(b.id) }" :data-comp="b.id">
      <div class="sect qk-bh" :style="{ paddingLeft: Math.min(b.depth, 4) * 10 + 'px' }" :title="b.id" @click="sel(b.id)">
        <Icon :name="b.icon" :size="12" />
        <span class="sect-t" data-i18n-skip>{{ b.label }}</span>
        <span v-if="b.sym" class="qk-sym" :title="b.sym.tip">×{{ b.sym.n }}</span>
        <Icon v-if="b.locked" name="lock" :size="12" class="qk-lk" />
      </div>
      <div v-for="r in b.rows" :key="r.key" class="srow">
        <label :class="{ 'md-red': r.bad }" :title="r.title">{{ r.label }}</label>
        <NumIn v-if="r.control === 'num'" :model-value="r.value" :integer="r.integer" :min="r.min" :max="r.max" :allow-empty="r.allowEmpty"
               :placeholder="r.placeholder" :bad="r.bad" :disabled="ro || b.locked" :title="r.title" @commit="setP(b.id, r.key, $event)" />
        <select v-else-if="r.control === 'select'" class="ci" :value="encOpt(r.value)" :disabled="ro || b.locked" :title="r.title" @change="setP(b.id, r.key, decOpt($event.target.value))">
          <option v-for="o in r.options" :key="encOpt(o.value)" :value="encOpt(o.value)">{{ o.label }}</option>
        </select>
        <label v-else class="md-chkrow"><input type="checkbox" :checked="!!r.value" :disabled="ro || b.locked" @change="setP(b.id, r.key, $event.target.checked)" /></label>
        <span v-if="r.control === 'num'" class="u">{{ r.unit }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.qk { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; }
.qk-head { display: flex; flex-direction: column; gap: 6px; }
.qk-src { display: flex; align-items: center; gap: 6px; font-size: var(--fs-2); color: var(--text-muted); }
.qk-tag { flex: none; font-size: var(--fs-1); line-height: 1; padding: 2px 5px; border-radius: var(--r-ctl); color: var(--text-muted); background: var(--surface-2); border: 1px solid var(--border); }
.qk-bh { gap: 6px; cursor: pointer; margin-inline: -6px; padding-top: 2px; padding-bottom: 2px; padding-right: 6px; border-radius: var(--r-box); }
.qk-bh .app-icon { flex: none; color: var(--text-faint); }
.qk-bh:hover { background: color-mix(in srgb, var(--text) 5%, transparent); }
.qk-blk.on .qk-bh { background: color-mix(in srgb, var(--accent-ui) 10%, transparent); }
.qk-blk.on .qk-bh .sect-t { color: var(--accent-ui); }
.qk-sym { font-size: var(--fs-2); color: var(--text-faint); font-variant-numeric: tabular-nums; }
.qk-lk { color: var(--text-faint); }
</style>
