<script setup>
import { ref } from 'vue'
import Icon from './Icon.vue'
import PolygonVertices from './PolygonVertices.vue'

defineProps({
  pg: { type: Object, required: true },
  expanded: Boolean, selected: Boolean, drawing: Boolean, moving: Boolean, editing: Boolean
})
const emit = defineEmits(['expand', 'visibility', 'field', 'finish', 'edit', 'move', 'draw', 'copy', 'offset', 'remove', 'clipboard'])
const section = ref('data')
const vertexDraft = ref(null)
const sections = [
  { key: 'data', label: '属性' },
  { key: 'points', label: '顶点' },
  { key: 'style', label: '样式' }
]
function setField(key, value, live = false) {
  emit('field', key, value)
  if (!live) emit('finish')
}
</script>

<template>
  <article class="plg" :data-pg="pg.id" :class="{ active: selected || drawing || moving || editing, hiddenPoly: pg.show === false }">
    <header>
      <button class="disclose" type="button" :aria-expanded="expanded" :aria-label="pg.name || 'Polygon'" @click="emit('expand')">
        <Icon :name="expanded ? 'chevron-down' : 'chevron-right'" />
        <Icon class="symbol" name="polygon" :size="20" :style="{ color: pg.color }" />
        <span class="name" data-i18n-skip :title="pg.name">{{ pg.name || 'Polygon' }}</span>
      </button>
      <span v-if="pg.value != null && pg.value !== ''" class="gain" :title="'gain = ' + pg.value" data-i18n-skip><small>gain</small> {{ pg.value }}</span>
      <button type="button" class="layersw" :class="{ on: pg.show !== false }" role="switch" :aria-checked="pg.show !== false" :title="pg.show === false ? '显示该 Polygon' : '隐藏该 Polygon（数据保留）'" @click="emit('visibility')"><i /></button>
    </header>
    <div v-if="!expanded" class="summary">
      <span v-if="pg.satName" class="sat" :title="pg.satName" data-i18n-skip>{{ pg.satName }}</span>
      <span v-if="pg.satLon != null && pg.satLon !== ''" title="long_nom">{{ pg.satLon }}°E</span>
      <span class="count">{{ pg.pts.length }} 点</span>
    </div>
    <div v-if="expanded" class="body">
      <div class="sections" role="group" aria-label="Polygon">
        <button v-for="s in sections" :key="s.key" type="button" :aria-pressed="section === s.key" @click="section = s.key">{{ s.label }}<span v-if="s.key === 'points'" class="n">{{ pg.pts.length }}</span></button>
      </div>
      <div v-if="section === 'data'" class="fields">
        <div v-if="pg.gxtSource" class="source wide" data-i18n-skip>
          <Icon name="file-text" /><span v-if="pg.gxtSource.file" :title="pg.gxtSource.file">{{ pg.gxtSource.file }}</span>
          <span v-if="pg.gxtSource.beamId" :title="'beam_id = ' + pg.gxtSource.beamId">{{ pg.gxtSource.beamId }}</span>
          <code>[{{ pg.gxtSource.section }}]</code>
        </div>
        <label class="wide"><span>名称</span><input :value="pg.name" placeholder="Polygon" @change="setField('name', $event.target.value)" /></label>
        <label class="wide" title="[GeoMain] sat_name"><span>卫星名称</span><input :value="pg.satName" placeholder="—" @change="setField('satName', $event.target.value)" /></label>
        <label title="[GeoMain] long_nom"><span>轨位 (°E)</span><input class="num" :value="pg.satLon" placeholder="—" @change="setField('satLon', $event.target.value)" /></label>
        <label title="[Cn] gain"><span>等值线值</span><input class="num" :value="pg.value" placeholder="—" @change="setField('value', $event.target.value)" /></label>
      </div>
      <PolygonVertices v-else-if="section === 'points'" v-model:draft="vertexDraft" :points="pg.pts" @update="setField('pts', $event)" @copy="emit('clipboard', $event)" />
      <div v-else class="styles" @change="emit('finish')" @focusout="emit('finish')">
        <div class="style-row">
          <span>线粗</span><input type="color" :value="pg.color" title="线条颜色" @input="setField('color', $event.target.value, true)" />
          <div class="slider"><input type="range" min="0.1" max="8" step="0.01" :value="pg.width ?? 2" title="线粗" @input="setField('width', +$event.target.value, true)" /><span>{{ Number(pg.width ?? 2).toFixed(2) }}</span></div>
        </div>
        <div class="style-row">
          <label><input type="checkbox" :checked="pg.fillOn !== false" @change="setField('fillOn', $event.target.checked)" />填充</label>
          <input type="color" :value="pg.fillColor || pg.color" title="填充颜色" @input="setField('fillColor', $event.target.value, true)" />
          <div class="slider"><input type="range" min="0" max="1" step="0.01" :value="pg.fillOp ?? 0.18" title="填充不透明度" @input="setField('fillOp', +$event.target.value, true)" /><span>{{ Math.round((pg.fillOp ?? 0.18) * 100) }}%</span></div>
        </div>
        <div class="style-row">
          <span>字号</span><label><input type="checkbox" :checked="!!pg.labelBold" @change="setField('labelBold', $event.target.checked)" />粗体</label>
          <div class="slider"><input type="range" min="2" max="40" step="0.1" :value="pg.labelSize || 16" title="字号" @input="setField('labelSize', +$event.target.value, true)" /><span>{{ Number(pg.labelSize || 16).toFixed(1) }}</span></div>
        </div>
      </div>
      <div class="map-tools">
        <button type="button" class="btn sm" :aria-pressed="editing" @click="emit('edit')"><Icon name="waypoints" />调整顶点</button>
        <button type="button" class="btn sm" :aria-pressed="moving" @click="emit('move')"><Icon name="move" />{{ moving ? '完成拖动' : '整体拖动' }}</button>
        <button type="button" class="btn sm" :aria-pressed="drawing" @click="emit('draw')"><Icon :name="drawing ? 'check' : 'pencil'" />{{ drawing ? '完成绘制' : '继续绘制' }}</button>
      </div>
      <div class="tools">
        <button type="button" @click="emit('copy')"><Icon name="copy" />复制</button>
        <button type="button" title="生成外扩的 Polygon" @click="emit('offset', 1)"><Icon name="plus" />扩大</button>
        <button type="button" title="生成内缩的 Polygon" @click="emit('offset', -1)"><Icon name="minus" />缩小</button>
        <button class="remove" type="button" title="删除该 Polygon（Ctrl+Z 撤销）" @click="emit('remove')"><Icon name="trash" /></button>
      </div>
    </div>
  </article>
</template>

<style scoped>
.plg { container-type: inline-size; margin-top: 7px; min-width: 0; border: 1px solid var(--border); border-radius: var(--r-card); color: var(--text); background: var(--bg); }
.plg.active { border-color: var(--accent-ui); }
header, .summary, .disclose, .sections, .tools, .tools button, .map-tools button, .style-row label, .slider { display: flex; align-items: center; }
header { gap: 8px; min-height: 32px; padding: 3px 9px 3px 5px; background: var(--surface); border-radius: inherit; }
.disclose { flex: 1; gap: 6px; min-width: 0; padding: 4px 0; color: var(--text-muted); text-align: left; }
.name, .gain, .sat { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.name { color: var(--text); font-size: var(--fs-3); font-weight: 600; }
.hiddenPoly .symbol { opacity: .45; }
.gain { display: block; max-width: 30%; padding: 2px 5px; border: 1px solid var(--border); border-radius: var(--r-ctl); font: var(--fs-2) var(--font-mono); }
.gain small { color: var(--text-muted); font: inherit; }
.summary { gap: 8px; padding: 4px 9px; font: var(--fs-2) var(--font-mono); color: var(--text-muted); }
.summary > span { white-space: nowrap; }
.count { margin-left: auto; }
.body { padding: 0 9px 4px; }
.sections { gap: 10px; margin-bottom: 8px; border-bottom: 1px solid var(--border); }
.sections button { display: inline-flex; align-items: center; gap: 4px; padding: 5px 2px; border-bottom: 2px solid transparent; font-size: var(--fs-2); color: var(--text-muted); }
.sections button[aria-pressed="true"] { border-color: var(--accent-ui); color: var(--accent); font-weight: 600; }
.sections button { border-inline: 0; border-top: 0; border-radius: 0; }
.n { font: var(--fs-2) var(--font-mono); }
.fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 10px; }
.fields label { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: var(--fs-2); color: var(--text-muted); }
.fields .wide { grid-column: 1 / -1; }
.source { display: flex; align-items: center; gap: 5px; min-width: 0; font-size: var(--fs-2); color: var(--text-muted); }
.source span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.source span + span::before { content: '· '; }
.source code { flex: none; font-family: var(--font-mono); }
.fields label > span { flex: none; }
.fields .wide > span { min-width: 4em; }
.fields input { flex: 1; width: 0; min-width: 0; box-sizing: border-box; padding: 3px 6px; font-size: var(--fs-3); border: 1px solid var(--field-border); border-radius: var(--r-ctl); background: var(--field-bg); color: var(--text); }
.num, .slider span { font-variant-numeric: tabular-nums; font-family: var(--font-mono); }
.styles { display: grid; grid-template-columns: auto auto minmax(0, 1fr); gap: 6px 8px; align-items: center; font-size: var(--fs-2); color: var(--text-muted); }
.style-row { display: contents; }
.style-row label { gap: 3px; }
.style-row input[type="checkbox"] { margin: 0; }
.style-row input[type="color"] { width: 29px; height: 21px; }
.slider { min-width: 0; gap: 4px; }
.slider input { flex: 1; width: 0; min-width: 0; }
.slider span { flex: none; }
.map-tools { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; border-top: 1px solid var(--border); margin-top: 8px; padding-top: 7px; }
.map-tools button { justify-content: center; gap: 4px; min-height: var(--h-ctl-sm); height: auto; padding: 3px 2px; white-space: normal; line-height: 1.25; }
.map-tools button[aria-pressed="true"] { color: var(--accent); border-color: var(--accent-ui); }
.tools { gap: 5px; margin-top: 3px; }
.tools button { gap: 3px; font-size: var(--fs-2); color: var(--text-muted); padding: 4px; border-radius: var(--r-ctl); }
.tools button:hover, .disclose:hover .name, .sections button:hover { color: var(--accent); }
.tools .remove { margin-left: auto; }
.tools .remove:hover { color: var(--danger); }
@container (max-width: 290px) {
  .fields { grid-template-columns: minmax(0, 1fr); }
  .fields label > span { min-width: 4em; }
  .map-tools button :deep(svg) { display: none; }
}
</style>
