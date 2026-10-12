<script setup>
// 库页「组件」档（2026-10-12）：全部组件与常用型号——不必先建一份卫星文档才看得到相控阵、螺旋天线、天线座……
//   · 搜索（同设计页组件库：中英文名 / 别名 / 功能分组 / 组件族 / 参数名）+ 领域筛选（只列常用于该领域的件；基本体恒在）；
//     卡片区 = AsmLib 浏览档（按功能分组 → 组件族；不分常用、不标角标）。
//   · 单击 / 方向键 = 选中并在视口里预览（wb.previewComp）；双击 / Enter = 以这一件为根件新建装配件（wb.newAssemblyFromComp：
//     设计页新签，领域按组件的设计领域）。
//   · 右键：新建装配件 / 添加到当前设计（设计页激活的是装配签时：切到设计页、与那里双击卡片同一口径——选中件的兼容空闲接口，空文档作根件）。
import { inject, ref, computed, watch } from 'vue'
import Icon from '../components/Icon.vue'
import AsmLib from './asm/AsmLib.vue'
import { libGroups, libKeyParams, DOMAIN_LABELS, NEW_DOMAINS } from './asmLogic.js'

const wb = inject('wb')
const asm = inject('asm')
const { st } = wb
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v } catch { return d } }
const lsSet = (k, v) => { try { localStorage.setItem(k, v) } catch { /* 便利数据 */ } }

const q = ref(lsGet('model/lib/compQ', ''))
const dom0 = lsGet('model/lib/compDom', '')
const only = ref(NEW_DOMAINS.includes(dom0) ? dom0 : '')
watch(q, (v) => lsSet('model/lib/compQ', v))
watch(only, (v) => lsSet('model/lib/compDom', v))

const countOf = (gs) => gs.reduce((n, g) => n + g.items.length, 0)
const nAll = computed(() => countOf(libGroups(null)))
const nShown = computed(() => countOf(libGroups(null, q.value, undefined, { only: only.value })))

function pick(k) { wb.previewComp(k) }
function open(k) { wb.newAssemblyFromComp(k) }

// ── 右键菜单 ──
const ctx = ref(null)   // {x, y, key}
function onMenu(m) {
  const w = 220, h = 96
  ctx.value = { x: Math.min(m.x, window.innerWidth - w - 6), y: Math.min(m.y, window.innerHeight - h - 6), key: m.key }
}
function closeCtx() { ctx.value = null }
function ctxDo(fn) { const k = ctx.value && ctx.value.key; closeCtx(); if (k) fn(k) }
/** 「添加到当前设计」的目标：设计页激活的装配签（模型签 / 没有签 → 不可用） */
const target = computed(() => { void st.activeDoc; void st.docs.length; return wb.activeAsmDoc() })
const targetName = computed(() => (target.value ? wb.docTitle(target.value) : ''))
function addToDesign(k) {
  const d = target.value
  if (!d) return
  const { type, params } = libKeyParams(k)
  st.tab = 'design'
  asm.queueAdd(type, params, d)
}
</script>

<template>
  <div class="asm libc">
    <div class="libc-bar">
      <label class="asm-search">
        <Icon name="search" :size="13" />
        <input v-model="q" type="text" spellcheck="false" placeholder="搜索组件" title="按中英文名称、别名、功能分组、组件类型、参数名搜索；不区分大小写、全角半角与连字符" />
        <button v-if="q" type="button" title="清空" @click="q = ''"><Icon name="x" :size="12" /></button>
      </label>
      <select v-model="only" class="ci libc-dom" title="只列常用于该领域的组件（任何组件都能装进任何领域的装配件）">
        <option value="">全部领域</option>
        <option v-for="d in NEW_DOMAINS" :key="d" :value="d">{{ DOMAIN_LABELS[d] }}</option>
      </select>
    </div>

    <AsmLib mode="browse" :q="q" :only="only" :sel="st.selComp" @pick="pick" @open="open" @menu="onMenu" />

    <div class="libc-foot">
      <span>共</span><b data-i18n-skip>{{ nAll }}</b><span>个</span>
      <template v-if="nShown !== nAll"><span class="sep">·</span><span>显示</span><b data-i18n-skip>{{ nShown }}</b></template>
    </div>

    <Teleport to="body">
      <div v-if="ctx" class="lb-ctx-mask" @mousedown="closeCtx" @contextmenu.prevent="closeCtx">
        <div class="lb-ctx" :style="{ left: ctx.x + 'px', top: ctx.y + 'px' }" @mousedown.stop>
          <button class="lb-ctx-i" data-act="comp-new" title="以此为根件新建装配件（领域按组件的设计领域；原样不入库，编辑后自动入库）" @click="ctxDo(open)">新建装配件</button>
          <button class="lb-ctx-i" data-act="comp-add" :disabled="!target" :title="target ? '在设计页添加到选中件的兼容空闲接口（空文档作根件）' : '设计页未打开装配件'" @click="ctxDo(addToDesign)">
            <span>添加到当前设计</span><span v-if="targetName" class="libc-doc" data-i18n-skip>{{ targetName }}</span>
          </button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.libc { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; }
.libc-bar { flex: none; display: flex; align-items: center; gap: 6px; }
.libc-bar > .asm-search { flex: 1; min-width: 0; }
.libc-dom { flex: none; width: 104px; min-width: 0; }
.libc-foot { flex: none; display: flex; align-items: baseline; gap: 4px; font-size: var(--fs-2); color: var(--text-muted); padding-top: 4px; border-top: 1px solid var(--border); }
.libc-foot b { font-weight: 600; color: var(--text); font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.libc-foot .sep { color: var(--text-faint); padding: 0 2px; }
/* 右键菜单「添加到当前设计」后缀目标签名（弱一档；长名截断） */
.libc-doc { display: inline-block; max-width: 120px; margin-left: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; color: var(--text-faint); }
.lb-ctx-i:hover:not(:disabled) .libc-doc { color: color-mix(in srgb, var(--bg) 78%, transparent); }
</style>
