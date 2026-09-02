<script setup>
// 应用场景仿真 · 检查器 + 结果。
//
// ★ 三档判据在这里必须【看得出区别】：
//   功率档 出 dB 余量；约束档 出「实际 / 上限」一对数，没有余量这一列；
//   契约档 的数字后面钉一个「契约」标，因为它不是算出来的。
// ★ 结果区不出现「可行 / 达标 / 受限」这类文字判定（CLAUDE.md）：只给数值与着色。
import { computed, ref } from 'vue'
import Icon from './Icon.vue'
import {
  scene, effective, modById, linkById, mediaOf, mediaLabel, tierOf, setOv, ovOf, energyOf,
  satEntryOf, scheduleSatSave
} from '../viz/scene/sceneStore.js'
import { ensureSearchPool } from '../ngso/satSearchPool.js'
import { orbitFromPoolRec, applyOrbitToForm, searchPool, orbitShapeOf } from '../shared/satPick.js'

const sel = computed(() => scene.sel)
const selMod = computed(() => (sel.value && sel.value.type === 'module' ? modById.value.get(sel.value.id) : null))
const selEff = computed(() => (selMod.value ? effective(selMod.value) : null))
const selLink = computed(() => (sel.value && sel.value.type === 'link' ? linkById.value.get(sel.value.id) : null))
const selFlow = computed(() => (sel.value && sel.value.type === 'flow' ? scene.flows.find((f) => f.id === sel.value.id) : null))

// ═══ 卫星节点 ═══
// ★ 两段分得开是这个检查器的要点：上半改的是【平台卫星库】那条条目（两个工作台共用，
//   改了别处也变），下半改的是【本场景这条业务】分到的那一片（只影响这个场景）。
//   一期把两者混在一起，用户改一个转发器带宽就把库里那颗星改了。
const isSat = computed(() => !!(selMod.value && selMod.value.kind === 'sat'))
const satEntry = computed(() => (selMod.value ? satEntryOf(selMod.value) : null))
const satForm = computed(() => (satEntry.value ? satEntry.value.form : null))
const satIsGso = computed(() => !!satForm.value && (satForm.value.orbitClass || 'GSO') === 'GSO')
const satPicked = computed(() => {
  const ns = satEntry.value && satEntry.value.ngsoSat
  return !!(ns && ns.mode !== 'manual' && ns.orbit)
})
const satShape = computed(() => orbitShapeOf(satEntry.value && satEntry.value.ngsoSat && satEntry.value.ngsoSat.orbit))
const BANDS = ['L', 'S', 'X', 'ExtC', 'C', 'ExtKu', 'Ku', 'Ku-BSS', 'Ka', 'Q', 'V', 'UHF']
function setSatForm(k, v) {
  const f = satForm.value; if (!f) return
  f[k] = v
  // 频段一变端口跟着变：接在旧端口上的星地边会当场判成「介质不符」，这是对的 ——
  // 换了频段那条边本来就不成立，宁可报错也不许悄悄按新频段算旧参数
  scheduleSatSave(); scene.dirty = true
}
function setSatOrbitClass(v) {
  const f = satForm.value; if (!f || f.orbitClass === v) return
  f.orbitClass = v
  if (v === 'GSO') clearSatPick()
  scheduleSatSave(); scene.dirty = true
}
function clearSatPick() {
  const e = satEntry.value; if (!e) return
  e.ngsoSat = { mode: 'manual', orbit: null, name: '', noradId: null, folder: '' }
  scheduleSatSave(); scene.dirty = true
}
// 星历搜索（口径与「添加卫星」弹层、端到端窗口同一份：shared/satPick.js）
const satKw = ref('')
const satPool = ref(null)
const satLoading = ref(false)
const satPoolErr = ref('')
const satListOpen = ref(false)
async function satEnsurePool() {
  if (satPool.value || satLoading.value) return
  satLoading.value = true; satPoolErr.value = ''
  try {
    const r = await ensureSearchPool()
    satPool.value = r.all
    if (!r.all.length) satPoolErr.value = '未取到任何卫星（需联网获取 CelesTrak OMM）'
  } catch (e) { satPoolErr.value = '卫星星历加载失败：' + ((e && e.message) || e) } finally { satLoading.value = false }
}
const satRes = computed(() => searchPool(satPool.value, satKw.value, 40))
function satPick(rec) {
  const e = satEntry.value; if (!e) return
  e.ngsoSat = { mode: 'search', orbit: orbitFromPoolRec(rec), name: rec.name, noradId: rec.noradId || null, folder: '' }
  e.form.satelliteName = rec.name
  applyOrbitToForm(e.form, e.ngsoSat.orbit)
  satKw.value = rec.name; satListOpen.value = false
  scheduleSatSave(); scene.dirty = true
}
// 本场景切片：改的是实例 ov.sat（库值作占位符显示）
const SLICE = [
  ['transponderBandwidth', '转发器带宽', 'MHz'], ['gt', '卫星 G/T', 'dB/K'],
  ['eirpSat', '饱和 EIRP', 'dBW'], ['eirp', '再生 EIRP', 'dBW'],
  ['sfdRef', 'SFD', 'dBW/m²'], ['BOi', 'IBO', 'dB'], ['BOo', 'OBO', 'dB'],
  ['procDelayMs', '处理时延', 'ms']
]

// ── 参数标签表（介质 defaults 的键 → 中文名 + 单位）──
const PL = {
  lengthM: ['长度', 'm'], lengthKm: ['长度', 'km'], awg: ['线规', 'AWG'], ratePreset: ['速率档', ''],
  poe: ['PoE', ''], poeLoadW: ['受电功率', 'W'], cable: ['电缆型号', ''], bucVdc: ['BUC 供电', 'V'],
  bucAmps: ['BUC 电流', 'A'], ifMaxLossDb: ['中频衰减上限', 'dB'],
  attnDbKm: ['光纤衰减', 'dB/km'], connectors: ['连接器数', '个'], connLossDb: ['连接器插损', 'dB'],
  splices: ['熔接点数', '个'], spliceLossDb: ['熔接损耗', 'dB'], txDbm: ['发射功率', 'dBm'],
  rxSensDbm: ['接收灵敏度', 'dBm'], sensDbm: ['接收灵敏度', 'dBm'], marginDb: ['衰落储备', 'dB'],
  baud: ['波特率', 'bps'], nodes: ['节点数', '个'], meters: ['表计数', '只'], hops: ['跳数', '跳'],
  freqGHz: ['频率', 'GHz'], freqUpGHz: ['上行频率', 'GHz'], freqDnGHz: ['下行频率', 'GHz'],
  pol: ['极化', ''], polUp: ['上行极化', ''], polDn: ['下行极化', ''],
  bwMHz: ['信道带宽', 'MHz'], bwKHz: ['带宽', 'kHz'], mcs: ['MCS', ''], sf: ['扩频因子 SF', ''],
  crDen: ['编码率 4/n', ''], streams: ['空间流', ''], gTxDbi: ['发射天线增益', 'dBi'],
  gRxDbi: ['接收天线增益', 'dBi'], lossTxDb: ['发射馈线损耗', 'dB'], lossRxDb: ['接收馈线损耗', 'dB'],
  distM: ['距离', 'm'], distKm: ['距离', 'km'], hTxM: ['发射天线高', 'm'], hRxM: ['接收天线高', 'm'],
  model: ['传播模型', ''], sameChannel: ['同频多跳', ''], clearanceM: ['主径净空', 'm'],
  rainMmH: ['R₀.₀₁', 'mm/h'], dN1: ['dN₁（P.453）', 'N 单位'], saM: ['地形粗糙度 sₐ', 'm'],
  availPct: ['可用度', '%'], rateBps: ['承诺带宽', 'bps'], rateUpBps: ['上行承诺', 'bps'],
  latencyMs: ['承诺时延', 'ms'], covered: ['有覆盖', ''], minElevDeg: ['最低仰角', '°'],
  miscLossDb: ['附加损耗', 'dB'], rangeKm: ['星间距离', 'km'], slantRangeKm: ['斜距', 'km'],
  elevationDeg: ['仰角', '°'], visibilityKm: ['能见度', 'km'], divMrad: ['发散角', 'mrad'],
  apertureM: ['接收口径', 'm'], wavelengthNm: ['波长', 'nm'], pointingLossDb: ['指向损耗', 'dB'],
  env: ['室内环境', ''], floors: ['穿越楼层', '层'], n: ['路径损耗指数 n', ''], extraDb: ['障碍损耗', 'dB'],
  phy: ['以太网 PHY', ''], laserWidthNm: ['谱宽', 'nm'], hopProcMs: ['逐跳处理时延', 'ms']
}
const MODELS = [
  ['fs', '自由空间 (P.525)'], ['two-ray', '双射线平面地反射'], ['logdist', '对数距离 + 障碍'],
  ['p1238', '室内 (P.1238)'], ['hata-urban-large', 'Hata 大城市'], ['hata-urban', 'Hata 市区'],
  ['hata-suburban', 'Hata 郊区'], ['hata-rural', 'Hata 开阔地'], ['los', '视距微波 (P.530)'],
  ['los-air', '空地视距'], ['los-sea', '海面视距']
]
const ENVS = [['office', '办公'], ['residential', '住宅'], ['commercial', '商业'], ['factory', '厂房']]

const linkFields = computed(() => {
  const l = selLink.value; if (!l) return []
  const m = mediaOf(l.medium); if (!m) return []
  const keys = Object.keys(m.defaults || {})
  // 星地边额外给上下行两个频率（一条边同时承载两个方向的两个频率）
  if (m.tier === 'satellite') return ['freqUpGHz', 'freqDnGHz', 'pol', 'miscLossDb', 'minElevDeg', 'slantRangeKm', 'elevationDeg']
  return keys
})
function fieldOpts(k, l) {
  if (k === 'model') return MODELS
  if (k === 'env') return ENVS
  if (k === 'pol' || k === 'polUp' || k === 'polDn') return [['V', 'V 垂直'], ['H', 'H 水平'], ['C', 'C 圆极化']]
  if (k === 'poe') return [['none', '不供电'], ['802.3af', '802.3af 15.4 W'], ['802.3at', '802.3at 30 W'], ['802.3bt-T3', '802.3bt Type3 60 W'], ['802.3bt-T4', '802.3bt Type4 90 W']]
  if (k === 'cable') { const t = mediaOf('ifl_l'); return ((t && t.limits.cables) || []).map((c) => [c.key, c.key]) }
  if (k === 'ratePreset') { const m = mediaOf(l.medium); return ((m && m.limits && m.limits.rates) || []).map((r) => [r.key, r.key]) }
  if (k === 'sameChannel' || k === 'covered') return [[true, '是'], [false, '否']]
  return null
}
const lbl = (k) => (PL[k] ? PL[k][0] : k)
const unit = (k) => (PL[k] ? PL[k][1] : '')
function setLinkParam(k, v) {
  const l = selLink.value; if (!l) return
  const opts = fieldOpts(k, l)
  if (opts && typeof opts[0][0] === 'boolean') l.params[k] = (v === 'true' || v === true)
  else if (opts) l.params[k] = v
  else l.params[k] = (v === '' ? null : (isFinite(+v) ? +v : v))
  scene.dirty = true
}

// ── 选中项的段结果 ──
const linkSegs = computed(() => {
  const l = selLink.value; if (!l || !scene.result) return []
  const out = []
  for (const f of scene.result.flows || []) {
    for (const d of f.dirs || []) {
      const i = (d.path || []).indexOf(l.id); if (i < 0) continue
      const s = (d.segments || [])[i]
      if (s) out.push({ flow: f.name, dir: d.dir === 'ab' ? '正向' : '返向', s })
    }
  }
  return out
})
const flowRes = computed(() => {
  const f = selFlow.value; if (!f || !scene.result) return null
  return (scene.result.flows || []).find((x) => x.id === f.id) || null
})
const energy = computed(() => (selMod.value ? energyOf(selMod.value.id) : null))

const modOptions = computed(() => scene.modules.map((m) => ({ id: m.id, name: m.name })))
const num = (v, d) => (v == null || v === '' ? '—' : (+v).toFixed(d == null ? 2 : d))
const fmtRate = (b) => (b == null || !isFinite(b) ? '—' : b >= 1e9 ? (b / 1e9).toFixed(2) + ' Gbps' : b >= 1e6 ? (b / 1e6).toFixed(2) + ' Mbps' : b >= 1e3 ? (b / 1e3).toFixed(2) + ' kbps' : Math.round(b) + ' bps')
const tierZh = (t) => ({ power: '功率预算', constraint: '约束校验', contract: '契约', satellite: '卫星段', supply: '供电' }[t] || t)

function setPlace(k, v) {
  const m = selMod.value; if (!m) return
  m.place = Object.assign({}, m.place, { [k]: (v === '' ? null : (isFinite(+v) ? +v : v)) })
  scene.dirty = true
}
function setMount(hostId) {
  const m = selMod.value; if (!m) return
  m.place = hostId ? { mode: 'mounted', hostId } : { mode: 'fixed', lat: m.place.lat, lon: m.place.lon, altM: m.place.altM }
  scene.dirty = true
}
</script>

<template>
  <!-- ═══ 检查器 ═══ -->
  <div v-if="sel" class="sec">
    <div class="sect"><span>检查器</span><span class="lnk" @click="scene.sel = null">关闭</span></div>

    <!-- 模块 -->
    <template v-if="selMod && selEff">
      <div class="srow"><label>名称</label><input class="ci" v-model="selMod.name" /></div>
      <div class="ihd">{{ selEff.zh }}<em v-if="selEff.src" :title="selEff.src">出处</em></div>
      <div v-if="!isSat" class="srow"><label>挂载于</label>
        <select :value="selMod.place.mode === 'mounted' ? selMod.place.hostId : ''" @change="setMount($event.target.value)">
          <option value="">（独立放置）</option>
          <option v-for="o in modOptions" :key="o.id" :value="o.id" :disabled="o.id === selMod.id">{{ o.name }}</option>
        </select>
      </div>
      <template v-if="!isSat && selMod.place.mode !== 'mounted'">
        <div class="srow"><label>纬度</label><input class="ci" :value="selMod.place.lat" placeholder="-90 ~ 90" @change="setPlace('lat', $event.target.value)" /></div>
        <div class="srow"><label>经度</label><input class="ci" :value="selMod.place.lon" placeholder="-180 ~ 180" @change="setPlace('lon', $event.target.value)" /></div>
        <div class="srow"><label>海拔</label><input class="ci" :value="selMod.place.altM" @change="setPlace('altM', $event.target.value)" /><span class="u">m</span></div>
      </template>
      <div v-if="selEff.rf" class="srow"><label>降雨率</label><input class="ci" :value="selMod.place.rainRate" placeholder="R₀.₀₁" @change="setPlace('rainRate', $event.target.value)" /><span class="u">mm/h</span></div>
      <div v-if="selEff.rf" class="srow"><label>可用度指标</label><input class="ci" :value="selMod.place.availPct" placeholder="99.5" @change="setPlace('availPct', $event.target.value)" /><span class="u">%</span></div>

      <!-- 射频参数：库值兜底、逐条覆盖 -->
      <template v-if="selEff.rf">
        <div class="sect sub"><span>射频（覆盖库值）</span><span v-if="selEff.typical" class="tag" title="电平类数值为该类设备典型值，非该型号实测">典型值</span></div>
        <div v-for="k in ['antennaDiameter','gainTxDbi','opPowerW','antennaEfficiency','feederLoss','rxAntennaEfficiency','rxReceiverNoiseTemp','rxFeederLoss']" :key="k" class="srow">
          <label>{{ ({ antennaDiameter:'天线口径', gainTxDbi:'天线增益', opPowerW:'功放功率', antennaEfficiency:'发射效率', feederLoss:'发射馈线', rxAntennaEfficiency:'接收效率', rxReceiverNoiseTemp:'接收机噪温', rxFeederLoss:'接收馈线' })[k] }}</label>
          <input class="ci" :class="{ ov: ovOf(selMod.id, 'rf.' + k) !== undefined }" :value="selEff.rf[k]" @change="setOv(selMod.id, 'rf.' + k, $event.target.value === '' ? null : +$event.target.value)" />
        </div>
      </template>
      <!-- 卫星：上半是【平台卫星库】那条条目（与端到端窗口共用，改了两处都变），
           下半是【本场景】这条业务分到的那一片（只影响这个场景）。两段各自标清楚。 -->
      <template v-if="isSat && satForm">
        <div class="sect sub"><span>卫星库</span><span class="tag lib">库</span></div>
        <div class="srow"><label>条目名</label><input class="ci" v-model="satEntry.name" @change="scheduleSatSave()" /></div>
        <div class="srow"><label>轨道类型</label>
          <span class="seg3">
            <span :class="{ on: satIsGso }" @click="setSatOrbitClass('GSO')">GSO</span>
            <span :class="{ on: !satIsGso }" @click="setSatOrbitClass('NGSO')">NGSO</span>
          </span>
        </div>
        <div class="srow"><label>工作频段</label>
          <select :value="satForm.frequencyBand" @change="setSatForm('frequencyBand', $event.target.value)">
            <option v-for="b in BANDS" :key="b" :value="b">{{ b }}</option>
          </select>
        </div>
        <div v-if="satIsGso" class="srow"><label>定点经度</label>
          <input class="ci" :value="satForm.orbitLongitude" @change="setSatForm('orbitLongitude', $event.target.value)" /><span class="u">°E</span>
        </div>
        <template v-else>
          <div class="srow"><label>轨道高度</label>
            <input class="ci" :value="satForm.orbitAltitude" :readonly="satPicked" @change="setSatForm('orbitAltitude', $event.target.value)" /><span class="u">{{ satPicked ? '自动' : 'km' }}</span>
          </div>
          <div class="srow"><label>轨道倾角</label>
            <input class="ci" :value="satForm.orbitInclination" :readonly="satPicked" @change="setSatForm('orbitInclination', $event.target.value)" /><span class="u">{{ satPicked ? '自动' : '°' }}</span>
          </div>
          <div class="srow"><label>星历</label>
            <input class="ci" v-model="satKw" placeholder="名称 / NORAD 号" @focus="satEnsurePool(); satListOpen = true" @input="satListOpen = true" />
            <span v-if="satPicked" class="lnk" @click="clearSatPick">取消选星</span>
          </div>
          <div v-if="satLoading" class="est">正在加载星历…</div>
          <div v-else-if="satPoolErr" class="errc">{{ satPoolErr }}</div>
          <div v-else-if="satListOpen && satRes.length" class="satlist">
            <div v-for="r in satRes" :key="r.noradId" class="satli" @mousedown.prevent="satPick(r)">
              <span class="satn" data-i18n-skip>{{ r.name }}</span>
              <span class="sati">NORAD {{ r.noradId }} · i={{ (+r.incl).toFixed(1) }}°</span>
            </div>
          </div>
          <div v-if="satPicked" class="kv"><span>已选卫星</span><b class="tx" data-i18n-skip>{{ satEntry.ngsoSat.name }}</b></div>
          <div v-if="satShape" class="est">{{ satShape.regime }} · {{ satShape.elliptical ? ('近 ' + Math.round(satShape.perigeeKm) + ' / 远 ' + Math.round(satShape.apogeeKm) + ' km') : ('h ≈ ' + Math.round(satShape.perigeeKm) + ' km') }} · 周期 {{ satShape.periodMin.toFixed(0) }} min</div>
        </template>

        <div class="sect sub"><span>本场景</span><span class="tag">本场景</span><span v-if="selEff.typical" class="tag">典型值</span></div>
        <div v-for="f in SLICE" :key="f[0]" class="srow">
          <label>{{ f[1] }}</label>
          <input class="ci" :class="{ ov: ovOf(selMod.id, 'sat.' + f[0]) !== undefined }"
                 :value="ovOf(selMod.id, 'sat.' + f[0])" :placeholder="satForm[f[0]]"
                 @change="setOv(selMod.id, 'sat.' + f[0], $event.target.value === '' ? null : +$event.target.value)" />
          <span class="u">{{ f[2] }}</span>
        </div>
      </template>

      <!-- 能量账（与 dB 账并列，不混算） -->
      <template v-if="energy">
        <div class="sect sub"><span>能量账</span></div>
        <div class="kv"><span>日能耗</span><b>{{ num(energy.energy.load.whPerDay, 2) }} Wh/d</b></div>
        <template v-if="energy.energy.supply.genWhPerDay != null">
          <div class="kv"><span>光伏（最差月{{ energy.energy.supply.worstMonth ? ' ' + energy.energy.supply.worstMonth.zh : '' }}）</span><b :class="{ neg: energy.energy.supply.genWhPerDay < energy.energy.load.whPerDay }">{{ num(energy.energy.supply.genWhPerDay, 1) }} Wh/d</b></div>
          <div class="kv"><span>所需组件</span><b>{{ num(energy.energy.supply.needWp, 1) }} Wp</b></div>
          <div class="kv" v-if="energy.energy.supply.autonomyDays != null"><span>自主天数</span><b>{{ num(energy.energy.supply.autonomyDays, 1) }} d</b></div>
          <div class="est">Kt 为用户给定的晴空指数，光伏值为估算</div>
        </template>
        <div v-else-if="energy.energy.supply.daysSupported != null" class="kv"><span>电池可支撑</span><b>{{ num(energy.energy.supply.daysSupported, 1) }} d</b></div>
      </template>
    </template>

    <!-- 连线 -->
    <template v-else-if="selLink">
      <div class="ihd">{{ (modById.get(selLink.a.modId) || {}).name }} → {{ (modById.get(selLink.b.modId) || {}).name }}</div>
      <div class="srow"><label>介质</label><span class="rv">{{ mediaLabel(selLink.medium) }}</span><span class="tag" :class="tierOf(selLink.medium)">{{ tierZh(tierOf(selLink.medium)) }}</span></div>
      <div class="srow"><label>角色</label>
        <select v-model="selLink.role" @change="scene.dirty = true">
          <option value="main">主用</option><option value="backup">备份</option>
        </select>
      </div>
      <div v-for="k in linkFields" :key="k" class="srow">
        <label :title="k">{{ lbl(k) }}</label>
        <select v-if="fieldOpts(k, selLink)" :value="selLink.params[k]" @change="setLinkParam(k, $event.target.value)">
          <option v-for="o in fieldOpts(k, selLink)" :key="String(o[0])" :value="o[0]">{{ o[1] }}</option>
        </select>
        <input v-else class="ci" :value="selLink.params[k]" @change="setLinkParam(k, $event.target.value)" />
        <span v-if="unit(k)" class="u">{{ unit(k) }}</span>
      </div>
      <div v-if="mediaOf(selLink.medium)" class="est">{{ mediaOf(selLink.medium).src }}</div>

      <!-- 这条边的逐向读数 -->
      <template v-if="linkSegs.length">
        <div class="sect sub"><span>读数</span></div>
        <div v-for="(r, i) in linkSegs" :key="i" class="segbox">
          <div class="segh">{{ r.flow }} · {{ r.dir }}<span class="tag" :class="r.s.tier">{{ tierZh(r.s.tier) }}</span></div>
          <template v-if="r.s.tier === 'power'">
            <div class="kv"><span>余量</span><b :class="{ neg: r.s.marginDb < 0 }">{{ num(r.s.marginDb) }} dB</b></div>
            <div v-for="(b, j) in r.s.budget" :key="j" class="led"><span>{{ b.label }}</span><b>{{ num(b.v) }} {{ b.unit }}</b></div>
          </template>
          <template v-if="r.s.checks && r.s.checks.length">
            <div v-for="(c, j) in r.s.checks" :key="'c' + j" class="kv"><span :title="c.src">{{ c.label }}</span>
              <b :class="{ neg: c.over }">{{ num(c.actual, 2) }} / {{ c.low ? '≥' : '≤' }} {{ num(c.limit, 2) }} {{ c.unit }}</b>
            </div>
          </template>
          <div v-if="r.s.quoted" class="kv"><span>承诺带宽</span><b>{{ fmtRate(r.s.rateBps) }} <em class="qt">契约</em></b></div>
          <div class="kv"><span>时延</span><b>{{ num(r.s.latencyMs, 3) }} ms</b></div>
          <div v-for="(n, j) in (r.s.notes || [])" :key="'n' + j" class="est">{{ n }}</div>
          <div v-for="(w, j) in (r.s.warn || [])" :key="'w' + j" class="warnc">{{ w }}</div>
        </div>
      </template>
    </template>

    <!-- 业务流 -->
    <template v-else-if="selFlow">
      <div class="srow"><label>名称</label><input class="ci" v-model="selFlow.name" @change="scene.dirty = true" /></div>
      <div class="srow"><label>A 端</label>
        <select v-model="selFlow.aId" @change="scene.dirty = true"><option v-for="o in modOptions" :key="o.id" :value="o.id">{{ o.name }}</option></select>
      </div>
      <div class="srow"><label>B 端</label>
        <select v-model="selFlow.bId" @change="scene.dirty = true"><option v-for="o in modOptions" :key="o.id" :value="o.id">{{ o.name }}</option></select>
      </div>
      <div class="srow"><label>方向</label>
        <select v-model="selFlow.dir" @change="scene.dirty = true">
          <option value="bidir">双向（两条链）</option><option value="ab">单向 A → B</option><option value="ba">单向 B → A</option>
        </select>
      </div>
      <div v-if="selFlow.dir !== 'ba'" class="srow"><label>A → B 速率</label><input class="ci" v-model.number="selFlow.rateAbBps" @change="scene.dirty = true" /><span class="u">bps</span></div>
      <div v-if="selFlow.dir !== 'ab'" class="srow"><label>B → A 速率</label><input class="ci" v-model.number="selFlow.rateBaBps" @change="scene.dirty = true" /><span class="u">bps</span></div>
      <div class="srow"><label>可用度要求</label><input class="ci" v-model.number="selFlow.availReqPct" placeholder="留空不比" @change="scene.dirty = true" /><span class="u">%</span></div>
      <div class="srow"><label>时延要求</label><input class="ci" v-model.number="selFlow.latReqMs" placeholder="留空不比" @change="scene.dirty = true" /><span class="u">ms</span></div>

      <template v-if="flowRes">
        <div v-for="d in flowRes.dirs" :key="d.dir" class="segbox">
          <div class="segh">{{ d.dir === 'ab' ? flowRes.aName + ' → ' + flowRes.bName : flowRes.bName + ' → ' + flowRes.aName }}</div>
          <div v-if="!d.ok" class="errc" v-for="(e, i) in d.errors" :key="i">{{ e }}</div>
          <template v-else>
            <div class="kv"><span>余量（最弱 RF 段）</span><b :class="{ neg: d.marginDb < 0 }">{{ num(d.marginDb) }} dB</b></div>
            <div class="kv"><span>最弱段</span><b class="tx">{{ d.weakestLabel || '—' }}</b></div>
            <div class="kv"><span>可承载速率</span><b :class="{ neg: d.rateOkRatio != null && d.rateOkRatio < 1 }">{{ fmtRate(d.capacityBps) }}</b></div>
            <div class="kv"><span>瓶颈段</span><b class="tx">{{ d.bottleneckLabel || '—' }}</b></div>
            <div class="kv"><span>时延</span><b>{{ num(d.latencyMs, 2) }} ms</b></div>
            <div class="kv"><span>可用度</span><b :class="{ neg: selFlow.availReqPct != null && d.availPct != null && d.availPct < selFlow.availReqPct }">{{ num(d.availPct, 4) }} %</b></div>
            <div class="segt">
              <div v-for="(s, i) in d.segments" :key="i" class="str">
                <span class="stier" :class="s.tier"></span>
                <span class="slbl">{{ s.label }}</span>
                <span class="sval" :class="{ neg: s.tier === 'power' && s.marginDb < 0 }">
                  {{ s.tier === 'power' ? num(s.marginDb) + ' dB' : (s.tier === 'contract' ? fmtRate(s.rateBps) : ((s.checks || []).length ? num(s.checks[0].actual, 1) + '/' + num(s.checks[0].limit, 1) + ' ' + s.checks[0].unit : '—')) }}
                </span>
              </div>
            </div>
            <div v-if="d.violations && d.violations.length" class="vio">
              <div v-for="(v, i) in d.violations" :key="i"><span>{{ v.seg }} · {{ v.label }}</span><b>{{ num(v.actual, 1) }} / {{ v.low ? '≥' : '≤' }} {{ num(v.limit, 1) }} {{ v.unit }}</b></div>
            </div>
            <div v-if="d.quotedSegs && d.quotedSegs.length" class="est">契约段（数值为承诺值）：{{ d.quotedSegs.join('、') }}</div>
            <div v-for="(w, i) in d.warn" :key="'w' + i" class="warnc">{{ w }}</div>
          </template>
        </div>
        <div v-if="flowRes.summary.rttMs != null" class="kv"><span>往返时延</span><b>{{ num(flowRes.summary.rttMs, 1) }} ms</b></div>
      </template>
    </template>
  </div>

  <!-- ═══ 未选中：全场景汇总 ═══ -->
  <div v-else-if="scene.result" class="sec">
    <div class="sect"><span>结果</span><span class="lnk" @click="scene.sel = null">{{ scene.result.flows.length }} 条流</span></div>
    <div v-for="f in scene.result.flows" :key="f.id" class="segbox">
      <div class="segh">{{ f.name }}<span class="dirtag">{{ f.dir === 'bidir' ? '双向' : '单向' }}</span></div>
      <div class="kv"><span>余量</span><b :class="{ neg: f.summary.marginDb < 0 }">{{ num(f.summary.marginDb) }} dB</b><em>{{ f.summary.marginDir === 'ab' ? '正向' : '返向' }}</em></div>
      <div class="kv"><span>可用度</span><b>{{ num(f.summary.availPct, 4) }} %</b></div>
      <div class="kv" v-if="f.summary.rttMs != null"><span>往返时延</span><b>{{ num(f.summary.rttMs, 1) }} ms</b></div>
      <div class="kv" v-else><span>时延</span><b>{{ num(f.summary.latencyMs, 1) }} ms</b></div>
      <div class="kv"><span>速率裕度</span><b :class="{ neg: f.summary.rateOkRatio != null && f.summary.rateOkRatio < 1 }">{{ f.summary.rateOkRatio == null ? '—' : (f.summary.rateOkRatio).toFixed(2) + '×' }}</b></div>
    </div>
    <div v-for="(e, i) in scene.result.errors" :key="i" class="errc">{{ e }}</div>
  </div>
</template>

<style scoped>
.sec { padding: 12px 16px; border-bottom: 1px solid var(--border); font-size: var(--fs-3); }
.sec > * + * { margin-top: 6px; }
.srow { --srow-lab: 82px; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
.srow label { color: var(--text-muted); min-width: var(--srow-lab); max-width: 100%; flex: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.srow .ci, .srow select { flex: 1; min-width: 0; border: 1px solid var(--field-border); background-color: var(--field-bg); padding: 3px 6px; font-size: var(--fs-3); outline: none; color: var(--text); }
.srow select { min-width: 116px; }
.srow .ci.ov { border-color: var(--accent-ui); }
.srow .u { flex: none; min-width: 34px; text-align: right; color: var(--text-muted); font-variant-numeric: tabular-nums; }
.srow .rv { flex: 1; }
.sect { display: flex; align-items: center; gap: 6px; color: var(--text-muted); }
.sect.sub { margin-top: 10px; padding-top: 6px; border-top: 1px solid var(--border); }
.sect .lnk { margin-left: auto; color: var(--accent); cursor: pointer; }
.ihd { font-weight: 600; }
.ihd em { font-style: normal; color: var(--text-faint); font-size: var(--fs-2, 11px); margin-left: 6px; cursor: help; text-decoration: underline dotted; }
.tag { flex: none; font-size: 10px; padding: 0 5px; border: 1px solid var(--border-strong); color: var(--text-muted); border-radius: var(--r-pill, 9px); }
.tag.satellite { color: var(--accent-ui); border-color: var(--accent-ui); }
.tag.contract { color: var(--warn); border-color: var(--warn); }
.tag.lib { color: var(--accent-ui); border-color: var(--accent-ui); }
.seg3 { display: inline-flex; border: 1px solid var(--field-border); border-radius: var(--r-1, 2px); overflow: hidden; }
.seg3 > span { padding: 2px 11px; cursor: pointer; color: var(--text-muted); user-select: none; }
.seg3 > span + span { border-left: 1px solid var(--field-border); }
.seg3 > span.on { background: var(--accent-ui); color: var(--bg); }
.satlist { max-height: 168px; overflow-y: auto; border: 1px solid var(--border); }
.satli { padding: 3px 7px; cursor: pointer; border-bottom: 1px solid var(--border); }
.satli:hover { background: var(--accent-ui-wash); }
.satn { display: block; }
.sati { display: block; color: var(--text-faint); font-size: var(--fs-2, 11px); font-variant-numeric: tabular-nums; }
.srow .lnk { flex: none; color: var(--accent); cursor: pointer; font-size: var(--fs-2, 11px); }
.kv { display: flex; align-items: baseline; gap: 8px; font-variant-numeric: tabular-nums; }
.kv > span { color: var(--text-muted); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kv > b { font-weight: 600; }
.kv > b.tx { font-weight: 400; color: var(--text-muted); font-size: var(--fs-2, 11px); }
.kv > em { font-style: normal; color: var(--text-faint); font-size: var(--fs-2, 11px); }
.kv .neg, .neg { color: var(--danger); }
.led { display: flex; gap: 8px; font-size: var(--fs-2, 11px); color: var(--text-faint); font-variant-numeric: tabular-nums; }
.led > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qt { font-style: normal; font-size: 10px; color: var(--warn); border: 1px solid var(--warn); padding: 0 3px; border-radius: 2px; margin-left: 4px; }
.est { color: var(--text-faint); font-size: var(--fs-2, 11px); line-height: 1.5; }
.warnc { color: var(--warn); font-size: var(--fs-2, 11px); line-height: 1.5; }
.errc { color: var(--danger); font-size: var(--fs-2, 11px); line-height: 1.5; }
.segbox { border: 1px solid var(--border); padding: 7px 9px; }
.segbox > * + * { margin-top: 4px; }
.segh { display: flex; align-items: center; gap: 6px; font-weight: 600; }
.dirtag { margin-left: auto; font-size: 10px; color: var(--text-faint); }
.segt { border-top: 1px solid var(--border); padding-top: 4px; }
.str { display: flex; align-items: center; gap: 6px; font-size: var(--fs-2, 11px); }
.stier { width: 3px; height: 12px; flex: none; background: var(--border-strong); }
.stier.satellite { background: var(--accent-ui); } .stier.contract { background: var(--warn); } .stier.power { background: var(--text); }
.slbl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); }
.sval { flex: none; font-variant-numeric: tabular-nums; }
.vio { border-top: 1px solid var(--border); padding-top: 4px; }
.vio > div { display: flex; gap: 8px; font-size: var(--fs-2, 11px); color: var(--danger); font-variant-numeric: tabular-nums; }
.vio > div > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
