<script setup>
// 链路瀑布表渲染：直接吃 core.buildWaterfallSegments 输出的 segments[]，
// 与原仓库结果详情页/专业版导出同一口径（逐行可手算）。
// ※ 与 ngso/WaterfallTable.vue 为镜像文件，改动须手工同步。
import { computed } from 'vue'
import { lbDocT } from '../shared/lbDocI18n.js'

const props = defineProps({
  segments: { type: Array, default: () => [] },
  // 渲染哪一部分（「详细预算」三段式排版用）：
  //   'all'     全部段，按 core 原序（TSV/报表口径，默认）
  //   'cascade' 只渲染级联主段（core 打了 role:'cascade'）——文档顶部主角，与图表区并排
  //   'rest'    渲染除级联外的参考段——铺底整幅段带（每段自适宽，见 lbworkbench.css .lbx-doc-ref）
  // 段序与内容不改，纯挑段渲染；导出/TSV 仍走完整 segments。
  pick: { type: String, default: 'all' },
  // 报表语言（功能区「语言」）：段标题/行标签/单位在 core 取数时就按语言翻好了
  // （waterfallBuilder 的 WF_DICT），表里只剩这三个列头要自己换
  lang: { type: String, default: 'zh' }
})
const t = computed(() => lbDocT(props.lang))
const isCascade = (seg) => !!seg && seg.role === 'cascade'
// 多列段的列头：默认「上行 / 下行 / 合计」，段可用 heads 自定义
//（如工况对照段的「晴空 / 降雨 / 雨致代价」）。长度不符时退回默认，不至于画出空列头。
const DEFAULT_HEADS = { 2: ['上行', '下行'], 3: ['上行', '下行', '合计'] }
const headsOf = (seg) => (Array.isArray(seg.heads) && seg.heads.length === seg.cols)
  ? seg.heads : (DEFAULT_HEADS[seg.cols] || [])
const shown = computed(() => (
  props.pick === 'cascade' ? props.segments.filter(isCascade)
    : props.pick === 'rest' ? props.segments.filter((s) => !isCascade(s))
      : props.segments
))
</script>

<template>
  <!-- wf-en：英文标签比中文长一截，参考段带的标签列/栏宽据此另给一档（lbworkbench.css） -->
  <div class="wf" :class="{ 'wf-en': lang === 'en' }">
    <!-- seg-cols{n}：段级列数标记，供参考段带的 subgrid 父网格按列数取模板（lbworkbench.css） -->
    <div v-for="(seg, si) in shown" :key="si" class="wf-seg" :class="'seg-cols' + seg.cols">
      <!-- 章节号（core 的 _number 按最终段序统一编）：栏轨密排会让短段回填上一行的空洞、
           局部提前，段头挂着 §n 读者才不会跟丢段序；同一个号也是 Excel sheet / PDF 章节的号。
           旧记录与尚未编号的构建器（NGSO / 再生式）没有 no，此时不画号，排版不受影响。 -->
      <div class="wf-title"><span v-if="seg.no" class="wf-no">§{{ seg.no }}</span>{{ seg.title }}</div>

      <div v-if="seg.cols >= 2" class="wf-row wf-head" :class="'cols' + seg.cols">
        <span class="wf-sign"></span>
        <span class="wf-l"></span>
        <span v-for="(h, hi) in headsOf(seg)" :key="hi" class="wf-c">{{ t(h) }}</span>
        <span class="wf-u"></span>
      </div>

      <div v-for="(row, ri) in seg.rows" :key="ri" class="wf-row" :class="['cols' + seg.cols, 'k-' + row.kind]">
        <span class="wf-sign">{{ row.sign }}</span>
        <span class="wf-l">{{ row.label }}</span>
        <span class="wf-c">{{ row.up }}</span>
        <template v-if="seg.cols >= 2">
          <span class="wf-c">{{ row.down }}</span>
          <span v-if="seg.cols === 3" class="wf-c">{{ row.total }}</span>
        </template>
        <span class="wf-u">{{ row.unit }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 三线表（booktabs）：题注下顶线、列头下栏目线、段末底线；行间无框线无底色填充，
   小节/结论行（k-sub / k-kpi / k-margin）以细辅助线 + 加粗分层。字体继承工作台衬线栈
   （TNR 数字字面等宽，右对齐天然成列），字号吃 --lb-fs（功能区「字号」组可调）。
   ※ 与 ngso/WaterfallTable.vue 为镜像文件，改动须手工同步。 */
.wf { display: flex; flex-direction: column; gap: 12px; font-size: var(--lb-fs, 11px); }
.wf-seg { border-bottom: 2px solid var(--lb-rule-strong); padding-bottom: 1px; }
.wf-title {
  padding: 2px 1px 3px; font-size: calc(var(--lb-fs, 11px) + 1px); font-weight: 700; color: var(--text);
  border-bottom: 2px solid var(--lb-rule-strong);
}
/* 章节号：退一档墨色、常规字重——它是定位用的路标，不与段名争标题的分量 */
.wf-no { font-weight: 400; color: var(--text-faint); margin-right: .5em; font-variant-numeric: tabular-nums; }
.wf-row { display: grid; align-items: baseline; gap: 8px; padding: 1px 2px; line-height: 1.5; }
.wf-row:not(.wf-head):hover { background: var(--surface); }
/* 列宽：标签列吃剩余宽度（minmax(0,3fr) 保证它先长、被挤时先让），数值列按内容需要钉死下限
   —— 4.9em ≈ 「−112.422」这类最长值的宽度（TNR 数字半角 0.5em），用 em 随 --lb-fs 同步缩放。
   数值列不用裸 1fr：窄栏下 fr 会把数值压到 min-content，而每行各自成 grid（列宽逐行独算），
   一旦触到 min-content 就逐行不等宽、数值列排成锯齿；minmax 下限是定值，逐行必然对齐。
   标签仍放不下时靠 .wf-l 折行显示全，不再切字（原 1.4fr + 省略号会把长标签截成「Recommended P…」）。 */
.wf-row.cols1 { grid-template-columns: 13px 1fr auto 48px; }
.wf-row.cols2 { grid-template-columns: 13px minmax(0, 3fr) minmax(4.9em, 1fr) minmax(4.9em, 1fr) 48px; }
.wf-row.cols3 { grid-template-columns: 13px minmax(0, 3fr) minmax(4.9em, 1fr) minmax(4.9em, 1fr) minmax(4.9em, 1fr) 48px; }
.wf-sign { color: var(--text-faint); text-align: center; }
/* 标签一律显示全：折行而非省略号（align-items:baseline → 数值与首行基线对齐，仍逐行可读）。
   break-word 兜底「ACI/ASI/XPI/IM」这类无空格长串。 */
.wf-l { color: var(--text-muted); overflow-wrap: break-word; }
.wf-c { text-align: right; color: var(--text); font-variant-numeric: tabular-nums; }
.wf-u { color: var(--text-faint); font-size: calc(var(--lb-fs, 11px) - 1px); }

/* 列头行（上行/下行/合计）：栏目线，无底色 */
.wf-head { border-bottom: 1px solid var(--lb-rule); }
.wf-head .wf-c { color: var(--text-muted); font-size: calc(var(--lb-fs, 11px) - 1px); font-weight: 600; }

/* 行类型：增益/损耗只染符号列（数值守中性墨色，纯数字口径）；小节行细线分层 */
.k-gain .wf-sign { color: var(--ok); font-weight: 700; }
.k-loss .wf-sign { color: var(--danger); font-weight: 700; }
.k-sub, .k-chk { font-weight: 600; border-top: 1px solid var(--lb-rule-soft); }
.k-sub .wf-l, .k-chk .wf-l { color: var(--text); font-weight: 600; }
.k-kpi { font-weight: 600; border-top: 1px solid var(--lb-rule-soft); }
.k-kpi .wf-l { color: var(--text); }
.k-margin { font-weight: 700; border-top: 1px solid var(--lb-rule); }
.k-margin .wf-l { color: var(--text); }
.k-margin .wf-c { color: var(--text); }
</style>
