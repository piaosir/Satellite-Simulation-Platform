<script setup>
// 干扰分析（C/I）主壳。方案见 docs/干扰分析模块调研.md。
//
// 布局：顶部功能条 + 单栏文档流。四种模式做页签而非并列铺开——同屏一个上下文，
// 别把四张不相干的表堆在一页。
//
// 曾有一条常驻左侧栏放「本站 / 本链路」，当作四种模式的公共上下文——已删。四种模式吃进去的
// 根本不是同一套：C/CCI 一个字段都不用（取值点自带经纬）、C/XPI 只用站址、NGSO 不吃期望星
// 轨位与发信链。常驻侧栏等于请人填一堆对当前页毫无作用的格子，还让人以为结果受它影响。
// 现在每页只摆本页真吃的量：C/ASI 与 NGSO 页首各一条「本站与本链路」输入带（逐项按模式开合），
// C/XPI 的站址就坐在「在本站取值」按钮旁边，C/CCI 什么都不需要。
//
// 本窗口是只读计算器：读三库与 GRD、不写回。算出的 C/I 要用到链路预算里由使用者自己搬。
import { computed, onMounted } from 'vue'
import ActivationLock from '../components/ActivationLock.vue'
import { useInterference } from './useInterference.js'
import CiGeoPanel from './CiGeoPanel.vue'
import LbSurfacePlot from '../components/LbSurfacePlot.vue'
import CiCdfPlot from './CiCdfPlot.vue'
import CiSeriesPlot from './CiSeriesPlot.vue'

const I = useInterference()
const {
  MODES, REUSE_COLORS, mode, busy, msg, site, carrier, asi, xpi, cci, ngso,
  satLib, grdAntennas, currentAntenna, ngsoGrdBeams, geoData, hoveredId, satSearch, ngsoGroups, groupStats, groupsErr
} = I

onMounted(() => { I.load(); I.loadLibraries(); I.loadGrdTree(); I.loadNgsoGroups() })

// C/XPI 各段的来源标签（source 由引擎 ciXpi.resolveXpd 给出，算式在 term.note 里，挂 title）
const XPI_SRC = {
  grd: 'GRD 实测', p618: 'P.618-14 §4.1', manual: '手填',
  axialRatio: '轴比换算', levels: '共/交实测', align: '对准误差'
}

const f = (v, n = 2) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(n))
// 页首输入带的一行摘要：站名在这里才有落点（它不进任何算式，是给人认站用的）
const siteSummary = computed(() =>
  `${site.name || '本站'} · ${f(site.lon, 4)}°E ${f(site.lat, 4)}°N · 收 Ø${f(site.rxDiameterM, 1)} m @ ${f(site.rxFreqGHz, 2)} GHz`)
const fPct = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v) >= 1 ? Number(v).toFixed(2) + '%' : Number(v).toFixed(3) + '%')
// 结果逐源明细里跟在干扰星名后的轨位标记：值就是「干扰星」表那一列（带符号 °E，西经为负），
// 最多两位小数并去掉尾零 —— 星名认人、轨位认星，两者挨着才看得出「哪颗星、离本星多远」。
const fSlot = (v) => (v == null || !Number.isFinite(Number(v)) ? '' : `${Math.round(Number(v) * 100) / 100}°E`)
const fDur = (s) => (s == null ? '—' : s < 60 ? s.toFixed(2) + ' s' : (s / 60).toFixed(2) + ' min')
const fTime = (ms) => { try { return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z' } catch (e) { return '—' } }

// ─── NGSO 分位数的样本支撑度（引擎的 percentileSupport）─────────────────────────
// 「样本不足」必须显示成「样本不足」，不能显示成一个看着完全正常的数字：
// 6 h / 10 s = 2161 个样本时，C/I(0.001%) 那一档对应 0.022 个样本——它就是最小值，
// 只是贴了个百分比标签，与 worst 差 0.003 dB。
const ngSup = (p) => {
  const r = ngso.result
  return (r && r.percentileSupport && r.percentileSupport[p]) || null
}
const ngSupTip = (p) => {
  const s = ngSup(p)
  if (!s) return ''
  if (!s.enough) return `样本不足：该档需 ≥ ${s.needSamples.toLocaleString()} 个样本，当前 ${(ngso.result.samples || 0).toLocaleString()} 个，有效样本 ${s.nEff.toExponential(2)} 个。延长时窗或减小步长后重算`
  if (s.weak) return `有效样本 ${s.nEff.toFixed(2)} 个，尾部估计不稳定`
  return `有效样本 ${s.nEff.toFixed(1)} 个`
}
// 一年折合分钟数：p% 的时间 = 一年里多少分钟
const fYearMin = (p) => (Number(p) / 100 * 525600)
// 多历元的 bootstrap 95% 区间（只有多历元才有：单历元长跑的样本时间上高度相关，
// 对它做 bootstrap 会把区间报得比真实窄得多）
const ngCi = (p) => {
  const e = ngso.result && ngso.result.epochStats
  return (e && e.ciP && e.ciP[p]) || null
}
// 区间按【历元整块】重采样得出（逐样本 i.i.d. 会把区间窄一个数量级）。块数不足时区间宽度
// 主要反映块组合的种数而非真实不确定度，此时必须让用户改看逐历元的原始估值散布。
const ngCiLowRes = computed(() => {
  const e = ngso.result && ngso.result.epochStats
  if (!e || !e.ciP) return false
  return Object.values(e.ciP).some((c) => c && c.lowResolution)
})
const ngPerEpoch = computed(() => {
  const e = ngso.result && ngso.result.epochStats
  return ((e && e.perEpoch) || []).filter((v) => v != null && Number.isFinite(v)).map((v) => v.toFixed(2))
})

// 模板里的 @click 只能写表达式，写不了 if 语句——这类分支一律落到这里
function toggleSearch() {
  satSearch.open = !satSearch.open
  if (satSearch.open && !satSearch.hits.length) I.searchNeighbors()
}

// 星座下拉按来源分段（口径见 useInterference 的 loadNgsoGroups）：自己建的东西排在前面，
// 编目星座十几个排最后——找自己的东西不该先滚过一整屏 CelesTrak 组名。
//
// ⚠️ 空的段**不删掉**，改成一条灰的说明项。曾经是「items 为空就 filter 掉」，于是一个字都不留：
// 用户在星座页建了自定义星座、回到这里发现下拉里根本没有「自定义」这一段，只能得出「选不了」，
// 却看不出该去哪儿建、也看不出是没建还是坏了。四段永远在，缺什么一目了然。
const SECTIONS = [
  { kind: 'satgroup', label: '卫星组', empty: '无 —— 在「星座」页按搜索结果 / 多选存组' },
  { kind: 'ccustom', label: '自定义星座', empty: '无 —— 在「星座」页用 Walker 生成器建' },
  { kind: 'custom', label: '自定义星历', empty: '无 —— 在「文件管理」导入 OMM / TLE' },
  { kind: 'omm', label: '编目星座', empty: '无 —— 需联网取一次 CelesTrak 分组' }
]
const groupSections = computed(() =>
  SECTIONS.map((s) => ({ ...s, items: ngsoGroups.value.filter((g) => (g.kind || 'omm') === s.kind) })))

const run = () => {
  if (mode.value === 'asi') I.computeAsi()
  else if (mode.value === 'xpi') I.computeXpi()
  else if (mode.value === 'cci') I.computeCci()
  else I.computeNgso()
}
</script>

<template>
  <div class="ci-root">
    <ActivationLock />
    <!-- ── 功能条 ── -->
    <header class="ci-bar">
      <h1 class="ci-title">干扰分析</h1>
      <nav class="ci-tabs">
        <button
          v-for="m in MODES" :key="m.key"
          class="ci-tab" :class="{ on: mode === m.key }" :title="m.tip"
          @click="mode = m.key">{{ m.label }}</button>
      </nav>
      <div class="ci-bar-sp" />
      <button class="ci-run" :disabled="busy" @click="run">{{ busy ? '计算中…' : '计算' }}</button>
      <button v-if="busy && mode === 'ngso'" class="ci-btn" @click="I.cancelNgso()">取消</button>
    </header>
    <p v-if="msg" class="ci-msg">{{ msg }}</p>

    <main class="ci-main">
      <!-- ── 本站与本链路 ──
           只在真吃这些量的两页出现，且逐项按模式开合（见文件头：为什么不再做常驻侧栏）。
           C/XPI 只用站址，那两格坐在它自己的取值按钮旁；C/CCI 一格都不需要。 -->
      <section v-if="mode === 'asi' || mode === 'ngso'" class="ci-panel">
        <div class="ci-panel-hd">
          <h2>本站与本链路</h2>
          <span class="ci-hd-sum">{{ siteSummary }}</span>
        </div>
        <div class="ci-band">
          <div class="ci-bcol">
            <h3>本站</h3>
            <label class="ci-bf"><span>站名</span><input v-model="site.name" class="txt" type="text" /></label>
            <label class="ci-bf"><span>经度 °E</span><input v-model.number="site.lon" type="number" step="0.0001" /></label>
            <label class="ci-bf"><span>纬度 °N</span><input v-model.number="site.lat" type="number" step="0.0001" /></label>
            <label class="ci-bf"><span>海拔 m</span><input v-model.number="site.alt" type="number" /></label>
          </div>

          <div class="ci-bcol">
            <h3>收信链（下行）</h3>
            <label class="ci-bf"><span>口径 m</span><input v-model.number="site.rxDiameterM" type="number" step="0.1" /></label>
            <label class="ci-bf"><span>效率 %</span><input v-model.number="site.rxEfficiency" type="number" /></label>
            <label class="ci-bf"><span>频率 GHz</span><input v-model.number="site.rxFreqGHz" type="number" step="0.01" /></label>
          </div>

          <div v-if="mode === 'asi'" class="ci-bcol">
            <h3>发信链（上行）</h3>
            <label class="ci-bf"><span>口径 m</span><input v-model.number="site.txDiameterM" type="number" step="0.1" /></label>
            <label class="ci-bf"><span>效率 %</span><input v-model.number="site.txEfficiency" type="number" /></label>
            <label class="ci-bf"><span>频率 GHz</span><input v-model.number="site.txFreqGHz" type="number" step="0.01" /></label>
            <label class="ci-bf"><span>功放 W</span><input v-model.number="site.txPowerW" type="number" /></label>
            <label class="ci-bf"><span>馈损 dB</span><input v-model.number="site.txFeederLossDb" type="number" step="0.1" /></label>
          </div>

          <div class="ci-bcol">
            <h3>本链路载波</h3>
            <label v-if="mode === 'asi'" class="ci-bf"><span>卫星轨位 °E</span><input v-model.number="carrier.satLonDeg" type="number" step="0.1" /></label>
            <label class="ci-bf"><span>EIRP dBW</span><input v-model.number="carrier.eirpDbW" type="number" step="0.1" /></label>
            <label class="ci-bf"><span>占用带宽 Hz</span><input v-model.number="carrier.bandwidthHz" type="number" /></label>
            <label class="ci-bf"><span>下行极化</span>
              <select v-model="carrier.dnPolarization"><option>H</option><option>V</option><option>L</option><option>R</option></select>
            </label>
            <label v-if="mode === 'asi'" class="ci-bf"><span>上行极化</span>
              <select v-model="carrier.upPolarization"><option>H</option><option>V</option><option>L</option><option>R</option></select>
            </label>
          </div>
        </div>
      </section>

      <!-- ============ C/ASI ============ -->
      <template v-if="mode === 'asi'">
        <section class="ci-panel">
          <div class="ci-panel-hd">
            <h2>干扰星</h2>
            <div class="ci-hd-tools">
              <label class="ci-chk"><input v-model="asi.applyPolarization" type="checkbox" />计入极化折减</label>
              <select v-if="satLib.length" class="ci-mini" @change="I.addFromLibrary(satLib[$event.target.value]); $event.target.value = ''">
                <option value="">从卫星库导入…</option>
                <option v-for="(s, i) in satLib" :key="s.ns + s.id" :value="i">{{ s.name }}（{{ s.ns }}）</option>
              </select>
              <button class="ci-btn" :class="{ on: satSearch.open }" @click="toggleSearch">搜索邻星…</button>
              <button class="ci-btn" @click="I.addSource()">+ 干扰星</button>
            </div>
          </div>
          <!-- 邻星搜索：直接用软件里的 GEO 星历，按与本星轨位的经度差排序 -->
          <div v-if="satSearch.open" class="ci-search">
            <div class="ci-search-hd">
              <input v-model="satSearch.q" type="text" placeholder="按星名过滤（留空 = 全部）" @keyup.enter="I.searchNeighbors()" />
              <label>范围 ±<input v-model.number="satSearch.spanDeg" type="number" step="1" style="width:56px" />°</label>
              <button class="ci-btn" :disabled="satSearch.busy" @click="I.searchNeighbors()">{{ satSearch.busy ? '搜索中…' : '搜索' }}</button>
              <span class="ci-search-msg">{{ satSearch.msg }}</span>
            </div>
            <div v-if="satSearch.hits.length" class="ci-search-list">
              <button
                v-for="h in satSearch.hits" :key="h.name"
                class="ci-hit" :title="h.inclined ? `星下点纬度 ${h.latDeg}° —— 有倾角残余，按赤道面近似会有偏差` : ''"
                @click="I.addNeighbor(h)">
                <b>{{ h.name }}</b>
                <span class="lon">{{ h.lonDeg }}°E</span>
                <span class="dl">Δ{{ h.dLon }}°</span>
                <span v-if="h.inclined" class="incl">倾</span>
              </button>
            </div>
          </div>

          <table class="ci-tb">
            <thead>
              <tr>
                <th class="w-chk"></th><th>名称</th><th>轨位 °E</th><th>下行 EIRP 密度 dBW/Hz</th>
                <th>极化</th><th>XPD dB</th><th>重叠</th><th class="w-chk"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in asi.sources" :key="s._id" :class="{ off: !s.enabled }">
                <td><input v-model="s.enabled" type="checkbox" /></td>
                <td><input v-model="s.name" type="text" /></td>
                <td><input v-model="s.lonDeg" type="number" step="0.1" /></td>
                <td><input v-model="s.eirpDensityDbWPerHz" type="number" step="0.1" /></td>
                <td><select v-model="s.polarization"><option value="">—</option><option>H</option><option>V</option><option>L</option><option>R</option></select></td>
                <td><input v-model="s.xpdDb" type="number" step="0.5" placeholder="25" /></td>
                <td><input v-model="s.overlapFactor" type="number" step="0.05" placeholder="1" /></td>
                <td><button class="ci-x" title="删除" @click="I.removeSource(s._id)">×</button></td>
              </tr>
            </tbody>
          </table>

          <div class="ci-sub">
            <h3>上行干扰源模型</h3>
            <div class="ci-radios">
              <label><input v-model="asi.uplinkMode" type="radio" value="peer" />对等站（工程估算）</label>
              <label><input v-model="asi.uplinkMode" type="radio" value="mask" />S.524 掩模（监管上界）</label>
              <label><input v-model="asi.uplinkMode" type="radio" value="explicit" />逐站给定</label>
            </div>
            <!-- 逐站给定：首版漏了这张表，导致该模式每条都因缺值被跳过、算不出数 -->
            <table v-if="asi.uplinkMode === 'explicit'" class="ci-tb compact">
              <thead><tr><th>干扰源</th><th>朝本星方向的离轴 EIRP 密度 dBW/Hz</th></tr></thead>
              <tbody>
                <tr v-for="s in asi.sources.filter((x) => x.enabled)" :key="s._id + 'e'">
                  <td class="ci-ro">{{ s.name || s._id }}</td>
                  <td><input v-model="s.offAxisEirpDensityDbWPerHz" type="number" step="0.1" placeholder="必填，缺则该条被跳过" /></td>
                </tr>
              </tbody>
            </table>
            <table v-if="asi.uplinkMode === 'peer'" class="ci-tb compact">
              <thead><tr><th>干扰站</th><th>口径 m</th><th>功放 W</th><th>带宽 Hz</th><th>馈损 dB</th><th>站经度</th><th>站纬度</th></tr></thead>
              <tbody>
                <tr v-for="s in asi.sources.filter((x) => x.enabled)" :key="s._id + 'p'">
                  <td class="ci-ro">{{ s.name || s._id }}</td>
                  <td><input v-model="s.diameterM" type="number" step="0.1" /></td>
                  <td><input v-model="s.powerW" type="number" /></td>
                  <td><input v-model="s.bandwidthHz" type="number" /></td>
                  <td><input v-model="s.feederLossDb" type="number" step="0.1" /></td>
                  <td><input v-model="s.stationLon" type="number" step="0.01" placeholder="同本站" /></td>
                  <td><input v-model="s.stationLat" type="number" step="0.01" placeholder="同本站" /></td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section v-if="asi.result" class="ci-panel">
          <h2>结果</h2>
          <div class="ci-kpis">
            <div class="ci-kpi"><span>下行 C/ASI</span><b>{{ f(asi.result.downlink && asi.result.downlink.ciDb) }}</b><i>dB</i></div>
            <div class="ci-kpi"><span>上行 C/ASI</span><b>{{ f(asi.result.uplink && asi.result.uplink.ciDb) }}</b><i>dB</i></div>
            <div class="ci-kpi"><span>收信站峰值增益</span><b>{{ f(asi.result.downlink && asi.result.downlink.geometry && asi.result.downlink.geometry.peakGainDbi) }}</b><i>dBi</i></div>
            <div class="ci-kpi"><span>主瓣宽度</span><b>{{ f(asi.result.downlink && asi.result.downlink.geometry && asi.result.downlink.geometry.beamwidth3dBDeg, 3) }}</b><i>°</i></div>
            <div class="ci-kpi"><span>期望星仰角</span><b>{{ f(asi.result.downlink && asi.result.downlink.geometry && asi.result.downlink.geometry.wantedElevDeg, 1) }}</b><i>°</i></div>
          </div>

          <div class="ci-split">
            <div class="ci-split-l">
              <h3>下行逐源明细</h3>
              <table class="ci-tb res">
                <thead><tr><th>干扰星</th><th>拓扑角 °</th><th>经度差 °</th><th>G(θ) dBi</th><th>鉴别度 dB</th><th>极化 dB</th><th>C/I dB</th><th>占比</th></tr></thead>
                <tbody>
                  <tr
                    v-for="s in (asi.result.downlink && asi.result.downlink.sources) || []" :key="s.id"
                    :class="{ hot: hoveredId === s.id, skip: s.skipped }"
                    @mouseenter="I.setHover(s.id)" @mouseleave="I.setHover('')">
                    <td>{{ s.name }}<span v-if="fSlot(s.lonDeg)" class="ci-slot" title="干扰星轨位（°E，西经为负）">{{ fSlot(s.lonDeg) }}</span></td>
                    <td>{{ f(s.thetaDeg) }}</td>
                    <td class="dim">{{ f(s.lonDiffDeg) }}</td>
                    <td>{{ f(s.offAxisGainDbi) }}</td>
                    <td>{{ f(s.discrimDb) }}</td>
                    <td>{{ f(s.polDb, 1) }}</td>
                    <td class="num">{{ s.skipped ? '—' : f(s.ciDb) }}</td>
                    <td class="num">{{ s.skipped ? s.skipped : fPct(s.sharePct) }}</td>
                  </tr>
                </tbody>
              </table>

              <h3>上行逐源明细</h3>
              <table class="ci-tb res">
                <thead><tr><th>干扰源</th><th>干扰站离轴角 °</th><th>干扰密度 dBW/Hz</th><th>来源</th><th>C/I dB</th><th>占比</th></tr></thead>
                <tbody>
                  <tr
                    v-for="s in (asi.result.uplink && asi.result.uplink.sources) || []" :key="s.id + 'u'"
                    :class="{ hot: hoveredId === s.id }"
                    @mouseenter="I.setHover(s.id)" @mouseleave="I.setHover('')">
                    <!-- 轨位标的是这一源所属的那颗干扰星（对等站模式下站址另有「站经度/站纬度」两列，别混） -->
                    <td>{{ s.name }}<span v-if="fSlot(s.lonDeg)" class="ci-slot" title="该源所属干扰星的轨位（°E，西经为负；非干扰站站址经度）">{{ fSlot(s.lonDeg) }}</span></td>
                    <!-- 施扰的是对方那座站：非共址时它看到的夹角与本站的拓扑角不是一个数 -->
                    <td>{{ f(s.offAxisDeg) }}</td>
                    <td>{{ f(s.interfererDensityDbWPerHz) }}</td>
                    <td class="dim">{{ s.maskBand ? 'S.524 ' + s.maskBand : (s.peer ? '对等站 Ø' + f(s.peer.diameterM, 1) + ' m' + (s.peer.coLocated ? '（共址）' : '') : '给定') }}</td>
                    <td class="num">{{ f(s.ciDb) }}</td>
                    <td class="num">{{ fPct(s.sharePct) }}</td>
                  </tr>
                </tbody>
              </table>

              <h3>协调判据 ΔT/T（施扰侧 · RR 附录 8）</h3>
              <div class="ci-grid inline">
                <label>邻星轨位 °E<input v-model.number="asi.coordLonDeg" type="number" step="0.1" /></label>
                <label>邻星 G/T dB/K<input v-model.number="asi.coordGoverT" type="number" step="0.1" /></label>
                <label>邻星接收增益 dBi<input v-model.number="asi.coordRxGain" type="number" step="0.1" /></label>
              </div>
              <table v-if="asi.result.coordination" class="ci-tb res">
                <tbody>
                  <tr><th>拓扑角</th><td class="num">{{ f(asi.result.coordination.thetaDeg) }} °</td></tr>
                  <tr><th>本站旁瓣增益</th><td class="num">{{ f(asi.result.coordination.sidelobeGainDbi) }} dBi</td></tr>
                  <tr><th>旁瓣 EIRP 密度</th><td class="num">{{ f(asi.result.coordination.sidelobeEirpDensityDbWPerHz) }} dBW/Hz</td></tr>
                  <tr><th>ΔT</th><td class="num">{{ f(asi.result.coordination.deltaTK, 3) }} K</td></tr>
                  <tr><th>邻网 T</th><td class="num">{{ f(asi.result.coordination.victimTk, 1) }} K</td></tr>
                  <tr class="strong"><th>ΔT/T</th><td class="num" :class="{ 'st-bad': asi.result.coordination.exceeds6pct }">{{ f(asi.result.coordination.deltaTOverTPct, 3) }} %<span class="dim"> （门限 6%）</span></td></tr>
                </tbody>
              </table>
            </div>

            <div class="ci-split-r">
              <h3>干扰几何</h3>
              <CiGeoPanel :down="geoData.down" :up="geoData.up" :hovered-id="hoveredId" @hover="I.setHover" />
            </div>
          </div>
        </section>
      </template>

      <!-- ============ C/CCI ============ -->
      <template v-else-if="mode === 'cci'">
        <section class="ci-panel">
          <div class="ci-panel-hd">
            <h2>方向图与复用方案</h2>
            <div class="ci-hd-tools">
              <button class="ci-btn" @click="I.importGrdHere()">导入 GRD…</button>
              <button class="ci-btn" @click="I.loadGrdTree()">刷新列表</button>
            </div>
          </div>
          <div class="ci-grid">
            <label class="wide">方向图
              <select v-model="cci.antennaKey">
                <option value="">— 选一副天线 —</option>
                <option v-for="a in grdAntennas" :key="a.key" :value="a.key">{{ a.label }} · {{ a.origin }}</option>
              </select>
            </label>
            <label>复用色数
              <select v-model.number="cci.colors">
                <option v-for="c in REUSE_COLORS" :key="c" :value="c">{{ c }} 色</option>
              </select>
            </label>
            <label>忽略门限 dB<input v-model.number="cci.floorDb" type="number" /></label>
          </div>
          <p v-if="!grdAntennas.length" class="ci-note">暂无可用方向图。</p>

          <div class="ci-panel-hd">
            <h3>取值点</h3>
            <button class="ci-btn" @click="I.addCciPoint()">+ 取值点</button>
          </div>
          <table class="ci-tb compact pts">
            <thead><tr><th>名称</th><th>经度 °E</th><th>纬度 °N</th><th class="w-chk"></th></tr></thead>
            <tbody>
              <tr v-for="p in cci.points" :key="p._id">
                <td><input v-model="p.name" type="text" /></td>
                <td><input v-model="p.lon" type="number" step="0.0001" /></td>
                <td><input v-model="p.lat" type="number" step="0.0001" /></td>
                <td><button class="ci-x" @click="I.removeCciPoint(p._id)">×</button></td>
              </tr>
            </tbody>
          </table>
        </section>

        <!-- 场图与逐站取值并排：同一副天线、同一套着色的两种读法——面上的分布与点上的读数。
             上下摆的时候，要核对某个点的数得先滚过一整张图，两个数还对不到一屏里。 -->
        <section class="ci-panel">
          <h2>覆盖场图与逐站取值</h2>
          <div class="ci-split cci">
            <div class="ci-split-l">
              <div class="ci-panel-hd">
                <h3>C/CCI 覆盖场图</h3>
                <button class="ci-btn" :disabled="busy || !currentAntenna" @click="I.computeCciField()">计算场图</button>
              </div>
              <div class="ci-grid inline">
                <label>经度起 °E<input v-model.number="cci.bounds.lonMin" type="number" step="1" /></label>
                <label>经度止 °E<input v-model.number="cci.bounds.lonMax" type="number" step="1" /></label>
                <label>纬度起 °N<input v-model.number="cci.bounds.latMin" type="number" step="1" /></label>
                <label>纬度止 °N<input v-model.number="cci.bounds.latMax" type="number" step="1" /></label>
                <label>网格步长 °<input v-model.number="cci.fieldStep" type="number" step="0.25" /></label>
              </div>
              <div v-if="cci.field" class="ci-fieldwrap">
                <LbSurfacePlot
                  :xs="cci.field.xs" :ys="cci.field.ys" :nx="cci.field.nx" :ny="cci.field.ny" :z="cci.field.z"
                  x-label="经度" x-unit="°E" y-label="纬度" y-unit="°N"
                  z-label="C/CCI" z-unit="dB"
                  :basemap="true" palette="turbo" :level-count="9"
                  :bounds="{ x0: -180, x1: 180, y0: -90, y1: 90 }" />
              </div>
              <p v-else class="ci-note">尚未计算。</p>
            </div>

            <div class="ci-split-r">
              <div class="ci-panel-hd">
                <h3>逐站取值</h3>
              </div>
              <template v-if="cci.result">
                <div class="ci-tbwrap">
                  <table class="ci-tb res">
                    <thead><tr><th>取值点</th><th>经度</th><th>纬度</th><th>服务波束</th><th>颜色</th><th>C/CCI dB</th></tr></thead>
                    <tbody>
                      <tr v-for="(r, i) in cci.result.rows" :key="i">
                        <td>{{ r.name }}</td>
                        <td class="dim">{{ f(r.lon, 4) }}</td>
                        <td class="dim">{{ f(r.lat, 4) }}</td>
                        <td>{{ r.servingIdx == null ? '—' : '#' + r.servingIdx }}</td>
                        <td>{{ r.servingIdx == null ? '—' : cci.result.coloring[r.servingIdx] }}</td>
                        <td class="num">{{ r.cciDb == null ? '无同色波束 / 域外' : f(r.cciDb) }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p class="ci-note sm">共 {{ (cci.result.beamIdx || []).length }} 个存活波束，按 {{ cci.result.colors }} 色复用着色。</p>
              </template>
              <p v-else class="ci-note">尚无逐点读数。</p>
            </div>
          </div>
        </section>
      </template>

      <!-- ============ C/XPI ============ -->
      <template v-else-if="mode === 'xpi'">
        <section class="ci-panel">
          <h2>三段来源</h2>
          <div class="ci-sub">
            <h3>① 卫星天线</h3>
            <div class="ci-radios">
              <label><input v-model="xpi.satSource" type="radio" value="grd" />由 GRD 方向图取（P1/P2 逐点实测）</label>
              <label><input v-model="xpi.satSource" type="radio" value="manual" />手填</label>
            </div>
            <!-- 站址就摆在取值按钮旁边：本页只吃这两个数，没必要为它挂一整条侧栏 -->
            <div v-if="xpi.satSource === 'grd'" class="ci-grid">
              <label class="wide">方向图
                <select v-model="cci.antennaKey">
                  <option value="">— 选一副天线 —</option>
                  <option v-for="a in grdAntennas" :key="a.key" :value="a.key">{{ a.label }} · {{ a.origin }}</option>
                </select>
              </label>
              <label>本站经度 °E<input v-model.number="site.lon" type="number" step="0.0001" /></label>
              <label>本站纬度 °N<input v-model.number="site.lat" type="number" step="0.0001" /></label>
              <label>本站处 XPD dB<input v-model="xpi.satGrdRatioDb" type="number" readonly /></label>
              <label class="btn-cell"><button class="ci-btn" :disabled="!currentAntenna" @click="I.sampleXpiFromGrd()">在本站取值</button></label>
            </div>
            <div v-else class="ci-grid">
              <label>卫星侧 XPI dB<input v-model.number="xpi.satManualDb" type="number" step="0.5" /></label>
            </div>
          </div>

          <div class="ci-sub">
            <h3>② 地球站天线</h3>
            <div class="ci-radios">
              <label><input v-model="xpi.esMode" type="radio" value="manual" />直接填 XPI</label>
              <label><input v-model="xpi.esMode" type="radio" value="axialRatio" />由轴比换算（圆极化）</label>
              <label><input v-model="xpi.esMode" type="radio" value="levels" />由实测共/交极化电平</label>
            </div>
            <div v-if="xpi.esMode === 'axialRatio'" class="ci-grid">
              <label>轴比 AR dB<input v-model.number="xpi.esArDb" type="number" step="0.05" min="0" /></label>
            </div>
            <div v-else-if="xpi.esMode === 'levels'" class="ci-grid">
              <label>共极化电平 dB<input v-model.number="xpi.esCoDb" type="number" step="0.1" /></label>
              <label>交叉极化电平 dB<input v-model.number="xpi.esXpolDb" type="number" step="0.1" /></label>
            </div>
            <div v-else class="ci-grid">
              <label>地球站侧 XPI dB<input v-model.number="xpi.earthStationDb" type="number" step="0.5" /></label>
            </div>
            <div class="ci-grid gap-t">
              <label class="ci-chk"><input v-model="xpi.esAlignOn" type="checkbox" />再计极化对准误差</label>
              <label v-if="xpi.esAlignOn">对准误差 τ °<input v-model.number="xpi.esAlignDeg" type="number" step="0.1" min="0" max="89" /></label>
            </div>
            <p v-if="xpi.esTerm" class="ci-derived">
              地球站侧 XPI = <b>{{ f(xpi.esTerm.db) }}</b> dB
              <span v-if="xpi.esTerm.note">· {{ xpi.esTerm.note }}</span>
            </p>
            <p v-else class="ci-derived off">本段无有效值，不计入合成。</p>
          </div>

          <div class="ci-sub">
            <h3>③ 降雨去极化</h3>
            <div class="ci-grid">
              <label>雨致 XPD dB<input v-model.number="xpi.rainXpdDb" type="number" step="0.5" /></label>
            </div>
          </div>
        </section>

        <section v-if="xpi.result" class="ci-panel">
          <h2>结果</h2>
          <div class="ci-kpis">
            <div class="ci-kpi"><span>总 C/XPI</span><b>{{ f(xpi.result.xpiDb) }}</b><i>dB</i></div>
            <div class="ci-kpi"><span>卫星侧来源</span><b class="sm">{{ xpi.result.grdBacked ? 'GRD 实测' : '手填' }}</b></div>
          </div>
          <table class="ci-tb res">
            <thead><tr><th>分段</th><th>XPI dB</th><th>来源</th><th>占总干扰</th></tr></thead>
            <tbody>
              <tr v-for="t in xpi.result.terms" :key="t.key">
                <td>{{ t.label }}</td>
                <td class="num">{{ f(t.db, 1) }}</td>
                <td class="dim" :title="t.note || ''">{{ XPI_SRC[t.source] || '手填' }}</td>
                <td class="num">{{ fPct(t.sharePct) }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="xpi.result.missing && xpi.result.missing.length" class="ci-note sm">
            缺失未计入的段：{{ xpi.result.missing.join('、') }}。
          </p>
        </section>
      </template>

      <!-- ============ NGSO ============ -->
      <template v-else>
        <section class="ci-panel">
          <h2>本星座</h2>
          <div class="ci-radios">
            <label><input v-model="ngso.wanted.source" type="radio" value="group" />真实星座（软件星历）</label>
            <label><input v-model="ngso.wanted.source" type="radio" value="walker" />Walker 参数（方案比选）</label>
          </div>
          <div v-if="ngso.wanted.source === 'group'">
            <div class="ci-grid">
              <label class="wide">星座
                <select v-model="ngso.wanted.group" @change="I.ensureGroup(ngso.wanted.group)">
                  <option value="">— 选一个星座 —</option>
                  <optgroup v-for="s in groupSections" :key="s.label" :label="s.label">
                    <option v-for="g in s.items" :key="g.key" :value="g.key">{{ g.label }}{{ g.count ? `（${g.count} 颗）` : (g.available ? '（本地有数据）' : '（无数据，需联网）') }}</option>
                    <option v-if="!s.items.length" disabled>（{{ s.empty }}）</option>
                  </optgroup>
                </select>
              </label>
              <label title="留空为全量。按倍率 K 抽样将使聚合干扰偏低约 10·lg K dB；受算力限制时应优先调整步长与时窗">抽样上限<input v-model.number="ngso.wanted.limit" type="number" placeholder="留空 = 全量" /></label>
              <label class="btn-cell"><button class="ci-btn" title="重新读取「星座」页的卫星组、自定义星座与编目列表；本窗口为单例，切换窗口返回时亦会自动重读" @click="I.loadNgsoGroups()">刷新列表</button></label>
              <label class="btn-cell"><button class="ci-btn" :disabled="!ngso.wanted.group" @click="I.ensureGroup(ngso.wanted.group, true)">联网刷新</button></label>
            </div>
            <p v-if="groupsErr" class="ci-note sm err">编目星座 / 自定义星历读取失败：{{ groupsErr }}</p>
            <!-- 选了真实星座就不再要求填根数：轨道参数由星历直接给出，这里只读速览 -->
            <dl v-if="groupStats[ngso.wanted.group]" class="ci-stats">
              <div><dt>在轨</dt><dd>{{ groupStats[ngso.wanted.group].count }} 颗</dd></div>
              <div><dt>轨道高度</dt><dd>{{ groupStats[ngso.wanted.group].altKmMin }}–{{ groupStats[ngso.wanted.group].altKmMax }} km<span class="dim">（中位 {{ groupStats[ngso.wanted.group].altKmMed }}）</span></dd></div>
              <div><dt>倾角</dt><dd>{{ groupStats[ngso.wanted.group].inclMin }}–{{ groupStats[ngso.wanted.group].inclMax }}°</dd></div>
              <div><dt>轨道周期</dt><dd>{{ groupStats[ngso.wanted.group].periodMin }} min</dd></div>
              <!-- 壳层 = 同一倾角且高度落在同一主峰窗里的那一撮，高度与倾角同源（抬轨/离轨中的星不计入） -->
              <div class="wide"><dt>主壳层</dt><dd>{{ groupStats[ngso.wanted.group].shells.slice(0, 3).map((x) => `${x.inclDeg}° / ${x.altKmMed} km × ${x.count} 颗`).join('　') }}</dd></div>
            </dl>
          </div>
          <div v-else class="ci-grid">
            <label>名称<input v-model="ngso.wanted.name" type="text" /></label>
            <label>轨道高度 km<input v-model.number="ngso.wanted.altKm" type="number" /></label>
            <label>倾角 °<input v-model.number="ngso.wanted.incl" type="number" step="0.1" /></label>
            <label>轨道面数<input v-model.number="ngso.wanted.planes" type="number" /></label>
            <label>每面星数<input v-model.number="ngso.wanted.perPlane" type="number" /></label>
            <label>相位因子 F<input v-model.number="ngso.wanted.phase" type="number" /></label>
          </div>
          <!-- 曾有两段说明（星座下拉四段的来源 / 抽样上限的偏差口径）铺在这里——已删。
               来源在下拉的分组标题里就写着，抽样偏差在输入框的 title 与运行时告警里都说了，
               铺成两段正文只是把面板顶长。 -->

          <div class="ci-panel-hd">
            <h3>干扰星座</h3>
            <button class="ci-btn" @click="I.addNgsoGroup()">+ 星座</button>
          </div>
          <table class="ci-tb compact">
            <thead>
<tr><th class="w-chk"></th><th>来源</th><th>名称 / 星座</th><th colspan="5">轨道（星历来源为只读）</th><th>EIRP 密度 dBW/Hz</th><th>极化</th><th>自系统</th><th class="w-chk"></th></tr>
            </thead>
            <tbody>
              <tr v-for="g in ngso.interferers" :key="g._id" :class="{ off: !g.enabled }">
                <td><input v-model="g.enabled" type="checkbox" /></td>
                <td>
                  <select v-model="g.source" class="src-sel"><option value="group">星历</option><option value="walker">Walker</option></select>
                </td>
                <td>
                  <select v-if="g.source === 'group'" v-model="g.group" @change="I.ensureGroup(g.group)">
                    <option value="">— 选星座 —</option>
                    <optgroup v-for="s in groupSections" :key="s.label" :label="s.label">
                      <option v-for="x in s.items" :key="x.key" :value="x.key">{{ x.label }}{{ x.count ? ` (${x.count})` : (x.available ? ' (本地)' : ' (无)') }}</option>
                      <option v-if="!s.items.length" disabled>（{{ s.empty }}）</option>
                    </optgroup>
                  </select>
                  <input v-else v-model="g.name" type="text" />
                </td>
                <template v-if="g.source === 'group'">
                  <!-- 选了真实星座，根数由星历给，不再要求填 -->
                  <td colspan="5" class="ci-ro sub">
                    <template v-if="groupStats[g.group]">
                      {{ groupStats[g.group].count }} 颗 · {{ groupStats[g.group].altKmMed }} km · {{ groupStats[g.group].inclMin }}–{{ groupStats[g.group].inclMax }}° · {{ groupStats[g.group].periodMin }} min
                    </template>
                    <template v-else-if="g.group">载入中…</template>
                    <template v-else>—</template>
                  </td>
                </template>
                <template v-else>
                  <td><input v-model.number="g.altKm" type="number" /></td>
                  <td><input v-model.number="g.incl" type="number" step="0.1" /></td>
                  <td><input v-model.number="g.planes" type="number" /></td>
                  <td><input v-model.number="g.perPlane" type="number" /></td>
                  <td><input v-model.number="g.phase" type="number" /></td>
                </template>
                <td><input v-model="g.eirpDensityDbWPerHz" type="number" step="0.1" /></td>
                <td><select v-model="g.polarization"><option value="">—</option><option>H</option><option>V</option><option>L</option><option>R</option></select></td>
                <td><input v-model="g.selfSystem" type="checkbox" title="同星座内的其他星（服务星自身不计为干扰）" /></td>
                <td><button class="ci-x" @click="I.removeNgsoGroup(g._id)">×</button></td>
              </tr>
            </tbody>
          </table>

          <div class="ci-sub">
            <h3>扫描设置</h3>
            <div class="ci-grid">
              <label>仰角门限 °<input v-model.number="ngso.minElevDeg" type="number" step="0.5" /></label>
              <label>时窗 h<input v-model.number="ngso.horizonH" type="number" step="0.5" /></label>
              <label>步长 s<input v-model.number="ngso.stepSec" type="number" step="0.1" /></label>
              <label>门限 C/I dB<input v-model.number="ngso.thresholdDb" type="number" step="0.5" /></label>
              <label>离轴包络
                <select v-model="ngso.patternKind">
                  <option value="average">S.1428（平均，NGSO 用）</option>
                  <option value="peak">AP8/S.580（峰值，对比用）</option>
                </select>
              </label>
              <label title="in-line 事件的判定半角。留空取半功率半角，此时穿越时长 = 3 dB 全宽 / 视角速度">
                in-line 规避角 °<input v-model="ngso.inlineGuardDeg" type="number" step="0.01" placeholder="留空 = 半功率半角" />
              </label>
              <label class="ci-chk wide"><input v-model="ngso.applyPolarization" type="checkbox" />计入极化折减</label>
            </div>
          </div>

          <!-- ============ 噪声 · 门限 · 可用度（P4）============ -->
          <div class="ci-sub">
            <h3>噪声与判据</h3>
            <div class="ci-grid">
              <label>噪声给法
                <select v-model="ngso.noise.mode">
                  <option value="tsys">系统噪声温度 T_sys</option>
                  <option value="gt">由 G/T 反推</option>
                </select>
              </label>
              <label v-if="ngso.noise.mode === 'tsys'">T_sys K<input v-model="ngso.noise.tSysK" type="number" step="1" placeholder="留空 = 仅输出 C/I" /></label>
              <label v-else title="T_sys = 10^((G_peak − G/T)/10)，G_peak 为本站天线峰值增益">G/T dB/K<input v-model="ngso.noise.gOverTdBK" type="number" step="0.1" /></label>
              <label title="仅用于「越限时间占比」的统计">C/I 门限 dB<input v-model="ngso.criteria.ciDb" type="number" step="0.5" placeholder="留空 = 不统计" /></label>
              <label title="门限数值须依 ITU-R S.1323 与具体协调场景确定">I/N 门限 dB<input v-model="ngso.criteria.iOverNDb" type="number" step="0.1" placeholder="留空 = 不统计" /></label>
              <label title="ΔT/T 与 I/N 为同一比值的两种表达">ΔT/T 门限 %<input v-model="ngso.criteria.deltaTOverTPct" type="number" step="0.5" placeholder="留空 = 不统计" /></label>
            </div>

            <h3>可用度合成</h3>
            <div class="ci-grid">
              <label class="ci-chk"><input v-model="ngso.rain.on" type="checkbox" />合成可用度</label>
              <label title="C/(N+I) 低于该值判为不可用">可用门限 dB<input v-model.number="ngso.rain.thresholdDb" type="number" step="0.5" /></label>
              <label title="干扰路径与本站路径的仰角不同，默认不施加雨衰（保守口径）">干扰路径雨衰
                <select v-model="ngso.rain.applyToInterference">
                  <option value="none">不施加（保守）</option>
                  <option value="same">按同路径等量施加</option>
                </select>
              </label>
              <label class="btn-cell"><button class="ci-btn" :disabled="busy" @click="I.loadRainCdf()">取雨衰分布</button></label>
            </div>
            <p v-if="ngso.rain.cdfInfo" class="ci-note sm">雨衰分布：{{ ngso.rain.cdfInfo }}</p>
            <p v-else-if="ngso.rain.on" class="ci-note sm">尚未取雨衰分布。</p>
          </div>

          <!-- ============ 历元编排 ============ -->
          <div class="ci-sub">
            <h3>仿真时长与历元</h3>
            <div class="ci-grid">
              <label>历元方式
                <select v-model="ngso.epochs.mode">
                  <option value="single">单历元（用上面的时窗）</option>
                  <option value="repeat">按回归周期取时窗</option>
                  <option value="monte-carlo">多历元蒙特卡洛（推荐）</option>
                </select>
              </label>
              <template v-if="ngso.epochs.mode === 'monte-carlo'">
                <label>历元个数<input v-model.number="ngso.epochs.count" type="number" step="1" min="2" /></label>
                <label title="起始历元在该基线内抽取">基线跨度 天<input v-model.number="ngso.epochs.spanDays" type="number" step="1" min="1" /></label>
                <label title="相同种子与起点的两次计算结果逐位一致">随机种子<input v-model.number="ngso.epochs.seed" type="number" step="1" /></label>
                <label title="目标分位连续两次变化小于该值判为收敛">收敛判据 dB<input v-model.number="ngso.epochs.convergeTolDb" type="number" step="0.05" /></label>
                <label title="用于判定收敛的分位档">收敛分位 %<input v-model.number="ngso.epochs.convergePct" type="number" step="0.01" /></label>
              </template>
              <template v-else-if="ngso.epochs.mode === 'repeat'">
                <label title="回归周期超过该上限时封顶，并输出实际覆盖率">时窗上限 天<input v-model.number="ngso.epochs.capDays" type="number" step="1" min="1" /></label>
              </template>
            </div>
            <p v-if="ngso.epochs.mode === 'monte-carlo'" class="ci-note sm">计算量为单历元的 {{ ngso.epochs.count }} 倍。</p>
          </div>

          <!-- ============ 卫星发射天线（干扰源侧）============ -->
          <div class="ci-sub">
            <h3>卫星发射天线</h3>
            <div class="ci-grid">
              <label>方向图
                <select v-model="ngso.satPattern.mode">
                  <option value="none">各向同性满 EIRP（上界包络）</option>
                  <option value="s1528">ITU-R S.1528 参考方向图</option>
                  <option value="gaussian">高斯主瓣近似</option>
                  <option value="grd">GRD 实测方向图</option>
                </select>
              </label>
              <label v-if="ngso.satPattern.mode !== 'none'">波束指向
                <select v-model="ngso.satPattern.pointing">
                  <option value="nadir">星下点</option>
                  <option value="cells">地面小区网格</option>
                  <option value="worst">始终指向本站（上界）</option>
                </select>
              </label>
              <label title="同频复用系数 × 波束时隙占空，线性作用于每颗干扰星的功率">
                同频占空<input v-model.number="ngso.satPattern.coFreqFactor" type="number" step="0.05" min="0.001" max="1" />
              </label>
              <template v-if="ngso.satPattern.mode === 's1528'">
                <label>S.1528 分节
                  <select v-model="ngso.satPattern.s1528Section">
                    <option value="1.2">§1.2（LN 型包络）</option>
                    <option value="1.3">§1.3（LEO / MEO 型）</option>
                  </select>
                </label>
                <label>3 dB 波束宽 °<input v-model.number="ngso.satPattern.beamwidth3dBDeg" type="number" step="0.1" /></label>
                <label title="留空时由 ψb 反推：D/λ = √1200/ψb，Gm = 20lg(D/λ) + 7.974（隐含 η≈63%）">
                  峰值增益 dBi<input v-model="ngso.satPattern.peakGainDbi" type="number" step="0.1" placeholder="留空 = 由波束宽反推" />
                </label>
                <label v-if="ngso.satPattern.s1528Section === '1.2'" title="S.1528 Table 1 仅给出四档；−30 dB 一档原文标注为待进一步研究">
                  近旁瓣 LN dB
                  <select v-model.number="ngso.satPattern.Ln">
                    <option :value="-15">−15</option><option :value="-20">−20</option>
                    <option :value="-25">−25</option><option :value="-30">−30（暂定）</option>
                  </select>
                </label>
                <template v-else>
                  <label>轨道类型
                    <select v-model="ngso.satPattern.satMode"><option value="LEO">LEO</option><option value="MEO">MEO</option></select>
                  </label>
                  <label title="S.1528 §1.3 仅给出 D/λ < 35 的形式">D/λ<input v-model="ngso.satPattern.dOverLambda" type="number" step="0.1" placeholder="留空 = 由 ψb 反推" /></label>
                </template>
                <label title="远旁瓣电平 LF，S.1528 正文取 0 dBi">远旁瓣 dBi<input v-model.number="ngso.satPattern.farOutDbi" type="number" step="0.5" /></label>
              </template>
              <template v-else-if="ngso.satPattern.mode === 'gaussian'">
                <label>3 dB 波束宽 °<input v-model.number="ngso.satPattern.beamwidth3dBDeg" type="number" step="0.1" /></label>
                <label>旁瓣底板 dB<input v-model.number="ngso.satPattern.sidelobeFloorDb" type="number" step="1" /></label>
              </template>
              <template v-else-if="ngso.satPattern.mode === 'grd'">
                <label class="wide">方向图
                  <select v-model="ngso.satPattern.grdKey">
                    <option value="">— 选择天线 —</option>
                    <option v-for="a in grdAntennas" :key="a.key" :value="a.key">{{ a.label }}（{{ a.origin }}）</option>
                  </select>
                </label>
                <label v-if="ngsoGrdBeams.length > 1" title="干扰计算的是与受扰载波同频的那一个波束，不是整副天线">同频波束
                  <select v-model="ngso.satPattern.grdBeam">
                    <option value="">全部波束取最大（上界）</option>
                    <option v-for="b in ngsoGrdBeams" :key="b.idx" :value="b.idx">{{ b.label }}</option>
                  </select>
                </label>
              </template>
              <template v-if="ngso.satPattern.mode !== 'none' && ngso.satPattern.pointing === 'cells'">
                <label title="每颗卫星同时激活的波束数">同时波束数<input v-model.number="ngso.satPattern.beamsPerSat" type="number" step="1" min="1" /></label>
                <label title="地面小区间距">小区间距 km<input v-model.number="ngso.satPattern.cellSpacingKm" type="number" step="10" min="1" /></label>
              </template>
            </div>
            <template v-if="ngso.satPattern.mode === 'grd'">
              <p v-if="ngsoGrdBeams.length > 1 && ngso.satPattern.grdBeam === ''" class="ci-warn">
                所选方向图含 <strong>{{ ngsoGrdBeams.length }} 个波束</strong>，当前按「全部波束取最大」计算。
              </p>
            </template>
            <p v-else-if="ngso.satPattern.mode === 'none'" class="ci-warn">未计入卫星发射方向图。</p>
            <div v-if="busy && ngso.progressTotal" class="ci-prog">
              <div class="ci-prog-bar" :style="{ width: (ngso.progress / ngso.progressTotal * 100) + '%' }" />
            </div>
          </div>
        </section>

        <section v-if="ngso.result" class="ci-panel">
          <h2>结果</h2>
          <div class="ci-kpis">
            <div class="ci-kpi"><span>C/I 中位</span><b>{{ f(ngso.result.medianCiDb, 1) }}</b><i>dB</i></div>
            <div class="ci-kpi" :title="ngSupTip(0.1)">
              <span>C/I(0.1%)</span>
              <template v-if="ngso.result.percentiles && ngso.result.percentiles[0.1] != null">
                <b>{{ f(ngso.result.percentiles[0.1], 1) }}</b><i>dB</i>
                <i v-if="ngCi(0.1)">±{{ f((ngCi(0.1).hi - ngCi(0.1).lo) / 2, 1) }}</i>
              </template>
              <template v-else><b class="kpi-short">样本不足</b><i>需 ≥ {{ ngSup(0.1) ? ngSup(0.1).needSamples.toLocaleString() : '—' }} 样本</i></template>
            </div>
            <div class="ci-kpi"><span>C/I 最差</span><b>{{ f(ngso.result.worstCiDb, 1) }}</b><i>dB</i></div>
            <div class="ci-kpi"><span>服务可用度</span><b>{{ f(ngso.result.availabilityPct, 2) }}</b><i>%</i></div>
            <div class="ci-kpi"><span>in-line</span><b>{{ ngso.result.inlineCount }}</b><i>次 / {{ f(ngso.result.horizonSec / 3600, 1) }} h</i></div>
          </div>

          <p v-if="ngso.result.epochStats" class="ci-note sm">
            多历元：{{ ngso.result.epochStats.count }} 个起始历元
            <template v-if="ngso.result.epochStats.spanDays">（{{ ngso.result.epochStats.spanDays }} 天基线内按种子 {{ ngso.result.epochStats.seed }} 抽取）</template>，
            样本池合并共 {{ (ngso.result.samples || 0).toLocaleString() }} 个。
            <template v-if="ngso.result.epochStats.converged">
              目标分位 C/I({{ ngso.result.epochStats.convergePct }}%) 在第
              <strong>{{ ngso.result.epochStats.convergedAtEpoch }}</strong> 个历元收敛（各历元独立估值的均值 95% 区间宽
              {{ f(ngso.result.epochStats.ciWidthDb, 2) }} dB &lt; {{ ngso.result.epochStats.convergeTolDb }} dB）。
            </template>
            <template v-else>
              目标分位 C/I({{ ngso.result.epochStats.convergePct }}%) 至第 {{ ngso.result.epochStats.count }} 个历元<strong>仍未收敛</strong>（各历元独立估值散布过大，其均值
              95% 区间宽 {{ f(ngso.result.epochStats.ciWidthDb, 2) }} dB，未达 {{ ngso.result.epochStats.convergeTolDb }} dB）。
            </template>
          </p>
          <p v-if="ngCiLowRes" class="ci-warn">
            历元数 {{ ngso.result.epochStats.count }} 少于 8：95% 区间按历元整块重采样得出，<strong>会偏窄</strong>。
            <template v-if="ngPerEpoch.length">
              各历元独立估出的 C/I({{ ngso.result.epochStats.convergePct }}%) 依次为
              <strong>{{ ngPerEpoch.join(' / ') }}</strong> dB。
            </template>
          </p>
          <p v-if="ngso.result.repeatPeriodSec" class="ci-note sm">
            星座回归周期 <strong>{{ f(ngso.result.repeatPeriodSec / 86400, 2) }} 天</strong>
            （{{ ngso.result.repeatPeriodOrbits }} 圈，ITU-R S.1325-3 §2.7.3，精度 {{ ngso.result.repeatPeriodAccuracyDeg }}°）；
            本次扫描覆盖 <strong>{{ f(ngso.result.repeatCoveragePct, 2) }}%</strong>。
          </p>
          <p v-if="!ngso.result.satPatternActive" class="ci-warn">
            未计入卫星发射方向图（各向同性满 EIRP）。
            其中 {{ f(ngso.result.farShareNoPatternPct, 1) }}% 的聚合干扰来自离轴
            {{ ngso.result.farOffAxisDeg }}° 以外的干扰星。
          </p>
          <p v-else class="ci-note sm">
            卫星发射天线：{{ ngso.result.satPattern.shape }}，指向
            {{ { nadir: '星下点', cells: '地面小区网格', worst: '始终指向本站' }[ngso.result.satPattern.pointing] || ngso.result.satPattern.pointing }}
            <template v-if="ngso.result.satPattern.beamCount > 1">，{{ ngso.result.satPattern.beamCount }} 个波束中{{ ngso.result.satPattern.beamPick == null ? '按全部取最大' : `仅取第 ${ngso.result.satPattern.beamPick + 1} 个` }}</template>
            <template v-if="ngso.result.satPattern.coFreqFactor !== 1">，同频占空 {{ ngso.result.satPattern.coFreqFactor }}（{{ f(ngso.result.satPattern.coFreqDb, 2) }} dB）</template>
            <template v-if="ngso.result.satPattern.peakGainDerived">，<strong>峰值增益由波束宽反推</strong></template>。
            <template v-if="ngso.result.satPattern.allBeamsMax">
              <strong>多波束按最大合并，本次结果为上界。</strong>
            </template>
            计入方向图后聚合干扰总能量下降 <strong>{{ f(ngso.result.satPatternReductionDb, 1) }} dB</strong>；
            离轴 {{ ngso.result.farOffAxisDeg }}° 以外的贡献占比由 {{ f(ngso.result.farShareNoPatternPct, 1) }}% 变为
            <strong>{{ f(ngso.result.farSharePct, 1) }}%</strong>。
          </p>
          <p v-if="ngso.result.perf" class="ci-note sm">
            算力：共 {{ (ngso.result.perf.totalPropagations || 0).toLocaleString() }} 次轨道传播，
            可见性粗筛保留 {{ f(ngso.result.perf.screenKeptPct, 0) }}%（粗步 {{ f(ngso.result.perf.coarseSec, 0) }} s，掩码自身 {{ (ngso.result.perf.screenPropagations || 0).toLocaleString() }} 次），
            耗时 {{ ngso.result.elapsedMs }} ms。
          </p>
          <div class="ci-split">
            <div class="ci-split-l">
              <h3>CDF 分位</h3>
              <table class="ci-tb res">
                <thead><tr>
                  <th>超越时间</th><th>C/I dB</th>
                  <th v-if="ngso.result.epochStats">95% 区间</th>
                  <th>有效样本</th>
                  <th v-if="ngso.result.iOverN" title="I/N 越大越劣，取自分布高端">I/N dB</th>
                  <th v-if="ngso.result.cOverNI" title="链路口径">C/(N+I) dB</th>
                  <th v-if="ngso.result.deltaTOverT" title="与 I/N 为同一比值的百分数表达">ΔT/T %</th>
                  <th>年折合</th>
                </tr></thead>
                <tbody>
                  <tr v-for="(v, k) in ngso.result.percentiles" :key="k" :class="{ 'pct-none': v === null, 'pct-weak': ngSup(k) && ngSup(k).weak }">
                    <td>{{ k }} %</td>
                    <td class="num" :title="ngSupTip(k)">
                      <template v-if="v !== null">
                        {{ f(v, 2) }}<sup v-if="ngSup(k) && ngSup(k).weak" class="pct-flag">弱</sup><sup v-if="ngSup(k) && ngSup(k).sampled" class="pct-flag samp">抽</sup>
                      </template>
                      <span v-else class="pct-short">样本不足</span>
                    </td>
                    <td v-if="ngso.result.epochStats" class="num dim">
                      <template v-if="ngCi(k)">±{{ f((ngCi(k).hi - ngCi(k).lo) / 2, 2) }}</template>
                      <template v-else>—</template>
                    </td>
                    <td class="num dim" :title="ngSupTip(k)">
                      <template v-if="ngSup(k)">
                        <template v-if="ngSup(k).enough">{{ ngSup(k).nEff < 100 ? ngSup(k).nEff.toFixed(1) : Math.round(ngSup(k).nEff).toLocaleString() }}</template>
                        <template v-else>需 ≥ {{ ngSup(k).needSamples.toLocaleString() }}</template>
                      </template>
                      <template v-else>—</template>
                    </td>
                    <td v-if="ngso.result.iOverN" class="num">{{ f(ngso.result.iOverN[k], 2) }}</td>
                    <td v-if="ngso.result.cOverNI" class="num">{{ f(ngso.result.cOverNI[k], 2) }}</td>
                    <td v-if="ngso.result.deltaTOverT" class="num">{{ f(ngso.result.deltaTOverT[k], 3) }}</td>
                    <td class="dim">{{ f(fYearMin(k), 1) }} min/年</td>
                  </tr>
                </tbody>
              </table>
              <p v-if="ngso.result.sampled" class="ci-note sm">
                标「抽」表示干扰星座按 1/{{ f(ngso.result.samplingFactorMax, 1) }} 抽样，
                聚合干扰偏低约 {{ f(10 * Math.log10(ngso.result.samplingFactorMax), 1) }} dB。
              </p>
              <p v-if="ngso.result.esPattern && ngso.result.esPattern.fellBack" class="ci-warn" title="AP8 为静态单干扰源的峰值包络，用于动态多干扰源场景偏保守">
                收信站离轴包络已由 S.1428 <strong>退回 AP8/S.580</strong>：{{ ngso.result.esPattern.reason }}。
              </p>

              <h3>in-line 穿越事件</h3>
              <p class="ci-note sm">
                干扰星进入规避角以内（θ &lt; {{ f(ngso.result.inlineGuardDeg, 3) }}°，
                天线 3 dB 全宽 {{ f(ngso.result.beamwidth3dBDeg, 3) }}°）的时段。
                <template v-if="ngso.result.inlineRefined">
                  事件表按 {{ f(ngso.result.inlineFineStepSec, 2) }} s 细步重扫得出。
                </template>
              </p>
              <table v-if="ngso.result.inlineEvents.length" class="ci-tb res">
                <thead><tr><th>起始</th><th>时长</th><th>最近离轴 °</th><th>该段最差 C/I dB</th></tr></thead>
                <tbody>
                  <tr v-for="(e, i) in ngso.result.inlineEvents.slice(0, 24)" :key="i">
                    <td class="dim">{{ fTime(e.startMs) }}</td>
                    <td>{{ fDur(e.durationSec) }}</td>
                    <td class="num">{{ f(e.minThetaDeg, 3) }}</td>
                    <td class="num">{{ f(e.worstCiDb, 1) }}</td>
                  </tr>
                </tbody>
              </table>
              <p v-else class="ci-note sm">本时窗内无穿越事件。</p>
              <p class="ci-note sm">
                合计 {{ f(ngso.result.inlineTotalSec, 1) }} s，占时 {{ f(ngso.result.inlineDutyPct, 5) }}%，折合每天 {{ f(ngso.result.inlinePerDay, 1) }} 次。
              </p>

              <p v-if="ngso.result.cdfAliasRisk" class="ci-warn">
                步长 {{ ngso.result.stepSec }} s 大于 in-line 穿越时长 {{ f(ngso.result.crossingSec, 2) }} s
                （干扰星视角速度 {{ f(ngso.result.interfererRateDegPerSec, 3) }} °/s），
                <strong>CDF 尾部可能漏采穿越事件</strong>。事件表已按细步重扫；CDF 一并覆盖需步长 ≤ {{ f(ngso.result.recommendedStepSec, 2) }} s。
              </p>
              <template v-if="ngso.result.perGroup && ngso.result.perGroup.length">
                <h3>单源分解</h3>
                <table class="ci-tb res">
                  <thead><tr><th>干扰星座</th><th>星数</th><th>聚合份额</th><th>时均 I₀ dBW/Hz</th><th>单入最坏 dBW/Hz</th><th>最坏时刻</th></tr></thead>
                  <tbody>
                    <tr v-for="g in ngso.result.perGroup" :key="g.id">
                      <td>{{ g.name }}</td>
                      <td class="num dim">{{ g.count }}</td>
                      <td class="num">
                        {{ f(g.sharePct, 1) }}%
                        <span class="share-bar"><i :style="{ width: Math.max(0, Math.min(100, g.sharePct || 0)) + '%' }" /></span>
                      </td>
                      <td class="num">{{ f(g.iAggDbW, 2) }}</td>
                      <td class="num">{{ f(g.worstSingleEntryDbW, 2) }}</td>
                      <td class="dim">{{ g.worstAtMs ? fTime(g.worstAtMs) : '—' }}</td>
                    </tr>
                  </tbody>
                </table>
              </template>

              <template v-if="ngso.result.breach && (ngso.result.breach.ciPct != null || ngso.result.breach.iOverNPct != null || ngso.result.breach.deltaTPct != null)">
                <h3>越限时间占比</h3>
                <table class="ci-tb res">
                  <thead><tr><th>判据</th><th>门限</th><th>越限时间</th><th>年折合</th></tr></thead>
                  <tbody>
                    <tr v-if="ngso.result.breach.ciPct != null">
                      <td>C/I</td><td class="num">&lt; {{ ngso.result.breach.criteria.ciDb }} dB</td>
                      <td class="num">{{ f(ngso.result.breach.ciPct, 4) }}%</td>
                      <td class="dim">{{ f(fYearMin(ngso.result.breach.ciPct), 1) }} min/年</td>
                    </tr>
                    <tr v-if="ngso.result.breach.iOverNPct != null">
                      <td>I/N</td><td class="num">&gt; {{ ngso.result.breach.criteria.iOverNDb }} dB</td>
                      <td class="num">{{ f(ngso.result.breach.iOverNPct, 4) }}%</td>
                      <td class="dim">{{ f(fYearMin(ngso.result.breach.iOverNPct), 1) }} min/年</td>
                    </tr>
                    <tr v-if="ngso.result.breach.deltaTPct != null">
                      <td>ΔT/T</td><td class="num">&gt; {{ ngso.result.breach.criteria.deltaTOverTPct }}%</td>
                      <td class="num">{{ f(ngso.result.breach.deltaTPct, 4) }}%</td>
                      <td class="dim">{{ f(fYearMin(ngso.result.breach.deltaTPct), 1) }} min/年</td>
                    </tr>
                  </tbody>
                </table>
              </template>

              <template v-if="ngso.result.availability">
                <h3>可用度</h3>
                <table class="ci-tb res">
                  <thead><tr><th>口径</th><th>可用度</th><th>年不可用</th></tr></thead>
                  <tbody>
                    <tr><td>仅雨衰</td><td class="num">{{ f(ngso.result.availability.noInterferencePct, 4) }}%</td><td class="dim">{{ f((100 - ngso.result.availability.noInterferencePct) / 100 * 8760, 2) }} h/年</td></tr>
                    <tr class="strong"><td>计入干扰</td><td class="num">{{ f(ngso.result.availability.withInterferencePct, 4) }}%</td><td class="dim">{{ f((100 - ngso.result.availability.withInterferencePct) / 100 * 8760, 2) }} h/年</td></tr>
                    <tr><td>所需补偿余量</td><td class="num">{{ f(ngso.result.availability.extraMarginDb, 2) }} dB</td><td class="dim"></td></tr>
                  </tbody>
                </table>
                <p class="ci-note sm">
                  门限 C/(N+I) = {{ ngso.result.availability.thresholdDb }} dB；
                  干扰路径雨衰{{ ngso.result.availability.applyToInterference === 'same' ? '按等量施加' : '不施加（保守口径）' }}；
                  雨致噪温抬升{{ ngso.result.availability.noiseRiseIncluded ? '已计入' : '未计入' }}。
                </p>
              </template>

            </div>

            <div class="ci-split-r">
              <CiCdfPlot
                title="C/I 累积分布" file-name="NGSO时变_CI累积分布"
                :cdf="ngso.result.cdf" :percentiles="ngso.result.percentiles"
                :median-ci-db="ngso.result.medianCiDb" :threshold-db="ngso.thresholdDb" />

              <template v-if="ngso.result.series && ngso.result.series.length">
                <CiSeriesPlot
                  title="C/I 时序" file-name="NGSO时变_CI时序"
                  :series="ngso.result.series" :threshold-db="ngso.thresholdDb"
                  metric="ci" :show-elev="true" />
                <template v-if="ngso.result.iOverN">
                  <CiSeriesPlot
                    title="I/N 时序" file-name="NGSO时变_IN时序"
                    :series="ngso.result.series" :threshold-db="ngso.result.breach && ngso.result.breach.criteria.iOverNDb"
                    metric="iOverN" :show-elev="false" />
                </template>
              </template>
            </div>
          </div>
        </section>
      </template>
    </main>
  </div>
</template>

<style scoped>
.ci-root { display: flex; flex-direction: column; height: 100vh; background: var(--bg); color: var(--text); font-size: 13px; }

.ci-bar { display: flex; align-items: center; gap: 12px; padding: 8px 14px; border-bottom: 1px solid var(--border-strong); background: var(--surface); }
.ci-title { margin: 0; font-size: 15px; font-weight: 700; letter-spacing: 0.02em; }
.ci-bar-sp { flex: 1; }
.ci-tabs { display: flex; gap: 3px; }
.ci-tab { font: inherit; font-size: 12px; padding: 5px 12px; cursor: pointer; background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl, 4px); }
.ci-tab.on { background: var(--surface-2); color: var(--text); border-color: var(--border-strong); font-weight: 600; box-shadow: inset 0 -2px 0 var(--accent); }
.ci-run { font: inherit; font-weight: 600; padding: 6px 18px; cursor: pointer; color: var(--bg); background: var(--accent); border: none; border-radius: var(--r-ctl, 4px); }
.ci-run:disabled { opacity: 0.55; cursor: default; }
.ci-btn { font: inherit; font-size: 12px; padding: 4px 10px; cursor: pointer; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: var(--r-ctl, 4px); }
.ci-btn:hover:not(:disabled) { border-color: var(--border-strong); }
.ci-btn:disabled { opacity: 0.5; cursor: default; }
.ci-x { font: inherit; line-height: 1; padding: 1px 6px; cursor: pointer; color: var(--text-muted); background: none; border: 1px solid transparent; border-radius: 3px; }
.ci-x:hover { color: var(--text); border-color: var(--border); }

.ci-msg { margin: 0; padding: 6px 14px; font-size: 12px; color: var(--text-muted); background: var(--surface-2); border-bottom: 1px solid var(--border); }

.ci-main { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 18px; }

.ci-panel { margin-bottom: 20px; padding: 14px 16px; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; }
.ci-panel > h2, .ci-panel-hd h2 { margin: 0 0 10px; font-size: 14px; font-weight: 700; }
.ci-panel h3 { margin: 14px 0 6px; font-size: 12.5px; font-weight: 700; color: var(--text-muted); }
.ci-panel-hd { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.ci-panel-hd h2, .ci-panel-hd h3 { margin: 0; flex: none; }
.ci-hd-tools { margin-left: auto; display: flex; align-items: center; gap: 8px; }
/* min-width:0 不能省：flex 项默认 min-width:auto，nowrap 的长站名会把它顶出面板而不是省略号 */
.ci-hd-sum { margin-left: auto; min-width: 0; font-family: var(--font-mono); font-size: 11.5px; color: var(--text-faint); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ci-sub { margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--border); }

/* 「本站与本链路」输入带：按分组横排，组内是读数表（标签左、值右对齐），
   与链路预算工作台的 .es-f/.es-l/.es-i 同一手感 —— 一堵等宽输入框墙读起来像表单，
   对齐成两栏才读得像参数表。列窄且可换行：宽屏不把四组拉成四条空旷的横幅。 */
/* 轨道上限钉死 232px：写 1fr 的话，窗口一宽或列数一少，剩余宽度全灌进标签与值之间的空当，
   一行读数拉成两头见不着的横幅。宽屏多出来的宽度宁可空在右边，也不摊给已经够宽的列。 */
.ci-band { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 232px)); gap: 10px 26px; }
.ci-bcol > h3 { margin: 0 0 5px; padding-bottom: 3px; font-size: 11.5px; font-weight: 700; letter-spacing: 0.04em; color: var(--text-muted); border-bottom: 1px solid var(--border); }
.ci-bf { display: flex; align-items: center; gap: 8px; padding: 2px 0; }
.ci-bf > span { flex: 1 1 auto; min-width: 0; font-size: 11.5px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ci-bf input, .ci-bf select {
  width: 104px; flex: none; font: inherit; font-size: 12.5px; text-align: right; padding: 3px 6px;
  color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-ctl, 4px);
}
.ci-bf select, .ci-bf input.txt { text-align: left; }
.ci-bf input:hover, .ci-bf select:hover { border-color: var(--border-strong); }
.ci-bf input:focus, .ci-bf select:focus { outline: none; border-color: var(--accent); }

.ci-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(148px, 1fr)); gap: 8px 10px; }
.ci-grid.inline { grid-template-columns: repeat(auto-fill, minmax(168px, 1fr)); margin-bottom: 8px; }
.ci-grid label { display: flex; flex-direction: column; gap: 3px; font-size: 11.5px; color: var(--text-muted); }
.ci-grid label.wide { grid-column: span 2; }
.ci-grid label.btn-cell { justify-content: flex-end; }
.ci-grid input, .ci-grid select { font: inherit; font-size: 12.5px; padding: 4px 6px; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-ctl, 4px); }
.ci-grid input:focus, .ci-grid select:focus { outline: none; border-color: var(--accent); }
.ci-grid input[readonly] { background: var(--surface-2); color: var(--text-muted); }

.ci-chk { flex-direction: row !important; align-items: center; gap: 5px !important; }
.ci-grid.gap-t { margin-top: 8px; }
/* 换算出来的那一段值：填在上面、结果就在下面一行，不用等点「计算」才知道自己填的等于多少 */
.ci-derived { margin: 9px 0 0; padding: 6px 10px; font-size: 12px; line-height: 1.5; color: var(--text); background: var(--surface-2); border-left: 3px solid var(--accent); border-radius: 3px; }
.ci-derived b { font-size: 13.5px; font-weight: 700; font-variant-numeric: tabular-nums; }
.ci-derived span { color: var(--text-muted); font-size: 11.5px; margin-left: 4px; }
.ci-derived.off { color: var(--text-muted); border-left-color: var(--border-strong); }
.ci-radios { display: flex; flex-wrap: wrap; gap: 14px; margin-bottom: 8px; font-size: 12px; }
.ci-radios label { display: flex; align-items: center; gap: 5px; cursor: pointer; }
.ci-mini { font: inherit; font-size: 12px; padding: 3px 6px; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: var(--r-ctl, 4px); }

.ci-tb { width: 100%; border-collapse: collapse; font-size: var(--lb-fs, 12.5px); }
.ci-tb th { padding: 4px 6px; font-size: 11.5px; font-weight: 600; text-align: left; color: var(--text-muted); border-bottom: 1px solid var(--border-strong); white-space: nowrap; }
.ci-tb td { padding: 2px 4px; border-bottom: 1px solid var(--border); }
.ci-tb tr.off { opacity: 0.45; }
.ci-tb tr.skip { opacity: 0.55; font-style: italic; }
.ci-tb tr.hot { background: var(--surface-2); }
.ci-tb .w-chk { width: 26px; }
.ci-tb input[type=text], .ci-tb input[type=number], .ci-tb select {
  width: 100%; font: inherit; font-size: inherit; padding: 3px 5px; color: var(--text);
  background: transparent; border: 1px solid transparent; border-radius: 3px;
}
.ci-tb input:hover, .ci-tb select:hover { border-color: var(--border); }
.ci-tb input:focus, .ci-tb select:focus { outline: none; background: var(--bg); border-color: var(--accent); }
.ci-tb.res td, .ci-tb.res th[scope], .ci-tb.res tbody th { padding: 3px 8px; }
.ci-tb.res tbody th { text-align: left; font-weight: 500; color: var(--text-muted); border-bottom: 1px solid var(--border); }
.ci-tb.res tr.strong { font-weight: 700; }
.ci-tb .num { text-align: right; font-variant-numeric: tabular-nums; }
.ci-tb .dim { color: var(--text-muted); }
.ci-tb .ci-ro { color: var(--text-muted); white-space: nowrap; }
/* 逐源明细里星名后的轨位标记：从属于名字的次要信息，压暗一档、不与名字断行。
   字号写 em 不写 px —— 表格本体跟着 --lb-fs 走（9~16px 可调），写死 px 会在小字号档与星名同高、
   两者糊成一串读不出主次 */
.ci-tb .ci-slot { margin-left: 6px; font-size: .87em; color: var(--text-muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.ci-tb.compact { margin-bottom: 4px; }
/* 取值点表：只有一个名字和两个经纬数，铺满整幅时三列各 498px，三个输入框成了大白条 ——
   一格里放得下一句话的宽度，装的是「39.9042」。列宽钉住、表宽收到内容尺度，右边宁可空着。 */
.ci-tb.pts { width: auto; table-layout: fixed; }
.ci-tb.pts th:nth-child(1) { width: 208px; }
.ci-tb.pts th:nth-child(2), .ci-tb.pts th:nth-child(3) { width: 112px; }

.ci-kpis { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; }
.ci-kpi { flex: 1 1 130px; padding: 8px 12px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 5px; }
.ci-kpi span { display: block; font-size: 11px; color: var(--text-muted); }
.ci-kpi b { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }
.ci-kpi b.sm { font-size: 14px; }
/* 「样本不足」不是一个数，别把它排得像一个数 */
.ci-kpi b.kpi-short { font-size: 15px; font-weight: 600; color: var(--text-muted); }

/* 分位表的样本支撑度：不足的整行压暗并划掉数字位，弱支撑只给个上标 */
.ci-tb.res tr.pct-none td { color: var(--text-muted); }
.ci-tb.res tr.pct-weak td.num { color: var(--warn, #d08a2e); }
.pct-short { font-size: 11px; color: var(--text-muted); }
.pct-flag { font-size: 8.5px; font-weight: 700; margin-left: 2px; color: var(--warn, #d08a2e); }
.pct-flag.samp { color: var(--danger, #c0392b); }

/* 单源分解的份额条：数值旁附一条细条，便于横向比较各座的贡献占比 */
.share-bar { display: inline-block; width: 46px; height: 5px; margin-left: 6px; vertical-align: middle; background: var(--surface-2); border: 1px solid var(--border); border-radius: 2px; overflow: hidden; }
.share-bar i { display: block; height: 100%; background: var(--accent); }
.ci-kpi i { font-size: 11px; font-style: normal; color: var(--text-muted); margin-left: 3px; }

.ci-split { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(300px, 0.85fr); gap: 20px; align-items: start; }
/* C/CCI 那对：图是主体，逐站取值六列全是短数字（实测自然宽 312px），给够读的宽度就行 ——
   表的上界钉死 400px（余量留给长站名与「无同色波束 / 域外」那格），多出来的宽度一律归图：
   信箱式 1°:1° 下栏宽直接决定图的大小，写 fr 会让超宽屏白空一大片表。
   不写 fit-content：栏宽跟着表内容跳，改个取值点名字整张图就重排一次。 */
.ci-split.cci { grid-template-columns: minmax(0, 1fr) minmax(320px, 400px); }
/* 媒体查询里必须把 .cci 一起点名：单类选择器压不住 .ci-split.cci 的特异度，塌单栏会失效 */
@media (max-width: 1180px) { .ci-split, .ci-split.cci { grid-template-columns: 1fr; } }
/* 两栏的标题行等高：左栏「算这张图」比 h3 高一截（.ci-btn 实测 24 px，字号写死不随 --lb-fs），
   不钉住的话 flex 居中会把右栏的「逐站取值」抬高 5 px —— 两个同级小标题差半行，一眼看得出。 */
.ci-split.cci .ci-panel-hd { min-height: 24px; }
/* 表窄到装不下时自己横滚，别把整个 grid 顶宽（grid 项默认 min-width:auto） */
.ci-tbwrap { min-width: 0; overflow-x: auto; }

.ci-note { margin: 6px 0 0; font-size: 11.5px; line-height: 1.55; color: var(--text-muted); }
.ci-note.sm { font-size: 11px; }
/* 取数失败的原因行：不是提示语气，要看得出是出了事 */
.ci-note.err { color: var(--danger, #d64545); }
.ci-note strong { color: var(--text); font-weight: 600; }
.ci-warn { margin: 8px 0 0; padding: 7px 10px; font-size: 11.5px; line-height: 1.55; color: var(--text); background: color-mix(in srgb, var(--warn, #d08a2e) 12%, transparent); border-left: 3px solid var(--warn, #d08a2e); border-radius: 3px; }
.ci-warn strong { font-weight: 700; }

.ci-fieldwrap { margin-top: 10px; }
/* 星座实参速览：选了真实星座后代替 Walker 输入格 */
.ci-stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 4px 14px; margin: 8px 0 0; padding: 8px 11px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 5px; }
.ci-stats > div { display: flex; gap: 7px; align-items: baseline; font-size: 12px; }
.ci-stats > div.wide { grid-column: 1 / -1; }
.ci-stats dt { flex: none; color: var(--text-muted); font-size: 11.5px; }
.ci-stats dd { margin: 0; font-variant-numeric: tabular-nums; }
.ci-stats .dim { color: var(--text-muted); }
.ci-tb .ci-ro.sub { font-size: 11.5px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
.ci-prog { height: 4px; margin-top: 8px; background: var(--surface-2); border-radius: 2px; overflow: hidden; }
.ci-prog-bar { height: 100%; background: var(--accent); transition: width 0.12s linear; }

/* 邻星搜索：结果按与本星轨位的经度差排序，最近的在前 */
.ci-search { margin: 8px 0 10px; padding: 10px 12px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 5px; }
.ci-search-hd { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ci-search-hd input[type=text] { flex: 1 1 200px; min-width: 160px; font: inherit; font-size: 12.5px; padding: 4px 7px; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-ctl, 4px); }
.ci-search-hd input[type=number] { font: inherit; font-size: 12.5px; padding: 4px 5px; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-ctl, 4px); }
.ci-search-hd label { display: flex; align-items: center; gap: 3px; font-size: 11.5px; color: var(--text-muted); white-space: nowrap; }
.ci-search-msg { font-size: 11.5px; color: var(--text-muted); }
.ci-search-list { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 9px; max-height: 168px; overflow-y: auto; }
.ci-hit { display: inline-flex; align-items: baseline; gap: 6px; font: inherit; font-size: 11.5px; padding: 3px 9px; cursor: pointer; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 11px; }
.ci-hit:hover { border-color: var(--accent); background: var(--surface); }
.ci-hit b { font-weight: 600; }
.ci-hit .lon { color: var(--text-muted); font-variant-numeric: tabular-nums; }
.ci-hit .dl { color: var(--accent); font-variant-numeric: tabular-nums; }
.ci-hit .incl { padding: 0 4px; font-size: 10px; color: var(--warn, #d08a2e); border: 1px solid currentColor; border-radius: 3px; }
.ci-btn.on { background: var(--surface-2); border-color: var(--border-strong); font-weight: 600; }
.src-sel { font-size: 11px !important; }

</style>
