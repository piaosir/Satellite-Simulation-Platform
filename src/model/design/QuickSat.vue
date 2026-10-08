<script setup>
// 快速设置 · 卫星驱动装配件（2026-10 统一设计）：整星驱动参数（paramBus spec）的精选表单。
//   · 常驻四节：平台（尺寸 / 整星质量 / 热控多层）、太阳翼（构型 / 基板 / 连接架 / 转角 + 翼展与基板面积读数）、
//     反射面天线（位置 / 口径 / 焦距 / 网状，一行一副，可增删）、平台细节（推力器 / 散热面 / 对接环 / 对地喇叭）；
//     LEO 平板另有相控阵，立方星换成太阳电池（体装 / 展开板）。其余驱动量收进「更多参数」（缺省折叠）。
//   · 每次落值 = 新 spec → 会话 driveSet（三方合并：组件随之重排，右栏详细编辑里的改写保留）→ 编辑器整文档替换，一步撤销。
//   · 值仍是模板给的：有出处的悬停给出处；示意值红色标示（与组件属性面板同一套）。改过的就是用户值，不再标。
//   · 结果读数（翼展、基板面积、反射面焦径比 / 净空 / 馈源倾角）只出数字。
import { inject, computed } from 'vue'
import Icon from '../../components/Icon.vue'
import NumIn from '../NumIn.vue'
import { normalizeSpec, LAYOUT_PRESETS } from '@core/models/paramBus.mjs'
import { templateSpec, DETAIL_PRESETS } from '@core/models/paramTemplates.mjs'
import { compById } from '../asmLogic.js'
import { fmtNum } from '../wbLogic.js'
import {
  LAYOUT_LABELS, REFL_SLOTS, MLI_CHOICES, WING_CONFIGS, mliOf, setMli, wingConfig, setWingConfig, wingValue, setWingValue, arrayAreaM2,
  reflRows, slotChoices, addReflector, removeReflector, setReflValue, effFocalM, reflGeom, provOf, setSpecValue
} from '../quickLogic.js'

const asm = inject('asm')
const ui = asm.ui
const doc = computed(() => asm.doc.value)
const drive = computed(() => (doc.value && doc.value.drive) || null)
const spec = computed(() => (drive.value ? drive.value.spec : null))
const norm = computed(() => (spec.value ? normalizeSpec(spec.value) : null))
const layout = computed(() => (norm.value ? norm.value.layout : 'geo'))
const tplId = computed(() => (drive.value && drive.value.templateId) || '')
const tpl = computed(() => (tplId.value ? templateSpec(tplId.value) : null))
const D = computed(() => (norm.value && DETAIL_PRESETS[norm.value.detailPreset]) || {})
const ro = computed(() => ui.posePreview || ui.dragging)

// 分节开合记在会话 ui.secOpen（本机便利数据，键 q-*）；「更多参数」缺省折叠
const CLOSED_BY_DEFAULT = new Set(['more'])
const isOpen = (k) => { const v = ui.secOpen['q-' + k]; return v === undefined ? !CLOSED_BY_DEFAULT.has(k) : v }
function toggle(k) { ui.secOpen = { ...ui.secOpen, ['q-' + k]: !isOpen(k) } }

// ── 落值 ──
function apply(next, key) { if (!ro.value && next) asm.driveSet(next, { mergeKey: 'q|' + key }) }
const setPath = (path, v) => apply(setSpecValue(spec.value, path, v), path)
const val = (path) => { const p = path.split('.'); let o = spec.value; for (const k of p) { if (o == null) return null; o = o[k] } return o }
const prov = (path) => provOf(tplId.value, spec.value, path)
const bad = (path) => prov(path).kind === 'illustrative'
const tip = (path, base) => { const t = prov(path).title; return [base, t].filter(Boolean).join('\n') }

// ── 名称 / 来源 ──
function rename(ev) { const v = String(ev.target.value || '').trim(); if (doc.value && v !== doc.value.name) asm.cmd({ type: 'setDoc', patch: { name: v } }) }
const tplName = computed(() => { const t = tpl.value && tpl.value.spec; return (t && (t.name || '')) || tplId.value })
const srcTip = computed(() => [tplName.value, tplId.value ? 'param:' + tplId.value : ''].filter(Boolean).join('\n'))

// ── 平台 ──
const BUS_TIPS = { xM: '平台本体沿本体 X（GEO 下为东西向）的外廓尺寸', yM: '平台本体沿本体 Y（南北向，太阳翼安装面法向）的外廓尺寸', zM: '平台本体沿本体 Z（对地向）的外廓尺寸' }
const mli = computed(() => (spec.value ? mliOf(spec.value) : 'none'))
const massTip = '整星质量：指定后由平台本体承担「整星 − 其余组件」的质量差额；留空按密度估算'

// ── 太阳翼 ──
const wcfg = computed(() => (spec.value ? wingConfig(spec.value) : 'none'))
const hasWings = computed(() => wcfg.value !== 'none')
const wv = (k) => (spec.value ? wingValue(spec.value, k) : { value: null, mixed: false, values: [] })
const wingIdx = computed(() => { const w = spec.value && spec.value.wings; if (!Array.isArray(w)) return 0; const i = w.findIndex((x) => x && x.side === '+Y'); return i >= 0 ? i : 0 })
const wPath = (k) => `wings[${wingIdx.value}].${k}`
const wMixTip = (k, unit = '') => { const r = wv(k); return r.mixed ? '两翼不同：' + r.values.map((v) => fmtNum(v, 5) + unit).join(' / ') : '' }
function setWing(k, v) { apply(setWingValue(spec.value, k, v), 'w|' + k) }
function setCfg(c) { if (c !== wcfg.value) apply(setWingConfig(spec.value, c, tpl.value && tpl.value.itemDefaults ? tpl.value.itemDefaults.wing : null), 'wcfg') }
const span = computed(() => { const b = ui.stats.bbox; return ui.stats.count && b && Number.isFinite(b[4]) && Number.isFinite(b[1]) ? b[4] - b[1] : null })
const area = computed(() => (spec.value ? arrayAreaM2(spec.value) : 0))
// 侧板位置：spec 里没写时是生成器缺省（归一后的值：倒数第二块）
const sideAt = computed(() => { const r = wv('sidePanelAt'); if (r.value != null) return r.value; const w = norm.value && norm.value.wings; return Array.isArray(w) && w[0] && w[0].sidePanelAt != null ? w[0].sidePanelAt : null })
// 电池片效率：spec 里没写时是生成器缺省（归一后的值）
const effPct = computed(() => { const r = wv('efficiency'); if (r.value != null) return r.value; const w = norm.value && norm.value.wings; return Array.isArray(w) && w[0] ? w[0].efficiency : null })

// ── 相控阵（LEO 平板）/ 太阳电池（立方星）──
const tiles = computed(() => (norm.value && norm.value.phasedArray ? norm.value.phasedArray.tiles : 0))
const cube = computed(() => (norm.value && norm.value.cubesat) || { bodyCells: false, deployPanels: 0 })

// ── 反射面天线 ──
const rows = computed(() => (spec.value ? reflRows(spec.value) : []))
const canAdd = computed(() => !!spec.value && slotChoices(spec.value).length > 0)
function addRefl() {
  const r = addReflector(spec.value, tpl.value && tpl.value.itemDefaults ? tpl.value.itemDefaults.reflector : null)
  if (r) apply(r.spec, 'r|add')
}
const rmRefl = (i) => apply(removeReflector(spec.value, i), 'r|rm')
const setRefl = (i, k, v) => apply(setReflValue(spec.value, i, k, v), `r|${i}|${k}`)
const reflComp = (r) => (r.uid != null && doc.value ? compById(doc.value, 'refl' + r.uid) : null)
const forcedMesh = (r) => Number.isFinite(r.diameterM) && Number.isFinite(D.value.meshAboveDM) && r.diameterM > D.value.meshAboveDM
const effF = (r) => { const c = reflComp(r); return c && Number.isFinite(c.params.focalM) ? c.params.focalM : effFocalM(spec.value, r) }
function geomTip(r) {
  const c = reflComp(r)
  const g = c ? reflGeom(c.params.diameterM, c.params.focalM, c.params.offsetHM) : null
  if (!g) return ''
  return `焦径比 F/D = ${fmtNum(g.fD, 3)}\n下缘净空 = ${fmtNum(g.clearanceM, 3)} m\n馈源倾角 θ0 = ${fmtNum(g.theta0Deg, 3)}°\n半张角 θ* = ${fmtNum(g.thetaStarDeg, 3)}°`
}
const fPlaceholder = (r) => { const f = effFocalM(spec.value, r); return Number.isFinite(f) ? fmtNum(f, 4) : '自动' }

// ── 更多参数 ──
const presets = computed(() => LAYOUT_PRESETS[layout.value] || [])
const PRESET_LABEL = { geo: 'GEO 平台', small: '小卫星', leo: 'LEO 平板', cubesat: '立方星' }
const tower = computed(() => compById(doc.value, 'tower'))
const towerPh = (k) => { const c = tower.value; return c && Number.isFinite(c.params[k]) ? fmtNum(c.params[k], 4) : '自动' }
</script>

<template>
  <div v-if="spec" class="asm qk" data-quick="sat">
    <!-- 名称 / 来源 -->
    <div class="sec qk-head">
      <div class="srow"><label>名称</label>
        <input :key="doc.name" class="ci asm-txt" type="text" spellcheck="false" :value="doc.name" data-i18n-skip @change="rename" @keydown.enter="$event.target.blur()" />
      </div>
      <div class="qk-src">
        <span class="qk-tag" :title="srcTip">{{ LAYOUT_LABELS[layout] || layout }}</span>
        <span v-if="tplId" class="qk-src-t" :title="srcTip" data-i18n-skip>{{ tplName }}</span>
      </div>
    </div>

    <!-- 平台 -->
    <div class="sec" data-sec="q-bus">
      <div class="sect acc" @click="toggle('bus')">
        <Icon name="chevron-down" class="disc" :class="{ shut: !isOpen('bus') }" :size="12" />
        <span class="sect-t">平台</span>
      </div>
      <template v-if="isOpen('bus')">
        <div class="srow"><label title="平台本体外廓尺寸：X 东西 · Y 南北 · Z 对地">本体尺寸</label>
          <div class="asm-v3">
            <NumIn v-for="k in ['xM', 'yM', 'zM']" :key="k" :model-value="val('bus.' + k)" :min="0.01" :max="50" :sig="5" :disabled="ro"
                   :bad="bad('bus.' + k)" :title="tip('bus.' + k, BUS_TIPS[k])" @commit="setPath('bus.' + k, $event)" />
          </div>
          <span class="u">m</span>
        </div>
        <div class="srow"><label :title="massTip">整星质量</label>
          <NumIn :model-value="val('massTargetKg')" :min="0.01" :max="1e6" :sig="6" allow-empty placeholder="按密度" :disabled="ro"
                 :bad="bad('massTargetKg')" :title="tip('massTargetKg', massTip)" @commit="setPath('massTargetKg', $event)" />
          <span class="u">kg</span>
        </div>
        <div v-if="layout === 'geo'" class="srow"><label title="平台本体多层隔热组件（MLI）外表面">热控多层</label>
          <div class="seg">
            <span v-for="m in MLI_CHOICES" :key="m.key" class="sg" :class="{ on: mli === m.key, off: ro }" @click="!ro && mli !== m.key && apply(setMli(spec, m.key), 'mli')">{{ m.label }}</span>
          </div>
        </div>
      </template>
    </div>

    <!-- 太阳翼 -->
    <div v-if="layout !== 'cubesat'" class="sec" data-sec="q-wing">
      <div class="sect acc" @click="toggle('wing')">
        <Icon name="chevron-down" class="disc" :class="{ shut: !isOpen('wing') }" :size="12" />
        <span class="sect-t">太阳翼</span>
      </div>
      <template v-if="isOpen('wing')">
        <div class="srow"><label title="太阳翼安装在 ±Y 面（GEO 下为南 / 北）">构型</label>
          <div class="seg">
            <span v-for="c in WING_CONFIGS" :key="c.key" class="sg" :class="{ on: wcfg === c.key, off: ro }" @click="!ro && setCfg(c.key)">{{ c.label }}</span>
          </div>
        </div>
        <template v-if="hasWings">
          <div class="srow"><label title="每翼沿翼展串联的基板块数 × 单块基板长（沿翼展）× 宽">基板</label>
            <div class="qk-panel">
              <NumIn :model-value="wv('panels').value" integer :min="1" :max="20" :disabled="ro" :bad="bad(wPath('panels'))"
                     :title="[tip(wPath('panels'), '每翼基板块数'), wMixTip('panels')].filter(Boolean).join('\n')" @commit="setWing('panels', $event)" />
              <span class="qk-x">块 ×</span>
              <NumIn :model-value="wv('panelHM').value" :min="0.01" :max="30" :sig="5" :disabled="ro" :bad="bad(wPath('panelHM'))"
                     :title="[tip(wPath('panelHM'), '单块基板沿翼展方向的长度'), wMixTip('panelHM', ' m')].filter(Boolean).join('\n')" @commit="setWing('panelHM', $event)" />
              <span class="qk-x">×</span>
              <NumIn :model-value="wv('panelWM').value" :min="0.01" :max="30" :sig="5" :disabled="ro" :bad="bad(wPath('panelWM'))"
                     :title="[tip(wPath('panelWM'), '单块基板宽度（板面内垂直于翼轴）'), wMixTip('panelWM', ' m')].filter(Boolean).join('\n')" @commit="setWing('panelWM', $event)" />
            </div>
            <span class="u">m</span>
          </div>
          <div class="srow"><label title="连接架（轭）长度：太阳翼驱动机构（SADA）外端至第一块基板内缘">连接架</label>
            <NumIn :model-value="wv('yokeLenM').value" :min="0" :max="30" :sig="5" :disabled="ro" :bad="bad(wPath('yokeLenM'))"
                   :title="[tip(wPath('yokeLenM'), '连接架长度；0 = 无连接架'), wMixTip('yokeLenM', ' m')].filter(Boolean).join('\n')" @commit="setWing('yokeLenM', $event)" />
            <span class="u">m</span>
          </div>
          <div class="srow"><label title="太阳翼驱动机构转角（绕本体 Y 轴，两翼电池面同向）；0° 时电池面朝天顶（−Z）">转角</label>
            <NumIn :model-value="wv('tiltDeg').value" :min="-180" :max="180" :sig="5" :disabled="ro"
                   :title="wMixTip('tiltDeg', '°') || '太阳翼驱动机构转角（两翼电池面同向）'" @commit="setWing('tiltDeg', $event)" />
            <span class="u">°</span>
          </div>
          <div class="md-kvs qk-kvs">
            <div class="md-kv" title="本体 Y 向包围盒长度（翼尖到翼尖）"><span class="k">翼展</span><span class="v" data-i18n-skip>{{ span != null ? fmtNum(span, 4) : '—' }}</span><span class="u">m</span></div>
            <div class="md-kv" title="全部基板面积（含侧板，不扣布片边距）"><span class="k">基板面积</span><span class="v" data-i18n-skip>{{ fmtNum(area, 4) }}</span><span class="u">m²</span></div>
          </div>
        </template>
      </template>
    </div>

    <!-- 立方星：太阳电池 -->
    <div v-if="layout === 'cubesat'" class="sec" data-sec="q-cells">
      <div class="sect acc" @click="toggle('cells')">
        <Icon name="chevron-down" class="disc" :class="{ shut: !isOpen('cells') }" :size="12" />
        <span class="sect-t">太阳电池</span>
      </div>
      <template v-if="isOpen('cells')">
        <label class="md-chkrow"><input type="checkbox" :checked="!!cube.bodyCells" :disabled="ro" @change="setPath('cubesat.bodyCells', $event.target.checked)" />体装电池片</label>
        <div class="srow"><label title="背地端展开太阳板">展开板</label>
          <div class="seg">
            <span v-for="n in [0, 2]" :key="n" class="sg" :class="{ on: cube.deployPanels === n, off: ro }" data-i18n-skip @click="!ro && setPath('cubesat.deployPanels', n)">{{ n }}</span>
          </div>
          <span class="u">块</span>
        </div>
      </template>
    </div>

    <!-- LEO 平板：相控阵 -->
    <div v-if="layout === 'leo-flat'" class="sec" data-sec="q-array">
      <div class="sect acc" @click="toggle('array')">
        <Icon name="chevron-down" class="disc" :class="{ shut: !isOpen('array') }" :size="12" />
        <span class="sect-t">相控阵</span>
      </div>
      <template v-if="isOpen('array')">
        <div class="srow"><label :class="{ 'md-red': bad('phasedArray.tiles') }" :title="tip('phasedArray.tiles', '对地面相控阵块数')">阵面块数</label>
          <div class="seg">
            <span v-for="n in [0, 1, 2, 4]" :key="n" class="sg" :class="{ on: tiles === n, off: ro }" data-i18n-skip @click="!ro && setPath('phasedArray.tiles', n)">{{ n }}</span>
          </div>
        </div>
        <label class="md-chkrow" title="背速度面电推力器"><input type="checkbox" :checked="!!(norm.detail && norm.detail.thrusters)" :disabled="ro" @change="setPath('detail.thrusters', $event.target.checked)" />电推力器</label>
      </template>
    </div>

    <!-- 反射面天线 -->
    <div class="sec" data-sec="q-refl">
      <div class="sect acc" @click="toggle('refl')">
        <Icon name="chevron-down" class="disc" :class="{ shut: !isOpen('refl') }" :size="12" />
        <span class="sect-t">反射面天线</span>
        <span class="cnt" data-i18n-skip>{{ rows.length }}</span>
      </div>
      <template v-if="isOpen('refl')">
        <div v-if="!rows.length" class="asm-empty qk-empty">暂无反射面。</div>
        <div v-else class="qk-rt">
          <div class="qk-rh"><span>位置</span><span title="口径 D（偏置口径面直径）">口径 (m)</span><span title="母抛物面焦距 F；留空按焦径比缺省">焦距 (m)</span><span title="可展开网状反射面">网状</span><span></span></div>
          <div v-for="r in rows" :key="r.uid != null ? r.uid : 'i' + r.i" class="qk-rr" :data-refl="r.uid" :title="geomTip(r) || null">
            <select class="ci" :value="r.slot" :disabled="ro || r.fixed" :title="r.fixed ? '按本体坐标定位' : '安装位置'" @change="setRefl(r.i, 'slot', $event.target.value)">
              <option v-for="s in slotChoices(spec, r.i)" :key="s.key" :value="s.key">{{ s.label }}</option>
              <option v-if="!REFL_SLOTS.some((s) => s.key === r.slot)" :value="r.slot">{{ r.slot }}</option>
            </select>
            <NumIn :model-value="r.diameterM" :min="0.01" :max="50" :sig="5" :disabled="ro" :bad="bad(`reflectors[${r.i}].diameterM`)"
                   :title="tip(`reflectors[${r.i}].diameterM`, '口径 D')" @commit="setRefl(r.i, 'diameterM', $event)" />
            <NumIn :model-value="r.focalM" :min="0.01" :max="100" :sig="5" allow-empty :placeholder="fPlaceholder(r)" :disabled="ro"
                   :bad="bad(`reflectors[${r.i}].focalM`)" :title="tip(`reflectors[${r.i}].focalM`, '焦距 F；留空按焦径比缺省')" @commit="setRefl(r.i, 'focalM', $event)" />
            <input type="checkbox" class="qk-chk" :checked="r.mesh || forcedMesh(r)" :disabled="ro || forcedMesh(r)"
                   :title="forcedMesh(r) ? `口径大于 ${fmtNum(D.meshAboveDM, 3)} m 时为网状` : '可展开网状反射面'" @change="setRefl(r.i, 'mesh', $event.target.checked)" />
            <button type="button" class="asm-ib" :disabled="ro" title="删除该反射面" @click="rmRefl(r.i)"><Icon name="trash" :size="12" /></button>
          </div>
        </div>
        <div class="md-acts"><button class="lb-mini" data-act="q-add-refl" :disabled="ro || !canAdd" title="添加一副偏置抛物面反射面（占用首个空闲位置）" @click="addRefl"><Icon name="plus" :size="12" />添加反射面</button></div>
      </template>
    </div>

    <!-- 平台细节 -->
    <div v-if="layout === 'geo'" class="sec" data-sec="q-detail">
      <div class="sect acc" @click="toggle('detail')">
        <Icon name="chevron-down" class="disc" :class="{ shut: !isOpen('detail') }" :size="12" />
        <span class="sect-t">平台细节</span>
      </div>
      <template v-if="isOpen('detail')">
        <div class="qk-chks">
          <label class="md-chkrow" title="远地点发动机与姿轨控推力器"><input type="checkbox" :checked="!!norm.detail.thrusters" :disabled="ro" @change="setPath('detail.thrusters', $event.target.checked)" />推力器</label>
          <label class="md-chkrow" title="南北面 OSR 散热面"><input type="checkbox" :checked="!!norm.detail.radiators" :disabled="ro" @change="setPath('detail.radiators', $event.target.checked)" />南北散热面</label>
          <label class="md-chkrow" title="星箭对接环"><input type="checkbox" :checked="!!norm.detail.adapter" :disabled="ro" @change="setPath('detail.adapter', $event.target.checked)" />对接环</label>
        </div>
        <div class="srow"><label title="对地板测控 / 信标喇叭数量">对地喇叭</label>
          <NumIn :model-value="norm.detail.deckHorns" integer :min="0" :max="3" :disabled="ro" @commit="setPath('detail.deckHorns', $event)" />
          <span class="u">个</span>
        </div>
      </template>
    </div>

    <!-- 更多参数（缺省折叠） -->
    <div class="sec" data-sec="q-more">
      <div class="sect acc" @click="toggle('more')">
        <Icon name="chevron-down" class="disc" :class="{ shut: !isOpen('more') }" :size="12" />
        <span class="sect-t">更多参数</span>
      </div>
      <template v-if="isOpen('more')">
        <div class="srow"><label title="附件（MLI、散热面、推力器、对接环、SADA 等）的示意尺度档">附件尺度档</label>
          <select class="ci" :value="spec.detailPreset || norm.detailPreset" :disabled="ro" @change="setPath('detailPreset', $event.target.value)">
            <option v-for="p in presets" :key="p" :value="p">{{ PRESET_LABEL[p] || p }}</option>
          </select>
        </div>
        <template v-if="hasWings">
          <div class="srow"><label title="相邻基板之间的缝隙">板缝</label>
            <NumIn :model-value="wv('gapM').value" :min="0" :max="2" :sig="4" :disabled="ro" :bad="bad(wPath('gapM'))" :title="[tip(wPath('gapM'), ''), wMixTip('gapM', ' m')].filter(Boolean).join('\n') || null" @commit="setWing('gapM', $event)" />
            <span class="u">m</span>
          </div>
          <div class="srow"><label title="主列某一块基板两侧垂直展开的侧板（十字形翼：SSL-1300、Spacebus 4000 类）">侧板</label>
            <div class="seg">
              <span v-for="n in [0, 2]" :key="n" class="sg" :class="{ on: wv('sidePanels').value === n, off: ro }" data-i18n-skip @click="!ro && setWing('sidePanels', n)">{{ n }}</span>
            </div>
            <span class="u">块</span>
          </div>
          <div v-if="wv('sidePanels').value === 2" class="srow"><label title="侧板挂在第几块基板两侧（自翼根数起）；缺省倒数第二块：外侧还有一块，翼面成十字形">侧板位置</label>
            <NumIn :model-value="sideAt" integer :min="1" :max="wv('panels').value || 20" :disabled="ro" :title="wMixTip('sidePanelAt') || null" @commit="setWing('sidePanelAt', $event)" />
            <span class="u">块</span>
          </div>
          <div class="srow"><label title="电池片光电转换效率（AGI 太阳翼组 efficiency，百分数）">电池片效率</label>
            <NumIn :model-value="effPct" :min="0" :max="100" :sig="4" :disabled="ro" :title="wMixTip('efficiency', ' %') || null" @commit="setWing('efficiency', $event)" />
            <span class="u">%</span>
          </div>
        </template>
        <template v-if="rows.length">
          <div v-for="r in rows" :key="'m' + (r.uid != null ? r.uid : r.i)" class="qk-more-r">
            <div class="qk-more-h" data-i18n-skip>{{ REFL_SLOTS.find((s) => s.key === r.slot) ? REFL_SLOTS.find((s) => s.key === r.slot).label : r.slot }}</div>
            <div class="srow"><label title="口径面中心至母轴的距离（偏置高度）；留空自动（内缘与侧壁保留净空）">偏置高度</label>
              <NumIn :model-value="r.offsetHM" :min="0" :max="100" :sig="5" allow-empty placeholder="自动" :disabled="ro" @commit="setRefl(r.i, 'offsetHM', $event)" />
              <span class="u">m</span>
            </div>
            <div class="srow"><label>馈电</label>
              <div class="seg">
                <span class="sg" :class="{ on: r.feedType !== 'array', off: ro }" @click="!ro && r.feedType === 'array' && setRefl(r.i, 'feedType', 'horn')">喇叭</span>
                <span class="sg" :class="{ on: r.feedType === 'array', off: ro }" @click="!ro && r.feedType !== 'array' && setRefl(r.i, 'feedType', 'array')">阵列</span>
              </div>
            </div>
            <label class="md-chkrow" title="赋形反射面（记为属性，不改变几何）"><input type="checkbox" :checked="r.shaped" :disabled="ro" @change="setRefl(r.i, 'shaped', $event.target.checked)" />赋形</label>
          </div>
        </template>
        <template v-if="tower">
          <div class="srow"><label title="对地板天线塔高度；留空按对地板反射面焦距自动计算">天线塔高</label>
            <NumIn :model-value="val('tower.hM')" :min="0.01" :max="20" :sig="5" allow-empty :placeholder="towerPh('hM')" :disabled="ro" @commit="setPath('tower.hM', $event)" />
            <span class="u">m</span>
          </div>
          <div class="srow"><label title="天线塔方截面边长；留空按附件尺度档">天线塔截面</label>
            <NumIn :model-value="val('tower.wM')" :min="0.01" :max="5" :sig="5" allow-empty :placeholder="towerPh('wM')" :disabled="ro" @commit="setPath('tower.wM', $event)" />
            <span class="u">m</span>
          </div>
        </template>
        <div class="md-acts qk-detach">
          <button class="lb-mini" data-act="q-detach" :disabled="ro" title="解除驱动：组件原样保留，转为普通装配件（快速设置不再联动）" @click="asm.detach()"><Icon name="unlink-2" :size="12" />解除驱动</button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.qk { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; }
.qk-head { display: flex; flex-direction: column; gap: 6px; }
.qk-src { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: var(--fs-2); color: var(--text-muted); }
.qk-tag { flex: none; font-size: var(--fs-1); line-height: 1; padding: 2px 5px; border-radius: var(--r-ctl); color: var(--text-muted); background: var(--surface-2); border: 1px solid var(--border); }
.qk-src-t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qk-panel { flex: 1 1 150px; min-width: 150px; display: grid; grid-template-columns: minmax(0, 0.8fr) auto minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: 3px; }
.qk-panel > input { width: 100%; }
.qk-x { color: var(--text-faint); font-size: var(--fs-2); white-space: nowrap; }
.qk-kvs { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.qk-chks { display: flex; flex-wrap: wrap; gap: 0 14px; }
.qk-chks > .md-chkrow { flex: none; }
.qk-empty { padding: 8px; }
/* 反射面表：位置 | 口径 | 焦距 | 网状 | 删除 */
.qk-rt { display: flex; flex-direction: column; gap: 3px; }
.qk-rh, .qk-rr { display: grid; grid-template-columns: minmax(96px, 1.5fr) minmax(48px, 1fr) minmax(48px, 1fr) 30px 22px; align-items: center; gap: 4px; }
.qk-rh { font-size: var(--fs-2); color: var(--text-muted); padding: 0 1px; }
.qk-rh > span:nth-child(4) { text-align: center; }
.qk-rr > select { width: 100%; min-width: 0; }
.qk-rr > input:not(.qk-chk) { width: 100%; }
.qk-chk { justify-self: center; margin: 0; }
.qk-more-r { display: flex; flex-direction: column; gap: 6px; padding-top: 4px; border-top: 1px dashed var(--lb-rule-soft); }
.qk-more-h { font-size: var(--fs-2); font-weight: 600; color: var(--text-muted); }
.qk-detach { padding-top: 4px; }
</style>
