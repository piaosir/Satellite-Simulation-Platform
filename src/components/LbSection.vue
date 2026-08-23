<script setup>
// 链路预算工作台「分节」外壳（GEO / NGSO / 再生式共用）。
// 取代旧「点击式模块标签页」：所有节常驻渲染、竖向堆叠，模块条退化为滚动定位（scrollspy）。
// 节头随内容滚走（不吸顶）——曾用 sticky 常驻可见，但节头会悬浮压在链路表/详细预算的内容上，已撤。
// 节头不可点：折叠/展开已删（各节一律常展，报告式文档流里藏起整节没有意义）。

defineProps({
  id: { type: String, required: true },        // 节 id（滚动定位锚，与模块 key 一致）
  title: { type: String, required: true },
  count: { type: Number, default: -1 },        // -1 = 不显示计数
  summary: { type: String, default: '' },      // 节头一行摘要（mono）
  flow: { type: String, default: '' }          // 'chain' = 链路构成节（节头左缘画信号流标记）
})
</script>

<template>
  <section class="lbx-sec" :data-sec="id">
    <header class="lbx-sec-hd" :class="{ chain: flow === 'chain' }">
      <span class="lbx-sec-t">{{ title }}</span>
      <span v-if="count >= 0" class="lbx-sec-n">{{ count }}</span>
      <span v-if="summary" class="lbx-sec-sum" :title="summary">{{ summary }}</span>
      <span class="lbx-sec-sp"></span>
      <!-- 节级动作 -->
      <span class="lbx-sec-acts"><slot name="actions" /></span>
    </header>
    <div class="lbx-sec-bd" :class="{ flush: $slots.default && flow === 'grid' }">
      <slot />
    </div>
  </section>
</template>

<style scoped>
/* 节头：三线语言的分章标题行——白底 + 标题加粗衬线 + 下缘粗题线，
   与结果三线表的题注同族；不再用灰底色条。计数/摘要退成纯文本。
   relative + z-8 只为保住兄弟节头间的层叠次序（结果列浮层靠它抬到 60，见 lbworkbench.css），
   不再 sticky——节头一律随内容滚走。 */
.lbx-sec-hd {
  position: relative; z-index: 8;
  display: flex; align-items: center; gap: 7px;
  padding: 5px 1px 4px;
  background: var(--bg);
  border-bottom: 2px solid var(--lb-rule-strong);
  user-select: none;
}
.lbx-sec-t { font-size: calc(var(--lb-fs, 11px) + 2px); font-weight: 700; letter-spacing: var(--ls-tight); color: var(--text); white-space: nowrap; }
.lbx-sec-n { font-size: calc(var(--lb-fs, 11px) - 1px); line-height: 1; color: var(--text-muted); font-variant-numeric: tabular-nums; }
.lbx-sec-n::before { content: '('; }
.lbx-sec-n::after { content: ')'; }
.lbx-sec-sum { font-size: calc(var(--lb-fs, 11px) - 1px); color: var(--text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.lbx-sec-sp { flex: 1; }
.lbx-sec-acts { display: inline-flex; align-items: center; gap: 4px; }
.lbx-sec-bd { padding: 8px 1px 2px; }
</style>
