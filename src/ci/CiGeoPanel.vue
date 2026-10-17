<script setup>
// 干扰几何 —— 两个视图：下行 / 上行。
//
// 两张图问的是两个不同的问题，谁也替不了谁：
//   下行  干扰星朝我发，我这面接收天线在那个角度上给多少增益 → 鉴别度 → C/ASI
//         画本站接收天线的方向图切面（CiPatternPlot）。
//   上行  邻网的站朝它自己的星发，旁瓣泼进本星，那座站在那个角度上泼多少 EIRP 密度
//         画离轴 EIRP 密度切面 + S.524 掩模（CiUplinkPlot）。
//
// 曾有「极坐标」与「全天」两个视图，2026-07-26 删除：环图与半球图都只能表达角度、
// 表达不了增益，而 C/ASI 的物理全在增益上；全天半球上这几颗星还与期望星重合成一点。
import { ref } from 'vue'
import CiPatternPlot from './CiPatternPlot.vue'
import CiUplinkPlot from './CiUplinkPlot.vue'
import { exportSvgPng, canExportPng, PNG_SCALE } from './ciFigureExport.js'
import NoticeLine from '../components/NoticeLine.vue'
import { useNotice } from '../shared/useNotice.js'

defineProps({
  down: { type: Object, default: null },
  up: { type: Object, default: null },
  hoveredId: { type: String, default: '' }
})
const emit = defineEmits(['hover'])

const view = ref('down')                                // 'down' | 'up'

// 出图：当前页签那一张（与 CDF / 时序图同一条出图路径，纸色白底）
const plotRef = ref(null)
const busy = ref(false)
const N = useNotice({ errorSink: false })
const outPath = (r) => (r && (r.path || (Array.isArray(r.paths) && r.paths[0]) || r.filePath)) || ''
async function exportPng() {
  if (busy.value || !plotRef.value) return
  busy.value = true; N.clearNotice()
  try {
    const r = await exportSvgPng(plotRef.value.svg, view.value === 'down' ? 'C-ASI 下行方向图切面' : 'C-ASI 上行离轴密度切面')
    if (r && r.ok) { const fp = outPath(r); N.toastFile('已导出：' + String(fp).split(/[\\/]/).pop(), fp) }
    else if (r && !r.canceled && !r.missing) N.toastError('导出失败：' + (r.error || ''))
  } finally { busy.value = false }
}
</script>

<template>
  <div class="ci-geo">
    <div class="ci-geo-tabs">
      <button class="gt" :class="{ on: view === 'down' }" :aria-pressed="(view === 'down') ? 'true' : 'false'" title="本站接收天线的方向图切面：干扰星落在曲线上，右轴直接读鉴别度" @click="view = 'down'">下行</button>
      <button class="gt" :class="{ on: view === 'up' }" :aria-pressed="(view === 'up') ? 'true' : 'false'" title="干扰站的离轴 EIRP 密度切面 + S.524 掩模：右轴直接读 C/I" @click="view = 'up'">上行</button>
      <span class="gt-sp" />
      <NoticeLine :n="N" />
      <button v-if="canExportPng" class="gt" :disabled="busy || !(view === 'down' ? down : up)"
        :title="`导出为 PNG 图片（${PNG_SCALE} 倍分辨率）`" @click="exportPng">导出</button>
    </div>

    <template v-if="view === 'down'">
      <CiPatternPlot ref="plotRef"
        :curve="(down && down.patternCurve) || []" :marks="(down && down.patternMarks) || []"
        :sources="(down && down.sources) || []"
        :pattern-name="down && down.esPattern ? `${down.esPattern.name} · ${down.esPattern.edition}` : ''"
        :peak-gain-dbi="down && down.peakGainDbi" :hovered-id="hoveredId" @hover="emit('hover', $event)" />
    </template>

    <template v-else>
      <CiUplinkPlot ref="plotRef"
        :own-density-db-w-per-hz="up && up.ownDensityDbWPerHz"
        :mask-curve="(up && up.maskCurve) || []" :mask-marks="(up && up.maskMarks) || []"
        :mask-band="(up && up.maskBand) || ''" :mask-authoritative="!!(up && up.maskAuthoritative)"
        :mask-phi0-deg="up && up.maskPhi0Deg"
        :peer-curves="(up && up.peerCurves) || []" :sources="(up && up.sources) || []"
        :peer-pattern-name="up && up.esPattern ? up.esPattern.name : ''"
        :hovered-id="hoveredId" @hover="emit('hover', $event)" />
    </template>
  </div>
</template>

<style scoped>
.ci-geo { width: 100%; }
.ci-geo-tabs { display: flex; align-items: center; gap: 3px; margin-bottom: 6px; }
.gt-sp { flex: 1; }
.gt:disabled { opacity: 0.45; cursor: default; }
.gt { font: inherit; font-size: var(--fs-3); height: var(--h-ctl); white-space: nowrap; padding: 0 14px; cursor: pointer; background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl, 4px); }
.gt.on { background: var(--surface-2); color: var(--text); border-color: var(--border-strong); font-weight: 600; }

.ci-note { margin: 6px 0 0; font-size: var(--fs-3); line-height: 1.55; color: var(--text-muted); }
.ci-note.sm { font-size: var(--fs-2); }
.ci-note strong { color: var(--text); font-weight: 600; }
</style>
