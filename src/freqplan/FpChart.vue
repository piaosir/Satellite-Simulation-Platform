<script setup>
// 频率计划图（屏上可交互版）。几何全部来自 shared/freqPlanRender 的 layout()——与导出用的
// toSvg() 同一份，所以「屏上看到的」与「导出的」不会漂。屏上多的只是 hover/选中高亮与点击命中，
// 导出不需要这些，故绘制各写一遍、几何只算一次。
import { computed, ref } from 'vue'
import { layout } from '../shared/freqPlanRender.js'

const props = defineProps({
  plan: { type: Object, required: true },
  selectedId: { type: String, default: '' },
  chartStyle: { type: Object, default: () => ({}) },
  width: { type: Number, default: 1280 }
})
const emit = defineEmits(['select', 'dblclick-block'])

const hoverId = ref('')
const L = computed(() => layout(props.plan, { ...props.chartStyle, width: props.width }))
const fs = computed(() => L.value.style.fontSize)

// 块底色 → 编号取黑或白（与 render 的 pickTextColor 同判据）
function textColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''))
  if (!m) return '#fff'
  const v = parseInt(m[1], 16)
  return (0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255)) > 150 ? '#111' : '#fff'
}
function fmtF(v) {
  if (!Number.isFinite(v)) return ''
  if (L.value.style.unit === 'GHz') return (v / 1000).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
  return String(Math.round(v * 100) / 100)
}
// 编号字号随块宽收敛，窄块也不溢出（与 toSvg 同式）
const noFs = (b) => Math.min(fs.value * 1.05, b.w / Math.max(1.6, String(b.no || '').length * 0.62))

const loText = computed(() => (props.plan.los || [])
  .map((l) => `${l.name}: ${Number.isFinite(l.valueMHz) ? (L.value.style.unit === 'GHz' ? (l.valueMHz / 1000).toFixed(3) + ' GHz' : l.valueMHz + ' MHz') : '—'}`)
  .join('   '))

const loArrow = computed(() => {
  const bands = L.value.bands
  if (bands.length !== 2 || !props.plan.los?.length) return null
  const ax = L.value.style.padX + L.value.innerW * 0.5
  return { x: ax, y0: bands[0].y1 + fs.value * 0.6, y1: bands[1].y0 - fs.value * 0.4 }
})

const legendItems = computed(() => {
  if (L.value.legendY == null) return []
  let lx = L.value.style.padX
  const sq = fs.value * 1.05
  return (props.plan.beams || []).map((bm) => {
    const label = `${bm.code ? bm.code + '：' : ''}${bm.name}`
    const item = { bm, x: lx, y: L.value.legendY, sq, label }
    lx += sq * 1.6 + 10 + label.length * fs.value * 0.56
    return item
  })
})
</script>

<template>
  <div class="fpc">
    <svg :width="L.width" :height="L.height" :viewBox="`0 0 ${L.width} ${L.height}`" class="fpc-svg">
      <!-- 空态 -->
      <text v-if="L.empty" :x="L.width / 2" :y="L.height / 2" :font-size="fs" class="fpc-empty" text-anchor="middle">
        频率计划为空 — 用右侧「批量生成」加一排转发器，或从截图导入
      </text>

      <template v-for="band in L.bands" :key="band.side">
        <text :x="L.style.padX - 8" :y="band.titleY + fs" :font-size="fs * 1.15" class="fpc-title">{{ band.title }}</text>
        <!-- 量程界标 -->
        <template v-if="L.style.showGuides">
          <line v-for="gx in [band.axisX0, band.axisX1]" :key="gx" :x1="gx" :y1="band.rowY[0] - fs * 1.2"
            :x2="gx" :y2="band.rowY[band.rowY.length - 1] + L.style.blockH + fs * 0.6" class="fpc-guide" />
          <text :x="band.axisX0" :y="band.rowY[0] - fs * 1.6" :font-size="fs * 0.86" class="fpc-dim" text-anchor="middle">{{ fmtF(band.ext.dataMin) }}</text>
          <text :x="band.axisX1" :y="band.rowY[0] - fs * 1.6" :font-size="fs * 0.86" class="fpc-dim" text-anchor="middle">{{ fmtF(band.ext.dataMax) }}</text>
        </template>
        <line :x1="band.axisX0" :y1="band.baselineY" :x2="band.axisX1" :y2="band.baselineY" class="fpc-base" />
        <text v-for="(p, i) in band.pols" :key="p" :x="L.style.padX - 20"
          :y="band.rowY[i] + L.style.blockH / 2 + fs * 0.36" :font-size="fs * 1.05" class="fpc-pol" text-anchor="end">{{ p }}</text>
      </template>

      <!-- LO 变频箭头 -->
      <template v-if="loArrow">
        <defs>
          <marker id="fpArrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 Z" class="fpc-arrowhead" />
          </marker>
        </defs>
        <line :x1="loArrow.x" :y1="loArrow.y0" :x2="loArrow.x" :y2="loArrow.y1" class="fpc-base" marker-end="url(#fpArrow)" />
        <text :x="loArrow.x + 10" :y="(loArrow.y0 + loArrow.y1) / 2 + fs * 0.35" :font-size="fs * 0.95" class="fpc-title">{{ loText }}</text>
      </template>

      <!-- 色块 -->
      <g v-for="b in L.blocks" :key="b.channelId + b.side" class="fpc-blk"
        :class="{ on: b.channelId === selectedId, hov: b.channelId === hoverId }"
        @click="emit('select', b.channelId)" @dblclick="emit('dblclick-block', b)"
        @mouseenter="hoverId = b.channelId" @mouseleave="hoverId = ''">
        <rect :x="b.x" :y="b.y" :width="b.w" :height="b.h" :fill="b.color || '#5B8FD4'"
          class="fpc-rect" :class="{ derived: b.derived, suspect: b.suspect }" />
        <text v-if="b.no" :x="b.x + b.w / 2" :y="b.y + b.h / 2 + noFs(b) * 0.35" :font-size="noFs(b)"
          :fill="textColor(b.color || '#5B8FD4')" text-anchor="middle" class="fpc-no">{{ b.no }}</text>
        <text v-if="L.style.showFreqLabels && Number.isFinite(b.fc)" :x="b.x + b.w / 2"
          :y="b.labelSide === 'above' ? b.labelY + fs * 0.9 : b.labelY + fs * 0.95"
          :font-size="fs * 0.86" class="fpc-dim" text-anchor="middle">{{ fmtF(b.fc) }}</text>
        <title>{{ b.no || '—' }} · {{ b.side === 'up' ? '上行' : '下行' }} {{ fmtF(b.fc) }} {{ L.style.unit }} · {{ Number.isFinite(b.bw) ? b.bw + ' MHz' : '带宽未给' }} · {{ b.pol }}{{ b.derived ? ' · 下行由 LO 推算' : '' }}</title>
      </g>

      <!-- 波束图例 -->
      <g v-for="it in legendItems" :key="it.bm.id">
        <rect :x="it.x" :y="it.y" :width="it.sq * 1.6" :height="it.sq" :fill="it.bm.color" class="fpc-rect" />
        <text :x="it.x + it.sq * 1.6 + 6" :y="it.y + it.sq * 0.82" :font-size="fs * 0.92" class="fpc-title">{{ it.label }}</text>
      </g>
    </svg>
  </div>
</template>

<style scoped>
.fpc { overflow: auto; background: var(--bg); }
.fpc-svg { display: block; font-family: var(--font-serif); }
.fpc-title { fill: var(--text); font-weight: 600; }
.fpc-dim { fill: var(--text-muted); }
.fpc-pol { fill: var(--text); }
.fpc-base { stroke: var(--text); stroke-width: 1.6; }
.fpc-arrowhead { fill: var(--text); }
.fpc-guide { stroke: var(--border-strong); stroke-width: 2.2; }
.fpc-empty { fill: var(--text-faint); }
.fpc-rect { stroke: #8a6d1f; stroke-width: 1.4; }
/* 下行由 LO 推算的块用虚边——一眼分出「图上真标了下行频率」与「我们替它算的」 */
.fpc-rect.derived { stroke-dasharray: 3 2; }
.fpc-rect.suspect { stroke: var(--danger); stroke-width: 2; }
.fpc-blk { cursor: pointer; }
.fpc-blk:hover .fpc-rect { filter: brightness(1.12); }
.fpc-blk.on .fpc-rect { stroke: var(--text); stroke-width: 2.6; }
.fpc-no { pointer-events: none; user-select: none; }
</style>
