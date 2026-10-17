<script setup>
// 协调触发页：RR 附录 8 式(1)–(3) 原式（同频段、同传输方向，Case I），公式即界面。
//
// 每条式子照原文记号排出来（MathML，小写 = 数值比），下面是这条式子新出现的量的输入格（大写 = dB 值，附录 8 §2.1 的
// 记号习惯；每格「符号 · 中文名 · 数值 · 单位」，名字写明是哪一方、哪副天线朝哪个方向），右侧是代入后的值，
// 再下一行把 dB 代入式逐项写出来、末尾换回右侧那个 K 值——与附件 4 算例的写法一致，工程师可以逐项对账。
// 带撇号的量属施扰方 = 本网，不带撇号的属受扰方 = 邻网：页面算的是本网对邻网的影响。
// 计算全在引擎（interference/ap8Formula.js），这里只排版、只把引擎回的数与输入原样拼成代入式。
import { computed } from 'vue'

const props = defineProps({
  // 原式入参（reactive，格子就地改）：PeDb G1Dbi G2Dbi LuDb PsDb G3Dbi G4Dbi LdDb gammaDb TK
  p: { type: Object, required: true },
  // 引擎结果（ap8CaseI）
  r: { type: Object, default: null }
})

// —— 符号（MathML 片段，常量）——
const PO = '<mo stretchy="false">(</mo>', PC = '<mo stretchy="false">)</mo>'
const thetaT = '<msub><mi>θ</mi><mi>t</mi></msub>'
const etaE = '<msub><mi>η</mi><mi>e</mi></msub>'
const deltaE = '<msub><mi>δ</mi><msup><mi>e</mi><mo>′</mo></msup></msub>'
const pr = (b, s) => `<msubsup><mi>${b}</mi>${s}<mo>′</mo></msubsup>`
const sb = (b, s) => `<msub><mi>${b}</mi>${s}</msub>`
const DT = (s) => `<mi mathvariant="normal">Δ</mi>${s ? sb('T', `<mi>${s}</mi>`) : '<mi>T</mi>'}`
const math = (x, block) => `<math${block ? ' display="block"' : ''}>${x}</math>`

const SYM = {
  PeDb: pr('P', '<mi>e</mi>'),
  G1Dbi: pr('G', '<mn>1</mn>') + PO + thetaT + PC,
  G2Dbi: sb('G', '<mn>2</mn>') + PO + deltaE + PC,
  LuDb: sb('L', '<mi>u</mi>'),
  PsDb: pr('P', '<mi>s</mi>'),
  G3Dbi: pr('G', '<mn>3</mn>') + PO + etaE + PC,
  G4Dbi: sb('G', '<mn>4</mn>') + PO + thetaT + PC,
  LdDb: sb('L', '<mi>d</mi>'),
  gammaDb: '<mi>γ</mi>',
  TK: '<mi>T</mi>',
  k: '<mi>k</mi>'
}
const dot = '<mo>·</mo>'
const EQ1 = math(DT('s') + '<mo>=</mo><mfrac><mrow>' + pr('p', '<mi>e</mi>') + dot + pr('g', '<mn>1</mn>') + PO + thetaT + PC + dot
  + sb('g', '<mn>2</mn>') + PO + deltaE + PC + '</mrow><mrow><mi>k</mi>' + dot + sb('l', '<mi>u</mi>') + '</mrow></mfrac>', true)
const EQ2 = math(DT('e') + '<mo>=</mo><mfrac><mrow>' + pr('p', '<mi>s</mi>') + dot + pr('g', '<mn>3</mn>') + PO + etaE + PC + dot
  + sb('g', '<mn>4</mn>') + PO + thetaT + PC + '</mrow><mrow><mi>k</mi>' + dot + sb('l', '<mi>d</mi>') + '</mrow></mfrac>', true)
const EQ3 = math(DT('') + '<mo>=</mo><mi>γ</mi>' + dot + DT('s') + '<mo>+</mo>' + DT('e'), true)
const EQ4 = math('<mfrac><mrow>' + DT('') + '</mrow><mi>T</mi></mfrac>', true)

// —— 参数格：side = 'own'（本网，施扰）| 'other'（邻网，受扰）| 'path'（路径）——
const P = (key, name, unit, side, tip) => ({ key, sym: math(SYM[key]), name, unit, side, tip })
const PARAMS1 = [
  P('PeDb', '本网发端站最大功率密度', 'dB(W/Hz)', 'own', '本网发端地球站天线输入端的最大功率密度（15 GHz 以下取最坏 4 kHz、以上取最坏 1 MHz 平均）'),
  P('G1Dbi', '本网发端站朝邻星的增益', 'dBi', 'own', '本网发端地球站天线朝邻星方向的增益（θt：地球站上看两星的拓扑角）'),
  P('G2Dbi', '邻星朝本网发端站的接收增益', 'dBi', 'other', '邻星接收天线朝本网发端地球站方向的增益'),
  P('LuDb', '上行自由空间损耗', 'dB', 'path', '本网发端地球站 → 邻星的上行自由空间损耗')
]
const PARAMS2 = [
  P('PsDb', '本星最大发射功率密度', 'dB(W/Hz)', 'own', '本星发射天线输入端的最大功率密度（15 GHz 以下取最坏 4 kHz、以上取最坏 1 MHz 平均）'),
  P('G3Dbi', '本星朝邻网收端站的增益', 'dBi', 'own', '本星发射天线朝邻网收端地球站方向的增益'),
  P('G4Dbi', '邻网收端站朝本星的增益', 'dBi', 'other', '邻网收端地球站天线朝本星方向的增益'),
  P('LdDb', '下行自由空间损耗', 'dB', 'path', '本星 → 邻网收端地球站的下行自由空间损耗')
]
const PARAMS3 = [P('gammaDb', '邻网卫星链路传输增益', 'dB', 'other', '邻网卫星链路的传输增益：邻星接收天线输出端 → 邻网收端地球站接收天线输出端')]
const PARAMS4 = [P('TK', '邻网卫星链路等效噪温', 'K', 'other', '邻网卫星链路的等效噪温，折算到邻网收端地球站接收天线输出端')]
const K_SYM = math(SYM.k)

const ok = computed(() => !!(props.r && props.r.ok))
const fx = (v, d) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(d))
// dB 代入式里的一项：按输入原样写数，符号单列（− 用真减号）
const num = (v) => { const n = Number(v); return v === '' || v == null || !Number.isFinite(n) ? null : n }
const term = (v, neg, first) => {
  const n = num(v)
  if (n == null) return (first ? '' : ' + ') + '?'
  const s = neg ? -n : n
  const a = String(Math.abs(s))
  return first ? (s < 0 ? '−' + a : a) : (s < 0 ? ' − ' : ' + ') + a
}
const kDb = computed(() => (props.r && Number.isFinite(props.r.kDb) ? props.r.kDb : 228.6))
const sub1 = computed(() => term(props.p.PeDb, false, true) + term(props.p.G1Dbi) + term(props.p.G2Dbi) + term(props.p.LuDb, true) + term(kDb.value))
const sub2 = computed(() => term(props.p.PsDb, false, true) + term(props.p.G3Dbi) + term(props.p.G4Dbi) + term(props.p.LdDb, true) + term(kDb.value))
// 式(3) 代入行：γ 先由 dB 换成数值比（10^(γ/10)），两步都写出来，与 γ 格里的 dB 值对得上
const gTxt = computed(() => term(props.p.gammaDb, false, true))
</script>

<template>
  <div class="af">
    <!-- (1) 上行：本网发端站旁瓣 → 邻星 -->
    <div class="af-blk">
      <div class="af-eq"><span class="af-no">(1)</span><span class="af-m" v-html="EQ1"></span>
        <span class="af-v" title="邻星接收系统噪温增量（本网上行旁瓣造成）">= <b class="mono">{{ ok ? fx(r.deltaTsK, 2) : '—' }}</b> K</span></div>
      <div class="af-ps">
        <label v-for="x in PARAMS1" :key="x.key" class="af-p" :class="x.side" :title="x.tip">
          <span class="af-sym" v-html="x.sym"></span>
          <span class="af-name">{{ x.name }}</span>
          <input v-model.number="p[x.key]" class="ci af-in" type="number" step="0.1" />
          <i class="af-u">{{ x.unit }}</i>
        </label>
        <span class="af-p const" title="玻尔兹曼常数 k = 1.38×10⁻²³ J/K"><span class="af-sym" v-html="K_SYM"></span><span class="af-name">玻尔兹曼常数</span><span class="af-k mono">−{{ kDb }}</span><i class="af-u">dB(J/K)</i></span>
      </div>
      <div class="af-sub mono">= {{ sub1 }} = {{ ok ? fx(r.deltaTsDbK, 2) : '—' }} dBK = {{ ok ? fx(r.deltaTsK, 2) : '—' }} K</div>
    </div>

    <!-- (2) 下行：本星 → 邻网收端站旁瓣 -->
    <div class="af-blk">
      <div class="af-eq"><span class="af-no">(2)</span><span class="af-m" v-html="EQ2"></span>
        <span class="af-v" title="邻网收端站接收系统噪温增量（本星下行造成）">= <b class="mono">{{ ok ? fx(r.deltaTeK, 2) : '—' }}</b> K</span></div>
      <div class="af-ps">
        <label v-for="x in PARAMS2" :key="x.key" class="af-p" :class="x.side" :title="x.tip">
          <span class="af-sym" v-html="x.sym"></span>
          <span class="af-name">{{ x.name }}</span>
          <input v-model.number="p[x.key]" class="ci af-in" type="number" step="0.1" />
          <i class="af-u">{{ x.unit }}</i>
        </label>
      </div>
      <div class="af-sub mono">= {{ sub2 }} = {{ ok ? fx(r.deltaTeDbK, 2) : '—' }} dBK = {{ ok ? fx(r.deltaTeK, 2) : '—' }} K</div>
    </div>

    <!-- (3) 合成：折算到邻网收端站 -->
    <div class="af-blk">
      <div class="af-eq"><span class="af-no">(3)</span><span class="af-m" v-html="EQ3"></span>
        <span class="af-v" title="邻网卫星链路等效噪温增量，折算到邻网收端站">= <b class="mono">{{ ok ? fx(r.deltaTK, 2) : '—' }}</b> K</span></div>
      <div class="af-ps">
        <label v-for="x in PARAMS3" :key="x.key" class="af-p" :class="x.side" :title="x.tip">
          <span class="af-sym" v-html="x.sym"></span>
          <span class="af-name">{{ x.name }}</span>
          <input v-model.number="p[x.key]" class="ci af-in" type="number" step="0.1" />
          <i class="af-u">{{ x.unit }}</i>
        </label>
      </div>
      <div class="af-sub mono">= 10^({{ gTxt }}/10) × {{ ok ? fx(r.deltaTsK, 2) : '—' }} + {{ ok ? fx(r.deltaTeK, 2) : '—' }} = {{ ok ? fx(r.gammaLin, 4) : '—' }} × {{ ok ? fx(r.deltaTsK, 2) : '—' }} + {{ ok ? fx(r.deltaTeK, 2) : '—' }} = {{ ok ? fx(r.deltaTK, 2) : '—' }} K</div>
    </div>

    <!-- 结果：ΔT/T 对 6% -->
    <div class="af-blk res">
      <div class="af-eq"><span class="af-no"></span><span class="af-m" v-html="EQ4"></span>
        <span class="af-v">= <b class="mono af-big" :class="{ bad: ok && r.exceeds }">{{ ok ? fx(r.pct, 2) : '—' }}</b> %
          <span class="af-thr mono" title="附录 8 §3：ΔT/T 门限">门限 {{ (r && r.thresholdPct) || 6 }} %</span></span></div>
      <div class="af-ps">
        <label v-for="x in PARAMS4" :key="x.key" class="af-p" :class="x.side" :title="x.tip">
          <span class="af-sym" v-html="x.sym"></span>
          <span class="af-name">{{ x.name }}</span>
          <input v-model.number="p[x.key]" class="ci af-in" type="number" step="1" />
          <i class="af-u">{{ x.unit }}</i>
        </label>
      </div>
      <div class="af-sub mono">= {{ ok ? fx(r.deltaTK, 2) : '—' }} / {{ p.TK === '' || p.TK == null ? '?' : p.TK }} = {{ ok ? fx(r.pct, 2) : '—' }} %</div>
    </div>
  </div>
</template>

<style scoped>
.af { display: flex; flex-direction: column; gap: 4px; }
.af-blk { padding: 10px 0 12px; border-bottom: 1px solid var(--lb-rule-soft, var(--border)); }
.af-blk.res { border-bottom: 0; }
.af-eq { display: flex; align-items: center; gap: 14px; min-height: 44px; }
.af-no { width: 26px; flex: none; font-size: var(--fs-3); color: var(--text-faint); font-variant-numeric: tabular-nums; }
/* 公式：衬线斜体（MathML 原生排版），字号比正文大一档 */
.af-m { font-size: 19px; color: var(--text); }
.af-m :deep(math) { font-family: 'Cambria Math', 'STIX Two Math', 'Latin Modern Math', 'Times New Roman', serif; margin: 0; }
.af-v { margin-left: auto; font-size: var(--fs-4); color: var(--text-muted); white-space: nowrap; }
.af-v b { font-size: var(--fs-5); color: var(--text); font-weight: 700; }
.af-v b.af-big { font-size: 26px; color: var(--accent); }
.af-v b.af-big.bad { color: var(--danger); }
.af-thr { margin-left: 12px; font-size: var(--fs-3); color: var(--text-faint); }

.af-ps { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 6px 10px; margin: 4px 0 0 40px; }
.af-p { display: flex; align-items: center; gap: 8px; padding: 3px 8px 3px 7px; border: 1px solid var(--border); border-left-width: 3px; border-radius: var(--r-ctl, 2px); background: var(--bg); }
/* 中文名：占满符号与数值之间的余宽，英文长名折行 */
.af-name { flex: 1; min-width: 0; font-size: var(--fs-3); color: var(--text); line-height: 1.25; }
.af-p.own { border-left-color: var(--plot-s0, var(--accent)); }
.af-p.other { border-left-color: var(--plot-s1, var(--warn)); }
.af-p.path { border-left-color: var(--text-faint); }
.af-p.const { border-left-color: var(--border-strong); background: transparent; }
.af-sym { min-width: 64px; font-size: 16px; }
.af-sym :deep(math) { font-family: 'Cambria Math', 'STIX Two Math', 'Latin Modern Math', 'Times New Roman', serif; }
.af-in { flex: none; width: 96px; text-align: right; font-family: var(--font-mono); }
.af-k { flex: none; width: 96px; text-align: right; font-size: var(--fs-3); color: var(--text-muted); }
.af-u { min-width: 58px; font-size: var(--fs-2); font-style: normal; color: var(--text-faint); white-space: nowrap; }

/* dB 代入式：逐项对账的读数行，可框选复制 */
.af-sub { margin: 6px 0 0 40px; font-size: var(--fs-3); color: var(--text-muted); user-select: text; -webkit-user-select: text; }
.mono { font-family: var(--font-mono); }
.af-v b, .af-sub { user-select: text; -webkit-user-select: text; }
</style>
