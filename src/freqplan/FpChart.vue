<script setup>
// 频率计划图（屏上可交互版）。几何全部来自 shared/freqPlanRender 的 layout()——与导出用的
// toSvg() 同一份，所以「屏上看到的」与「导出的」不会漂。屏上多的只是 hover/选中高亮与点击命中，
// 导出不需要这些，故绘制各写一遍、几何只算一次。
import { computed, ref } from 'vue'
import { layout, blockNoFs, fmtFreq, loNoteText, beaconNoteText, loArrowGeom } from '../shared/freqPlanRender.js'
import { fmtBw, unitLabel, KIND_LABEL } from '../shared/freqPlanModel.js'

const props = defineProps({
  plan: { type: Object, required: true },
  selectedId: { type: String, default: '' },
  chartStyle: { type: Object, default: () => ({}) },
  width: { type: Number, default: 1280 },
  // 屏上缩放：只放大 SVG 的呈现尺寸，viewBox 不动，故几何、命中测试与导出全不受影响
  zoom: { type: Number, default: 1 }
})
const emit = defineEmits(['select', 'dblclick-block'])

const hoverId = ref('')
const L = computed(() => layout(props.plan, { ...props.chartStyle, width: props.width }))
const fs = computed(() => L.value.style.fontSize)

// 编号的墨色由 layout 一并算好（block.ink：压在色片上=黑字，压在留白上=跟主题）——
// 屏上再实现一遍必与导出漂开。
// 频率/带宽的写法与 LO 注记同样取 render 与 model 那一份 —— 屏上再写一遍迟早与导出漂开
const uu = computed(() => unitLabel(L.value.style.unit))
const fmtF = (v) => fmtFreq(v, L.value.style.unit)
const fmtB = (mhz) => (Number.isFinite(mhz) ? fmtBw(mhz, L.value.style.unit) : '带宽未给')
// 编号字号（含「窄到看不清就不画」的判据）取 render 那一份，屏上与导出同源
const noFs = (b) => blockNoFs(b, fs.value)

const loText = computed(() => loNoteText(props.plan, L.value.style.unit))
const beaconText = computed(() => beaconNoteText(props.plan, L.value.style.unit))

// 箭头几何同样取 render 那一份（竖线 + 自绘三角头）——屏上再摆一遍必与导出漂开，
// 而这正是导出图上那只巨大黑三角的由来（见 loArrowGeom 头上那段）
const loArrow = computed(() => (
  L.value.style.showLo && props.plan.los?.length ? loArrowGeom(L.value, L.value.style) : null
))

// 图例几何直接取 layout 的那一份（含折行）——屏上再算一遍迟早与导出漂开
const legendItems = computed(() => L.value.legend?.items || [])
</script>

<template>
  <div class="fpc">
    <svg :width="L.width * zoom" :height="L.height * zoom" :viewBox="`0 0 ${L.width} ${L.height}`" class="fpc-svg">
      <!-- 空态 -->
      <text v-if="L.empty" :x="L.width / 2" :y="L.height / 2" :font-size="fs" class="fpc-empty" text-anchor="middle">
        频率计划为空
      </text>

      <template v-for="band in L.bands" :key="band.side">
        <text :x="L.style.padX - 8" :y="band.titleY + fs" :font-size="fs * 1.15" class="fpc-title">{{ band.title }}</text>
        <!-- 量程界标 -->
        <template v-if="L.style.showGuides">
          <line v-for="gx in [band.axisX0, band.axisX1]" :key="gx" :x1="gx" :y1="band.guideY0"
            :x2="gx" :y2="band.guideY1" class="fpc-guide" />
          <template v-if="band.endLabelsFit">
            <text :x="band.axisX0" :y="band.endLabelY" :font-size="fs * 0.86" class="fpc-dim" text-anchor="middle">{{ fmtF(band.guideExt.dataMin) }}</text>
            <text :x="band.axisX1" :y="band.endLabelY" :font-size="fs * 0.86" class="fpc-dim" text-anchor="middle">{{ fmtF(band.guideExt.dataMax) }}</text>
          </template>
        </template>
        <!-- 基线在断口处断开，断口中间点三个点（几何同样来自 layout，与导出同源） -->
        <line v-for="(sg, i) in band.baseSegs" :key="'bs' + i" :x1="sg[0]" :y1="band.baselineY" :x2="sg[1]" :y2="band.baselineY" class="fpc-base" />
        <template v-for="(br, bi) in band.breaks" :key="'br' + bi">
          <circle v-for="(cx, di) in br.dots" :key="di" :cx="cx" :cy="br.y" :r="br.dotR" class="fpc-brk" />
        </template>
        <text v-for="(p, i) in band.pols" :key="p" :x="L.style.padX - 20"
          :y="band.rowMidY[i] + fs * 0.36" :font-size="fs * 1.05" class="fpc-pol" text-anchor="end">{{ p }}</text>
      </template>

      <!-- LO 变频箭头（竖线 + 三角头，几何来自 loArrowGeom，与导出同源） -->
      <template v-if="loArrow">
        <line :x1="loArrow.x" :y1="loArrow.y0" :x2="loArrow.x" :y2="loArrow.lineY1" class="fpc-base" />
        <path :d="loArrow.head" class="fpc-arrowhead" />
        <text :x="loArrow.textX" :y="loArrow.textY" :font-size="fs * 0.95" class="fpc-title">{{ loText }}</text>
      </template>

      <!-- 色块 -->
      <g v-for="b in L.blocks" :key="b.channelId + b.side" class="fpc-blk"
        :class="{ on: b.channelId === selectedId, hov: b.channelId === hoverId }"
        @click="emit('select', b.channelId)" @dblclick="emit('dblclick-block', b)"
        @mouseenter="hoverId = b.channelId" @mouseleave="hoverId = ''">
        <!-- 标记类载波（信标 / 遥控 / 遥测）：一根从频率轴上立起来的谱线，几何同样来自 layout。
             fill 透明的命中矩形铺在箭头那一格上（markG.hit，比箭头宽出几像素）—— 一根 1.5px 的线点不中；
             ★ 命中区跟着箭头走而不是跟着整格块高走：箭头比色块矮，铺满整格的话 hover 那片灰底会比
             箭头高出一截，看着像多了个空块 -->
        <template v-if="b.mark">
          <line :x1="b.markG.x" :y1="b.markG.y0" :x2="b.markG.x" :y2="b.markG.lineY1" class="fpc-mark" />
          <path :d="b.markG.head" class="fpc-markhead" />
          <rect :x="b.markG.hit.x" :y="b.markG.hit.y" :width="b.markG.hit.w" :height="b.markG.hit.h" class="fpc-hit" />
        </template>
        <!-- 波束占的那几片：同频共用时横着切（各片满宽）、频分占用时竖着切（各段满高），几何都来自
             layout。先无描边铺片，再在整块上压一圈描边（逐片描边会把一个转发器切成两个块） -->
        <template v-else>
          <rect v-for="(sp, si) in b.stripes" :key="si" :x="sp.x" :y="sp.y" :width="sp.w" :height="sp.h + 0.3"
            :fill="sp.color" class="fpc-fill" />
          <rect :x="b.x" :y="b.y" :width="b.w" :height="b.h" fill="none"
            class="fpc-rect" :class="{ derived: b.derived, suspect: b.suspect }" />
          <!-- ink 为 null = 编号压在那截未分配的留白上 → 不写 fill，落到 .fpc-no 的正文色（跟主题走） -->
          <text v-if="noFs(b)" :x="b.x + b.w / 2" :y="b.y + b.h / 2 + noFs(b) * 0.35" :font-size="noFs(b)"
            :fill="b.ink || null" text-anchor="middle" class="fpc-no">{{ b.no }}</text>
        </template>
        <text v-if="L.style.showFreqLabels && Number.isFinite(b.fc)" :x="b.x + b.w / 2"
          :y="b.labelSide === 'above' ? b.labelY + fs * 0.9 : b.labelY + fs * 0.95"
          :font-size="fs * 0.86" class="fpc-dim" text-anchor="middle">{{ fmtF(b.fc) }}</text>
        <title v-if="b.mark">{{ KIND_LABEL[b.kind] || '' }} {{ b.no || '—' }} · {{ b.side === 'up' ? '上行' : '下行' }} {{ fmtF(b.fc) }} {{ uu }} · {{ b.pol }}</title>
        <title v-else>{{ b.no || '—' }} · {{ b.side === 'up' ? '上行' : '下行' }} {{ fmtF(b.fc) }} {{ uu }} · {{ fmtB(b.bw) }}{{ b.bwFromBeam ? '（取自波束组）' : '' }} · {{ b.pol }}{{ b.beam ? ' · ' + b.beam : '' }}{{ b.derived ? ' · 下行由 LO 推算' : '' }}</title>
      </g>

      <!-- 波束/带宽 图例 -->
      <g v-for="it in legendItems" :key="it.id">
        <rect :x="it.x" :y="it.y" :width="it.sq * 1.6" :height="it.sq" :fill="it.color || '#5B8FD4'" class="fpc-rect" />
        <text :x="it.textX" :y="it.y + it.sq * 0.82" :font-size="fs * 0.92" class="fpc-title">{{ it.label }}</text>
      </g>

      <!-- 信标 / 遥测注记：导出图上一直画着，屏上却漏了这一行（版式已为它留出行高） -->
      <text v-if="L.loY != null && beaconText" :x="L.style.padX" :y="L.loY + fs" :font-size="fs * 0.9" class="fpc-dim">{{ beaconText }}</text>
    </svg>
  </div>
</template>

<style scoped>
.fpc { overflow: auto; background: var(--bg); }
/* 屏上跟界面走无衬线；导出（shared/freqPlanRender.js 的 toSvg / PNG）另走 SERIF_STACK，两条路径本就分开 */
.fpc-svg { display: block; font-family: var(--font-ui); }
.fpc-title { fill: var(--text); font-weight: 600; }
.fpc-dim { fill: var(--text-muted); }
.fpc-pol { fill: var(--text); }
.fpc-base { stroke: var(--text); stroke-width: 1.6; }
.fpc-brk { fill: var(--text); }
.fpc-arrowhead { fill: var(--text); }
.fpc-guide { stroke: var(--border-strong); stroke-width: 2.2; }
.fpc-empty { fill: var(--text-faint); }
.fpc-fill { stroke: none; }
.fpc-rect { stroke: #8a6d1f; stroke-width: 1.4; }
/* 标记类载波那根箭头：与色块无关，走正文墨色（标准计划图上它们本就是黑的一根线）。
   箭头本身没有可提亮的填充（.fpc-fill 那条对它无效），故 hover/选中打在它身下那格命中区上 ——
   那一格比箭头宽出几像素，不然一根 9px 的箭头几乎点不中。选中不给它描边：9px 宽的方框看着
   像个小色块，与「这不是块」的整个意思相反，故只把箭头本身加粗 */
.fpc-mark { stroke: var(--text); stroke-width: 1.5; }
.fpc-markhead { fill: var(--text); }
.fpc-hit { fill: transparent; }
.fpc-blk:hover .fpc-hit { fill: rgba(127, 127, 127, .18); }
.fpc-blk.on .fpc-hit { fill: rgba(127, 127, 127, .14); }
.fpc-blk.on .fpc-mark { stroke-width: 3; }
/* 下行由 LO 推算的块用虚边——一眼分出「图上真标了下行频率」与「我们替它算的」 */
.fpc-rect.derived { stroke-dasharray: 3 2; }
.fpc-rect.suspect { stroke: var(--danger); stroke-width: 2; }
.fpc-blk { cursor: pointer; }
/* 没归波束的块一片色都没有（见 layoutStripes），fill="none" 的框只有那 1.4px 边线接得住指针 ——
   pointer-events 让框内那片空白照样可点可悬停，否则空块几乎点不中 */
.fpc-blk .fpc-rect { pointer-events: all; }
/* 提亮打在色片上——描边那层已经没有填充了，打在它上面等于什么都没做 */
.fpc-blk:hover .fpc-fill { filter: brightness(1.12); }
.fpc-blk.on .fpc-rect { stroke: var(--text); stroke-width: 2.6; }
.fpc-no { pointer-events: none; user-select: none; fill: var(--text); }
</style>
