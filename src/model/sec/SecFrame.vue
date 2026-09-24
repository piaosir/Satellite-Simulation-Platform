<script setup>
// 本体轴：模型系 → 本体系的四元数 q 与原点偏移 t。X / Y / Z ±90° 六个步进（bodyFrame.axisStep）+ 滚转 / 俯仰 / 偏航微调
// （相对最近的 90° 整数倍基准，3-2-1，bodyFrame.fineRotate —— 每次从基准重算，不在上一次结果上累加）+ 出厂映射 + 已核定。
// 「出厂映射」= 入库时的 q（wbLogic.factoryFrameQ，取法次序见那里）：本工具导出 / 转换的件（带 extras.satsim，含渲染端转的
// OBJ / STL / FBX）、STK 本机件、带 AGI 扩展、参数化件 → STK 映射；NASA、普通 glb / glTF、STEP / IGES / BREP → +Y 天顶。
// 不是一律 DEFAULT_Q_MODEL2BODY：那样未核的 NASA 件一点就绕本体 X 翻 180°。
// 改轴向时本体系里贴在几何上的量一起转（wbLogic.reframeMeta），改原点时一起平移（retranslateMeta）。
import { computed, inject } from 'vue'
import Icon from '../../components/Icon.vue'
import MdSec from '../MdSec.vue'
import NumIn from '../NumIn.vue'
import { axisStep, fineRotate, relativeEulerZYX, DEFAULT_Q_MODEL2BODY, quatCanonical, Q_STK } from '@core/models/bodyFrame.mjs'
import { reframeMeta, retranslateMeta, nearestAxisQuat, sameRotation, fmtNum, bodyBoxOfMeta, factoryFrameQ } from '../wbLogic.js'

const wb = inject('wb')
const getVp = inject('viewport')
const { cur } = wb
const m = computed(() => cur.meta)
const ro = computed(() => !cur.editable)
const q = computed(() => { const f = m.value && m.value.frame; return f && Array.isArray(f.q_model2body) ? f.q_model2body : DEFAULT_Q_MODEL2BODY.slice() })
const t = computed(() => { const f = m.value && m.value.frame; return f && Array.isArray(f.t_model2body) ? f.t_model2body : [0, 0, 0] })
const base = computed(() => nearestAxisQuat(q.value) || DEFAULT_Q_MODEL2BODY.slice())
const fine = computed(() => relativeEulerZYX(q.value, base.value) || { rollDeg: 0, pitchDeg: 0, yawDeg: 0 })
const factoryQ = computed(() => factoryFrameQ(m.value))
const isFactory = computed(() => sameRotation(q.value, factoryQ.value, 1e-6))
const factoryTip = computed(() => (sameRotation(factoryQ.value, Q_STK, 1e-6)
  ? '回到导入缺省：STK 映射（glTF +Y ↦ 本体 +Z 天底、+Z ↦ +X 速度）'
  : '回到导入缺省：+Y 天顶（glTF +Y ↦ 本体 −Z 天顶、+Z ↦ +X 速度）')
  + '\n按来源：本工具导出 / 转换的件（带 extras.satsim，含 OBJ / STL / FBX）、STK 本机件、带 AGI 扩展、参数化件 → STK 映射；'
  + 'NASA、普通 glb / glTF、STEP / IGES / BREP → +Y 天顶'
  + '\n本机导入 / 社区件：当前朝向最近的 90° 基准是上面两种之一就取它，否则按有无 AGI 扩展')

function setQ(qn) {
  if (!qn || sameRotation(qn, q.value, 1e-9)) return
  const q0 = q.value.slice()
  wb.edit((x) => {
    const n = reframeMeta(JSON.parse(JSON.stringify(x)), q0, qn)
    for (const key of Object.keys(n)) x[key] = n[key]
  }, { geom: true })
}
function step(axis, deg) { setQ(axisStep(q.value, axis, deg)) }
function setFine(key, v) {
  const f = { ...fine.value, [key]: v }
  setQ(fineRotate(base.value, f.rollDeg, f.pitchDeg, f.yawDeg))
}
function factory() { setQ(quatCanonical(factoryQ.value)) }
function setVerified(on) { wb.edit((x) => { x.frame = { ...(x.frame || {}), verified: !!on } }) }
function shift(delta) {
  if (!delta || delta.every((v) => v === 0)) return
  wb.edit((x) => {
    const n = retranslateMeta(JSON.parse(JSON.stringify(x)), delta)
    for (const key of Object.keys(n)) x[key] = n[key]
  }, { geom: true })
}
function setT(k, v) { const d = [0, 0, 0]; d[k] = v - t.value[k]; shift(d) }
const com = computed(() => { const mp = m.value && m.value.massProps; return mp && Array.isArray(mp.comBody) ? mp.comBody : null })
function originToCom() { if (com.value) shift(com.value.map((v) => -v)) }
function originToCenter() {
  const vp = getVp()
  const b = vp ? vp.bounds.bboxBody : bodyBoxOfMeta(m.value)
  if (b) shift([0, 1, 2].map((k) => -(b.min[k] + b.max[k]) / 2))
}
const STEPS = [['x', 90], ['x', -90], ['y', 90], ['y', -90], ['z', 90], ['z', -90]]
const AXC = { x: 'fr-x', y: 'fr-y', z: 'fr-z' }
</script>

<template>
  <MdSec id="m-frame" title="本体轴" :summary="isFactory ? '' : 'q ' + q.map((v) => fmtNum(v, 3)).join(', ')"
         tip="本体系：+X 速度、+Y 补全右手、+Z 天底（STK 缺省 Nadir 姿态同口径）">
    <template v-if="m">
      <div class="fr-steps">
        <button v-for="s in STEPS" :key="s[0] + s[1]" class="lb-mini fr-step" :class="AXC[s[0]]" :disabled="ro"
                :title="'模型在本体系里绕本体 ' + s[0].toUpperCase() + ' 轴转 ' + (s[1] > 0 ? '+' : '−') + '90°（挂点、部件、质心随模型一起转）'" @click="step(s[0], s[1])">
          <b>{{ s[0].toUpperCase() }}</b><span data-i18n-skip>{{ s[1] > 0 ? '+90°' : '−90°' }}</span>
        </button>
      </div>
      <div class="srow"><label title="绕本体 X 轴的微调（3-2-1：先偏航、再俯仰、后滚转；相对最近的 90° 整数倍朝向）">滚转</label>
        <NumIn :model-value="+fine.rollDeg.toFixed(6)" :min="-180" :max="180" :sig="6" :disabled="ro" @commit="(v) => setFine('rollDeg', v)" /><span class="u">°</span></div>
      <div class="srow"><label title="绕本体 Y 轴的微调">俯仰</label>
        <NumIn :model-value="+fine.pitchDeg.toFixed(6)" :min="-90" :max="90" :sig="6" :disabled="ro" @commit="(v) => setFine('pitchDeg', v)" /><span class="u">°</span></div>
      <div class="srow"><label title="绕本体 Z 轴的微调">偏航</label>
        <NumIn :model-value="+fine.yawDeg.toFixed(6)" :min="-180" :max="180" :sig="6" :disabled="ro" @commit="(v) => setFine('yawDeg', v)" /><span class="u">°</span></div>
      <div class="srow"><label title="模型原点在本体系里的位置（米）；改它等于把模型整体平移，挂点等随模型一起移">原点</label>
        <div class="md-v3">
          <NumIn v-for="k in [0, 1, 2]" :key="k" :model-value="t[k]" :sig="6" :disabled="ro" @commit="(v) => setT(k, v)" />
        </div><span class="u">m</span></div>
      <div class="md-acts">
        <button class="lb-mini" :disabled="ro || isFactory" :title="factoryTip" @click="factory"><Icon name="undo-2" :size="12" />出厂映射</button>
        <button class="lb-mini" :disabled="ro || !com" title="平移模型，使质心落在本体原点" @click="originToCom">原点移到质心</button>
        <button class="lb-mini" :disabled="ro" title="平移模型，使包围盒中心落在本体原点" @click="originToCenter">原点移到几何中心</button>
      </div>
      <label class="md-chkrow" title="轴向已与实物 / 文档核对（装配核定）">
        <input type="checkbox" :checked="!!(m.frame && m.frame.verified)" :disabled="ro" @change="setVerified($event.target.checked)" />本体轴已核定
      </label>
    </template>
  </MdSec>
</template>

<style scoped>
.fr-steps { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 3px; }
.fr-step { height: var(--h-ctl-lg); padding: 0 2px !important; gap: 2px !important; font-family: var(--font-mono); font-size: var(--fs-2) !important; }
.fr-step b { font-weight: 700; }
.fr-x b { color: #e5484d; } .fr-y b { color: #30a46c; } .fr-z b { color: #3e63dd; }
</style>
