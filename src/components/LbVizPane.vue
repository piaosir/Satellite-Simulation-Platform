<script setup>
// 链路预算「详细预算」文档区的图表区（GSO / NGSO / 再生式三窗共用）。
//
// 排版位置：.lbx-doc-side 右栏——左轨是「链路预算级联」主表，两块并排；参考段带整幅铺在两者之下。
// 图表就地长在详细预算里而不是另开分析页签：读的是同一条链路的同一组数，表与图同屏才对得上。
//
// 只画「表里没有的东西」：一次计算的逐行构成左边的三线表已经讲清楚了，把同一份数再画一遍
// 不增加任何信息（级联瀑布图、参数扫描曲线、环境场图先后因此下架——环境场图那两根轴上的
// 雨衰与余量，三线表里逐行都列着）。留下的两张竖排，各自答一个表答不了的问题：
//   地理  站址经纬度铺成平面 + 世界地图底图——这条链路搬到哪儿还成立；
//   链路  3D 地球上的站-星几何——「仰角 3.2°」是个数，卫星贴着地平线是张图。
import { ref } from 'vue'
import LbSpacePane from './LbSpacePane.vue'
import LbLinkPane from './LbLinkPane.vue'

defineProps({
  engine: { type: String, default: 'geo' },
  params: { type: Object, default: null },
  sweep2D: { type: Function, default: null },
  outputDefs: { type: Function, default: null },
  // 本窗存储键前缀（三窗各存各的选择）
  storeKey: { type: String, default: 'lb' },
  // 报表语言（功能区「语言」）：图与左边的表同属「详细预算」这一份文档，一起换语言
  lang: { type: String, default: 'zh' },
  // 该体制不支持扫描时的说明（原样透传给地理图）
  sweepUnavailable: { type: String, default: '' },
  // 链路视图的场景描述子（shared/lbLinkScene.js 产出）。地理图也用它——取被扫那一端连的
  // 那颗星的位置做覆盖门，两张图讲的是同一条链路的同一个瞬间。
  linkScene: { type: Object, default: null },
  // 地理图的覆盖门与方向图联动：{ minElev:{tx,rx}, pattern:{tx,rx} }，由各窗按匹配状态给
  geoLink: { type: Object, default: null },
  // 地理图：整块显示与否（再生式星间没有地球站，无从铺站址平面）；
  // 锁定站则是「这条链路只有一端在地面」时把发/收二选一收起来（再生式上行→发、下行→收）
  showGeo: { type: Boolean, default: true },
  geoSite: { type: String, default: '' }
})

// —— 报告导出：把这一栏两张图收成图件 ——
// 上层（各窗 exportReport）逐条链路切换详细预算，切一条就来这里取一次图。图与表同源同刻：
// 取的是此刻屏幕上这条链路的这两张图，报告里因此不会出现「表是第 3 条、图还是第 2 条」。
// 画不出来的图不占位（地理场图整片在覆盖外、链路视图缺几何）——没有就是没有。
const geoRef = ref(null)
const linkRef = ref(null)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function captureFigures(o) {
  const { scale = 4, timeoutMs = 120000 } = o || {}
  const panes = [geoRef.value, linkRef.value].filter(Boolean)
  for (const p of panes) { try { p.flush() } catch (e) { /* 该图不支持立刻重算即可 */ } }
  const t0 = Date.now()
  while (panes.some((p) => !p.ready) && Date.now() - t0 < timeoutMs) await sleep(80)
  const out = []
  for (const p of panes) {
    if (!p.hasFigure) continue
    let url = ''
    try { url = await p.pngDataUrl(scale) } catch (e) { url = '' }
    if (url) out.push({ title: p.figTitle, dataUrl: url })
  }
  return out
}
defineExpose({ captureFigures })
</script>

<template>
  <aside class="lbv">
    <!-- 两张图的图面分配：地理图是这一栏的主角（一整幅场 + 等值线要读得出数），高由经纬
         跨度锁死、默认铺满栏宽的正方（见 LbSurfacePlot 的 plotBox 与 LbSpacePane 的默认区间）；
         链路视图只回答「这条链路在天上长什么样」，一眼即得，故压扁到 230 px——站-星那一段
         本就被取景甩到画面横向（见 lbglobe 的 frame），扁画幅正合它的形状。
         plot-height 只是「非地理图」的图框高，地理图不走它 -->
    <LbSpacePane v-if="showGeo" ref="geoRef" :engine="engine" :params="params" :sweep2D="sweep2D"
      :output-defs="outputDefs" :store-key="storeKey" :lang="lang" :unavailable="sweepUnavailable"
      :fixed-site="geoSite" :scene="linkScene" :geo-link="geoLink" :plot-height="320" />
    <LbLinkPane ref="linkRef" :scene="linkScene" :store-key="storeKey" :lang="lang" :height="230" />
  </aside>
</template>

<style scoped>
/* 右栏之首：两图竖排，间距与右栏内其它分块一致 */
.lbv { min-width: 0; display: flex; flex-direction: column; gap: 14px; }
</style>
