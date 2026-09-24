<script setup>
// 卫星页「姿态律」（DESIGN2 §1 / 任务书 §6.2；数学在 packages/core/models/attitude.mjs，参数口径在 schema.mjs ATTITUDE_PARAM_DEFAULTS）：
//   nadir 对地（可加固定偏航）· yawSteer 偏航导引（太阳翼轴 ⟂ 太阳）· sun 指定本体轴对日 · inertial 固定惯性姿态（TEME）·
//   target 指定本体轴指向地球站 / 另一颗星。参数改一格即写回绑定（400 ms 防抖落盘）；切律不丢别的律填过的参数（schema 照留）。
import { ref, computed, inject, watch } from 'vue'
import Icon from '../../components/Icon.vue'
import MdSec from '../MdSec.vue'
import NumIn from '../NumIn.vue'
import CityPicker from '../../components/CityPicker.vue'
import SatKeyPicker from './SatKeyPicker.vue'
import { LAWS, LAW_LABEL, AXIS_OPTIONS, axisKeyOf, SECONDARY_LABEL } from '../mountLogic.js'
import { ATTITUDE_SECONDARY, normalizeAttitude } from '@core/models/schema.mjs'
import { keyLabel } from '../satStore.js'

const sat = inject('sat')
const S = sat.st
const att = computed(() => { void S.rev; return S.binding ? S.binding.attitude : null })
const law = computed(() => (att.value ? att.value.law : 'nadir'))
const P = computed(() => (att.value && att.value.params) || {})

function setAtt(fn) {
  sat.edit((x) => {
    const a = { law: x.attitude.law, params: { ...(x.attitude.params || {}) } }
    fn(a)
    x.attitude = normalizeAttitude(a).attitude
  })
}
function setLaw(v) { setAtt((a) => { a.law = v }) }
function setParam(k, v) { setAtt((a) => { if (v === null || v === undefined || v === '') delete a.params[k]; else a.params[k] = v }) }
const axisKey = (k, def) => axisKeyOf(P.value[k]) || def
function setAxis(k, key) { const o = AXIS_OPTIONS.find((a) => a.key === key); setParam(k, o ? o.v.slice() : null) }

// inertial：欧拉角（3-2-1，度）与四元数二选一——给了 q 就以 q 为准
const inMode = computed(() => (Array.isArray(P.value.q) ? 'q' : 'euler'))
const euler = computed(() => { const e = P.value.eulerDeg || {}; return Array.isArray(e) ? { yaw: e[0], pitch: e[1], roll: e[2] } : { yaw: e.yaw ?? 0, pitch: e.pitch ?? 0, roll: e.roll ?? 0 } })
function setEuler(k, v) { setAtt((a) => { delete a.params.q; a.params.eulerDeg = { ...euler.value, [k]: v == null ? 0 : v } }) }
function setQ(i, v) {
  setAtt((a) => {
    const q = Array.isArray(a.params.q) ? a.params.q.slice() : [0, 0, 0, 1]
    q[i] = v == null ? 0 : v
    const n = Math.hypot(...q)
    if (n > 0) a.params.q = q.map((x) => x / n)
    delete a.params.eulerDeg
  })
}
function setInMode(m) { setAtt((a) => { if (m === 'q') { a.params.q = [0, 0, 0, 1]; delete a.params.eulerDeg } else { delete a.params.q; a.params.eulerDeg = { yaw: 0, pitch: 0, roll: 0 } } }) }

// target：地球站（CityPicker / 手填）或另一颗星
const tgt = computed(() => P.value.target || null)
const tgtKind = computed(() => (tgt.value ? tgt.value.kind : 'station'))
function setTarget(t) { setParam('target', t) }
function setTgtKind(k) {
  if (k === 'station') setTarget({ kind: 'station', latDeg: 39.9, lonDeg: 116.4, altM: 0, name: '' })
  else setTarget(null)
  tgtKindUi.value = k
}
// 点了「卫星」、还没选星时（target 为空）界面先切到选星框；有了真目标就跟数据走。组件常驻（KeepAlive），换星必须复位
const tgtKindUi = ref('')
const kindShown = computed(() => tgtKindUi.value || tgtKind.value)
watch(() => S.satKey, () => { tgtKindUi.value = ''; tgtPicked.value = { key: '', label: '' } })
watch(() => (tgt.value ? tgt.value.kind : ''), (k) => { if (k) tgtKindUi.value = '' })
function setStation(k, v) {
  const t = tgt.value && tgt.value.kind === 'station' ? { ...tgt.value } : { kind: 'station', latDeg: 0, lonDeg: 0, altM: 0 }
  t[k] = v == null ? 0 : v
  if (k !== 'name') delete t.name
  setTarget(t)
}
const cityOpen = ref(false)
function onCity(items) {
  const c = items && items[0]
  if (!c) return
  setTarget({ kind: 'station', latDeg: Number(c.lat), lonDeg: Number(c.lon), altM: 0, name: String(c.name || '') })
  cityOpen.value = false
}
// 目标星的显示名：刚在选星框里选的那颗用选星时的名字；别的（换星 / 撤销 / 读回来的）按键现算
const tgtPicked = ref({ key: '', label: '' })
const tgtSatLabel = computed(() => {
  const k = tgt.value && tgt.value.kind === 'sat' ? tgt.value.satKey : ''
  if (!k) return ''
  return tgtPicked.value.key === k && tgtPicked.value.label ? tgtPicked.value.label : keyLabel(k)
})
function onTgtSat(o) { tgtPicked.value = { key: o.satKey, label: o.label || '' }; setTarget({ kind: 'sat', satKey: o.satKey }) }
const summary = computed(() => LAW_LABEL[law.value] || law.value)
</script>

<template>
  <MdSec id="s-att" title="姿态律" :summary="summary" tip="本体系：+X 速度、+Y 补全右手、+Z 天底；姿态律给出本体三轴在地固系下的朝向（逐时刻），挂点视轴随之转">
    <template v-if="att">
      <div class="srow">
        <label>律</label>
        <select class="ci sa-sel" :value="law" @change="setLaw($event.target.value)">
          <option v-for="l in LAWS" :key="l" :value="l">{{ LAW_LABEL[l] }}</option>
        </select>
      </div>
      <!-- nadir -->
      <div v-if="law === 'nadir'" class="srow">
        <label title="绕本体 +Z（天底）的固定偏航角，右手">偏航偏置</label>
        <NumIn :model-value="P.yawBiasDeg ?? 0" :min="-360" :max="360" :sig="6" @commit="(v) => setParam('yawBiasDeg', v || null)" />
        <span class="u">°</span>
      </div>
      <!-- yawSteer -->
      <div v-else-if="law === 'yawSteer'" class="srow">
        <label title="偏航导引后太阳落在本体 +X 还是 −X 一侧的半平面（太阳翼轴 ±Y 始终垂直太阳）">太阳侧</label>
        <div class="lbu-seg sa-seg">
          <button :class="{ on: (P.sunSide || '+X') === '+X' }" @click="setParam('sunSide', '+X')">+X</button>
          <button :class="{ on: P.sunSide === '-X' }" @click="setParam('sunSide', '-X')">−X</button>
        </div>
      </div>
      <!-- sun / target 的主轴与次约束 -->
      <template v-else-if="law === 'sun' || law === 'target'">
        <div class="srow">
          <label :title="law === 'sun' ? '精确指向太阳的本体轴' : '精确指向目标的本体轴'">指向轴</label>
          <select class="ci sa-ax" :value="axisKey('axis', law === 'sun' ? '-Z' : '+Z')" @change="setAxis('axis', $event.target.value)">
            <option v-for="a in AXIS_OPTIONS" :key="a.key" :value="a.key">{{ a.key.replace('-', '−') }}</option>
          </select>
          <label class="sa-l2" title="主轴对准后剩下的绕主轴转角由次约束定：次轴落在「主方向–次方向」平面里、朝次方向一侧">次约束</label>
          <select class="ci sa-ax" :value="P.secondary || ''" @change="setParam('secondary', $event.target.value || null)">
            <option value="">缺省</option>
            <option v-for="k in ATTITUDE_SECONDARY" :key="k" :value="k">{{ SECONDARY_LABEL[k] || k }}</option>
          </select>
        </div>
        <template v-if="law === 'target'">
          <div class="srow">
            <label>目标</label>
            <div class="lbu-seg sa-seg">
              <button :class="{ on: kindShown === 'station' }" @click="setTgtKind('station')">地球站</button>
              <button :class="{ on: kindShown === 'sat' }" @click="setTgtKind('sat')">卫星</button>
            </div>
          </div>
          <template v-if="kindShown === 'station'">
            <div class="srow">
              <label title="WGS-84 大地坐标">站址</label>
              <NumIn :model-value="tgt && tgt.kind === 'station' ? tgt.latDeg : null" :min="-90" :max="90" :sig="8" title="纬度（°，北正）" @commit="(v) => setStation('latDeg', v)" />
              <NumIn :model-value="tgt && tgt.kind === 'station' ? tgt.lonDeg : null" :min="-360" :max="360" :sig="8" title="经度（°，东正）" @commit="(v) => setStation('lonDeg', v)" />
              <button class="lb-mini lb-mini-ico" title="从城市库选" @click="cityOpen = true"><Icon name="map-pin" :size="13" /></button>
            </div>
            <div v-if="tgt && tgt.name" class="md-kvs"><div class="md-kv"><span class="k">站名</span><span class="v sa-name" data-i18n-skip>{{ tgt.name }}</span></div></div>
          </template>
          <div v-else class="srow">
            <label>目标星</label>
            <SatKeyPicker :model-value="tgt && tgt.kind === 'sat' ? tgt.satKey : ''" :label="tgtSatLabel" @pick="onTgtSat" />
          </div>
        </template>
      </template>
      <!-- inertial -->
      <template v-else-if="law === 'inertial'">
        <div class="srow">
          <label title="本体 → TEME 惯性系的固定旋转（TEME 与 J2000 差岁差 + 章动，2026 年约 0.36°）">给法</label>
          <div class="lbu-seg sa-seg">
            <button :class="{ on: inMode === 'euler' }" @click="setInMode('euler')">欧拉角</button>
            <button :class="{ on: inMode === 'q' }" @click="setInMode('q')">四元数</button>
          </div>
        </div>
        <div v-if="inMode === 'euler'" class="srow">
          <label title="3-2-1 顺序：先偏航（绕 Z）、再俯仰（绕 Y）、最后滚转（绕 X），度">偏航 / 俯仰 / 滚转</label>
          <div class="md-v3">
            <NumIn :model-value="euler.yaw" :min="-360" :max="360" :sig="6" @commit="(v) => setEuler('yaw', v)" />
            <NumIn :model-value="euler.pitch" :min="-360" :max="360" :sig="6" @commit="(v) => setEuler('pitch', v)" />
            <NumIn :model-value="euler.roll" :min="-360" :max="360" :sig="6" @commit="(v) => setEuler('roll', v)" />
          </div>
        </div>
        <div v-else class="srow">
          <label title="[x, y, z, w]，改完自动归一">q</label>
          <div class="sa-q4">
            <NumIn v-for="i in [0, 1, 2, 3]" :key="i" :model-value="P.q ? P.q[i] : (i === 3 ? 1 : 0)" :min="-1" :max="1" :sig="7" @commit="(v) => setQ(i, v)" />
          </div>
        </div>
      </template>
    </template>
    <CityPicker v-if="cityOpen" single title="地球站" @add="onCity" @close="cityOpen = false" />
  </MdSec>
</template>

<style scoped>
.sa-sel { flex: 1 1 160px; min-width: 0 !important; }
.sa-seg { flex: 1 1 auto; display: flex; }
.sa-seg > button { flex: 1 1 auto; height: var(--h-ctl); }
.sa-ax { flex: 1 1 70px; min-width: 0 !important; }
.sa-l2 { flex: none; min-width: 0 !important; margin-left: 4px; }
.sa-q4 { flex: 1 1 0; min-width: 160px; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 3px; }
.sa-name { font-family: var(--font-ui) !important; }
.srow :deep(.md-num) { flex: 1 1 60px; }
</style>
