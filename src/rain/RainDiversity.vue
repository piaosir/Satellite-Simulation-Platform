<script setup>
// 多站总可用度 —— 雨衰页第三栏的「多站汇总」视图。
// 数学在 packages/core/utils/rainDiversity.js；本组件只负责铺数。
//
// 口径（同步自引擎，改这里之前先读那份文件头）：
//   · 系统不可用 = P(中断站数 ≥ L)，L = 参与站数 − 最少可用站数 + 1（Poisson–binomial，绝不连乘）
//   · 各站可用度：表内直接给，或由「可承受衰减」（用户自己的链路预算结论）经 A(p) 反解
//   · 各站中断按相互独立计（纯概率论口径，2026-08-10 重做时相关档已整体移除）
//   · 切换不进概率模型，只作为独立可加项 U_sw = N_sw × T_sw，与站点中断项相加成合计
import { computed } from 'vue'

// 纯结果视图：算什么、怎么算全在中间栏底部那条（与单算例共用一个「计算」按钮），本组件只铺数。
const props = defineProps({
  result: { type: Object, default: null }    // core.solveMultiSite 的返回
})

// 可承受衰减对标哪一项（与底栏下拉同一套措辞）。
// ★ dnd 不含气体吸收：气体晴空时就在、已计入晴空基线，不构成「劣化」，故它不是 totalAtten 的超集。
const TARGET_LABEL = {
  rainAtten: '单独雨衰',
  totalAtten: '气体吸收 + 云衰 + 雨衰',
  dnd: '雨衰 + 云衰 + 噪声抬升'
}

// —— 数字格式（结果区纯数字，不出文字判定）——
const HOURS = 8766
function pct(v, d = 4) {
  if (v == null || !Number.isFinite(v)) return '—'
  if (v === 0) return '0'
  const p = v * 100
  return (p >= 1e-4 || p === 0) ? p.toFixed(d) : p.toExponential(3)
}
function hrs(v) {
  if (v == null || !Number.isFinite(v)) return '—'
  const h = v * HOURS
  return h >= 1 ? h.toFixed(2) : (h * 60).toFixed(2)
}
function hUnit(v) { return (v != null && Number.isFinite(v) && v * HOURS < 1) ? 'min/年' : 'h/年' }
const fx = (v, d) => (v == null || !Number.isFinite(v)) ? '—' : v.toFixed(d)

// 分数 → 年时长读数（h / min / s 自适应）。极小概率用「一年断多久」比科学计数法直观得多
function yearly(v) {
  if (v == null || !Number.isFinite(v) || v <= 0) return '0'
  const h = v * HOURS
  if (h >= 1) return h.toFixed(2) + ' h/年'
  const m = h * 60
  if (m >= 1) return m.toFixed(2) + ' min/年'
  return (m * 60).toFixed(2) + ' s/年'
}

// 中断站数分布的百分比：定点小数（不用科学计数法），3 位有效数字。
// 小数位按量级算出来，封顶 8 位 —— 再往下（<1e-8 %，合 0.003 s/年）在纯降雨模型里已无物理意义，直接显示 0。
function pmfPct(v) {
  if (v == null || !Number.isFinite(v) || v <= 0) return '0'
  const p = v * 100
  if (p >= 100) return '100'
  const d = Math.min(8, Math.max(0, 2 - Math.floor(Math.log10(p))))
  const s = p.toFixed(d)
  return parseFloat(s) === 0 ? '0' : s
}
// 格内只放百分比，精确值与「一年断多久」进 title（不占版面）
function pmfTitle(v, j) {
  if (v == null || !Number.isFinite(v)) return ''
  return `恰好 ${j} 个站同时中断：${(v * 100).toExponential(3)} % · ${yearly(v)}`
}

const R = computed(() => props.result)
const sites = computed(() => (R.value && R.value.sites) || [])
const sys = computed(() => R.value && R.value.system)
// 系统表的级联行：P(S≥L) 的逐项分解（与链路预算级联同口径：逐行可手算，Σ 即「站点中断」）。
// ★ 逐行相加必须在显示精度上严格等于 Σ：低于显示分辨率（相对 1e-4，pct 显示 4 位有效数字）
//   的尾项不逐行占位，而是并成一条「其余 j ≥ x」，差额显式入表，账才能闭合。最多列 6 项。
const tailRows = computed(() => {
  const s = sys.value
  if (!s || !Array.isArray(s.pmf) || !(s.unavail > 0)) return []
  const total = s.unavail
  const rows = []
  let shown = 0
  for (let j = Math.max(0, s.L); j < s.pmf.length; j++) {
    const v = s.pmf[j]
    if (!(v >= total * 1e-4) || rows.length >= 6) break
    rows.push({ j, v }); shown += v
  }
  const rest = total - shown
  if (rest >= total * 1e-4) {
    rows.push({ j: null, jFrom: rows.length ? rows[rows.length - 1].j + 1 : Math.max(0, s.L), v: rest })
  }
  return rows
})
// 输入方式：'avail' 直接给站可用度（不出「可承受」列）
const byAvail = computed(() => R.value && R.value.inputMode === 'avail')
// 切换：独立可加项，直接并进年度总账（静态概率模型没有时间轴，只能这样加）
const sw = computed(() => (R.value && R.value.switch) || null)

// 逐站行：反解状态决定着色，越界只标色 + title，不禁用（与 NGSO §8 clamped 同口径）
function siteCls(s) {
  if (!s.solve || s.solve.state === 'err') return 'bad'
  if (s.solve.state === 'below' || s.solve.state === 'above' || s.solve.state === 'flat') return 'clamped'
  return null
}
function siteTitle(s) {
  if (!s.solve) return s.warn && s.warn.includes('noBudget') ? '未填可承受衰减' : (s.warn && s.warn.includes('noAvail') ? '未填可用度' : '')
  const q = s.solve, t = []
  if (q.state === 'below') t.push('目标衰减低于 A(5%)，已钳到 5% 端点（ITU-R P.618-14 式(8) 定义域 0.001%~5%）')
  if (q.state === 'above') t.push('目标衰减高于 A(0.001%)，已钳到 0.001% 端点')
  if (q.state === 'flat') t.push('该站 A(p) 在定义域上几乎不随 p 变，无从反解')
  if (q.rootCount > 1) t.push('§8 等效仰角随 p 变，检出 ' + q.rootCount + ' 个根，取最大 p 的那个（保守）')
  if (Number.isFinite(q.errDb)) t.push('求根残差 ' + q.errDb.toExponential(2) + ' dB')
  if (s.warn && s.warn.length) t.push('warn: ' + s.warn.join(', '))
  return t.join('；')
}
</script>

<template>
  <div class="rv">
    <div class="rv-bd">
      <template v-if="!result">
        <div class="rv-ph">尚无多站结果。</div>
      </template>
      <template v-else-if="result.error">
        <div class="rv-err">✕ {{ result.message }}</div>
      </template>
      <template v-else-if="!result.activeCount">
        <div class="rv-ph">参与站少于 1 个。</div>
      </template>
      <template v-else>
        <!-- 逐站 -->
        <div class="rv-sec">
          <div class="rv-hd">逐站<span class="rv-sub">{{ result.activeCount }} 站<template v-if="!byAvail"> · 可承受衰减对标 {{ TARGET_LABEL[result.target] || result.target }}</template></span></div>
          <table class="rv-tb">
            <thead>
              <tr>
                <th class="l">站</th>
                <th v-if="!byAvail" :title="TARGET_LABEL[result.target] ? ('当前对标：' + TARGET_LABEL[result.target]) : ''">可承受<br />dB</th>
                <th :title="byAvail ? '表内填入的站可用度' : '由可承受衰减反解'">可用度<br />%</th>
                <th>年停时<br />h</th>
                <th title="该站在自己这个可用度上的纯雨衰">雨衰<br />dB</th>
                <th title="气体吸收 + 云衰 + 雨衰">合计<br />dB</th>
                <th title="雨衰 + 云衰 + 降雨噪声抬升；相对晴空基线，不含气体（仅下行）">下行总劣化<br />dB</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in sites" :key="s.idx" :class="siteCls(s)" :title="siteTitle(s)">
                <td class="l" data-i18n-skip>{{ s.name }}</td>
                <td v-if="!byAvail">{{ fx(s.attenBudgetDb, 2) }}</td>
                <td>{{ s.solve && s.solve.state !== 'err' ? s.solve.availability.toFixed(5) : '—' }}</td>
                <td>{{ s.solve && s.solve.state !== 'err' ? s.solve.downtimeYear.toFixed(3) : '—' }}</td>
                <td>{{ fx(s.atten && s.atten.rain, 2) }}</td>
                <td>{{ fx(s.atten && s.atten.total, 2) }}</td>
                <td>{{ fx(s.atten && s.atten.dnd, 2) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 系统（级联：P(S≥L) 逐项 → Σ → 切换 → 合计，逐行可手算） -->
        <div class="rv-sec">
          <div class="rv-hd">系统<span v-if="sys" class="rv-sub" title="参与站数 : 最少可用站数">{{ sys.M }}:{{ sys.nMin }}</span></div>
          <table class="rv-tb">
            <thead><tr><th class="l"></th><th class="l">算式</th><th>不可用度 %</th><th>可用度 %</th><th>年停时</th></tr></thead>
            <tbody>
              <tr v-for="r in tailRows" :key="r.j == null ? 'rest' : r.j" class="dimrow"
                :title="r.j == null ? ('j ≥ ' + r.jFrom + ' 各项之和：' + (r.v * 100).toExponential(3) + ' % · ' + yearly(r.v)) : pmfTitle(r.v, r.j)">
                <td class="l">{{ r.j == null ? ('其余 j ≥ ' + r.jFrom) : ('恰好中断 ' + r.j + ' 站') }}</td>
                <td class="l f">{{ r.j == null ? ('ΣP(S≥' + r.jFrom + ')') : ('P(S=' + r.j + ')') }}</td>
                <td>{{ pct(r.v, 6) }}</td>
                <td>{{ (100 - r.v * 100).toFixed(6) }}</td>
                <td>{{ yearly(r.v) }}</td>
              </tr>
              <tr title="P(同时中断的站数 ≥ L)，L = 参与站数 − 最少可用站数 + 1；各站中断按相互独立计（Poisson–binomial 尾概率），逐项见上行与分布表">
                <td class="l">站点中断</td>
                <td class="l f">{{ sys ? 'P(S≥' + sys.L + ') = Σ' : '' }}</td>
                <td>{{ sys ? pct(sys.unavail, 6) : '—' }}</td>
                <td>{{ sys ? (100 - sys.unavail * 100).toFixed(6) : '—' }}</td>
                <td>{{ sys ? hrs(sys.unavail) + ' ' + hUnit(sys.unavail) : '—' }}</td>
              </tr>
              <tr v-if="sw && sw.unavail != null" title="切换造成的年不可用度 = 次数 × 单次时长 ÷ 全年分钟数。静态概率模型没有时间轴，切换只能这样作为独立可加项进来">
                <td class="l">切换</td>
                <td class="l f">{{ fx(sw.nSwPerYear, 0) }} × {{ fx(sw.tSwMin, 0) }} min ÷ 525960</td>
                <td>{{ pct(sw.unavail, 6) }}</td>
                <td>{{ (100 - sw.unavail * 100).toFixed(6) }}</td>
                <td>{{ hrs(sw.unavail) + ' ' + hUnit(sw.unavail) }}</td>
              </tr>
              <tr v-if="sw && sw.total != null" class="em" title="站点中断 + 切换。已知偏保守：系统已中断的时段里也在计切换，这部分被算了两遍">
                <td class="l">合计</td>
                <td class="l f">站点中断 + 切换</td>
                <td>{{ pct(sw.total, 6) }}</td>
                <td>{{ (100 - sw.total * 100).toFixed(6) }}</td>
                <td>{{ hrs(sw.total) + ' ' + hUnit(sw.total) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 中断站数分布 -->
        <div v-if="sys" class="rv-sec">
          <div class="rv-hd">中断站数分布<span class="rv-sub">同时中断 j 个站的时间占比 %</span></div>
          <div class="rv-scroll">
            <table class="rv-tb">
              <thead><tr><th class="l">j</th><th v-for="(v, j) in sys.pmf" :key="j" :class="{ tail: j >= sys.L }">{{ j }}</th></tr></thead>
              <tbody>
                <tr><td class="l">占比</td><td v-for="(v, j) in sys.pmf" :key="j" :class="{ tail: j >= sys.L }" :title="pmfTitle(v, j) + (j >= sys.L ? ' · 计入系统不可用度（j ≥ L）' : '')">{{ pmfPct(v) }}</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- 切换 -->
        <div v-if="sw" class="rv-sec">
          <div class="rv-hd">切换<span class="rv-sub">U_sw = 次数 × 时间 ÷ 525960 min</span></div>
          <table class="rv-tb">
            <tbody>
              <tr title="单次切换的业务中断时长"><td class="l">切换时间</td><td class="v">{{ fx(sw.tSwMin, 2) }}</td><td class="u">min</td></tr>
              <tr title="一年切换多少次"><td class="l">切换次数</td><td class="v">{{ fx(sw.nSwPerYear, 0) }}</td><td class="u">次/年</td></tr>
              <tr title="切换造成的年不可用度。它进不了联合概率模型（静态模型没有时间轴），只能作独立可加项与站点中断项相加"><td class="l">切换不可用度</td><td class="v">{{ sw.unavail == null ? '—' : pct(sw.unavail, 6) }}</td><td class="u">%</td></tr>
              <tr title="切换造成的年中断时长"><td class="l">切换年停时</td><td class="v">{{ sw.unavail == null ? '—' : hrs(sw.unavail) }}</td><td class="u">{{ sw.unavail == null ? '' : hUnit(sw.unavail) }}</td></tr>
            </tbody>
          </table>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.rv { display: flex; flex-direction: column; min-height: 0; height: 100%; }

.rv-bd { flex: 1 1 auto; overflow: auto; padding: 8px; }
.rv-ph, .rv-err { padding: 14px 4px; font-size: 12px; color: var(--text-muted); }
.rv-err { color: var(--danger, #9c5751); }

.rv-sec + .rv-sec { margin-top: 14px; }
.rv-hd { display: flex; align-items: center; gap: 8px; padding: 0 0 4px; font-size: 11px; letter-spacing: var(--ls-label); text-transform: uppercase; color: var(--text-muted); font-weight: 600; }
.rv-sub { font-weight: 400; letter-spacing: 0; text-transform: none; }
.rv-scroll { overflow-x: auto; }

/* 三线表（booktabs 口径：只有顶线/表头线/底线，无竖线无填充） */
.rv-tb { border-collapse: collapse; width: 100%; font-size: 12px; }
.rv-tb thead th { font-weight: 600; color: var(--text-muted); text-align: right; padding: 3px 8px; white-space: nowrap;
  border-top: 1.4px solid var(--text); border-bottom: .8px solid var(--border); font-size: 11px; line-height: 1.25; }
.rv-tb tbody td { font-family: var(--font-mono); text-align: right; padding: 3px 8px; white-space: nowrap; }
.rv-tb tbody tr:last-child td { border-bottom: 1.4px solid var(--text); }
.rv-tb .l { text-align: left; font-family: var(--font-sans, inherit); }
.rv-tb .u { text-align: left; color: var(--text-muted); font-size: 11px; }
.rv-tb tbody tr.bad td { color: var(--danger, #9c5751); }
.rv-tb tbody tr.clamped td { color: var(--warn, #8a7038); }
.rv-tb tbody tr.dimrow td { color: var(--text-muted); }
.rv-tb tbody tr.em td { background: color-mix(in srgb, var(--accent) 6%, transparent); font-weight: 600; }
/* 级联算式列：手算路径，弱化不抢数值 */
.rv-tb td.f { color: var(--text-muted); font-size: 11px; }
/* 分布表中计入系统尾和（j ≥ L）的格：与「合计」行同一层强调色，两表对得上 */
.rv-tb th.tail, .rv-tb td.tail { background: color-mix(in srgb, var(--accent) 6%, transparent); }
</style>
