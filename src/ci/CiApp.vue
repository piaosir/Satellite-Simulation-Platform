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
import { useInterference } from './useInterference.js'
import CiGeoPanel from './CiGeoPanel.vue'
import LbSurfacePlot from '../components/LbSurfacePlot.vue'
import CiCdfPlot from './CiCdfPlot.vue'

const I = useInterference()
const {
  MODES, REUSE_COLORS, mode, busy, msg, site, carrier, asi, xpi, cci, ngso,
  satLib, grdAntennas, currentAntenna, geoData, hoveredId, satSearch, ngsoGroups, groupStats, groupsErr
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
  { kind: 'satgroup', label: '我的卫星组', empty: '无 —— 在「星座」页按搜索结果 / 多选存组' },
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
        <p v-if="mode === 'ngso'" class="ci-note sm">
          本页不设「卫星轨位」与「发信链」：期望星由下面的本星座给出（非静止，轨位逐时刻变），
          时变 C/I 只算下行。上行邻星干扰在 C/ASI 页。
        </p>
      </section>

      <!-- ============ C/ASI ============ -->
      <template v-if="mode === 'asi'">
        <section class="ci-panel">
          <div class="ci-panel-hd">
            <h2>干扰星</h2>
            <div class="ci-hd-tools">
              <label class="ci-chk"><input v-model="asi.applyPolarization" type="checkbox" />计入极化折减</label>
              <select v-if="satLib.length" class="ci-mini" @change="I.addFromLibrary(satLib[$event.target.value]); $event.target.value = ''">
                <option value="">从卫星库带入…</option>
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
            <p class="ci-note sm">
              星历仅提供轨位，<strong>下行 EIRP 密度须手工填写</strong>：该项属邻网发射参数，星历中不含。
              标「倾」者星下点纬度不为 0（倾角残余），按赤道面圆轨道近似计算 C/ASI 存在偏差。
            </p>
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
            <p class="ci-note">
              掩模模式按邻网各站均达到 ITU-R S.524-9 限值满功率发射计算，给出的是<strong>硬上界</strong>而非运行值：
              实测同一算例与对等站模式相差可达 27 dB。核查协调门限用掩模，估计预期值用对等站。
            </p>
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
            <p v-if="asi.uplinkMode === 'explicit'" class="ci-note sm">
              此处填写干扰站<strong>朝本星方向</strong>（非其主轴方向）的 EIRP 谱密度，
              适用于已取得对方实测数据或协调函件申报值的情形。
            </p>
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
          <p v-if="!grdAntennas.length" class="ci-note">
            暂无可用方向图。可点「导入 GRD…」直接导入本窗口，或在「星座3D」/「链路预算」中导入后点「刷新列表」引用。
          </p>
          <p class="ci-note">
            缺省着色按波束在 GRD 中的原始次序轮转（idx % N），在无布局信息时为中立取法，
            但<strong>不保证同色波束在空间上分散</strong>。实际系统的着色由波束布局决定，请按系统设计文件指派。
          </p>

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
                <button class="ci-btn" :disabled="busy || !currentAntenna" @click="I.computeCciField()">算这张图</button>
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
                <p class="ci-note sm">
                  同色波束的旁瓣在每一格上叠加得到的 C/CCI。无解格（落在方向图覆盖外，或该色下无其他同色波束）
                  <strong>留白不着色</strong>。
                </p>
              </div>
              <p v-else class="ci-note">选定方向图与复用色数后点「算这张图」。逐格合成在主进程完成。</p>
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
              <p v-else class="ci-note">上面「取值点」填好经纬后点右上角「计算」，逐点读数出现在这里。</p>
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
            <p v-if="xpi.satSource === 'grd'" class="ci-note sm">
              取<strong>该站址所在网格</strong>的共/交极化比。站址与 C/ASI、NGSO 两页共用同一座站，在此修改后两页同步。
            </p>
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
            <p v-else class="ci-derived off">本段无有效值，不计入合成（视为无此项劣化）。</p>
            <p class="ci-note sm">
              GRD 为<strong>卫星</strong>天线的方向图，不含本段，须取天线规格值或实测值；
              轴比与 XPD 为同一量的两种表示，可直接填入（AR 0.55 dB ↔ 30.0 dB，1.0 ↔ 24.8，2.0 ↔ 18.8；
              工程上常见的入网要求为主瓣内 XPD ≥ 30 dB）。
              <strong>对准误差仅对线极化有意义</strong>：圆极化对天线绕视轴旋转不敏感，不产生交叉极化分量（τ = 1° → 35.2 dB，2° → 29.1 dB）。
            </p>
          </div>

          <div class="ci-sub">
            <h3>③ 降雨去极化</h3>
            <div class="ci-grid">
              <label>雨致 XPD dB<input v-model.number="xpi.rainXpdDb" type="number" step="0.5" /></label>
            </div>
            <p class="ci-note sm">按 ITU-R P.618-14 §4.1：链路预算与雨衰计算器的「降雨去极化 XPD」即为此值。</p>
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
          <p class="ci-note sm">
            占比最大的一段即瓶颈：三段串联劣化，改善最弱一段收益最大。
            <template v-if="xpi.result.missing && xpi.result.missing.length">缺失未计入的段：{{ xpi.result.missing.join('、') }}。</template>
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
              <label>抽样上限<input v-model.number="ngso.wanted.limit" type="number" placeholder="留空 = 全部" /></label>
              <label class="btn-cell"><button class="ci-btn" title="重读「星座」页的卫星组 / 自定义星座与编目列表——本窗口是单例，开着它去建的组靠这里进来（切窗口回来也会自动重读）" @click="I.loadNgsoGroups()">刷新列表</button></label>
              <label class="btn-cell"><button class="ci-btn" :disabled="!ngso.wanted.group" @click="I.ensureGroup(ngso.wanted.group, true)">联网刷新</button></label>
            </div>
            <p v-if="groupsErr" class="ci-note sm err">编目星座 / 自定义星历这两段没取回来：{{ groupsErr }}</p>
            <!-- 选了真实星座就不再要求填根数：轨道参数由星历直接给出，这里只读速览 -->
            <dl v-if="groupStats[ngso.wanted.group]" class="ci-stats">
              <div><dt>在轨</dt><dd>{{ groupStats[ngso.wanted.group].count }} 颗</dd></div>
              <div><dt>轨道高度</dt><dd>{{ groupStats[ngso.wanted.group].altKmMin }}–{{ groupStats[ngso.wanted.group].altKmMax }} km<span class="dim">（中位 {{ groupStats[ngso.wanted.group].altKmMed }}）</span></dd></div>
              <div><dt>倾角</dt><dd>{{ groupStats[ngso.wanted.group].inclMin }}–{{ groupStats[ngso.wanted.group].inclMax }}°</dd></div>
              <div><dt>轨道周期</dt><dd>{{ groupStats[ngso.wanted.group].periodMin }} min</dd></div>
              <div class="wide"><dt>主壳层</dt><dd>{{ groupStats[ngso.wanted.group].shells.map((x) => `${x.inclDeg}° × ${x.count} 颗`).join('　') }}</dd></div>
            </dl>
            <p v-else-if="ngso.wanted.group" class="ci-note sm">选中后自动载入，载入完成后在此列出该星座的实际轨道参数。</p>
          </div>
          <div v-else class="ci-grid">
            <label>名称<input v-model="ngso.wanted.name" type="text" /></label>
            <label>轨道高度 km<input v-model.number="ngso.wanted.altKm" type="number" /></label>
            <label>倾角 °<input v-model.number="ngso.wanted.incl" type="number" step="0.1" /></label>
            <label>轨道面数<input v-model.number="ngso.wanted.planes" type="number" /></label>
            <label>每面星数<input v-model.number="ngso.wanted.perPlane" type="number" /></label>
            <label>相位因子 F<input v-model.number="ngso.wanted.phase" type="number" /></label>
          </div>
          <p class="ci-note sm">
            星座下拉分四段：<strong>我的卫星组</strong>（星座页所存的组，仅记编目号，成员星历自全量编目取得）、
            <strong>自定义星座</strong>（星座页 Walker 生成器建的合成星座，按同一份放置公式与场景历元展开，
            与 3D 页看到的是同一批星）、<strong>自定义星历</strong>（文件管理中导入的 OMM/TLE 组）、
            <strong>编目星座</strong>（CelesTrak 分组，与主窗口「星座」页同一份数据）。某段显示「无」就是那里还没有东西，
            按括号里的去处去建；建完点「刷新列表」（或切到主窗口再切回来）即可出现。
            右侧「Walker 参数」用于连星座都还没建、只有设计参数时的方案比选。
            大星座请用「抽样上限」限量：数千颗逐时刻传播将超出计算量上限。
          </p>

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
              <label class="ci-chk wide"><input v-model="ngso.applyPolarization" type="checkbox" />计入极化折减</label>
            </div>
            <p class="ci-note">
              <strong>包络须按角域核对</strong>：S.1428 在近区（&lt;37°）低于 AP8，但在 40°–120° 的溢出区高出 2.5–7.5 dB。
              干扰星散布全天时多数落在远区，故 S.1428 给出的聚合 C/I 常<strong>更低（更保守）</strong>，并非更宽松。
            </p>
            <div v-if="busy && ngso.progressTotal" class="ci-prog">
              <div class="ci-prog-bar" :style="{ width: (ngso.progress / ngso.progressTotal * 100) + '%' }" />
            </div>
          </div>
        </section>

        <section v-if="ngso.result" class="ci-panel">
          <h2>结果</h2>
          <div class="ci-kpis">
            <div class="ci-kpi"><span>C/I 中位</span><b>{{ f(ngso.result.medianCiDb, 1) }}</b><i>dB</i></div>
            <div class="ci-kpi"><span>C/I(0.1%)</span><b>{{ f(ngso.result.percentiles && ngso.result.percentiles[0.1], 1) }}</b><i>dB</i></div>
            <div class="ci-kpi"><span>C/I 最差</span><b>{{ f(ngso.result.worstCiDb, 1) }}</b><i>dB</i></div>
            <div class="ci-kpi"><span>服务可用度</span><b>{{ f(ngso.result.availabilityPct, 2) }}</b><i>%</i></div>
            <div class="ci-kpi"><span>in-line</span><b>{{ ngso.result.inlineCount }}</b><i>次 / {{ f(ngso.result.horizonSec / 3600, 1) }} h</i></div>
          </div>

          <p v-if="ngso.result.perf" class="ci-note sm">
            算力：共 {{ (ngso.result.perf.totalPropagations || 0).toLocaleString() }} 次轨道传播，
            可见性粗筛保留 {{ f(ngso.result.perf.screenKeptPct, 0) }}%（粗步 {{ f(ngso.result.perf.coarseSec, 0) }} s，掩码自身 {{ (ngso.result.perf.screenPropagations || 0).toLocaleString() }} 次），
            耗时 {{ ngso.result.elapsedMs }} ms。
          </p>
          <div class="ci-split">
            <div class="ci-split-l">
              <h3>CDF 分位</h3>
              <table class="ci-tb res">
                <thead><tr><th>超越时间</th><th>C/I dB</th><th>年折合</th></tr></thead>
                <tbody>
                  <tr v-for="(v, k) in ngso.result.percentiles" :key="k">
                    <td>{{ k }} %</td>
                    <td class="num">{{ f(v, 2) }}</td>
                    <td class="dim">{{ f(Number(k) / 100 * 525600, 1) }} min/年</td>
                  </tr>
                </tbody>
              </table>

              <h3>in-line 穿越事件</h3>
              <p class="ci-note sm">
                干扰星穿过接收主瓣（θ &lt; {{ f(ngso.result.beamwidth3dBDeg, 3) }}°）的时段。
                <template v-if="ngso.result.inlineRefined">
                  事件表按 {{ f(ngso.result.inlineFineStepSec, 2) }} s 细步重扫得出：粗步长会漏采快速穿越。
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
                ⚠ 步长 {{ ngso.result.stepSec }} s 大于 in-line 穿越时长 {{ f(ngso.result.crossingSec, 2) }} s
                （干扰星视角速度 {{ f(ngso.result.interfererRateDegPerSec, 3) }} °/s）：
                <strong>CDF 尾部可能漏采穿越事件</strong>。事件表已按细步重扫；若需 CDF 一并覆盖，
                请将步长降至 {{ f(ngso.result.recommendedStepSec, 2) }} s 以下重新计算。
              </p>
              <p class="ci-note sm">
                此处的时间百分比为<strong>几何统计</strong>（取决于卫星轨位分布），与雨衰可用度的百分比（传播统计）
                物理独立，两者不能相加，合成需另行判断。
              </p>
            </div>

            <div class="ci-split-r">
              <h3>C/I 累积分布</h3>
              <CiCdfPlot
                :cdf="ngso.result.cdf" :percentiles="ngso.result.percentiles"
                :median-ci-db="ngso.result.medianCiDb" :threshold-db="ngso.thresholdDb" />
              <p class="ci-note sm">
                纵轴取对数：关注区间为 0.001%–1%（相当于每年数分钟至数小时），线性轴会将其压缩。
                竖线为门限，交点即低于门限的时间占比。
              </p>
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
.ci-run { font: inherit; font-weight: 600; padding: 6px 18px; cursor: pointer; color: #fff; background: var(--accent); border: none; border-radius: var(--r-ctl, 4px); }
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
