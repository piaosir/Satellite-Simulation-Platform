<script setup>
// 装配页视口左下读数（契约 §6.1）：件数 · 质量 · 质心 · 惯量 · 包围盒 · 穿插 · 帧率 —— 全是运行时数字（结果区只出数字）。
// 数据来自会话 ui.stats（编辑器 stats 事件，拖动中节流到 ≤ 15 Hz、松手后精确一次）；质心 / 惯量的全精度与全张量只进 title。
// 根元素带 md-read：外框、底色、日照模式配色吃 ModelApp 的同名 scoped 规则（子组件根元素同时带父组件的 scope 属性）。
// ★ 定点定位数（不用有效数字：43 µm 这种伪精度、科学计数法、拖动中字符数忽长忽短都不专业）：质心 / 包围盒 3 位小数（mm）、
//   质量 1 位小数、惯量取整；负号一律 U+2212（与视角「后（−X）」同）。质心三个分量各带淡色轴名（X / Y / Z，不用括号逗号），
//   每个数的最小宽度只按它自己的量级取（max(实际长度, 5)：0.000 与 −0.001 等宽、拖动中不抖，也不为短数撑出大块空白）。
//   「键 + 值 + 单位」成组不拆行（窄视口只在组之间换行）；组之间只留间距、不用「·」分隔（折行后行首不会挂着一个孤零零的点）。
import { inject, computed } from 'vue'
import { fmtNum, fmtInt } from '../wbLogic.js'

const props = defineProps({ fps: { type: Number, default: 0 }, frameMs: { type: Number, default: 0 } })
const asm = inject('asm')
const s = computed(() => asm.ui.stats)
const MINUS = '−'
/** 定点 d 位小数；舍入后是 0 的写 0（不出 −0.000）；负号 U+2212。 */
function fx(v, d) {
  const x = Number.isFinite(v) && Math.abs(v) >= 0.5 * 10 ** -d ? v : 0
  const t = x.toFixed(d)
  return t[0] === '-' ? MINUS + t.slice(1) : t
}
const cl = (v) => (Math.abs(v) < 5e-10 ? 0 : v)
const com = computed(() => s.value.com.map((v) => fx(v, 3)))
const inertia = computed(() => s.value.inertiaDiag.map((v) => fx(cl(v), 0)))
const box = computed(() => { const b = s.value.bbox; return [0, 1, 2].map((k) => fx(Math.max(0, b[k + 3] - b[k]), 3)) })
const boxOk = computed(() => { const b = s.value.bbox; return s.value.count > 0 && b.every(Number.isFinite) && b[3] >= b[0] })
// 最小宽度（ch，等宽字）：各数按自己的量级取（带不带负号同宽），不统一撑到最宽那个
const wOf = (t) => Math.max(5, t.length + (t[0] === MINUS ? 0 : 1))
const comTip = computed(() => '质心（本体系，文档原点）\n' + s.value.com.map((v, i) => 'XYZ'[i] + ' = ' + fmtNum(cl(v), 9) + ' m').join('\n'))
const inTip = computed(() => {
  const I = s.value.inertia
  const rows = Array.isArray(I) ? I.map((r) => r.map((v) => fmtNum(cl(v), 6).padStart(12)).join(' ')) : []
  return ['惯量张量（对质心、本体轴，kg·m²）', ...rows].join('\n')
})
const massTip = computed(() => fmtNum(s.value.massKg, 9) + ' kg')
</script>

<template>
  <div class="md-read asm-read" data-asm-readout>
    <span class="g"><span class="k" title="展开对称后的件数">件数</span><span class="v" data-i18n-skip>{{ fmtInt(s.count) }}</span></span>
    <template v-if="s.count">
      <span class="g"><span class="k">质量</span><span class="v" data-i18n-skip :title="massTip">{{ fx(s.massKg, 1) }}</span><span class="u">kg</span></span>
      <span class="g"><span class="k">质心</span><span class="v" data-i18n-skip :title="comTip"><template v-for="(t, i) in com" :key="i"><span class="ax">{{ 'XYZ'[i] }}</span><span class="n" :style="{ minWidth: wOf(t) + 'ch' }">{{ t }}</span></template></span><span class="u">m</span></span>
      <span class="g"><span class="k">惯量</span><span class="v" data-i18n-skip :title="inTip"><template v-for="(t, i) in inertia" :key="i"><span v-if="i" class="sep"> / </span><span class="n">{{ t }}</span></template></span><span class="u">kg·m²</span></span>
      <span v-if="boxOk" class="g"><span class="k">包围盒</span><span class="v" data-i18n-skip><template v-for="(t, i) in box" :key="i"><span v-if="i" class="sep"> × </span><span class="n">{{ t }}</span></template></span><span class="u">m</span></span>
      <span class="g"><span class="k">穿插</span><span class="v" :class="{ bad: s.clashes > 0 }" data-i18n-skip>{{ fmtInt(s.clashes) }}</span></span>
    </template>
    <span v-if="fps" class="g"><span class="v" data-i18n-skip :title="'帧 CPU ' + frameMs + ' ms'" :style="{ minWidth: '3ch' }">{{ Math.round(fps) }}</span><span class="u">fps</span></span>
  </div>
</template>

<style scoped>
.asm-read { flex-wrap: wrap; row-gap: 1px; column-gap: 14px; max-width: calc(100% - 24px); }
/* 一组 = 「键 值 单位」：组内不换行；组之间只留间距 */
.g { display: inline-flex; align-items: baseline; gap: 5px; white-space: nowrap; }
.k { color: var(--text-muted); white-space: nowrap; }
.v { color: var(--text); font-family: var(--font-mono); font-variant-numeric: tabular-nums; white-space: nowrap; pointer-events: auto; text-align: right; }
.v.bad { color: var(--danger); font-weight: 600; }
.n { display: inline-block; text-align: right; }
/* 质心分量的轴名：淡色小一号，数值前 */
.ax { margin: 0 3px 0 6px; font-family: var(--font-ui); font-size: var(--fs-1); color: var(--text-faint); }
.ax:first-child { margin-left: 0; }
.sep { white-space: pre; }
.u, .s { color: var(--text-faint); white-space: nowrap; }
:global(.md-stage.sun) .k { color: #97a0ad; }
:global(.md-stage.sun) .v { color: #e9edf3; }
:global(.md-stage.sun) .u, :global(.md-stage.sun) .ax { color: #6d7684; }
:global(.md-stage.sun) .v.bad { color: #e0867d; }
</style>
