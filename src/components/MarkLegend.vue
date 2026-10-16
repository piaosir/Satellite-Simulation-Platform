<script setup>
// 图例小样：标记对象树的行首、属性检查器标题上那枚「地图上的样子」（ArcGIS Pro 内容窗格的符号小样口径）。
// 与 2D / 3D 渲染器同一支画笔（markSymbols / numBadge / vehicleSymbol / stationSymbol）—— 形状只画一次的约定照旧，
// 样式一改、逐条颜色一覆盖，小样跟着变。
import { ref, watch, onMounted } from 'vue'
import { paintMarkSymbol } from '../viz/markers/markSymbols.js'
import { paintNumBadge } from '../viz/markers/numBadge.js'
import { drawVehicle } from '../viz/vehicleSymbol.js'
import { stationSvg } from '../viz/stationSymbol.js'
import Icon from './Icon.vue'

const props = defineProps({
  type: { type: String, default: 'symbol' },   // symbol 点标记符号 | badge 序号圈 | station 地球站天线 | vehicle 船 / 飞机剪影 | icon 线框图标 | lines 航迹线
  size: { type: Number, default: 16 },          // 外框边长（CSS px）
  shape: { type: String, default: 'circle' },   // symbol：形状 / 填色 / 不透明度 / 描边（宽 = 直径的比例）
  fill: { type: String, default: '' },
  opacity: { type: Number, default: 1 },
  edge: { type: Number, default: 0 },
  edgeColor: { type: String, default: '' },
  text: { type: [String, Number], default: '' }, // badge：圈心编号 + 配色 { fill, fillOpacity, ring, ink }
  badge: { type: Object, default: null },
  kind: { type: String, default: 'sea' },       // vehicle：sea | flight + 填色
  color: { type: String, default: '' },          // vehicle / icon 的颜色
  icon: { type: String, default: '' },           // icon：图标名（航迹行用 ship / plane —— 俯视剪影在 16px 下认不出是船）
  lines: { type: Array, default: () => [] }     // lines：[{ color, dash }]，自上而下逐条
})

// 地球站符号是 Noto 的固定六色天线（不着色），一张数据 URL 全组件共用
let stationUrl = ''
const stationSrc = () => stationUrl || (stationUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(stationSvg()))

const cv = ref(null)
const DASH = { solid: [], dash: [4, 2.5], dot: [1.2, 2], dashdot: [4, 2, 1.2, 2] }
let uiFont = ''
const fontOf = () => uiFont || (uiFont = (typeof document !== 'undefined' && getComputedStyle(document.body).fontFamily) || 'sans-serif')

function paint() {
  const c = cv.value
  if (!c) return
  const S = props.size
  const dpr = Math.max(1, Math.ceil((window.devicePixelRatio || 1) * 2) / 2)
  const W = Math.round(S * dpr)
  if (c.width !== W || c.height !== W) { c.width = W; c.height = W }
  const x = c.getContext('2d')
  x.setTransform(dpr, 0, 0, dpr, 0, 0)
  x.clearRect(0, 0, S, S)
  if (props.type === 'symbol') {
    // 小样里压一道不透明度下限：整层调到很淡时符号仍认得出形状（地图上照实际不透明度画）
    const d = S * 0.75, pin = props.shape === 'pin'
    paintMarkSymbol(x, S / 2, pin ? (S + d) / 2 : S / 2, d, { shape: props.shape, fill: props.fill || undefined, opacity: Math.max(0.4, props.opacity), edge: props.edge, edgeColor: props.edgeColor || undefined })
  } else if (props.type === 'badge') {
    // 盘直径 d，连两道套边的视觉直径约 1.19d
    paintNumBadge(x, S / 2, S / 2, S * 0.8, String(props.text ?? ''), fontOf(), props.badge || null)
  } else if (props.type === 'vehicle') {
    drawVehicle(x, props.kind === 'flight' ? 'flight' : 'sea', S / 2, S / 2, S, 0, props.color || undefined)
  } else if (props.type === 'lines') {
    const L = props.lines.length ? props.lines : [{}]
    const gap = S / (L.length + 1)
    x.lineCap = 'butt'; x.lineWidth = 2
    L.forEach((l, i) => {
      const y = Math.round(gap * (i + 1)) + 0.5
      x.setLineDash(DASH[l.dash] || [])
      x.strokeStyle = l.color || '#ffffff'
      x.beginPath(); x.moveTo(1, y); x.lineTo(S - 1, y); x.stroke()
    })
  }
}
onMounted(paint)
// flush post：type 在 station ↔ 其余之间切换时画布是新挂的，要等它进 DOM 再画
watch(() => [props.type, props.size, props.shape, props.fill, props.opacity, props.edge, props.edgeColor, props.text, JSON.stringify(props.badge), props.kind, props.color, JSON.stringify(props.lines)], paint, { flush: 'post' })
</script>

<template>
  <span v-if="type === 'icon'" class="mlg mlg-ic" :style="{ width: size + 'px', height: size + 'px', color: color || null }"><Icon :name="icon" :size="size - 2" /></span>
  <img v-else-if="type === 'station'" class="mlg" :src="stationSrc()" :style="{ width: size + 'px', height: size + 'px' }" alt="" draggable="false" />
  <canvas v-else ref="cv" class="mlg" :style="{ width: size + 'px', height: size + 'px' }"></canvas>
</template>

<style scoped>
.mlg { flex: none; display: block; }
.mlg-ic { display: inline-flex; align-items: center; justify-content: center; }
</style>
