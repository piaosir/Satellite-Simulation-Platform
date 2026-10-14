<script setup>
// 「天线 boresight · 姿态 + 挂点」里的本体姿态律（对地 / 对星覆盖分析共用：挂在 GrdSetSections.vue 的 att 分支里）。
//
// 改的是【这颗星】的姿态律，不是本天线的设置 —— 一颗星只有一个本体姿态：本星全部天线、3D 模型、模型工作台「卫星」页
// 读的是同一份绑定（宿主经 grd.setBodyAttitude → bodyRuntime.setAttitude 写回，先落本地缓存再落盘）。
// 五律全给（与 packages/core/models/attitude.mjs 一一对应）：
//   对地定向  滚转 / 俯仰 / 偏航偏置（相对轨道系，3-2-1）
//   偏航导引  太阳侧
//   对日定向  指向轴 + 次约束 + 次约束轴
//   惯性定向  欧拉角（3-2-1）或四元数（本体 → TEME），换给法按当前姿态互换
//   对目标定向 目标（地球站 / 卫星 / 空间点）+ 指向轴 + 次约束 + 次约束轴
// 编辑口径在 viz/models/attEdit.js（切律不丢参数、切到目标 / 惯性律按此刻姿态补内容、偏置 0 不落键）。
// 数字框一律 NumBox（草稿 + 迟提交）：本组件随覆盖重算频繁重渲染，直接 :value 会吞掉正在打的数（memory 输入框跳变陷阱）。
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
import NumBox from './NumBox.vue'
import CityPicker from './CityPicker.vue'
import * as AE from '../viz/models/attEdit.js'
import { pointFallbackName, stationFallbackName } from '../shared/markerNames.js'

const props = defineProps({
  grd: { type: Object, required: true },            // useGrdCoverage 活实例（bodyAttitude / setBodyAttitude / bodyAttSeed … 转宿主 hooks）
  // 目标星搜索（宿主注入，全量：星座目录 + 卫星组 + 自定义星座），同 GrdSetSections 的对星跟踪：
  //   async (q, limit, excludeIds) => { items: [{ name, noradId, group, tag }], total }
  satSearch: { type: Function, default: null },
  // 三个偏置此刻各推动视轴读数的哪个量：{ roll, pitch, yaw } ∈ 'az' | 'el' | 'psi'（宿主随读数行一起算好，见 coverage.attBiasTags）
  axisTags: { type: Object, default: null }
})
const grd = props.grd
const { LAWS, LAW_NAMES, SECONDARIES, SECONDARY_NAMES, AXES, axisLabel } = AE

const body = computed(() => (typeof grd.bodyAttitude === 'function' ? grd.bodyAttitude() : null))   // { satKey, attitude } | null
const att = computed(() => AE.attOf(body.value && body.value.attitude))
const law = computed(() => att.value.law)
const P = computed(() => att.value.params)
const err = ref('')
const seed = () => (typeof grd.bodyAttSeed === 'function' ? grd.bodyAttSeed() : null)
function put(nextAtt) {
  if (!body.value || typeof grd.setBodyAttitude !== 'function') return
  let r = null
  try { r = grd.setBodyAttitude(nextAtt) } catch { r = null }
  if (r && typeof r.then === 'function') r.then((x) => { err.value = x && x.ok === false && x.code !== 'locked' ? '未能写入绑定表。' : '' }).catch(() => { err.value = '未能写入绑定表。' })
}
watch(() => grd.active.value, () => { err.value = ''; tgtKindUi.value = ''; bq.value = ''; picked.value = { key: '', label: '' } })

const r6 = (v) => (Number.isFinite(+v) && v !== null && v !== '' ? +(+v).toFixed(6) : null)
const bias = (k) => r6(P.value[k] ?? 0)
// 偏置标签上的读数标注：用读数行同一套符号（Az / El / ψ），按此刻几何取 —— 赤道 GEO 上滚转 → El、俯仰 → Az，极轨对调
const AX_SYM = { az: 'Az', el: 'El', psi: 'ψ' }
const AX_TIP = { az: '视轴方位 Az', el: '视轴俯仰 El', psi: '绕视轴转角 ψ' }
const axTag = (k) => { const v = props.axisTags && props.axisTags[k]; return AX_SYM[v] ? v : '' }

// ---- 对日 / 对目标：主轴 + 次约束 ----
const axisSel = computed(() => AE.primaryAxisKey(law.value, P.value))           // '' = 自定义方向（JSON 导入的任意轴）
const secSel = computed(() => (SECONDARIES.includes(P.value.secondary) ? P.value.secondary : ''))
const secDefName = computed(() => SECONDARY_NAMES[AE.defaultSecondary(law.value, P.value)])
const sAxSel = computed(() => (P.value.secondaryAxis === undefined || P.value.secondaryAxis === null ? '' : (AE.axisKeyOf(P.value.secondaryAxis) || '__custom')))
const sAxDef = computed(() => axisLabel(AE.defaultSecondaryAxisKey(AE.effectiveSecondary(law.value, P.value))))
const primV = computed(() => AE.primaryAxisVec(law.value, P.value))
const parallelToPrim = (k) => { const v = AE.axisVec(k), p = primV.value; return Math.abs(v[0] * p[0] + v[1] * p[1] + v[2] * p[2]) > 1 - 1e-9 }
const conflict = computed(() => AE.secondaryConflict(law.value, P.value))

// ---- 惯性定向 ----
const inMode = computed(() => AE.inertialModeOf(P.value))
const eul = computed(() => AE.eulerOf(P.value))
const quat = computed(() => AE.quatOf(P.value))

// ---- 对目标定向：目标 ----
const tv = computed(() => AE.targetView(P.value))
// 点了「卫星」、还没选星时（目标仍是原来那个地球站 / 空间点）界面先切到选星框；选中后跟数据走
const tgtKindUi = ref('')
const kindShown = computed(() => tgtKindUi.value || tv.value.kind || 'station')
watch(() => tv.value.kind, (k) => { if (k && k === tgtKindUi.value) tgtKindUi.value = '' })
function setTgtKind(k) {
  if (k === 'sat') { tgtKindUi.value = tv.value.kind === 'sat' ? '' : 'sat'; return }
  tgtKindUi.value = ''
  if (k === 'station' && tv.value.kind !== 'station') put(AE.withStation(att.value, null, seed()))
  else if (k === 'ecef' && tv.value.kind !== 'ecef') put(AE.withSpacePoint(att.value, null, seed()))
}
const setStation = (patch) => put(AE.withStation(att.value, patch, seed()))
const setPoint = (patch) => put(AE.withSpacePoint(att.value, patch, seed()))

// 地球站：城市库 + 主窗口的点标记 / 地球站（同源 localStorage，与链路预算「导入站址」同一份附加分区）
const cityOpen = ref(false)
function markerSections() {
  let mk = {}
  try { mk = JSON.parse(localStorage.getItem('globe3d/markers') || 'null') || {} } catch { mk = {} }
  const groups = []
  const pts = (mk.points || []).map((p, i) => ({ id: 'pt:' + (p.id || i), name: String(p.name || '').trim() || pointFallbackName(i), lon: p.lon, lat: p.lat }))
  const sts = (mk.stations || []).map((s, i) => ({ id: 'st:' + (s.id || i), name: String(s.name || '').trim() || stationFallbackName(i), lon: s.lon, lat: s.lat }))
  if (sts.length) groups.push({ id: 'stations', name: '地球站', nameEn: 'Earth Stations', items: sts })
  if (pts.length) groups.push({ id: 'points', name: '点标记', nameEn: 'Points', items: pts })
  return groups.length ? [{ label: '标记', labelEn: 'Markers', groups }] : []
}
const cityExtra = ref([])
function openCity() { cityExtra.value = markerSections(); cityOpen.value = true }
function onCity(items) {
  const c = items && items[0]
  cityOpen.value = false
  if (!c || !Number.isFinite(+c.lat) || !Number.isFinite(+c.lon)) return
  setStation({ lat: +c.lat, lon: +c.lon, name: String(c.name || '') })
}

// 卫星：全量搜索（同对星跟踪）—— 防抖 200 ms + 序号守卫；源星自己排除在外（自己指自己定不出方向）
const picked = ref({ key: '', label: '' })
const tgtLabel = computed(() => {
  const k = tv.value.kind === 'sat' ? tv.value.satKey : ''
  if (!k) return ''
  if (picked.value.key === k && picked.value.label) return picked.value.label
  return (typeof grd.attKeyLabel === 'function' && grd.attKeyLabel(k)) || k
})
const selfIds = computed(() => {
  const f = String(grd.active.value || '').split('|')[0]
  const n = f ? grd.sats.value.find((x) => x.folder === f) : null
  return n && n.noradId ? ['n:' + n.noradId] : []
})
const bq = ref('')
const bcand = ref([])
const bTotal = ref(0)
const bBusy = ref(false)
let bSeq = 0, bTimer = null
watch(bq, (v) => {
  const q = String(v || '').trim()
  if (bTimer) { clearTimeout(bTimer); bTimer = null }
  bSeq++
  if (!q) { bcand.value = []; bTotal.value = 0; bBusy.value = false; return }
  bBusy.value = true
  bTimer = setTimeout(async () => {
    const seq = bSeq
    let r = { items: [], total: 0 }
    try { r = (props.satSearch ? await props.satSearch(q, 60, selfIds.value) : null) || { items: [], total: 0 } } catch { r = { items: [], total: 0 } }
    if (seq !== bSeq) return
    bcand.value = r.items || []; bTotal.value = r.total || 0; bBusy.value = false
  }, 200)
})
onBeforeUnmount(() => { if (bTimer) clearTimeout(bTimer) })
function pickTgtSat(e) {
  const key = typeof grd.attTargetKey === 'function' ? grd.attTargetKey(e) : null
  bq.value = ''
  if (!key) return
  picked.value = { key, label: e.name || '' }
  tgtKindUi.value = ''
  put(AE.withTargetSat(att.value, key))
}
</script>

<template>
  <div v-if="body" class="gaf">
    <div class="srow"><label title="卫星本体的姿态律：本星全部天线、3D 模型与模型工作台「卫星」页共用同一份">姿态律</label>
      <select :value="law" @change="put(AE.withLaw(att, $event.target.value, seed()))">
        <option v-for="l in LAWS" :key="l" :value="l">{{ LAW_NAMES[l] }}</option>
      </select>
    </div>

    <!-- 对地定向：相对轨道系的姿态偏置（3-2-1） -->
    <template v-if="law === 'nadir'">
      <div class="srow"><label title="绕本体 +X（沿迹）的固定滚转，右手；正值使视轴 +Z 向 −Y 侧倾（赤道顺行轨道即向北）">滚转偏置<span v-if="axTag('roll')" class="axt" :title="AX_TIP[axTag('roll')]">{{ AX_SYM[axTag('roll')] }}</span></label>
        <NumBox class="ci" :model-value="bias('rollBiasDeg')" :min="-180" :max="180" :step="0.01" @commit="(v) => put(AE.withBias(att, 'rollBiasDeg', v))" /><span class="u">°</span>
      </div>
      <div class="srow"><label title="绕本体 +Y 的固定俯仰，右手；正值使视轴 +Z 向 +X（沿迹）侧倾">俯仰偏置<span v-if="axTag('pitch')" class="axt" :title="AX_TIP[axTag('pitch')]">{{ AX_SYM[axTag('pitch')] }}</span></label>
        <NumBox class="ci" :model-value="bias('pitchBiasDeg')" :min="-180" :max="180" :step="0.01" @commit="(v) => put(AE.withBias(att, 'pitchBiasDeg', v))" /><span class="u">°</span>
      </div>
      <div class="srow"><label title="绕本体 +Z（天底）的固定偏航，右手；三个偏置按 3-2-1 顺序施加：先偏航、再俯仰、后滚转">偏航偏置<span v-if="axTag('yaw')" class="axt" :title="AX_TIP[axTag('yaw')]">{{ AX_SYM[axTag('yaw')] }}</span></label>
        <NumBox class="ci" :model-value="bias('yawBiasDeg')" :min="-180" :max="180" :step="0.01" @commit="(v) => put(AE.withBias(att, 'yawBiasDeg', v))" /><span class="u">°</span>
      </div>
    </template>

    <!-- 偏航导引 -->
    <div v-else-if="law === 'yawSteer'" class="srow"><label title="偏航导引后太阳所在的本体半平面（太阳翼轴 ±Y 始终垂直于太阳方向）">太阳侧</label>
      <div role="radiogroup" class="seg">
        <button type="button" role="radio" :aria-checked="!!(P.sunSide !== '-X')" class="sg" :class="{ on: P.sunSide !== '-X' }" @click="put(AE.withParam(att, 'sunSide', null))">+X</button>
        <button type="button" role="radio" :aria-checked="!!(P.sunSide === '-X')" class="sg" :class="{ on: P.sunSide === '-X' }" @click="put(AE.withParam(att, 'sunSide', '-X'))">−X</button>
      </div>
    </div>

    <!-- 惯性定向：欧拉角 / 四元数（本体 → TEME） -->
    <template v-else-if="law === 'inertial'">
      <div class="srow"><label title="本体 → TEME 惯性系的固定旋转（TEME 与 J2000 相差岁差与章动，2026 年约 0.36°）">定义方式</label>
        <div role="radiogroup" class="seg">
          <button type="button" role="radio" :aria-checked="!!(inMode === 'euler')" class="sg" :class="{ on: inMode === 'euler' }" @click="inMode === 'euler' || put(AE.withInertialMode(att, 'euler'))">欧拉角</button>
          <button type="button" role="radio" :aria-checked="!!(inMode === 'q')" class="sg" :class="{ on: inMode === 'q' }" @click="inMode === 'q' || put(AE.withInertialMode(att, 'q'))">四元数</button>
        </div>
      </div>
      <template v-if="inMode === 'euler'">
        <div class="srow"><label title="3-2-1 顺序：先偏航（绕 Z），再俯仰（绕新 Y），最后滚转（绕新 X）">偏航角</label>
          <NumBox class="ci" :model-value="r6(eul.yaw)" :min="-180" :max="180" :step="0.1" @commit="(v) => put(AE.withEuler(att, 'yaw', v))" /><span class="u">°</span>
        </div>
        <div class="srow"><label title="3-2-1 顺序：先偏航（绕 Z），再俯仰（绕新 Y），最后滚转（绕新 X）">俯仰角</label>
          <NumBox class="ci" :model-value="r6(eul.pitch)" :min="-90" :max="90" :step="0.1" @commit="(v) => put(AE.withEuler(att, 'pitch', v))" /><span class="u">°</span>
        </div>
        <div class="srow"><label title="3-2-1 顺序：先偏航（绕 Z），再俯仰（绕新 Y），最后滚转（绕新 X）">滚转角</label>
          <NumBox class="ci" :model-value="r6(eul.roll)" :min="-180" :max="180" :step="0.1" @commit="(v) => put(AE.withEuler(att, 'roll', v))" /><span class="u">°</span>
        </div>
      </template>
      <!-- 四个分量一行一个：挤在一行里每格只剩五十来像素，六位小数显示不全 -->
      <template v-else>
        <div v-for="(c, i) in ['x', 'y', 'z', 'w']" :key="c" class="srow"><label title="本体 → TEME 四元数 [x, y, z, w]；改任一分量后整体归一">q {{ c }}</label>
          <NumBox class="ci" :model-value="r6(quat[i])" :min="-1" :max="1" :step="0.01" @commit="(v) => put(AE.withQuat(att, i, v))" />
        </div>
      </template>
    </template>

    <!-- 对目标定向：目标 -->
    <template v-else-if="law === 'target'">
      <div class="srow"><label>目标</label>
        <div role="radiogroup" class="seg">
          <button type="button" role="radio" :aria-checked="!!(kindShown === 'station')" class="sg" :class="{ on: kindShown === 'station' }" title="WGS-84 大地坐标" @click="setTgtKind('station')">地球站</button>
          <button type="button" role="radio" :aria-checked="!!(kindShown === 'sat')" class="sg" :class="{ on: kindShown === 'sat' }" @click="setTgtKind('sat')">卫星</button>
          <button type="button" role="radio" :aria-checked="!!(kindShown === 'ecef')" class="sg" :class="{ on: kindShown === 'ecef' }" title="地心经纬度 + 高度（与手动「空间点」指向同一口径）" @click="setTgtKind('ecef')">空间点</button>
        </div>
      </div>
      <template v-if="kindShown === 'station'">
        <div class="srow"><label>地球站</label>
          <span class="tgtnm" data-i18n-skip>{{ tv.kind === 'station' && tv.name ? tv.name : '—' }}</span>
          <button type="button" class="ibtn sm" title="从城市库 / 标记中选择" @click="openCity"><Icon name="map-pin" :size="12" /></button>
        </div>
        <div class="srow"><label>纬度</label><NumBox class="ci" :model-value="tv.kind === 'station' ? r6(tv.lat) : null" :min="-90" :max="90" :step="0.1" @commit="(v) => setStation({ lat: v })" /><span class="u">°N</span></div>
        <div class="srow"><label>经度</label><NumBox class="ci" :model-value="tv.kind === 'station' ? r6(tv.lon) : null" :min="-180" :max="180" :step="0.1" @commit="(v) => setStation({ lon: v })" /><span class="u">°E</span></div>
        <div class="srow"><label>高度</label><NumBox class="ci" :model-value="tv.kind === 'station' ? r6(tv.altM) : null" :min="-12000" :max="100000000" :step="10" @commit="(v) => setStation({ altM: v })" /><span class="u">m</span></div>
      </template>
      <template v-else-if="kindShown === 'sat'">
        <div class="srow"><label>目标卫星</label>
          <span class="tgtnm" data-i18n-skip>{{ tgtLabel || '—' }}</span>
        </div>
        <div class="srow"><input class="ci search-field" v-model="bq" placeholder="搜索目标卫星：卫星名 / NORAD / 星座 / 卫星组" /></div>
        <div v-if="bq.trim()" class="sres">
          <div v-if="bBusy" class="sres-e">搜索中…</div>
          <div v-else-if="!bcand.length" class="sres-e">无匹配卫星。</div>
          <template v-else>
            <div class="sres-list">
              <div v-for="e in bcand" :key="e.noradId || e.name" class="sitem" @click="pickTgtSat(e)">
                <div class="nm" :title="e.name" data-i18n-skip>{{ e.name }}</div>
                <div class="sub">{{ e.tag }}<template v-if="e.noradId && !e.syn"><template v-if="e.tag"> · </template>NORAD {{ e.noradId }}</template></div>
              </div>
            </div>
            <div class="sres-n">{{ bTotal > bcand.length ? `命中 ${bTotal} 颗 · 列出前 ${bcand.length}` : `${bTotal} 颗` }}</div>
          </template>
        </div>
      </template>
      <template v-else>
        <div class="srow"><label>纬度</label><NumBox class="ci" :model-value="tv.kind === 'ecef' ? r6(tv.lat) : null" :min="-90" :max="90" :step="0.1" @commit="(v) => setPoint({ lat: v })" /><span class="u">°N</span></div>
        <div class="srow"><label>经度</label><NumBox class="ci" :model-value="tv.kind === 'ecef' ? r6(tv.lon) : null" :min="-180" :max="180" :step="0.1" @commit="(v) => setPoint({ lon: v })" /><span class="u">°E</span></div>
        <div class="srow"><label title="地心球面 r = 6378.137 km + 该值">高度</label><NumBox class="ci" :model-value="tv.kind === 'ecef' ? r6(tv.altKm) : null" :min="0" :max="10000000" :step="10" @commit="(v) => setPoint({ altKm: v })" /><span class="u">km</span></div>
      </template>
    </template>

    <!-- 对日 / 对目标：主轴 + 次约束 -->
    <template v-if="law === 'sun' || law === 'target'">
      <div class="srow"><label :title="law === 'sun' ? '精确指向太阳的本体轴' : '精确指向目标的本体轴'">指向轴</label>
        <select :value="axisSel" @change="put(AE.withAxis(att, 'axis', $event.target.value))">
          <option v-for="k in AXES" :key="k" :value="k">{{ axisLabel(k) }}</option>
          <option v-if="!axisSel" value="" disabled>自定义方向</option>
        </select>
      </div>
      <div class="srow"><label title="主轴对准后，绕主轴的剩余转角由次约束确定：次约束轴位于「主方向–次方向」平面内并朝向次方向一侧">次约束</label>
        <select :value="secSel" @change="put(AE.withParam(att, 'secondary', $event.target.value || null))">
          <option value="">缺省（{{ secDefName }}）</option>
          <option v-for="k in SECONDARIES" :key="k" :value="k" :disabled="law === 'sun' && k === 'sun'">{{ SECONDARY_NAMES[k] }}</option>
        </select>
      </div>
      <div class="srow"><label title="朝向次约束方向的本体轴">次约束轴</label>
        <select :value="sAxSel" @change="put(AE.withAxis(att, 'secondaryAxis', $event.target.value))">
          <option value="">缺省（{{ sAxDef }}）</option>
          <option v-for="k in AXES" :key="k" :value="k" :disabled="parallelToPrim(k)">{{ axisLabel(k) }}</option>
          <option v-if="sAxSel === '__custom'" value="__custom" disabled>自定义方向</option>
        </select>
      </div>
      <div v-if="conflict" class="aerr">次约束轴与指向轴平行。</div>
    </template>
    <div v-if="err" class="aerr">{{ err }}</div>
    <!-- 城市库 + 标记：挂到 body 上，免得被侧栏的滚动 / 裁剪容器框住 -->
    <Teleport to="body">
      <CityPicker v-if="cityOpen" single title="地球站" :extra="cityExtra" @add="onCity" @close="cityOpen = false" />
    </Teleport>
  </div>
</template>

<style scoped>
/* 行与控件的口径同 GrdSetSections.vue（宿主 scoped 样式进不来，这里自带一份；改动请对照，同 GaussModelFields.vue） */
.gaf > * + * { margin-top: 8px; }
.srow .ci, .srow select { flex: 1; min-width: 0; border: 1px solid var(--field-border); background-color: var(--field-bg); padding: 0 7px; font-size: var(--fs-3); outline: none; color: var(--text); }
.srow select { min-width: 116px; }
.srow .u { flex: none; min-width: 34px; text-align: right; color: var(--text-muted); font-variant-numeric: tabular-nums; }
/* 偏置标签尾的读数标注（Az / El / ψ）：标签列 70 px 之内放得下，不把这三行的输入框挤出列 */
.axt { margin-left: 5px; color: var(--accent-ui); font-size: var(--fs-2); }
.tgtnm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
.aerr { font-size: var(--fs-2); color: var(--warn); }
.sres { border: 1px solid var(--border); background: var(--bg); }
.sres-list { max-height: 210px; overflow-y: auto; }
.sitem { padding: 4px 8px; border-bottom: 1px solid var(--border); cursor: pointer; }
.sitem:last-child { border-bottom: 0; }
.sitem:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); }
.sitem .nm { font-size: var(--fs-3); color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sitem .sub { font-size: var(--fs-2); color: var(--text-faint); font-family: var(--font-mono); }
.sres-e { padding: 6px 8px; font-size: var(--fs-3); color: var(--text-faint); }
.sres-n { padding: 3px 8px; border-top: 1px solid var(--border); font-size: var(--fs-1); color: var(--text-faint); font-family: var(--font-mono); }
</style>
