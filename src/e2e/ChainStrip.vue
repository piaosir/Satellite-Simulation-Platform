<script setup>
// 链路条：一条端到端链路的水平信号流编辑器（本窗口的核心控件）。
// 三层，从上到下：
//   ① 链路行——节点卡片与 hop 连线交替。卡片点选进检查器、右键改类型/删；连线上标频率（星间加距离）、
//      中央「＋」在此处插入节点、下标该跳算后回填的 C/N。
//   ② 段标尺——按再生类节点自动切分的色带，与上方近似对齐（flex 比例）；最弱段 2px accent 描边。
//   ③ 端到端汇总条——三个数字卡：端到端余量 / 系统可用度 / 端到端时延。
// 链过长在本容器内横向滚动。纯展示 + 事件，不碰数据：增删改都 emit 给宿主。
import { computed, ref } from 'vue'
import { hopTypeOf, isSpaceHop, segmentsOf } from './e2eParams.js'
import { byLang } from '../shared/i18n/lang.js'   // 空名占位是界面语汇，却画在打了 skip 的名字位上（呈现层翻不到），故在这里按语言出字

const props = defineProps({
  row: { type: Object, default: null },           // 当前链路行 { nodes, hops }
  result: { type: Object, default: null },        // 引擎出参（data），未算为 null
  sel: { type: Object, default: () => ({}) },     // 选中项 { type:'node'|'hop', index }
  satName: { type: Function, default: null },     // (node) => 卫星库条目名（解析引用）
  satVal: { type: Function, default: null },      // (node, key) => 该卫星参数有效值（ov 优先、库兜底）
  esName: { type: Function, default: null },      // (node) => 地球站库条目名
  segCarrier: { type: Function, default: null },  // (段号) => 该段载波体制名（逐段可换）
  solved: { type: Array, default: null }          // 自动几何解出的逐跳几何（手动档为 null）
})
const emit = defineEmits(['select', 'insert', 'remove', 'toggle-kind', 'toggle-link', 'toggle-endpoint', 'extend-end'])

const nodes = computed(() => (props.row && props.row.nodes) || [])
const hops = computed(() => (props.row && props.row.hops) || [])
const segs = computed(() => segmentsOf(nodes.value))
const hopType = (i) => hopTypeOf(nodes.value[i], nodes.value[i + 1], hops.value[i])
const HOP_LBL = { up: '上行', down: '下行', isl: '星间微波', laser: '星间激光' }

// 引擎回填：逐跳 C/N、逐段结果、逐颗透明星的转发器占用
const hopRes = (i) => (props.result && props.result.hops && props.result.hops[i]) || null
const segRes = (i) => (props.result && props.result.segments && props.result.segments[i]) || null
const txpRes = (i) => ((props.result && props.result.transponders) || []).find((t) => t.nodeIndex === i) || null
// 占比条：0–100% 按值铺宽，超发（>100%）铺满并转红。纯数字口径——条只是把数画出来，不下结论。
const pctNum = (v) => { const n = parseFloat(v); return isFinite(n) ? n : null }
const barW = (v) => { const n = pctNum(v); return n === null ? '0%' : Math.max(0, Math.min(100, n)) + '%' }
const barOver = (v) => { const n = pctNum(v); return n !== null && n > 100 }
const isEnd = (i) => i === 0 || i === nodes.value.length - 1

// 节点摘要（第三行小字）：地球站报站址，卫星报 EIRP 与 G/T（ov 优先、库兜底——一眼看清工作点，
// 不必点进检查器；透明星报饱和 EIRPs、再生星报载波直发 EIRP）
function nodeSummary(nd) {
  if (!nd) return ''
  if (nd.kind === 'es') {
    const lat = nd.latitude, lon = nd.longitude
    return (lat !== '' && lat != null && lon !== '' && lon != null) ? `${(+lat).toFixed(1)}°N ${(+lon).toFixed(1)}°E` : ''
  }
  const v = (k) => (props.satVal ? props.satVal(nd, k) : null)
  const eirp = nd.kind === 'regen' ? v('eirp') : v('eirpSat')
  const gt = v('gt')
  return [
    eirp != null ? `${nd.kind === 'regen' ? 'EIRP' : 'EIRPs'} ${eirp} dBW` : '',
    gt != null ? `G/T ${gt} dB/K` : ''
  ].filter(Boolean).join(' · ')
}
const nodeTypeLabel = (nd) => (nd.kind === 'es' ? '地球站' : '卫星')
function nodeBadge(nd, i) {
  // 端点卫星＝载波在星上发起（源）/ 在星上解调结算（宿），不设透明转发
  if (nd.kind !== 'es' && isEnd(i)) return { t: i === 0 ? '源' : '宿', cls: 'bg-accent' }
  if (nd.kind === 'regen') return { t: '再生', cls: 'bg-accent' }
  if (nd.kind === 'txp') return { t: '透明', cls: 'bg-out' }
  return (i > 0 && i < nodes.value.length - 1) ? { t: '转接', cls: 'bg-accent' } : null
}
function nodeTitle(nd, i) {
  if (nd.kind === 'es') return isEnd(i) ? '端点地球站' : '地面转接站（落地解调再上星，切段）'
  if (isEnd(i)) return i === 0 ? '起点卫星（载波在星上发起，按载荷直发 EIRP 起算）' : '终点卫星（载波在星上解调结算）'
  return nd.kind === 'regen' ? '再生卫星（解调-重调，切段）' : '透明卫星（变频放大转发，不切段）'
}
// 跳上标的距离：手动档报单元格里的数，自动档报解出来的那份（送进引擎的就是它）
function hopDist(i) {
  const s = (props.solved || [])[i]
  if (s) return s.rangeKm || s.slantRange || ''
  return hops.value[i].rangeKm || ''
}

// 右键菜单
const ctx = ref({ open: false, x: 0, y: 0, kind: '', index: -1 })
function openCtx(e, kind, index) {
  ctx.value = { open: true, x: e.clientX, y: e.clientY, kind, index }
}
function closeCtx() { ctx.value.open = false }
function ctxDo(fn) { closeCtx(); fn() }

// 插入菜单（「＋」圆钮）
const ins = ref({ open: false, x: 0, y: 0, index: -1 })
function openIns(e, i) { ins.value = { open: true, x: e.clientX, y: e.clientY, index: i } }
// 地面转接站的入跳是星地下行、出跳是星地上行 ⇒ 只能插在星间跳上（插在星地跳上会造出「站→站」）
const insCanRelay = computed(() => ins.value.index >= 0 && isSpaceHop(hopType(ins.value.index)))
function doInsert(kind) { const i = ins.value.index; ins.value.open = false; emit('insert', i, kind) }

const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : null }
const marginCls = (v) => { const n = num(v); return n === null ? '' : (n < 0 ? 'bad' : 'ok') }
// hop 下标的读数：射频跳报本跳 C/N，激光跳没有 C/N（光功率链只出 P_rx / P_req）⇒ 报光链余量
const hopBot = (i) => {
  const r = hopRes(i)
  if (!r) return { v: '', t: null }
  if (r.cnResult) return { v: r.cnResult, t: null }
  return r.laserMarginResult ? { v: r.laserMarginResult, t: '光链余量 P_rx − P_req' } : { v: '', t: null }
}
</script>

<template>
  <div class="cs">
    <div v-if="!row" class="cs-empty">还没有链路。</div>
    <template v-else>
      <!-- ① 链路行 -->
      <div class="cs-scroll">
        <div class="cs-flow">
          <template v-for="(nd, i) in nodes" :key="nd._id">
            <div class="cs-node" :class="[nd.kind, { on: sel.type === 'node' && sel.index === i }]"
                 :title="nodeTitle(nd, i)"
                 @click="emit('select', { type: 'node', index: i })"
                 @contextmenu.prevent.stop="openCtx($event, 'node', i)">
              <div class="cs-n-top">
                <span class="cs-n-t">{{ nodeTypeLabel(nd) }}</span>
                <span v-if="nodeBadge(nd, i)" class="cs-badge" :class="nodeBadge(nd, i).cls">{{ nodeBadge(nd, i).t }}</span>
              </div>
              <div class="cs-n-name" data-i18n-skip :title="nd.name || (nd.kind === 'es' ? esName?.(nd) : satName?.(nd)) || ''">{{ nd.name || (nd.kind === 'es' ? esName?.(nd) : satName?.(nd)) || byLang('未命名', 'Unnamed') }}</div>
              <div class="cs-n-sum" :title="nodeSummary(nd)">{{ nodeSummary(nd) }}</div>
              <!-- 透明星的转发器占用：这一条载波吃掉多少功率、多少带宽（>100% 铺满转红＝超发） -->
              <div v-if="txpRes(i)" class="cs-occ">
                <!-- 提示语写成两条整串而非插值：界面翻译按整串查表，插值会把中文劈成查不到的碎片 -->
                <div v-for="m in [{ k: '功率', t: '本载波占该转发器输出功率的比例', v: txpRes(i).powerRatioResult },
                                  { k: '带宽', t: '本载波占该转发器带宽的比例', v: txpRes(i).bandwidthRatioResult }]" :key="m.k"
                     class="cs-occ-row" :title="m.t">
                  <span class="cs-occ-k">{{ m.k }}</span>
                  <span class="cs-occ-bar"><i :style="{ width: barW(m.v) }" :class="{ over: barOver(m.v) }"></i></span>
                  <span class="cs-occ-v" :class="{ over: barOver(m.v) }">{{ m.v }}<em>%</em></span>
                </div>
              </div>
            </div>
            <div v-if="i < hops.length" class="cs-hop" :class="{ on: sel.type === 'hop' && sel.index === i }"
                 @click="emit('select', { type: 'hop', index: i })"
                 @contextmenu.prevent.stop="openCtx($event, 'hop', i)">
              <div class="cs-h-top">
                <span>{{ HOP_LBL[hopType(i)] }}</span>
                <b v-if="!isSpaceHop(hopType(i))">{{ hops[i].frequency }} GHz</b>
                <b v-else>{{ hopDist(i) || '—' }} km</b>
              </div>
              <div class="cs-h-line">
                <span class="cs-h-wire"></span>
                <button class="cs-h-add" title="在此处插入节点" @click.stop="openIns($event, i)">
                  <svg viewBox="0 0 12 12" width="9" height="9"><path d="M6 2v8M2 6h8" /></svg>
                </button>
                <span class="cs-h-wire"></span>
                <span class="cs-h-arrow"></span>
              </div>
              <div class="cs-h-bot" :title="hopBot(i).t">{{ hopBot(i).v }}<i v-if="hopBot(i).v">dB</i></div>
            </div>
          </template>
        </div>

        <!-- ② 段标尺 -->
        <div class="cs-ruler">
          <div v-for="(sg, si) in segs" :key="si" class="cs-band"
               :class="{ weak: segRes(si) && segRes(si).weakest }"
               :style="{ flex: (sg.to - sg.from) }"
               title="本段的 C/(N+I) 与余量：段内各跳噪声级联后与门限比较（起讫节点见上方链路行）">
            <span class="cs-b-n">段<em class="cs-b-i">{{ si + 1 }}</em></span>
            <span v-if="segCarrier?.(si)" class="cs-b-c" data-i18n-skip title="本段载波体制（段起点节点可换）">{{ segCarrier(si) }}</span>
            <!-- 纯激光段没有 C/(N+I)：这一格改报接收光功率（段余量格照旧） -->
            <span v-if="segRes(si) && segRes(si).laser" class="cs-b-v" title="接收光功率 P_rx">{{ segRes(si).prxResult }}<i>dBm</i></span>
            <span v-else-if="segRes(si)" class="cs-b-v">{{ segRes(si).cnResult }}<i>dB</i></span>
            <span v-if="segRes(si)" class="cs-b-m" :class="marginCls(segRes(si).marginResult)">{{ segRes(si).marginResult }}<i>dB</i></span>
          </div>
        </div>
      </div>

      <!-- ③ 端到端汇总条 -->
      <div class="cs-sum">
        <div class="cs-card">
          <span class="cs-c-l">端到端余量</span>
          <span class="cs-c-v" :class="marginCls(result && result.e2eMarginResult)">{{ (result && result.e2eMarginResult) || '—' }}<i>dB</i></span>
        </div>
        <div class="cs-card">
          <span class="cs-c-l" title="各星地 hop 站址可用度之积（各站雨区独立假设）；星间 hop 不贡献可用度损失。地面转接站上下行同址同雨，独立乘积为保守包络">系统可用度</span>
          <span class="cs-c-v">{{ (result && result.systemAvailabilityResult) || '—' }}<i>%</i></span>
        </div>
        <div class="cs-card">
          <span class="cs-c-l" title="各段设计误码率之和：各段独立解调、比特透传，误码一旦产生下游无法恢复">端到端 BER</span>
          <span class="cs-c-v">{{ (result && result.e2eBerResult) || '—' }}</span>
        </div>
        <div class="cs-card">
          <span class="cs-c-l" title="Σ hop 传播时延（距离/c）+ Σ 再生类节点处理时延">端到端时延</span>
          <span class="cs-c-v">{{ (result && result.e2eDelayResult) || '—' }}<i>ms</i></span>
        </div>
      </div>
    </template>

    <!-- 右键菜单 -->
    <div v-if="ctx.open" class="lb-ctx-mask" @click="closeCtx" @contextmenu.prevent="closeCtx">
      <div class="lb-ctx" :style="{ left: ctx.x + 'px', top: ctx.y + 'px' }" @click.stop>
        <template v-if="ctx.kind === 'node'">
          <!-- 两条整句而非「切换为{插值}卫星」：界面翻译按整串查表，插值会把中文劈成查不到的碎片 -->
          <template v-if="isEnd(ctx.index)">
            <button v-if="nodes[ctx.index] && nodes[ctx.index].kind === 'es'" class="lb-ctx-i"
                    @click="ctxDo(() => emit('toggle-endpoint', ctx.index))">端点改为卫星</button>
            <button v-else class="lb-ctx-i"
                    @click="ctxDo(() => emit('toggle-endpoint', ctx.index))">端点改为地球站</button>
            <!-- 向外延长链：端点是卫星时可以再接一个地球站（落地）或再接一颗星；
                 端点是地球站时只能接卫星——地球站直连地球站不是卫星链路 -->
            <button v-if="nodes[ctx.index] && nodes[ctx.index].kind !== 'es'" class="lb-ctx-i"
                    @click="ctxDo(() => emit('extend-end', ctx.index, 'es'))">向外接一个地球站</button>
            <button class="lb-ctx-i" @click="ctxDo(() => emit('extend-end', ctx.index, 'sat'))">向外接一颗卫星</button>
          </template>
          <template v-else>
            <button v-if="nodes[ctx.index] && nodes[ctx.index].kind === 'txp'" class="lb-ctx-i"
                    @click="ctxDo(() => emit('toggle-kind', ctx.index))">切换为再生卫星</button>
            <button v-else-if="nodes[ctx.index] && nodes[ctx.index].kind === 'regen'" class="lb-ctx-i"
                    @click="ctxDo(() => emit('toggle-kind', ctx.index))">切换为透明卫星</button>
          </template>
          <button class="lb-ctx-i danger" :disabled="nodes.length <= 2"
                  @click="ctxDo(() => emit('remove', 'node', ctx.index))">删除节点</button>
        </template>
        <template v-else>
          <button v-if="isSpaceHop(hopType(ctx.index)) && hops[ctx.index].link === 'laser'" class="lb-ctx-i"
                  @click="ctxDo(() => emit('toggle-link', ctx.index))">切换为星间微波</button>
          <button v-else-if="isSpaceHop(hopType(ctx.index))" class="lb-ctx-i"
                  @click="ctxDo(() => emit('toggle-link', ctx.index))">切换为星间激光</button>
          <button class="lb-ctx-i" @click="ctxDo(() => emit('select', { type: 'hop', index: ctx.index }))">编辑本跳参数</button>
        </template>
      </div>
    </div>

    <!-- 插入节点：类型选择 -->
    <div v-if="ins.open" class="lb-ctx-mask" @click="ins.open = false" @contextmenu.prevent="ins.open = false">
      <div class="lb-ctx" :style="{ left: ins.x + 'px', top: ins.y + 'px' }" @click.stop>
        <div class="cs-ins-hd">插入节点</div>
        <button class="lb-ctx-i" @click="doInsert('txp')">透明卫星</button>
        <button class="lb-ctx-i" @click="doInsert('regen')">再生卫星</button>
        <button v-if="insCanRelay" class="lb-ctx-i" @click="doInsert('es')">地面转接站</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* --cs-wire：信号流线与箭头的墨色。--lb-rule（42%）在浅色下只有 2.65:1，够不上
   WCAG 对「有意义图形」的 3:1；提到 55% 后明暗两主题分别 3.6 / 4.9，两头都过。 */
.cs { display: flex; flex-direction: column; gap: 8px; min-width: 0;
      --cs-wire: color-mix(in srgb, var(--text) 55%, var(--bg)); }
.cs-empty { font-size: var(--fs-3); color: var(--text-faint); padding: 14px 2px; }
.cs-scroll { overflow-x: auto; overflow-y: hidden; padding-bottom: 2px; }
.cs-flow { display: flex; align-items: stretch; gap: 0; min-width: min-content; }

/* 节点卡片。宽度按【最长的常见星名】定：卫星编目名（STARLINK-1123 / ZHONGXING-6D）在 118px 下
   一律被省略号砍掉，而卡片上最该一眼认出的就是这个名字。放到 158px 后常见星名整名可见；
   再长的（NAVSTAR 那种带括号 PRN 的）折成两行，仍认得出前半段。 */
.cs-node {
  flex: none; width: 158px; padding: 5px 8px 6px; cursor: pointer; user-select: none;
  background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-box, 3px);
}
.cs-node:hover { border-color: var(--border-strong); }
.cs-node.on { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent-ui); }
.cs-n-top { display: flex; align-items: center; justify-content: space-between; gap: 4px; }
.cs-n-t { font-size: var(--fs-3); color: var(--text-muted); white-space: nowrap; }
.cs-badge { font-size: var(--fs-1); line-height: 1.5; padding: 0 4px; border-radius: var(--r-ctl); white-space: nowrap; }
.cs-badge.bg-accent { background: var(--accent); color: var(--bg); }
.cs-badge.bg-out { background: transparent; color: var(--text-muted); border: 1px solid var(--border-strong); }
/* 名字最多折两行（超长再省略）：整名比「一行齐平」重要 */
.cs-n-name {
  font-size: var(--fs-5); font-weight: 500; color: var(--text); margin-top: 1px; line-height: 1.25;
  overflow: hidden; word-break: break-word;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}
.cs-n-sum { font-size: var(--fs-3); color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 透明星的转发器占用条：细带 + 读数，两行（功率 / 带宽）。数轴恒为 0–100%，超发铺满转红——
   条只是把数画出来，判定仍交给读数本身（纯数字口径）。 */
.cs-occ { margin-top: 3px; display: flex; flex-direction: column; gap: 1px; }
.cs-occ-row { display: flex; align-items: center; gap: 3px; }
.cs-occ-k { flex: none; font-size: var(--fs-1); color: var(--text-muted); }
.cs-occ-bar { flex: 1; min-width: 0; height: 4px; background: var(--surface-2); border: 0.5px solid var(--border); border-radius: var(--r-ctl); overflow: hidden; }
.cs-occ-bar i { display: block; height: 100%; background: var(--accent); }
.cs-occ-bar i.over { background: var(--danger); }
.cs-occ-v { flex: none; font-size: var(--fs-1); color: var(--text); font-variant-numeric: tabular-nums; }
.cs-occ-v.over { color: var(--danger); font-weight: 600; }
.cs-occ-v em { font-style: normal; color: var(--text-muted); margin-left: 1px; }

/* hop 连线：线与箭头走 --cs-wire，深色主题下 --border-strong 只有 1.6:1，
   而这根线是「信号往哪儿流」的唯一视觉线索，不能退成分隔线的分量 */
.cs-hop { flex: 1 1 96px; min-width: 96px; display: flex; flex-direction: column; justify-content: center; cursor: pointer; padding: 0 2px; }
.cs-hop.on .cs-h-wire, .cs-hop.on .cs-h-arrow { background: var(--accent); border-left-color: var(--accent); }
.cs-hop.on .cs-h-top { color: var(--text); }
.cs-h-top { display: flex; align-items: baseline; justify-content: center; gap: 5px; font-size: var(--fs-2); color: var(--text-muted); white-space: nowrap; }
.cs-h-top b { font-weight: 600; color: var(--text); font-variant-numeric: tabular-nums; }
.cs-h-line { display: flex; align-items: center; gap: 3px; padding: 3px 0; }
.cs-h-wire { flex: 1; height: 1px; background: var(--cs-wire); }
.cs-h-arrow { width: 0; height: 0; border-top: 3.5px solid transparent; border-bottom: 3.5px solid transparent; border-left: 6px solid var(--cs-wire); }
.cs-h-add {
  flex: none; width: 15px; height: 15px; padding: 0; cursor: pointer; display: flex; align-items: center; justify-content: center;
  background: var(--bg); color: var(--text-muted); border: 1px solid var(--border-strong); border-radius: 50%;
}
.cs-h-add:hover { color: var(--accent); border-color: var(--accent); }
.cs-h-add svg { fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; }
.cs-h-bot { text-align: center; font-size: var(--fs-2); color: var(--text); font-variant-numeric: tabular-nums; min-height: 15px; }
.cs-h-bot i { font-style: normal; font-size: var(--fs-1); color: var(--text-faint); margin-left: 2px; }

/* ② 段标尺 */
.cs-ruler { display: flex; align-items: stretch; gap: 3px; margin-top: 6px; min-width: min-content; }
/* ★ min-width 取 max-content：段宽本按跳数分（flex 比例），一跳的段分不到几个像素，
   体制名先被挤成「2…」——读数卡上的数被裁掉就等于没有。下界钉在内容宽后，多出来的
   空间照旧按比例分，与上方链路行仍近似对齐；实在放不下就整条标尺随 .cs-scroll 横滚。 */
.cs-band {
  min-width: max-content; padding: 3px 7px; display: flex; align-items: baseline; gap: 8px;
  background: var(--surface); border: 0.5px solid var(--border); border-radius: var(--r-ctl, 2px); white-space: nowrap;
}
.cs-band.weak { border: 2px solid var(--accent); padding: 1.5px 5.5px; }
.cs-b-n { font-size: var(--fs-2); color: var(--text-muted); }
/* 段号与「段」字拆成两个节点：界面翻译按整串查表，「段 1」这种带数字的串没法进词典
   （只靠一个汉字打头的模式会命中一大片，见 test/uiDict.test.mjs 的「锚定过弱」）。 */
.cs-b-i { font-style: normal; margin-left: 3px; font-variant-numeric: tabular-nums; }
/* 段的载波体制名：段与段之间可换（再生节点重新调制），故名字挂在段上 */
/* 体制名上界给到 210px：「155.520 Mbps · 16APSK 5/6」这种整名在 130px 下要掉尾巴 */
.cs-b-c { font-size: var(--fs-2); color: var(--text-muted); max-width: 210px; overflow: hidden; text-overflow: ellipsis; }
.cs-b-v, .cs-b-m { font-size: var(--fs-3); font-weight: 600; color: var(--text); font-variant-numeric: tabular-nums; }
.cs-b-m.bad { color: var(--danger); }
.cs-b-m.ok { color: var(--ok); }
.cs-b-v i, .cs-b-m i { font-style: normal; font-size: var(--fs-1); font-weight: 400; color: var(--text-faint); margin-left: 1px; }

/* ③ 端到端汇总条 */
.cs-sum { display: flex; gap: 10px; flex-wrap: wrap; }
.cs-card {
  display: flex; align-items: baseline; gap: 7px; padding: 4px 10px;
  border-top: 2px solid var(--lb-rule-strong); border-bottom: 2px solid var(--lb-rule-strong);
}
.cs-c-l { font-size: var(--fs-2); color: var(--text-muted); white-space: nowrap; }
.cs-c-v { font-size: var(--fs-6); font-weight: 700; color: var(--text); font-variant-numeric: tabular-nums; }
.cs-c-v.bad { color: var(--danger); }
.cs-c-v.ok { color: var(--ok); }
.cs-c-v i { font-style: normal; font-size: var(--fs-2); font-weight: 400; color: var(--text-faint); margin-left: 2px; }

.cs-ins-hd { padding: 3px 12px 4px; font-size: var(--fs-2); color: var(--text-faint); letter-spacing: var(--ls-label); }
</style>
