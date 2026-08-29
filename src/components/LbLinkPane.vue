<script setup>
// 链路视图（GSO / NGSO / 再生式三窗共用）：把详细预算此刻正在显示的那条链路，摆到 3D 地球上。
//
// 它接的是「环境场图」原来的位置。换掉的理由：可用度 × 降雨率那张图讲的东西，
// 左边三线表的雨衰/余量几行已经讲全了，图上无非把同一组数换个形状；而**几何**是全场
// 唯一一个表里根本表达不出来的东西——「仰角 3.2°」是个数字，「卫星贴着地平线、链路
// 斜穿半个大气层」是张图。三个体制看的正是各自那点几何差异：
//   GSO   定点轨位不动，两条腿一目了然；
//   NGSO  卫星摆在最差工况时刻 t* 的星下点（余量最差那一候选，与表同一瞬间）；
//   再生式 上行只画发信站那一端、下行只画收信站那一端，星间两颗星连成一条擦地的线。
//
// 场景由 shared/lbLinkScene.js 归一成描述子后传进来，本组件不认体制；3D 那头
// （viz/lbglobe/linkGlobe.js，连同 three）动态 import，图表区没打开就不进包也不建 WebGL 上下文。
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { lbDocT } from '../shared/lbDocI18n.js'
import { isDark } from '../shared/lbPlotTheme.js'

const props = defineProps({
  // shared/lbLinkScene.js 产出的场景描述子。三种形态：
  //   null            还没算这条链路
  //   { blocked }     算出来了，但几何缺料（缺轨位/缺站址…）——原样说出来，见 hint
  //   { nodes, legs } 可画
  scene: { type: Object, default: null },
  lang: { type: String, default: 'zh' },
  storeKey: { type: String, default: 'lb' },
  height: { type: Number, default: 330 }
})
const t = computed(() => lbDocT(props.lang))
// 有没有真几何可画。空场景与「算了但缺料」要分开说：后者若也报「先计算链路」，
// 读者会以为自己没点计算，而其实是某个几何输入是空的（引擎有默认值兜底，图没有）。
const hasGeom = computed(() => !!(props.scene && Array.isArray(props.scene.nodes) && props.scene.nodes.length))
const hint = computed(() => {
  if (hasGeom.value) return ''
  const b = props.scene && props.scene.blocked
  return b ? (t.value('本链路无可绘制的几何') + '：' + t.value(b)) : t.value('链路尚未计算')
})

const host = ref(null)
const failed = ref('')
let globe = null, mo = null, destroyed = false

const spin = ref((() => { try { return localStorage.getItem(props.storeKey + '/viz/link/spin') === '1' } catch (e) { return false } })())
watch(spin, (v) => {
  try { localStorage.setItem(props.storeKey + '/viz/link/spin', v ? '1' : '0') } catch (e) { /* ignore */ }
  if (globe) globe.setAutoRotate(v)
})

onMounted(async () => {
  if (!host.value) return
  try {
    const mod = await import('../viz/lbglobe/linkGlobe.js')
    if (destroyed || !host.value) return
    globe = mod.createLinkGlobe(host.value)
    await globe.applyTheme(isDark())
    globe.setAutoRotate(spin.value)
    if (hasGeom.value) globe.setScene(props.scene)
  } catch (e) {
    failed.value = (e && e.message) ? e.message : String(e)
    return
  }
  // 主题是行内写在 <html> 上的 data-theme，computed 读不到后续变化 → 盯 attribute
  mo = new MutationObserver(() => { if (globe) globe.applyTheme(isDark()) })
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
})
onBeforeUnmount(() => {
  destroyed = true
  if (mo) { mo.disconnect(); mo = null }
  if (globe) { globe.dispose(); globe = null }
})
watch(() => props.scene, (s) => { if (globe) globe.setScene(hasGeom.value ? s : null) })

// —— 读数条：几何量原样取自场景描述子（即表里那一组），此处只负责排版 ——
const g2 = (n, p = 2) => (n == null || !isFinite(n)) ? '—' : Number(n).toFixed(p)
const km = (n) => (n == null || !isFinite(n)) ? '—' : (n >= 1000 ? Math.round(n).toLocaleString('en-US') : Number(n).toFixed(2))
const DIR_NAME = { up: '上行', down: '下行', isl: '星间' }
const legRows = computed(() => {
  const s = props.scene
  if (!s || !s.legs) return []
  const nameOf = (id) => { const n = (s.nodes || []).find((x) => x.id === id); return n ? n.name : id }
  return s.legs.map((l) => ({
    dir: l.dir,
    name: t.value(DIR_NAME[l.dir] || l.dir),
    path: nameOf(l.from) + ' → ' + nameOf(l.to),
    elev: l.elevDeg, az: l.azDeg, slant: l.slantKm
  }))
})
// 时刻：与几何卡同一套 UTCG 写法（1 Jan 2026 00:00:00）
const UTCG_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const epochText = computed(() => {
  const iso = props.scene && props.scene.epochISO
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return String(iso)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCDate()} ${UTCG_MON[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTCG`
})

function resetView() { if (globe) globe.resetView() }

// —— 导出 ——
const exportFile = (typeof window !== 'undefined' && window.api) ? window.api.exportFile : null
// 取一帧 = 一个 data:image/png URL（snapshot 内部先 syncSprites 再渲染，见 linkGlobe）。
// 与 exportPng 同一条路径，报告里的图即用户手动导出的那张图。
function pngDataUrl(scale) {
  if (!globe || !hasGeom.value) return ''
  try { return globe.snapshot(scale || 4) } catch (e) { return '' }
}
async function exportPng() {
  if (!exportFile) return
  const url = pngDataUrl(4)
  if (!url) return
  try {
    const data = new Uint8Array(await (await fetch(url)).arrayBuffer())
    await exportFile({ defaultName: t.value('链路视图') + '.png', data, filters: [{ name: t.value('PNG 图片'), extensions: ['png'] }] })
  } catch (e) { /* 用户取消或取帧失败：不出图即可 */ }
}

// —— 供「报告导出」逐条链路取图 ——
// 场景是同步 setScene 的，没有异步扫描要等，故 ready 恒真；画不出几何时 hasFigure 为假，
// 报告里这一条就没有这张图（「没有就是没有」）。
defineExpose({
  flush: () => {},
  ready: computed(() => true),
  hasFigure: hasGeom,
  figTitle: computed(() => t.value('链路视图')),
  pngDataUrl: async (s) => pngDataUrl(s)
})
</script>

<template>
  <div class="lk">
    <div class="lk-hd">
      <b class="lk-name">{{ t('链路视图') }}</b>
      <span class="lk-sub">{{ t('站星几何') }}</span>
      <span class="lk-flex"></span>
      <button class="lk-btn" :title="t('导出为 PNG 图片（4 倍分辨率）')" @click="exportPng">{{ t('导出') }}</button>
    </div>

    <div class="lk-bar">
      <span v-if="scene && scene.method" class="lk-tag">{{ scene.method }}</span>
      <span v-if="epochText" class="lk-time" :title="t('本图几何所在时刻（与详细预算同一瞬间）')">{{ epochText }}</span>
      <span class="lk-flex"></span>
      <label class="lk-f" :title="t('让地球缓慢自转（不影响任何数值）')">
        <input v-model="spin" type="checkbox" class="lk-ck" />{{ t('自转') }}
      </label>
      <button class="lk-btn" :title="t('回到自动取景的视角')" @click="resetView">{{ t('复位') }}</button>
    </div>

    <div v-if="failed" class="lk-ph">{{ t('3D 视图初始化失败') }}：{{ failed }}</div>
    <template v-else>
      <!-- 画布始终挂着（WebGL 上下文只建一次）；没几何时盖一层说明，不销毁重建 -->
      <div class="lk-box" :style="{ height: height + 'px' }">
        <div ref="host" class="lk-cv"></div>
        <div v-if="!hasGeom" class="lk-mask">{{ hint }}</div>
      </div>
      <div v-if="hasGeom" class="lk-legs">
        <div v-for="(l, i) in legRows" :key="i" class="lk-leg">
          <span class="lk-dot" :class="'lk-' + l.dir"></span>
          <span class="lk-lname" data-i18n-skip>{{ l.name }}</span>
          <span class="lk-lpath">{{ l.path }}</span>
          <span v-if="l.elev != null" class="lk-lv">{{ t('仰角') }} {{ g2(l.elev) }}<i>°</i></span>
          <span v-if="l.az != null" class="lk-lv">{{ t('方位') }} {{ g2(l.az) }}<i>°</i></span>
          <span v-if="l.slant != null" class="lk-lv">{{ t(l.dir === 'isl' ? '星间距离' : '斜距') }} {{ km(l.slant) }}<i>km</i></span>
        </div>
      </div>
      <div class="lk-note">
        <span v-for="(n, i) in ((scene && scene.notes) || [])" :key="i" class="lk-cav">{{ n }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* 控件语言与 LbSpacePane 一致（方角、细边、衬线数字）：两张图并排放着，题行必须是一套 */
.lk { font-family: var(--font-ui); min-width: 0; }
.lk-hd {
  display: flex; align-items: baseline; gap: 8px;
  padding: 0 1px 2px; font-size: var(--lb-fs, 11px); color: var(--text);
  border-bottom: 1px solid var(--lb-rule);
}
.lk-name { font-weight: 700; }
.lk-sub { font-size: calc(var(--lb-fs, 11px) - 1px); color: var(--text-faint); }
.lk-flex { flex: 1 1 auto; }
.lk-bar { display: flex; align-items: center; gap: 5px 9px; flex-wrap: wrap; padding: 5px 1px 6px; font-size: var(--lb-fs, 11px); }
.lk-tag { color: var(--text-muted); }
.lk-time { color: var(--text-faint); font-variant-numeric: tabular-nums; }
.lk-f { display: inline-flex; align-items: center; gap: 4px; color: var(--text-muted); cursor: pointer; }
.lk-ck { margin: 0; }
.lk-btn {
  font: inherit; font-size: calc(var(--lb-fs, 11px) - 1px); color: var(--text-muted); cursor: pointer; height: var(--h-ctl); white-space: nowrap; padding: 0 6px;
  background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px);
}
.lk-btn:hover { color: var(--text); border-color: var(--border-strong); }

.lk-box { position: relative; border: 1px solid var(--lb-rule); background: var(--bg); overflow: hidden; }
.lk-cv { position: absolute; inset: 0; }
.lk-mask {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  background: var(--bg); color: var(--text-faint); font-size: var(--lb-fs, 11px);
}
.lk-ph { padding: 16px 4px; font-size: var(--lb-fs, 11px); color: var(--text-faint); text-align: center; }

/* 读数条：一条腿一行，与三线表同一套数字排版（等宽数字、单位小一号跟在后面） */
.lk-legs { padding-top: 5px; font-size: var(--lb-fs, 11px); }
.lk-leg { display: flex; align-items: baseline; gap: 4px 10px; flex-wrap: wrap; padding: 1px 1px; }
/* 图例色块与 3D 里的链路线同色（viz/lbglobe/linkGlobe.js 的 DIR_COLOR，亮暗两套） */
.lk-dot { width: 9px; height: 2px; border-radius: 1px; align-self: center; }
.lk-up { background: #15619b; }
.lk-down { background: #b8571a; }
.lk-isl { background: #6a3d9a; }
html[data-theme="dark"] .lk-up { background: #4a8fc9; }
html[data-theme="dark"] .lk-down { background: #d2792f; }
html[data-theme="dark"] .lk-isl { background: #9878d8; }
.lk-lname { color: var(--text); font-weight: 600; }
.lk-lpath { color: var(--text-muted); }
.lk-lv { color: var(--text); font-variant-numeric: tabular-nums; }
.lk-lv i { font-style: normal; color: var(--text-faint); font-size: calc(var(--lb-fs, 11px) - 1px); margin-left: 1px; }
.lk-note { display: flex; flex-direction: column; gap: 1px; font-size: calc(var(--lb-fs, 11px) - 1px); padding-top: 3px; }
.lk-cav { color: var(--text-faint); }
</style>
