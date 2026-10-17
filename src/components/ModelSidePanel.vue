<script setup>
// 「卫星模型」侧栏视图（活动栏 side='model'；设计契约 §6.3）。3D 页只负责 Teleport 挂载与喂数据。
//   ① 当前卫星：缩略图 + 模型名 + 来源 / 保真度（署名与许可放 title）+ 尺寸 / 质量读数 + 姿态律 / 挂点数（二期）；
//      模型下拉（自动 / 无 / 库中模型…）；
//      跟随 / 编辑…（编辑… = 模型工作台「卫星」页：这颗星的姿态律与挂点）
//   ② 显示：显示模型（拨杆，在节标题上；卫星与标记共用）、图标大小（所有卫星模型统一一个值，不逐颗设；标记挂的模型跟标记自己的图标大小，
//      在标记侧栏，模型与图标共用一个设置）、跟随时的 HUD 八项（常驻，跟随时生效）
//   图标大小一律是【默认视角下】的像素，球面上随缩放联动（拉近变大、拉远变小，与标记 / 地名同一把尺，见 viz/globe3d/zoomScale.js）
//   ③ 模型库：搜索 + 来源分段 + 缩略图网格（点卡片 = 绑定到当前卫星；右键：下载 / 移除缓存 / 在工作台中打开）
//   ④ 底部「模型工作台」
// 绑定写回由页面做（要与已有的挂点 / 姿态律合并，见 ConstellationMap3D 的 bindModel）；缩略图、下载、移除、开工作台直接走 IPC。
// ★ 所有 api 调用都 catch，并认 {locked:true}（未激活时 gate 通道回这个，界面静默）。
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import Icon from './Icon.vue'
import { isSecOpen, toggleSec } from '../stores/panelSections'
import { byLang } from '../shared/i18n/lang.js'
import { onLangChange } from '../shared/i18n/runtime.js'
// 缩略图逻辑抽到 modelThumbs.js（模块级单例：本侧栏、标记侧栏的「模型」小块、模型选择弹层共用一份缓存）。
// 缩略图下载完成 / 元数据变了的重取由 3D 页 onModelsChanged 统一做（refreshThumb）：侧栏没展开时同样要刷新那份缓存
import { thumbs, requestThumb, createThumbObserver } from './modelThumbs.js'
import { entryFacts } from '../model/wbLogic.js'

const props = defineProps({
  sat: { type: Object, default: null },          // { key, name } 主选星；null = 未选中
  model: { type: Object, default: null },        // 主选星的模型信息（页面 selModel）
  lib: { type: Array, default: () => [] },       // manifest 条目（含 local 状态）+ 参数化模板
  following: { type: Boolean, default: false },   // 正在跟随（3D 相机跟随 / 2D 星下点跟随都算）
  st: { type: Object, required: true }           // focusStyle（modelOn / modelPx / hud*）
})
const emit = defineEmits(['toggle-follow', 'bind', 'set-style', 'reset-style', 'open-wb'])
const models = (typeof window !== 'undefined' && window.api && window.api.models) || null

// ---------------- 当前卫星 ----------------
const FID = {
  outreach: { icon: 'image', t: '科普美术模型' },
  parametric: { icon: 'sliders-horizontal', t: '参数化生成' },
  cad: { icon: 'box', t: 'CAD 模型' },
  engineering: { icon: 'weight', t: '工程模型' }
}
const fidOf = (f) => FID[f] || FID.outreach
// 二期新加的界面词（姿态律 / 挂点）按语言直接出字：词典（uiDict）不归本面板管，呈现层查不到就会在英文界面漏成中文。
// 读 langTick 建立依赖 —— 切语言时模板随之重渲染（byLang 本身读 localStorage，不是响应式）
const langTick = ref(0)
const offLang = onLangChange(() => { langTick.value++ })
onBeforeUnmount(() => offLang())
function zhEn(zh, en) { void langTick.value; return byLang(zh, en) }
// 姿态律名（绑定表 attitude.law；没绑定 = nadir）。口径写进 title
const LAW = {
  nadir: { t: ['对地定向', 'Nadir'], tt: ['+Z 指地心、+X 沿惯性速度', '+Z to Earth centre, +X along inertial velocity'] },
  yawSteer: { t: ['偏航导引', 'Yaw steering'], tt: ['在对地定向基础上绕 +Z 偏航，太阳翼轴（本体 ±Y）始终垂直于太阳方向', 'Nadir pointing with yaw about +Z so the array axis (body ±Y) stays perpendicular to the Sun'] },
  sun: { t: ['对日定向', 'Sun pointing'], tt: ['指定本体轴精确指向太阳', 'The chosen body axis points exactly at the Sun'] },
  inertial: { t: ['惯性定向', 'Inertial'], tt: ['本体相对 TEME 惯性系固定', 'Body fixed relative to the TEME inertial frame'] },
  target: { t: ['对目标定向', 'Target pointing'], tt: ['指定本体轴精确指向地球站或目标卫星', 'The chosen body axis points exactly at an earth station or target satellite'] }
}
const lawOf = (k) => LAW[k] || LAW.nadir
const lawName = (k) => zhEn(...lawOf(k).t)
const attTitle = computed(() => {
  const m = props.model
  if (!m) return ''
  const tt = zhEn(...lawOf(m.law).tt), n = m.mounts || 0, k = m.masks || 0
  return zhEn('姿态律：' + tt + '\n挂点 ' + n + ' 副，其中 ' + k + ' 副已有遮挡掩模', 'Attitude law: ' + tt + '\n' + n + ' mounts, ' + k + ' with obscuration masks')
})
const nameOf = (m) => (m ? (byLang(m.titleZh || m.title || m.id, m.title || m.titleZh || m.id)) : '')
const srcTitle = (m) => {
  if (!m) return ''
  const s = m.source || {}
  return [s.credit, s.license].filter(Boolean).join(' · ') || m.id
}
const bindValue = computed(() => {
  const m = props.model
  if (!m) return 'auto'
  if (m.bound === null) return 'none'
  if (m.bound && m.bound !== 'auto') return m.bound
  return 'auto'
})
const autoLabel = computed(() => {
  const m = props.model
  return m && m.auto && m.id ? '自动（' + (m.name || m.id) + '）' : '自动'
})
function onBindSelect(e) {
  const v = e.target.value
  if (v === '__lib') {
    e.target.value = bindValue.value
    if (!isSecOpen('mdl-lib')) toggleSec('mdl-lib')
    nextTick(() => { const el = libEl.value; if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' }) })
    return
  }
  emit('bind', v === 'auto' ? 'auto' : (v === 'none' ? null : v))
}
// ---------------- 缩略图（按需、可见才取；远端的由主进程下到本机缓存；参数化 / 实体模板现场生成，见 modelThumbs.js） ----------------
const thumbCur = computed(() => (props.model && props.model.id ? thumbs.value.get(props.model.id) || '' : ''))
watch(() => props.model && props.model.id, (id) => { if (id) requestThumb(id) }, { immediate: true })
// ★ 在 setup 里就建：卡片的函数 ref 在首次渲染时（早于 onMounted）就会被调用
const thumbObs = createThumbObserver('120px')
const libEl = ref(null)
function observe(el) { thumbObs.observe(el) }

// ---------------- 下载进度 ----------------
const prog = ref(new Map())            // id → { phase, frac }
let offChanged = null
onMounted(() => {
  if (models && models.onChanged) {
    offChanged = models.onChanged((e) => {
      if (!e || e.type !== 'download' || !e.id) return
      const m = new Map(prog.value)
      if (e.phase === 'ready' || e.phase === 'canceled' || e.phase === 'error') m.delete(e.id)
      else m.set(e.id, { phase: e.phase, frac: e.total > 0 ? Math.min(1, e.received / e.total) : 0 })
      prog.value = m
    })
  }
})
onBeforeUnmount(() => { if (offChanged) offChanged(); thumbObs.disconnect() })

// ---------------- 模型库 ----------------
const q = ref('')
const seg = ref('all')
const SEGS = [
  { k: 'all', t: '全部' }, { k: 'builtin', t: '内置' }, { k: 'local', t: '已下载' }, { k: 'cloud', t: '云端' }, { k: 'user', t: '本机' }
]
const ready = (m) => !!(m.local && (m.local.lod0 === 'ready' || m.local.lod1 === 'ready' || m.local.lod2 === 'ready'))
const isParam = (m) => String(m.id).startsWith('param:')
// 运行时生成、没有文件的条目（参数化模板 param: / 实体模板 ent:）：没有「下载」「移除缓存」可言
const isGen = (m) => /^(param|ent):/.test(String(m.id))
// 「移除缓存」只给远端件下载下来的缓存（与工作台库页 canRemoveCache 同一判据）。本机导入件 / 工作台自建装配件 / STK 件
// 的文件就是原件，删了找不回 —— 侧栏不给删，删除走工作台库页（有确认，并处理打开着的签与草稿）
const isCloud = (m) => entryFacts(m).cloud
const canRemoveCache = (m) => { const f = entryFacts(m); return f.cloud && (f.cached || f.partial) }
// 「下载」只给云端件、且完整模型（lod0）还没下到本机的（与工作台库页 canDownload 同一判据）；正在下的不再给。
// 本机导入件 / STK 件 / 参数化与实体模板没有可下的东西，已缓存的也不必再下 —— 原来这几类照样能点、点了没反应
const canDownload = (m) => { const f = entryFacts(m); return !!models && f.cloud && !(m.local && m.local.lod0 === 'ready') && !prog.value.has(m.id) }
// 地面 / 空中 / 水面件的占位图标（缩略图出来之前）
const KIND_ICON = { ground: 'satellite-dish', aircraft: 'plane', ship: 'ship', vehicle: 'car' }
const phIcon = (m) => KIND_ICON[m.kind] || (isParam(m) ? 'box' : 'satellite')
function segOf(m) {
  if (isParam(m) && m.origin !== 'user') return 'builtin'
  if (m.origin === 'builtin') return 'builtin'
  if (m.origin === 'user' && !m.overridesId) return 'user'
  return ready(m) || (m.builtin && m.builtin.length) ? 'local' : 'cloud'
}
const norm = (s) => String(s || '').normalize('NFKC').toLowerCase()
// 排序：参数化模板（通信卫星平台，给星绑模型最常用）→ 航天器 → 空间站 / 载人 → 深空 → 部件 → 运载 → 地面设施 → 飞机 → 船 → 车；同类按名称
const KIND_RANK = { spacecraft: 1, station: 2, crewed: 3, deepspace: 4, component: 5, launcher: 6, ground: 7, aircraft: 8, ship: 9, vehicle: 10, other: 11 }
const rankOf = (m) => (isParam(m) ? 0 : (KIND_RANK[m.kind] || 11))
const sorted = computed(() => props.lib.slice().sort((a, b) => (rankOf(a) - rankOf(b)) || nameOf(a).localeCompare(nameOf(b), 'zh-Hans-CN')))
const shown = computed(() => {
  const k = norm(q.value).trim()
  return sorted.value.filter((m) => {
    if (seg.value !== 'all' && segOf(m) !== seg.value) return false
    if (!k) return true
    return norm(m.title).includes(k) || norm(m.titleZh).includes(k) || norm(m.id).includes(k) ||
      (Array.isArray(m.aliases) && m.aliases.some((a) => norm(a).includes(k))) || (Array.isArray(m.tags) && m.tags.some((a) => norm(a).includes(k)))
  })
})
// 点卡片 = 绑定到当前卫星；没有主选星时只在库里点亮（预览选中态，DESIGN §6.3），再点一次取消
const preview = ref('')
function pick(m) {
  if (props.sat) { preview.value = ''; emit('bind', m.id); return }
  preview.value = preview.value === m.id ? '' : m.id
}
watch(() => props.sat && props.sat.key, () => { preview.value = '' })
const cardOn = (m) => (props.sat ? !!(props.model && props.model.id === m.id) : preview.value === m.id)
function stateOf(m) {
  const p = prog.value.get(m.id)
  if (p) return { cls: 'dl', frac: p.frac, t: p.phase === 'queued' ? '排队中' : '下载中' }
  if (isGen(m)) return null
  if (ready(m)) return { cls: 'ok', t: '已缓存' }
  if (m.builtin && m.builtin.length) return { cls: 'ok', t: '随安装包' }
  return m.origin === 'remote' ? { cls: 'cloud', t: '云端' } : null
}

// 卡片右键菜单：fixed 定位在指针处，按实际尺寸夹回视口（同 SatLayersPanel 的 place）。
// 原来 absolute 挂在侧栏里、按侧栏坐标摆：右列卡片右键时菜单伸出侧栏右缘被裁掉一截
const menu = ref(null)   // { x, y, m }（视口坐标）
const menuEl = ref(null)
function openMenu(e, m) {
  menu.value = { x: e.clientX, y: e.clientY, m }
  window.addEventListener('keydown', onMenuKey, true)
  window.addEventListener('scroll', closeMenu, true)   // fixed 的菜单不跟卡片滚：侧栏一滚就收（捕获阶段收得到任何一层滚动区的 scroll）
  nextTick(() => {   // 量到实际宽高再夹（英文菜单更宽）；nextTick 在绘制之前，不会先闪一帧在原位
    const el = menuEl.value, cur = menu.value
    if (!el || !cur) return
    const r = el.getBoundingClientRect(), pad = 4
    const x = Math.max(pad, Math.min(cur.x, window.innerWidth - r.width - pad))
    const y = Math.max(pad, Math.min(cur.y, window.innerHeight - r.height - pad))
    if (x !== cur.x || y !== cur.y) menu.value = { ...cur, x, y }
  })
}
function closeMenu() {
  menu.value = null
  window.removeEventListener('keydown', onMenuKey, true)
  window.removeEventListener('scroll', closeMenu, true)
}
// Esc 关菜单：捕获阶段截住，同一下 Esc 不再被宿主页当成别的快捷键（同 SatLayersPanel）；输入法组字中的 Esc 归输入法
function onMenuKey(e) {
  if (e.key !== 'Escape' || e.isComposing) return
  e.stopPropagation(); e.preventDefault()
  closeMenu()
}
async function doDownload(m) {
  closeMenu()
  if (!canDownload(m)) return
  try { await models.ensure({ id: m.id, lod: 'lod0' }) } catch { /* 状态由下载事件回报 */ }
}
async function doRemove(m) {
  closeMenu()
  if (!models || !models.remove || !canRemoveCache(m)) return
  try { await models.remove(m.id) } catch { /* ignore */ }
}
function doOpen(m) { closeMenu(); emit('open-wb', { modelId: m.id }) }

// 卡片拖出（DESIGN3 E11）：拖到 3D 球 / 2D 平面图上的地球站、点标记、航迹载具头或卫星上松手 = 挂模型（接收在 3D 页 .stage-wrap）。
// 数据类型 application/x-satsim-model，值 {id, kind}（工作台库卡片下期照同一口径拖出）。
// 拖拽预览：缩略图就绪时现做一枚 64 px 的小卡（原图 384 px，直接交给 setDragImage 会按原尺寸画一大块）
const MDL_TYPE = 'application/x-satsim-model'
function onCardDrag(e, m) {
  const dt = e.dataTransfer
  if (!dt) return
  closeMenu()
  try { dt.setData(MDL_TYPE, JSON.stringify({ id: m.id, kind: m.kind || '' })) } catch { return }
  dt.effectAllowed = 'copy'
  const img = e.currentTarget && e.currentTarget.querySelector ? e.currentTarget.querySelector('.th img') : null
  if (!img || !(img.naturalWidth > 0) || typeof dt.setDragImage !== 'function') return
  try {
    // 画布是同步出内容的（新建 <img> 换 src 要异步解码，拍下来可能是空白）
    const S = 64, dpr = Math.min(3, window.devicePixelRatio || 1)
    const c = document.createElement('canvas')
    c.width = Math.round(S * dpr); c.height = Math.round(S * dpr)
    c.style.cssText = `position:fixed;left:-1000px;top:-1000px;width:${S}px;height:${S}px;pointer-events:none;`
    const x = c.getContext('2d')
    x.scale(dpr, dpr)
    const cs = getComputedStyle(document.documentElement)
    const bg = cs.getPropertyValue('--surface').trim() || '#1b1b1b', ln = cs.getPropertyValue('--accent-ui').trim() || '#6a8ab8'
    x.beginPath(); x.roundRect(1, 1, S - 2, S - 2, 6)
    x.globalAlpha = 0.92; x.fillStyle = bg; x.fill(); x.globalAlpha = 1
    x.lineWidth = 1.5; x.strokeStyle = ln; x.stroke()
    const k = Math.min((S - 8) / img.naturalWidth, (S - 8) / img.naturalHeight)
    const w = img.naturalWidth * k, h = img.naturalHeight * k
    x.drawImage(img, (S - w) / 2, (S - h) / 2, w, h)
    document.body.appendChild(c)
    dt.setDragImage(c, S / 2, S / 2)
    setTimeout(() => c.remove(), 0)   // 浏览器在 dragstart 返回时已把它拍成位图，节点当拍即可摘掉
  } catch { /* 拿不到预览就用浏览器缺省的半透明卡片 */ }
}
function onDocDown(e) { if (menu.value && !(e.target.closest && e.target.closest('.mdl-menu'))) closeMenu() }
onMounted(() => document.addEventListener('pointerdown', onDocDown, true))
onBeforeUnmount(() => { document.removeEventListener('pointerdown', onDocDown, true); closeMenu() })

const HUD = [
  { k: 'hudAxes', t: '本体轴', tt: '+X 红 / +Y 绿 / +Z 蓝' }, { k: 'hudLvlh', t: 'LVLH', tt: '沿迹 / 径向 / 轨道法向（r × v）' }, { k: 'hudNadir', t: '天底' },
  { k: 'hudVel', t: '速度', tt: '惯性速度方向' }, { k: 'hudSun', t: '太阳' },
  { k: 'hudIsl', t: 'ISL', tt: '与 500 km 内相邻卫星的通视连线（连线最低高度不低于 100 km）' },
  { k: 'hudEs', t: '地球站', tt: '标记层中仰角 ≥ 0° 的地球站方向，按距离由近及远取 12 个' },
  { k: 'hudMounts', t: '挂点', tt: '绑定表中各挂点的视轴射线与视场锥（视场取挂点的 fovDeg；未设置时按参数化天线的 −3 dB 波束宽度）',
    en: 'Mounts', ttEn: 'Boresight ray and field-of-view cone of each bound mount (FOV = the mount\'s fovDeg; otherwise the −3 dB beamwidth of the parametric antenna)' }
]
</script>

<template>
  <div class="cov-side mdl-side docked">

    <div class="sec">
      <div class="sect acc" data-sec="mdl-cur" :class="{ open: isSecOpen('mdl-cur') }" @click="toggleSec('mdl-cur')" role="button" tabindex="0" :aria-expanded="isSecOpen('mdl-cur') ? 'true' : 'false'" @keydown.enter.self.prevent="toggleSec('mdl-cur')" @keydown.space.self.prevent="toggleSec('mdl-cur')"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('mdl-cur') }" :size="12" /><span>当前卫星</span></div>
      <template v-if="isSecOpen('mdl-cur')">
        <div v-if="!sat" class="empty">未选择卫星。</div>
        <template v-else>
          <div class="cur">
            <div class="cthumb" :class="{ none: !thumbCur }">
              <img v-if="thumbCur" :src="thumbCur" crossorigin="anonymous" alt="" draggable="false" />
              <Icon v-else name="box" :size="30" :stroke-width="1.2" />
            </div>
            <div class="cinfo">
              <div class="csat" :title="sat.name" data-i18n-skip>{{ sat.name }}</div>
              <div class="cmod" :title="model && model.title ? model.title : ''" data-i18n-skip>{{ model && model.id ? model.name : '—' }}</div>
              <div v-if="model && model.id" class="cmeta">
                <span class="ic" :title="fidOf(model.fidelity).t + ' · ' + srcTitle(model.meta)"><Icon :name="fidOf(model.fidelity).icon" :size="12" /></span>
                <span class="ic" :class="{ ok: model.sizeVerified }" :title="model.sizeVerified ? '尺寸已核定（有出处）' : '尺寸未核定'"><Icon name="ruler" :size="12" /></span>
                <span class="ic" :class="{ ok: model.frameVerified }" :title="model.frameVerified ? '本体轴已核定' : '本体轴未核定'"><Icon name="axis-3d" :size="12" /></span>
              </div>
              <div v-if="model && model.dims" class="rd" title="包围盒（本体系 X × Y × Z）"><span class="n">{{ model.dims }}</span><i>m</i></div>
              <div v-if="model && model.mass" class="rd" title="整星质量"><span class="n">{{ model.mass }}</span><i>kg</i></div>
              <div v-if="model" class="rd att" :title="attTitle"><span class="lw">{{ lawName(model.law) }}</span><span class="n">{{ model.mounts || 0 }}</span><i>{{ zhEn('挂点', 'mounts') }}</i></div>
            </div>
          </div>
          <div class="srow"><label>模型</label>
            <select :value="bindValue" title="自动：按卫星名称 / NORAD 编号 / 轨道类别匹配；无：仅显示点符号" @change="onBindSelect">
              <option value="auto">{{ autoLabel }}</option>
              <option value="none">无</option>
              <option v-if="bindValue !== 'auto' && bindValue !== 'none'" :value="bindValue" data-i18n-skip>{{ model && model.name ? model.name : bindValue }}</option>
              <option value="__lib">库中模型…</option>
            </select>
          </div>
          <div class="btns">
            <button type="button" class="btn" :class="{ on: following }" :aria-pressed="following ? 'true' : 'false'" @click="emit('toggle-follow')"><Icon name="locate-fixed" :size="12" /><span>跟随卫星</span></button>
            <button type="button" class="btn" :disabled="!sat.key" :title="zhEn('模型工作台「卫星」页：姿态律、挂点、遮挡掩模', 'Model workbench, Satellite page: attitude law, mounts, obscuration masks')" @click="emit('open-wb', { tab: 'sat', satKey: sat.key, modelId: model && model.id })"><Icon name="pencil" :size="12" /><span>编辑…</span></button>
          </div>
        </template>
      </template>
    </div>

    <div class="sec" :class="{ hid: !st.modelOn }">
      <div class="sect acc" data-sec="mdl-disp" :class="{ open: isSecOpen('mdl-disp') }" @click="toggleSec('mdl-disp')" role="button" tabindex="0" :aria-expanded="isSecOpen('mdl-disp') ? 'true' : 'false'" @keydown.enter.self.prevent="toggleSec('mdl-disp')" @keydown.space.self.prevent="toggleSec('mdl-disp')"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('mdl-disp') }" :size="12" /><span>显示</span><button type="button" class="ibtn sm sect-rst" title="恢复本节默认" aria-label="恢复本节默认" @click.stop="emit('reset-style')"><Icon name="rotate-ccw" :size="12" /></button><button type="button" class="layersw sect-layersw" :class="{ on: st.modelOn }" role="switch" :aria-checked="st.modelOn ? 'true' : 'false'" :title="st.modelOn ? '隐藏模型（卫星显示为点符号，标记显示为图标）' : '显示模型'" @click.stop="emit('set-style', 'modelOn', !st.modelOn)"><i></i></button></div>
      <template v-if="isSecOpen('mdl-disp')">
        <div class="srow" :title="zhEn('卫星模型在默认视角下的包围直径（屏幕像素），随视距缩放；对全部卫星统一生效。标记所挂模型的大小与标记图标一致', 'Satellite model bounding diameter in pixels at the default view; grows when zooming in, shrinks when zooming out; applies to all satellites. Models on markers follow the marker icon size')"><label>图标大小</label><input class="rng" type="range" min="4" max="2048" step="1" :value="st.modelPx" @input="emit('set-style', 'modelPx', Number($event.target.value))" /><span class="u">{{ st.modelPx }}</span></div>
        <div class="hudt" title="跟随卫星时叠加的方向指示">HUD</div>
        <label v-for="h in HUD" :key="h.k" class="chk2" :title="h.en ? zhEn(h.tt, h.ttEn) : (h.tt || '')"><input type="checkbox" :checked="st[h.k]" @change="emit('set-style', h.k, $event.target.checked)" /><span>{{ h.en ? zhEn(h.t, h.en) : h.t }}</span></label>
      </template>
    </div>

    <div ref="libEl" class="sec lib">
      <div class="sect acc" data-sec="mdl-lib" :class="{ open: isSecOpen('mdl-lib') }" @click="toggleSec('mdl-lib')" role="button" tabindex="0" :aria-expanded="isSecOpen('mdl-lib') ? 'true' : 'false'" @keydown.enter.self.prevent="toggleSec('mdl-lib')" @keydown.space.self.prevent="toggleSec('mdl-lib')"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('mdl-lib') }" :size="12" /><span>模型库</span><span class="cnt">{{ shown.length }}</span></div>
      <template v-if="isSecOpen('mdl-lib')">
        <div class="srch search-field"><Icon name="search" :size="12" /><input v-model="q" type="text" placeholder="搜索" spellcheck="false" /><button type="button" v-if="q" class="ibtn sm" title="清除" @click="q = ''"><Icon name="x" :size="12" /></button></div>
        <div class="seg nseg" role="radiogroup" aria-label="来源">
          <button type="button" v-for="s in SEGS" :key="s.k" role="radio" :aria-checked="!!(seg === s.k)" class="sg" :class="{ on: seg === s.k }" @click="seg = s.k">{{ s.t }}</button>
        </div>
        <div v-if="!lib.length" class="empty">暂无模型。</div>
        <div v-else-if="!shown.length" class="empty">无匹配模型。</div>
        <div v-else class="grid" @contextmenu.prevent>
          <div
            v-for="m in shown" :key="m.id" :ref="observe" class="card" :class="{ on: cardOn(m) }" :data-id="m.id" draggable="true"
            :title="nameOf(m) + '\n' + srcTitle(m)" @click="pick(m)" @dragstart="onCardDrag($event, m)" @contextmenu.prevent.stop="openMenu($event, m)"
          >
            <div class="th">
              <img v-if="thumbs.get(m.id)" :src="thumbs.get(m.id)" crossorigin="anonymous" alt="" draggable="false" loading="lazy" />
              <Icon v-else :name="phIcon(m)" :size="26" :stroke-width="1.2" />
              <span class="fid" :title="fidOf(m.fidelity).t"><Icon :name="fidOf(m.fidelity).icon" :size="12" /></span>
              <template v-if="stateOf(m)">
                <span v-if="stateOf(m).cls === 'dl'" class="bar" :title="stateOf(m).t"><i :style="{ width: Math.round(stateOf(m).frac * 100) + '%' }"></i></span>
                <span v-else class="stt" :class="stateOf(m).cls" :title="stateOf(m).t"><Icon :name="stateOf(m).cls === 'cloud' ? 'cloud-download' : 'check'" :size="12" /></span>
              </template>
            </div>
            <div class="nm" data-i18n-skip>{{ nameOf(m) }}</div>
          </div>
        </div>
      </template>
    </div>

    <div class="foot">
      <button type="button" class="btn wide" @click="emit('open-wb', { satKey: sat && sat.key, modelId: model && model.id })"><Icon name="box" :size="12" /><span>模型工作台</span></button>
    </div>

    <div v-if="menu" ref="menuEl" class="mdl-menu menu" role="menu" :style="{ left: menu.x + 'px', top: menu.y + 'px' }">
      <button type="button" class="mi menu-item" role="menuitem" :class="{ dis: !canDownload(menu.m) }" @click="canDownload(menu.m) && doDownload(menu.m)">下载</button>
      <button type="button" v-if="isCloud(menu.m)" class="mi menu-item" role="menuitem" :class="{ dis: !canRemoveCache(menu.m) }" @click="canRemoveCache(menu.m) && doRemove(menu.m)">移除缓存</button>
      <button type="button" class="mi menu-item" role="menuitem" @click="doOpen(menu.m)">在工作台中打开</button>
    </div>
  </div>
</template>

<style scoped>
/* 侧栏视觉语言照抄 ConstellationMap3D / SatCovPanel 的 .cov-side 一套（那份是 scoped 的、进不到本组件），改动请对照 */
.cov-side { width: 286px; flex: none; background: var(--surface); overflow-y: auto; display: flex; flex-direction: column; font-size: var(--fs-3); }
.cov-side.docked { width: auto; border-left: 0; overflow: visible; }
.mdl-side { position: relative; }
.sec { padding: 12px 16px; border-bottom: 1px solid var(--border); }
.sec > * + * { margin-top: 8px; }
.sec > .sect + * { margin-top: 6px; }
.sec.hid > :not(.sect) { opacity: .5; }
.srow { --srow-lab: 70px; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
.srow label { color: var(--text-muted); min-width: var(--srow-lab); max-width: 100%; flex: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.srow select { flex: 1; min-width: 116px; border: 1px solid var(--field-border); background-color: var(--field-bg); padding: 0 7px; font-size: var(--fs-3); outline: none; color: var(--text); }
.srow .u { flex: none; min-width: 34px; text-align: right; color: var(--text-muted); font-variant-numeric: tabular-nums; }
.rng { flex: 1; min-width: 0; }
.sect { display: flex; align-items: center; color: var(--text); }
.sect.acc { cursor: pointer; user-select: none; gap: 5px; margin-inline: -6px; padding: 3px 6px; border-radius: var(--r-box); transition: background-color var(--dur-1) linear; }
.sect.acc .app-icon { flex: none; color: var(--text-faint); }
.sect.acc:hover { background: color-mix(in srgb, var(--text) 5%, transparent); }
.sect.acc:has(.lnk:hover, .layersw:hover) { background: transparent; }
.sec > .sect.acc:first-child { margin-top: -3px; }
.sec > .sect.acc:last-child { margin-bottom: -3px; }
.sect .lnk { margin-left: auto; color: var(--text-muted); cursor: pointer; font-size: var(--fs-3); transition: color var(--dur-1) linear; }
.sect .lnk:hover { color: var(--text); text-decoration: underline; text-underline-offset: 2px; }
.sect-layersw { margin-left: auto; }
.sect .lnk ~ .sect-layersw { margin-left: 12px; }
.sect > .sect-rst { margin-left: auto; color: var(--text-faint); }
.sect > .sect-rst:hover { color: var(--text); }
.sect > .sect-rst + .sect-layersw { margin-left: 6px; }
.sect .cnt { margin-left: auto; color: var(--text-faint); font-variant-numeric: tabular-nums; font-size: var(--fs-2); }
.chk2 { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.chk2 + .chk2 { margin-top: 5px; }
.empty { color: var(--text-faint); padding: 4px 0; }
.hudt { color: var(--text-muted); font-size: var(--fs-2); letter-spacing: var(--ls-caps); }

/* 当前卫星 */
.cur { display: flex; gap: 10px; align-items: flex-start; }
.cthumb { flex: none; width: 96px; height: 96px; border: 1px solid var(--border); border-radius: var(--r-box); background: radial-gradient(ellipse at 50% 38%, color-mix(in srgb, var(--text) 7%, var(--surface)) 0%, var(--surface) 75%); display: flex; align-items: center; justify-content: center; overflow: hidden; color: var(--text-faint); }
.cthumb img { width: 100%; height: 100%; object-fit: contain; }
.cinfo { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.csat { color: var(--text-muted); font-size: var(--fs-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cmod { color: var(--text); font-size: var(--fs-4); line-height: 1.3; overflow-wrap: anywhere; }
.cmeta { display: flex; gap: 6px; }
.cmeta .ic { display: inline-flex; color: var(--text-faint); }
.cmeta .ic.ok { color: var(--ok); }
.rd { font-family: var(--font-mono); font-variant-numeric: tabular-nums; color: var(--text); font-size: var(--fs-3); }
.rd i { font-style: normal; color: var(--text-faint); font-size: var(--fs-2); margin-left: 3px; }
.rd.att { display: flex; align-items: baseline; gap: 6px; }
.rd.att .lw { font-family: var(--font-ui); color: var(--text-muted); font-size: var(--fs-2); }
.rd.att .n + i { margin-left: 0; }
.btns { display: flex; gap: 8px; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: var(--h-ctl); padding: 0 12px; border: 1px solid var(--border-strong); border-radius: var(--r-ctl); background: var(--surface); color: var(--text); font-size: var(--fs-3); cursor: pointer; transition: background-color var(--dur-1) linear, border-color var(--dur-1) linear; }
.btn:hover:not(:disabled) { background: var(--wash-hover); }
.btn:disabled { color: var(--text-faint); cursor: default; }
/* 切换钮按下态：与全局 controls.css 的 .btn.on 同一种实底（本文件自带一份 .btn，特异度更高，须就地再写） */
.btn.on, .btn.on:hover:not(:disabled) { background: var(--sel-fill); border-color: var(--sel-fill); color: var(--sel-on); }
.btns .btn { flex: 1 1 0; }
.btn.wide { width: 100%; }

/* 模型库 */
.srch { display: flex; align-items: center; gap: 6px; height: var(--h-ctl); padding: 0 8px; border: 1px solid var(--field-border); background: var(--field-bg); color: var(--text-faint); }
.srch input { flex: 1; min-width: 0; border: 0; background: transparent; outline: none; color: var(--text); font-size: var(--fs-3); padding: 0; height: 100%; }
/* 分段（本体在 controls.css）：来源三段铺满整行 */
.seg > .sg { flex: 1 1 auto; padding-left: 4px; padding-right: 4px; }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.card { border: 1px solid var(--border); border-radius: var(--r-box); background: var(--surface); cursor: pointer; overflow: hidden; transition: border-color var(--dur-1) linear, background-color var(--dur-1) linear; }
.card:hover { border-color: var(--border-strong); background: color-mix(in srgb, var(--text) 4%, var(--surface)); }
.card.on { border-color: var(--accent-ui); box-shadow: inset 0 0 0 1px var(--accent-ui); }
.th { position: relative; aspect-ratio: 1 / 1; display: flex; align-items: center; justify-content: center; color: var(--text-faint);
  background: radial-gradient(ellipse at 50% 38%, color-mix(in srgb, var(--text) 7%, var(--surface)) 0%, var(--surface) 78%); }
.th img { width: 100%; height: 100%; object-fit: contain; }
.th .fid { position: absolute; left: 4px; top: 4px; display: inline-flex; color: var(--text-faint); }
.th .stt { position: absolute; right: 4px; top: 4px; display: inline-flex; align-items: center; justify-content: center; width: 15px; height: 15px; border-radius: 50%; background: var(--surface); border: 1px solid var(--border); color: var(--text-faint); }
.th .stt.ok { color: var(--ok); }
.th .stt.cloud { color: var(--text-muted); }
.th .bar { position: absolute; left: 6px; right: 6px; bottom: 5px; height: 3px; border-radius: 2px; background: color-mix(in srgb, var(--text) 14%, transparent); overflow: hidden; }
.th .bar > i { display: block; height: 100%; background: var(--accent-ui); transition: width .2s linear; }
/* 两行截断：留白放在 margin 上 —— 放 padding 里的话第三行会从下内边距里露出半截（overflow 按内边距盒裁） */
.nm { margin: 4px 6px 5px; font-size: var(--fs-2); line-height: 1.3; color: var(--text); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; min-height: calc(2 * 1.3em); max-height: calc(2 * 1.3em); }
.foot { padding: 12px 16px; }
/* 外观走 controls.css 的菜单基线（.menu / .menu-item）；这里只留定位与宽度 */
.mdl-menu { position: fixed; min-width: 132px; }
</style>
