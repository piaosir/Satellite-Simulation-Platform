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

defineProps({
  down: { type: Object, default: null },
  up: { type: Object, default: null },
  hoveredId: { type: String, default: '' }
})
const emit = defineEmits(['hover'])

const view = ref('down')                                // 'down' | 'up'
</script>

<template>
  <div class="ci-geo">
    <div class="ci-geo-tabs">
      <button class="gt" :class="{ on: view === 'down' }" title="本站接收天线的方向图切面：干扰星落在曲线上，右轴直接读鉴别度" @click="view = 'down'">下行</button>
      <button class="gt" :class="{ on: view === 'up' }" title="干扰站的离轴 EIRP 密度切面 + S.524 掩模：右轴直接读 C/I" @click="view = 'up'">上行</button>
    </div>

    <template v-if="view === 'down'">
      <CiPatternPlot
        :curve="(down && down.patternCurve) || []" :marks="(down && down.patternMarks) || []"
        :sources="(down && down.sources) || []"
        :peak-gain-dbi="down && down.peakGainDbi" :hovered-id="hoveredId" @hover="emit('hover', $event)" />
      <p class="ci-note sm">
        横轴为离轴角（对数），纵轴为增益，曲线为<strong>本站接收天线</strong>的 AP8/S.580 包络，
        右侧副轴直读<strong>鉴别度</strong>。干扰星标于曲线上并引垂线至横轴；其所处区段
        （主瓣、φ₁ 拐点、29−25lgφ 斜坡或远场底板）决定鉴别度取值。
      </p>
    </template>

    <template v-else>
      <CiUplinkPlot
        :own-density-db-w-per-hz="up && up.ownDensityDbWPerHz"
        :mask-curve="(up && up.maskCurve) || []" :mask-marks="(up && up.maskMarks) || []"
        :mask-band="(up && up.maskBand) || ''" :mask-authoritative="!!(up && up.maskAuthoritative)"
        :mask-phi0-deg="up && up.maskPhi0Deg"
        :peer-curves="(up && up.peerCurves) || []" :sources="(up && up.sources) || []"
        :source-mode="(up && up.sourceMode) || 'peer'"
        :hovered-id="hoveredId" @hover="emit('hover', $event)" />
      <p class="ci-note sm">
        施扰源为<strong>邻网发射站</strong>，按其自身天线与自身视轴夹角计算：
        横轴为<strong>干扰站</strong>离轴角，纵轴为其 EIRP 谱密度。水平线为本站上行密度（即 C），
        其到干扰点的垂直距离<strong>即</strong>该源的 C/I，右侧副轴已标定。
        红虚线为 S.524 监管上界，实线为对等站按实际天线算得的值，
        两者之差即「硬上界」与「工程值」的差量（约二十余 dB）。
      </p>
    </template>
  </div>
</template>

<style scoped>
.ci-geo { width: 100%; }
.ci-geo-tabs { display: flex; gap: 3px; margin-bottom: 6px; }
.gt { font: inherit; font-size: 11.5px; padding: 3px 14px; cursor: pointer; background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl, 4px); }
.gt.on { background: var(--surface-2); color: var(--text); border-color: var(--border-strong); font-weight: 600; }

.ci-note { margin: 6px 0 0; font-size: 11.5px; line-height: 1.55; color: var(--text-muted); }
.ci-note.sm { font-size: 11px; }
.ci-note strong { color: var(--text); font-weight: 600; }
</style>
