// 波束合成（对齐 TICRA SATSOFT）：嵌套模型 —— 卫星 ▸ 波束组 ▸ 波束设置 ▸ 波束。
//   · 波束组(Group)＝一根生成的天线；两种类型：多馈源反射面(gauss，点波束群) / 赋形反射面(shaped，Polygon 赋形)。
//     一颗星可挂多个组 → 多根天线（覆盖树本就支持每星多天线，改的只是编辑器能同时握多份草稿并切换）。
//   · 波束设置(Setting，仅高斯)＝命名宽度预设（如 0.8°/0.9°/1.6°）；按当前激活设置放置波束，各波束
//     记住自己的 thX/thY/rot，混合宽度合成到同一根天线（buildGaussGrd 逐波束算峰值，天然支持）。
//   · 赋形＝Polygon 基（覆盖区并集），无波束设置。
//
// 工作态（satFolder/mode/beams/settings/activeSettingId/curName/p）是「当前编辑组」的活动镜像：
//   selectGroup = commitActive()→hydrate(目标)；兄弟组不被编辑，其数据留在各自的 group 对象里。
// 生成：generateGroup 经 synth.js 产标准 GRD → grd.importSynthGrd 入树（同名替换＝更新），此后与导入
//   GRD 天线完全同构（拖拽指向/性能表/导出链全通）。草图独立持久化 localStorage（v2 嵌套，含旧档迁移）。
import { ref, reactive, computed, watch } from 'vue'
import { theta3dbFromAperture, shapedTheta3db, shapedApertureEff, feedGeom, crossoverDb, polysUnionPeak, buildGaussGrd, buildShapedGrd, beamSketchRing, hexFillCenters, snapTangentAzEl, colorFreqPlan, solveReflector, solvePam, buildPamGrd } from './synth.js'
import { dirToAzEl, azElGround } from './coverage.js'

const KEY = 'globe3d/beamSynth'
const BAK = KEY + '.v1bak'                        // 旧档一次性备份（首次升级到 v2 前写入，可回退）
const SKETCH_CSS = '#5ad1ff'                      // 草图默认轮廓色（放置阶段，与正式覆盖层区分）
const DIM_NUM_CSS = '#8a97a6'                     // 兄弟组（只读）编号色（压暗，与激活组区分）
// 频率计划配色板（三色/四色取前 3/4 个；七色 = 经典蜂窝 reuse-7）：饱和度压过、地图上不刺眼
const FC_PALETTE = [0xe05252, 0xf2c14e, 0x3fb77f, 0x4f8fe8, 0xa06fdc, 0xf08a3c, 0x38b8b0]
const fcHex = (i) => FC_PALETTE[((i % FC_PALETTE.length) + FC_PALETTE.length) % FC_PALETTE.length]
const fcCss = (i) => '#' + fcHex(i).toString(16).padStart(6, '0')
// 波束设置默认配色板（每个新设置换一色，便于区分不同宽度的波束环）
const SETTING_CSS = ['#5ad1ff', '#f2c14e', '#3fb77f', '#e05252', '#a06fdc', '#f08a3c', '#38b8b0', '#4f8fe8']
// '#rrggbb' → 数值色（渲染层吃数值）；非法输入回退 fb
const cssNum = (s, fb) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(s || '').trim()); return m ? parseInt(m[1], 16) : fb }

// 组级参数默认值（不含宽度/名字——宽度在 Setting，名字＝Group.name）
const DEFAULT_P = {
  fGHz: 14.25, antD: 2.4, eff: 55,               // 频率/口径/效率（效率现由解析反射面模型算出，此值被 refl 同步覆盖）
  // —— 解析反射面模型耦合（高斯档，SATSOFT/AR §6.3.2）：口径↔波束宽、焦距↔馈源间距 两组「选一驱动」；效率/方向性算出 ——
  apDriver: 'aperture',                          // 口径驱动方向：'aperture'=填口径算波束宽 | 'beamwidth'=填波束宽算口径
  bw3: 1.6,                                       // Design 3dB BW（deg）：apDriver='beamwidth' 时为输入，否则镜像自算出值
  fdDriver: 'focal',                             // 焦距驱动方向：'focal'=填焦距算馈源间距 | 'feedspacing'=填馈源间距算焦距
  feedSpacingWl: 1.5,                            // 馈源间距（WL）：fdDriver='feedspacing' 时为输入，否则镜像自算出值
  feedModel: 'te11',                             // 馈源模型：'te11'（单模）| 'potter'（TE11+TM11，更宽、效率更低）
  feedDiaAuto: true, feedDiaWl: 1.5,             // 馈源直径 Auto=馈源间距（避免交叠）；否则手填 WL
  autoSpacing: true, spacing: 3,                 // 蜂窝布满角间距（Auto = 激活设置 θx → 交叠 −3.01 dB）
  snapTangent: true,                             // SATSOFT 式相切吸附
  skColor: SKETCH_CSS, skWidth: 1.5, skDash: false,
  skNumShow: true, skNumMode: 'auto', skNumScale: 100, skNumSize: 14, skNumColor: SKETCH_CSS,
  fcN: 4, fcShow: true, fcOpacity: 0.3,          // 频率计划：颜色数（3/4/7）/ 显隐 / 填充透明度
  polyId: '',                                    // 蜂窝布满目标 Polygon（高斯档）
  polyIds: [],                                   // 赋形：覆盖区 Polygon（多选）；各区目标电平 = 该 Polygon 的「数值」栏
  shapedMode: 'value',                           // 电平口径：'value'=按覆盖值(Polygon 数值当绝对 EIRP/覆盖) | 'physical'=按天线增益(方向图积分算 dBi，数值只提供分区相对锥度)
  // —— 赋形反射面模型（对齐 SATSOFT Shaped Reflector Model 对话框 §6.4）——
  foc: 3,                                        // 焦距（m）→ F/D 读数；本引擎只参与几何/馈源读数
  taper: -15,                                    // 馈源边缘锥度（dB）→ 成分波束宽 θ3=k(|T|)·λ/D；−15 ≈ 旧版 70λ/D
  simSame: true, fSim: 14.25,                    // 仿真频率（=方向图计算频率）；默认同设计频率 fGHz
  pol: 'linX',                                   // 极化类型 'linX'|'linY'|'rhcp'|'lhcp'（记入 SYNTHMETA；不改功率方向图）
  offsetClr: 0.2,                                // 偏置净空/D（0=贴轴，-0.5=正馈）——几何/馈源直径读数
  hotspots: [],                                  // 峰点引导（连续目标场）[{id,lon,lat,boost,width}]：boost=目标增量dB，width=坡宽°(空=θ3)
  // —— 相控阵（PAM，SATSOFT §6.5）组级参数：矩形阵 Nx×Ny 单元 · 间距 dx/dy(WL) · 单元因子 cos^R · 三角晶格 ——
  pamNx: 8, pamNy: 8, pamDx: 0.6, pamDy: 0.6, pamR: 1.2, pamElem: true, pamTri: false, pamEff: 100, pamFGHz: 20
}
const freshP = () => ({ ...DEFAULT_P, polyIds: [], hotspots: [] })
// 高斯档「反射面参数」键：下沉到每个波束设置（每设置 = 一套独立反射面 → 各自波束宽/效率/方向性）。
// 组级 p 只留显示/频率计划（skColor/fc*/polyId/snapTangent）与赋形档参数（taper/polyIds/hotspots/shapedMode）。
const RP_KEYS = ['fGHz', 'antD', 'eff', 'apDriver', 'bw3', 'fdDriver', 'feedSpacingWl', 'feedModel', 'feedDiaAuto', 'feedDiaWl', 'foc', 'offsetClr', 'pol', 'simSame', 'fSim', 'autoSpacing', 'spacing']
const pickRP = (src) => { const o = {}; for (const k of RP_KEYS) o[k] = (src && src[k] !== undefined) ? src[k] : DEFAULT_P[k]; return o }
const defName = (m) => (m === 'pam' ? '相控阵' : m === 'shaped' ? '赋形反射面' : '多馈源反射面')
// 大圆距离（km）：峰点引导 —— 实际峰值落点与引导点的偏差报告
const gcKm = (lo1, la1, lo2, la2) => {
  const d2r = Math.PI / 180, dLa = (la2 - la1) * d2r, dLo = (lo2 - lo1) * d2r
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * d2r) * Math.cos(la2 * d2r) * Math.sin(dLo / 2) ** 2
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)))
}

export function useBeamSynth({ grd, getPolys, livePos, appAlert, refresh }) {
  const polysOf = () => (getPolys() || [])
  const open = ref(false)

  // ---- 嵌套数据 + 当前编辑组的活动镜像 ----
  const groups = ref([])                          // 全部波束组（跨星），每个 group 自带 satFolder
  const activeGroupId = ref(null)
  const satFolder = ref('')                       // 导航器选中的卫星（＝激活组的卫星）
  const mode = ref('gauss')                       // 激活组类型 'gauss'|'shaped'
  const beams = ref([])                           // 激活组波束 [{id,lon,lat,thX,thY,rot,fc?,settingId?}]（高斯）
  const settings = ref([])                        // 激活组波束设置 [{id,name,thX,thY,rot,autoTheta,color}]（高斯）
  const activeSettingId = ref(null)
  const curName = ref('多馈源反射面')             // 激活组名（＝天线名，同名生成＝更新）
  const placing = ref(false)                      // 放置模式：地图点击 = 放一个波束轮廓 / 拾取峰点
  const adjusting = ref(false)                    // 调整模式：平面图拖动波束中心
  const deleting = ref(false)                     // 删除模式：平面图点击命中的波束中心 = 删除该波束
  const hotPickId = ref(null)                     // 赋形峰点拾取目标行 id（placing 且非空 → 地图点击写该峰点）
  const status = ref('')
  const p = reactive(freshP())                    // 激活组的组级参数

  let seq = 1
  const newId = (pfx) => pfx + Date.now().toString(36) + (seq++)
  let _loading = false                            // hydrate/load 期间抑制 watcher 回写
  let _drag = false                               // 拖拽中：抑制逐帧持久化

  // ---- 组/设置查询 ----
  const curGroup = computed(() => groups.value.find((g) => g.id === activeGroupId.value) || null)
  const hasGroup = computed(() => !!curGroup.value)
  const curSetting = computed(() => settings.value.find((s) => s.id === activeSettingId.value) || settings.value[0] || null)
  const groupsForSat = computed(() => groups.value.filter((g) => g.satFolder === satFolder.value))
  // 当前星下参与草图渲染的组（仅高斯有轮廓）：默认只画激活组，避免多组同屏乱——想对照时手动「常显」(pinned) 该组
  const visibleGroups = () => groups.value.filter((g) => g.satFolder === satFolder.value && (g.mode === 'gauss' || g.mode === 'pam') && (g.id === activeGroupId.value || g.pinned))
  // 激活组的整星编号偏移＝同星、更靠前的可见高斯组的波束总数
  const beamNumOffset = computed(() => {
    let off = 0
    for (const g of visibleGroups()) {
      if (g.id === activeGroupId.value) break
      off += (g.beams ? g.beams.length : 0)
    }
    return off
  })
  // 组徽标统计（激活组取活动镜像的实时数，兄弟组取其存储数）
  function groupStat(g) {
    if (g.mode === 'gauss' || g.mode === 'pam') { const n = g.id === activeGroupId.value ? beams.value.length : (g.beams ? g.beams.length : 0); return { n, unit: '波束' } }
    const ids = g.id === activeGroupId.value ? p.polyIds : (g.p && g.p.polyIds ? g.p.polyIds : [])
    return { n: Array.isArray(ids) ? ids.length : 0, unit: '区' }
  }

  // ---- 参数换算（实时显示，对齐 SATSOFT 口径）----
  // 仿真频率（=方向图计算频率，默认同设计）
  const simFreqOf = (gp) => (gp && gp.simSame !== false ? Number(gp.fGHz) : Number(gp && gp.fSim))
  const shapedSimF = computed(() => simFreqOf(p))
  // 解析反射面求解（高斯档 SATSOFT/AR §6.3.2）：从组参数 gp 反解全部耦合量——口径↔波束宽、焦距↔馈源间距按驱动取舍，效率/方向性算出
  const reflOf = (gp) => solveReflector({
    apDriver: gp.apDriver === 'beamwidth' ? 'beamwidth' : 'aperture', apertureM: Number(gp.antD), beamwidthDeg: Number(gp.bw3),
    fdDriver: gp.fdDriver === 'feedspacing' ? 'feedspacing' : 'focal', focalM: Number(gp.foc), feedSpacingWl: Number(gp.feedSpacingWl),
    offsetClr: Number(gp.offsetClr), fDesignGHz: Number(gp.fGHz), fSimGHz: simFreqOf(gp), feedModel: gp.feedModel === 'potter' ? 'potter' : 'te11',
    feedDiaAuto: gp.feedDiaAuto !== false, feedDiaWl: Number(gp.feedDiaWl), beamSpacingAuto: gp.autoSpacing !== false, beamSpacingDeg: Number(gp.spacing)
  })
  // 反射面参数下沉到每个设置：refl = 当前激活设置的反射面解（每设置一套独立反射面 → 各自波束宽/效率/方向性）
  const refl = computed(() => (mode.value === 'gauss' && curSetting.value ? reflOf(curSetting.value) : { ok: false }))
  // 当前设置口径 → 波束宽 θ3dB（deg）：解析反射面算出；无解时回落 70λ/D
  const thetaAuto = computed(() => { const r = refl.value; if (r && r.ok && r.th3Design > 0) return r.th3Design; const s = curSetting.value; return s ? theta3dbFromAperture(Number(s.fGHz), Number(s.antD)) : NaN })
  // 方向性＝反射面口径面积方向性（与天线参数一致；高斯波束宽公式差 k 因子，生成时用 effGauss 补齐峰值）
  const dirDbi = computed(() => { const r = refl.value; return r && r.ok ? r.dirDbi : NaN })
  const crossX = computed(() => { const s = curSetting.value; return s ? crossoverDb(Number(s.spacing), Number(s.thX)) : NaN })
  const crossY = computed(() => { const s = curSetting.value; return s ? crossoverDb(Number(s.spacing), Number(s.thY)) : NaN })
  // ---- 相控阵（PAM，SATSOFT §6.5）：阵面参数（组级 p）→ solvePam 读数（波束宽/间距/交叉/栅瓣/方向性/可扫范围）----
  const pamOf = (gp) => solvePam({ fGHz: Number(gp.pamFGHz), Nx: Number(gp.pamNx), Ny: Number(gp.pamNy), dxWl: Number(gp.pamDx), dyWl: Number(gp.pamDy), R: Number(gp.pamR), eff: Number(gp.pamEff), tri: gp.pamTri === true })
  const pam = computed(() => (mode.value === 'pam' ? pamOf(p) : { ok: false }))
  const pamTheta = computed(() => { const v = pam.value; return v && v.ok ? { x: v.th3xDeg, y: v.th3yDeg } : { x: NaN, y: NaN } })
  // 赋形：仿真频率 → 成分波束宽 θ3=k(|锥度|)·λ/D
  const shapedTheta3 = computed(() => shapedTheta3db(shapedSimF.value, Number(p.antD), Number(p.taper)))
  // 赋形口径效率（照射×溢出，由馈源锥度定死）：只读读数 + 生成定标用（不再自由输入）
  const shapedEff = computed(() => shapedApertureEff(Number(p.taper)).effPct)
  // 反射面/馈源几何读数（F/D、均匀口径 3dB 宽、λ、馈源直径 WL/cm——对齐官方对话框）
  const shapedRefl = computed(() => {
    const g = feedGeom({ Dm: Number(p.antD), focM: Number(p.foc), fGHz: shapedSimF.value, taperDb: Number(p.taper), offsetClr: Number(p.offsetClr) })
    const fD = Number(p.fGHz)
    return g ? { ...g, lamDesignCm: fD > 0 ? 100 * 0.299792458 / fD : NaN, lamSimCm: shapedSimF.value > 0 ? 100 * 0.299792458 / shapedSimF.value : NaN } : null
  })
  const polysForP = (gp) => polysOf().filter((x) => gp && Array.isArray(gp.polyIds) && gp.polyIds.includes(x.id) && x.pts && x.pts.length >= 3)
  const shapedPolys = () => polysForP(p)
  const shapedPeak = computed(() => {
    const pgs = shapedPolys(), node = satNode()
    if (!pgs.length || !node) return null
    const pos = livePos(node)
    return polysUnionPeak({
      satLon: pos.lon, satLat: pos.lat || 0, altKm: pos.altKm,
      polysPts: pgs.map((pg) => pg.pts.map((q) => [q[0], q[1]])),
      effPct: shapedEff.value, theta3: Number(shapedTheta3.value) > 0 ? Number(shapedTheta3.value) : 0
    })
  })
  function togglePoly(id) {
    if (!Array.isArray(p.polyIds)) p.polyIds = []
    const i = p.polyIds.indexOf(id)
    if (i >= 0) p.polyIds.splice(i, 1); else p.polyIds.push(id)
    refresh()                                      // 质心变了：地图上的视轴中心点/调整手柄跟着刷新
  }

  function satNodeOf(folder) { return grd.sats.value.find((x) => x.folder === folder) || null }
  function satNode() { return satNodeOf(satFolder.value) }
  function satPos() { const n = satNode(); return n ? livePos(n) : null }

  // ---- 解析反射面：把算出的被动量同步回【当前设置】（反射面参数下沉到每设置；效率恒算出；被动的
  //      口径/波束宽、焦距/馈源间距 按驱动镜像，保持 setting.antD/foc 始终为物理一致的规范值）----
  let _syncingRefl = false
  function syncReflBack() {
    if (_syncingRefl || _loading || mode.value !== 'gauss') return   // 仅高斯档：赋形的 eff 由用户填，勿被反射面覆盖
    const s = curSetting.value; if (!s) return
    const r = refl.value
    if (!r || !r.ok) return
    _syncingRefl = true
    const setNum = (k, v, eps = 1e-6) => { if (Number.isFinite(v) && Math.abs(Number(s[k]) - v) > eps) s[k] = +v.toFixed(6) }
    setNum('eff', r.effPct, 1e-4)                                     // 口径效率恒算出
    if (s.apDriver === 'beamwidth') setNum('antD', r.Dm); else setNum('bw3', r.th3Design)
    if (s.fdDriver === 'feedspacing') setNum('foc', r.focM); else setNum('feedSpacingWl', r.feedSpacingWl)
    if (s.feedDiaAuto !== false) setNum('feedDiaWl', r.feedDiaWl)     // Auto：馈源直径=间距
    _syncingRefl = false
  }
  watch(refl, () => { if (!_loading) syncReflBack() }, { flush: 'sync' })

  // ---- 波束宽 = 本设置反射面 θ3：θ3 变→同步【当前设置 + 属于它的波束】的宽度=θ3（圆波束，thX=thY，rot 不变）。
  //      各设置各自 θ3；beams 的 thX/thY 存值恒 = 其所属设置的 θ3，下游渲染/吸附照旧用存值。----
  function syncWidths() {
    if (_loading) return
    const t = thetaAuto.value
    if (!(Number.isFinite(t) && t > 0)) return
    const w = +t.toFixed(4)
    const s = curSetting.value; if (!s) return
    if (s.thX !== w || s.thY !== w) { s.thX = w; s.thY = w }
    const sid = activeSettingId.value
    for (const b of beams.value) if (b.settingId === sid && (b.thX !== w || b.thY !== w)) { b.thX = w; b.thY = w; b._ring = null }
  }
  watch(thetaAuto, syncWidths, { immediate: true, flush: 'sync' })   // sync：_loading 守卫在 hydrate 内同步生效
  watch([() => (curSetting.value ? curSetting.value.thX : null), () => (curSetting.value ? curSetting.value.autoSpacing : null)], () => {
    if (_loading) return
    const s = curSetting.value
    if (s && s.autoSpacing !== false && Number.isFinite(Number(s.thX))) s.spacing = Number(s.thX)
  }, { immediate: true, flush: 'sync' })
  // 相控阵：阵面参数变→波束宽变→同步所有波束的 thX/thY（草图轮廓跟随；生成时用 solvePam 精确值不读此）。
  function syncPamWidths() {
    if (_loading || mode.value !== 'pam') return
    const t = pamTheta.value
    if (!(t.x > 0 && t.y > 0)) return
    const wx = +t.x.toFixed(4), wy = +t.y.toFixed(4)
    for (const b of beams.value) if (b.thX !== wx || b.thY !== wy) { b.thX = wx; b.thY = wy; b._ring = null }
  }
  watch(pamTheta, syncPamWidths, { flush: 'sync' })
  // 「新勾选带数值 Polygon → 自动切 value 口径」的逻辑放在 togglePoly（用户动作里），不用 watcher。

  // ---- 持久化（草图独立于覆盖树，v2 嵌套）----
  const bareBeam = (b) => ({ id: b.id, lon: b.lon, lat: b.lat, thX: b.thX, thY: b.thY, rot: b.rot || 0, ...(b.fc != null ? { fc: b.fc } : {}), ...(b.settingId != null ? { settingId: b.settingId } : {}) })
  const bare = (list) => list.map(bareBeam)       // 剥离渲染缓存（_ring）
  const bareSetting = (s) => ({ id: s.id, name: s.name, thX: s.thX, thY: s.thY, rot: s.rot || 0, color: s.color || SKETCH_CSS, ...pickRP(s) })
  const serializeGroup = (g) => ({ id: g.id, satFolder: g.satFolder, mode: g.mode, name: g.name, pinned: !!g.pinned, p: { ...g.p }, settings: (g.settings || []).map(bareSetting), activeSettingId: g.activeSettingId, beams: bare(g.beams || []), ...(g._genName ? { _genName: g._genName } : {}) })

  // 把工作态镜像回激活组对象（beams/settings 用【活动引用】以保住 _ring 缓存与对象身份）
  function commitActive() {
    const g = curGroup.value
    if (!g) return
    g.satFolder = satFolder.value
    g.mode = mode.value
    g.name = curName.value
    g.p = { ...p }
    g.settings = settings.value
    g.activeSettingId = activeSettingId.value
    g.beams = beams.value
  }
  // 从组对象装载到工作态（_loading 下进行，防 watcher 中途改宽度）
  function hydrate(g) {
    _loading = true
    try {
      if (!g) { beams.value = []; settings.value = []; activeSettingId.value = null; return }
      satFolder.value = g.satFolder || ''
      mode.value = (g.mode === 'shaped' || g.mode === 'pam') ? g.mode : 'gauss'
      curName.value = g.name || defName(mode.value)
      const gp = g.p || {}, fp = freshP()
      // 组里【存了】的键照抄（含 null）；没存的键（旧档升级）回落新鲜默认——绝不保留上一组的活动镜像残值（跨组泄漏）
      for (const k of Object.keys(p)) p[k] = gp[k] !== undefined ? gp[k] : fp[k]
      if (!Array.isArray(p.polyIds)) p.polyIds = []
      if (!Array.isArray(p.hotspots)) p.hotspots = []
      settings.value = Array.isArray(g.settings) ? g.settings : []
      if (mode.value === 'gauss' && !settings.value.length) settings.value = [defaultSetting()]
      activeSettingId.value = (settings.value.find((s) => s.id === g.activeSettingId) ? g.activeSettingId : (settings.value[0] ? settings.value[0].id : null))
      beams.value = Array.isArray(g.beams) ? g.beams.filter((b) => b && b.id) : []
    } finally { _loading = false }
    // 反射面算出值回填：hydrate 期间 _loading 掐断了 syncReflBack，收尾补一次（否则 eff/波束宽/馈源间距停在存档旧值）
    syncReflBack()
    // 波束宽拉齐：把装载组的所有设置/波束宽度对齐到 θ3（存档里可能是旧的独立宽度，如 0.444 → 强制=θ3）
    syncWidths()
    // Auto 间距兜底：hydrate 期间 _loading 掐断了同步 watcher（flush:'sync'），收尾把每个设置的「波束间距」同步到其宽度 θ3dB。
    for (const s of settings.value) if (s.autoSpacing !== false && Number.isFinite(Number(s.thX))) s.spacing = Number(s.thX)
    syncPamWidths()   // 相控阵：装载组时把波束宽对齐到阵面 θ3（_loading 期 watcher 被掐断）
  }
  function persist() {
    if (_loading || _drag) return
    commitActive()
    try { localStorage.setItem(KEY, JSON.stringify({ v: 2, activeGroupId: activeGroupId.value, groups: groups.value.map(serializeGroup) })) } catch { /* ignore */ }
  }
  function defaultSetting(nameHint) {
    const idx = settings.value.length
    const rp = pickRP(curSetting.value || DEFAULT_P)          // 新设置反射面：从当前设置拷一份（起步=当前反射面，再改口径等）
    const r = reflOf(rp)
    const w = r && r.ok && r.th3Design > 0 ? +r.th3Design.toFixed(3) : (Number(curSetting.value && curSetting.value.thX) || 3)
    return { id: newId('st'), name: nameHint || ('设置' + (idx + 1)), thX: w, thY: w, rot: 0, color: SETTING_CSS[idx % SETTING_CSS.length], ...rp }
  }
  function load() {
    _loading = true
    let raw = null
    try { raw = localStorage.getItem(KEY) } catch { /* ignore */ }
    try {
      const d = JSON.parse(raw || 'null')
      if (d && typeof d === 'object' && d.v >= 2 && Array.isArray(d.groups)) {
        groups.value = d.groups.map((g) => {
          const gmode = (g.mode === 'shaped' || g.mode === 'pam') ? g.mode : 'gauss'
          const gp = { ...freshP(), ...(g.p || {}) }
          let settings = Array.isArray(g.settings) ? g.settings : []
          // 迁移：老 gauss 设置（无反射面参数）→ 从组 p 补齐一套反射面（旧组单反射面→各设置同参，用户可再改）
          if (gmode === 'gauss') settings = settings.map((s) => ({ ...pickRP(s && s.antD !== undefined ? s : gp), ...s }))
          return {
            id: g.id || newId('bg'), satFolder: g.satFolder || '', mode: gmode,
            name: g.name || defName(g.mode), pinned: !!g.pinned,
            p: gp, settings,
            activeSettingId: g.activeSettingId || null, beams: Array.isArray(g.beams) ? g.beams.filter((b) => b && b.id) : [],
            ...(g._genName ? { _genName: g._genName } : {})
          }
        })
        activeGroupId.value = groups.value.find((g) => g.id === d.activeGroupId) ? d.activeGroupId : (groups.value[0] ? groups.value[0].id : null)
      } else if (d && typeof d === 'object' && (Array.isArray(d.beams) || d.p)) {
        // 旧档（单块草稿，无 v）→ 包成一个组，无损迁移；写一次性备份
        try { if (raw && !localStorage.getItem(BAK)) localStorage.setItem(BAK, raw) } catch { /* ignore */ }
        const op = d.p || {}
        const m = d.mode === 'shaped' ? 'shaped' : 'gauss'
        const np = { ...freshP() }
        for (const k of Object.keys(np)) if (op[k] != null) np[k] = op[k]
        if (!Array.isArray(np.polyIds)) np.polyIds = []
        if (!np.polyIds.length && typeof op.polyId === 'string' && op.polyId) np.polyIds = [op.polyId]
        const sid = newId('st')
        const setting = { id: sid, name: '默认', thX: Number(op.thX) || 3, thY: Number(op.thY) || 3, rot: Number(op.rot) || 0, color: op.skColor || SKETCH_CSS, ...pickRP(np) }
        const nm = m === 'shaped' ? (op.shapedName || '赋形反射面') : (op.gaussName || '多馈源反射面')
        const bl = (Array.isArray(d.beams) ? d.beams : []).filter((b) => b && b.id).map((b) => ({ ...b, settingId: b.settingId || sid }))
        const g = { id: newId('bg'), satFolder: d.satFolder || '', mode: m, name: nm, pinned: false, p: np, settings: m === 'gauss' ? [setting] : [], activeSettingId: m === 'gauss' ? sid : null, beams: bl, _genName: nm }
        groups.value = [g]
        activeGroupId.value = g.id
      }
    } catch { /* ignore */ }
    _loading = false
    if (curGroup.value) hydrate(curGroup.value)
  }
  load()
  // 工作态深监听 → 提交激活组并落盘 + 重绘草图（结构性组增删/波束操作已在各自动作里显式 refresh；这里补上纯展示类
  // p 字段——轮廓色/线宽/线型/编号/频率配色显隐与透明度等——的即时生效，改完不必再等下一次交互才刷新）
  watch([beams, settings, () => ({ ...p }), satFolder, mode, curName, activeGroupId], () => { persist(); refresh() }, { deep: true })
  persist()   // 归一化存储到 v2（旧档迁移后立即落盘；无数据则写空 v2，避免下次重复迁移）

  // ---- 撤销 / 重做（每组独立栈；快照＝该组 beams+settings，随组切换不串味）----
  const _stacks = new Map()                        // groupId -> { undo:[], redo:[] }
  const canUndo = ref(false), canRedo = ref(false)
  const stackFor = (id) => { let s = _stacks.get(id); if (!s) _stacks.set(id, s = { undo: [], redo: [] }); return s }
  const _snap = () => JSON.stringify({ beams: bare(beams.value), settings: settings.value.map(bareSetting), activeSettingId: activeSettingId.value })
  function _flags() { const s = _stacks.get(activeGroupId.value); canUndo.value = !!(s && s.undo.length); canRedo.value = !!(s && s.redo.length) }
  function _apply(str) {
    const d = JSON.parse(str)
    settings.value = Array.isArray(d.settings) ? d.settings : settings.value
    beams.value = Array.isArray(d.beams) ? d.beams : beams.value
    if (d.activeSettingId && settings.value.find((s) => s.id === d.activeSettingId)) activeSettingId.value = d.activeSettingId
  }
  function pushUndo() { if (!activeGroupId.value) return; const s = stackFor(activeGroupId.value); s.undo.push(_snap()); if (s.undo.length > 100) s.undo.shift(); s.redo.length = 0; _flags() }
  function dropUndo() { const s = _stacks.get(activeGroupId.value); if (s) s.undo.pop(); _flags() }
  function undo() { const s = _stacks.get(activeGroupId.value); if (!s || !s.undo.length) return; s.redo.push(_snap()); _apply(s.undo.pop()); _flags(); refresh() }
  function redo() { const s = _stacks.get(activeGroupId.value); if (!s || !s.redo.length) return; s.undo.push(_snap()); _apply(s.redo.pop()); _flags(); refresh() }

  // ---- 组 CRUD ----
  function uniqueGroupName(base, folder, exceptId) {
    const taken = new Set(groups.value.filter((g) => g.satFolder === folder && g.id !== exceptId).map((g) => g.name))
    if (!taken.has(base)) return base
    for (let i = 2; i < 999; i++) { const n = base + ' ' + i; if (!taken.has(n)) return n }
    return base + ' ' + Date.now().toString(36)
  }
  function defaultSettingFor(gp) {
    const rp = pickRP(gp)                                            // 首个设置的反射面参数取自组默认（freshP）
    const r = reflOf(rp)                                             // 初始宽度 = 解析反射面 θ3
    const t = r && r.ok && r.th3Design > 0 ? r.th3Design : theta3dbFromAperture(Number(gp.fGHz), Number(gp.antD))
    const w = Number.isFinite(t) && t > 0 ? +t.toFixed(3) : 3
    return { id: newId('st'), name: '设置1', thX: w, thY: w, rot: 0, color: SETTING_CSS[0], ...rp }
  }
  function addGroup(m) {
    const mm = (m === 'shaped' || m === 'pam') ? m : 'gauss'
    commitActive()
    const folder = satFolder.value || (grd.sats.value[0] ? grd.sats.value[0].folder : '')
    const g = { id: newId('bg'), satFolder: folder, mode: mm, name: uniqueGroupName(defName(mm), folder), pinned: false, p: freshP(), settings: [], activeSettingId: null, beams: [] }
    if (mm === 'gauss') { const s = defaultSettingFor(g.p); g.settings = [s]; g.activeSettingId = s.id }
    groups.value.push(g)
    activeGroupId.value = g.id
    hydrate(g)
    placing.value = false; adjusting.value = false; deleting.value = false
    _flags(); persist(); refresh()
    return g.id
  }
  function removeGroup(id) {
    const idx = groups.value.findIndex((g) => g.id === id)
    if (idx < 0) return
    _stacks.delete(id)
    const wasActive = id === activeGroupId.value
    groups.value.splice(idx, 1)
    if (wasActive) {
      const next = groups.value.find((g) => g.satFolder === satFolder.value) || groups.value[0] || null
      activeGroupId.value = next ? next.id : null
      if (next) { satFolder.value = next.satFolder; hydrate(next) } else hydrate(null)
      placing.value = false; adjusting.value = false; deleting.value = false
    }
    _flags(); persist(); refresh()
  }
  function renameGroup(id, name) {
    const g = groups.value.find((x) => x.id === id); if (!g) return
    const nm = String(name || '').trim(); if (!nm) return
    g.name = uniqueGroupName(nm, g.satFolder, g.id)
    if (id === activeGroupId.value) curName.value = g.name
    persist(); refresh()
  }
  function duplicateGroup(id) {
    const g = groups.value.find((x) => x.id === id); if (!g) return
    commitActive()
    const smap = new Map()
    const settings2 = (g.settings || []).map((s) => { const ns = { ...bareSetting(s), id: newId('st') }; smap.set(s.id, ns.id); return ns })
    const beams2 = (g.beams || []).map((b) => ({ ...bareBeam(b), id: newId('bs'), ...(b.settingId != null && smap.has(b.settingId) ? { settingId: smap.get(b.settingId) } : {}) }))
    const g2 = { id: newId('bg'), satFolder: g.satFolder, mode: g.mode, name: uniqueGroupName((g.name || '波束组') + ' 副本', g.satFolder), pinned: false, p: { ...g.p, polyIds: [...(g.p && g.p.polyIds || [])], hotspots: (g.p && g.p.hotspots || []).map((h) => ({ ...h, id: newId('hp') })) }, settings: settings2, activeSettingId: (g.activeSettingId && smap.get(g.activeSettingId)) || (settings2[0] ? settings2[0].id : null), beams: beams2 }
    groups.value.push(g2)
    activeGroupId.value = g2.id
    satFolder.value = g2.satFolder
    hydrate(g2)
    placing.value = false; adjusting.value = false; deleting.value = false
    _flags(); persist(); refresh()
    return g2.id
  }
  function toggleGroupVisible(id) {
    const g = groups.value.find((x) => x.id === id); if (!g) return
    g.pinned = !g.pinned
    persist(); refresh()
  }
  // 组切换：提交当前 → 装载目标（退出放置/调整态，避免拖拽索引指到别的组）
  function selectGroup(id) {
    if (id === activeGroupId.value) return
    const g = groups.value.find((x) => x.id === id); if (!g) return
    placing.value = false; adjusting.value = false; deleting.value = false
    commitActive()
    activeGroupId.value = id
    satFolder.value = g.satFolder
    hydrate(g)
    _flags(); persist(); refresh()
  }
  // 切换导航器卫星：定位该星首个组（或清空为“空态”）
  function setSat(folder) {
    if (folder === satFolder.value) return
    placing.value = false; adjusting.value = false; deleting.value = false
    commitActive()
    satFolder.value = folder
    const first = groups.value.find((g) => g.satFolder === folder) || null
    activeGroupId.value = first ? first.id : null
    hydrate(first)
    _flags(); persist(); refresh()
  }

  // ---- 波束设置 CRUD（高斯）----
  function addSetting() {
    pushUndo()
    const s = defaultSetting()                     // 新设置 = 当前反射面的副本（一种波束类型），用户再改口径/馈源做出不同波束宽
    settings.value.push(s)
    activeSettingId.value = s.id
    refresh()
    return s.id
  }
  function removeSetting(id) {
    if (settings.value.length <= 1) { appAlert('至少保留一个波束设置'); return }
    pushUndo()
    settings.value = settings.value.filter((s) => s.id !== id)
    if (activeSettingId.value === id) activeSettingId.value = settings.value[0] ? settings.value[0].id : null
    refresh()                                      // 该设置的波束保留自身宽度（settingId 悬空 → 回退基础色）
  }
  function renameSetting(id, name) { const s = settings.value.find((x) => x.id === id); if (s) { s.name = String(name || '').trim() || s.name; refresh() } }
  function selectSetting(id) { if (settings.value.find((s) => s.id === id)) { activeSettingId.value = id; refresh() } }
  // 把激活/指定设置的宽度批量应用到「该设置放置的波束」（手动重刷一整环）
  function applySettingToBeams(id) {
    const sid = id || activeSettingId.value
    const s = settings.value.find((x) => x.id === sid); if (!s) return
    const hit = beams.value.filter((b) => b.settingId === sid)
    if (!hit.length) { appAlert('该设置下还没有放置任何波束'); return }
    pushUndo()
    for (const b of hit) { b.thX = s.thX; b.thY = s.thY; b.rot = s.rot || 0; b._ring = null }
    status.value = `已把「${s.name}」的宽度 ${s.thX}×${s.thY}° 应用到 ${hit.length} 个波束`
    refresh()
  }

  // ---- 放置 / 调整 / 蜂窝布满 ----
  function openFor(folder) {
    commitActive()
    // 优先恢复【上次保存的选择】：activeGroupId 已由 load() 从 localStorage 恢复。只要激活组仍有效
    // （其卫星还在覆盖分析里），就保持它——波束合成记住自己的卫星 + 波束组，不被覆盖分析的当前卫星覆盖。
    const g = curGroup.value
    if (g && grd.sats.value.some((s) => s.folder === g.satFolder)) {
      satFolder.value = g.satFolder
      hydrate(g)
      status.value = ''; _flags(); open.value = true; refresh()
      return
    }
    // 无有效上次选择（首次 / 激活组或其卫星已删）：用传入 folder（覆盖分析卫星）或第一个卫星兜底，取该卫星首个组
    let target = folder || ''
    if (folder && !groups.value.some((x) => x.satFolder === folder)) {
      target = (groups.value[0] && groups.value[0].satFolder) || folder
    }
    if (!target && grd.sats.value.length) target = grd.sats.value[0].folder
    satFolder.value = target
    const first = groups.value.find((x) => x.satFolder === target) || null
    activeGroupId.value = first ? first.id : null
    hydrate(first)
    status.value = ''
    _flags()
    open.value = true
    refresh()
  }
  function close() { open.value = false; placing.value = false; adjusting.value = false; deleting.value = false; refresh() }

  function activeWidth() {
    if (mode.value === 'pam') { const t = pamTheta.value; return { thX: t.x > 0 ? t.x : 1, thY: t.y > 0 ? t.y : 1, rot: 0, id: null } }
    const s = curSetting.value; return { thX: s ? Number(s.thX) || 1 : 1, thY: s ? Number(s.thY) || 1 : 1, rot: s ? Number(s.rot) || 0 : 0, id: s ? s.id : null }
  }
  // SATSOFT 式相切吸附：地面经纬 → 方向空间贴边相切 → 映射回地面。
  function snapGround(lon, lat, exclude, band) {
    const pos = satPos()
    if (!p.snapTangent || !pos) return { lon, lat }
    const others = beams.value.filter((b) => b !== exclude && Number.isFinite(b.lon) && Number.isFinite(b.lat) && b.thX > 0 && b.thY > 0)
    if (!others.length) return { lon, lat }
    const aw = activeWidth()
    const ae = dirToAzEl(pos.lon, pos.lat || 0, pos.altKm, lon, lat)
    const rNew = (exclude ? (Number(exclude.thX) + Number(exclude.thY)) / 4 : (aw.thX + aw.thY) / 4) || 0.5
    const nbs = others.map((b) => { const a = dirToAzEl(pos.lon, pos.lat || 0, pos.altKm, b.lon, b.lat); return { az: a.az, el: a.el, r: (b.thX + b.thY) / 4 } })
    const s = snapTangentAzEl([ae.az, ae.el], nbs, rNew, 1.6, band != null ? band : null)
    if (!s.snapped) return { lon, lat }
    const g = azElGround(pos.lon, pos.lat || 0, pos.altKm, s.az, s.el)
    return g ? { lon: +g.lon.toFixed(4), lat: +g.lat.toFixed(4) } : { lon, lat }
  }
  function placeAt(ll) {
    if (!ll) return
    if (mode.value === 'shaped') {                 // 赋形：placing 态 = 峰点拾取（单发，落点即退出）
      const h = hotPickId.value && Array.isArray(p.hotspots) ? p.hotspots.find((x) => x.id === hotPickId.value) : null
      hotPickId.value = null
      placing.value = false
      if (!h) return
      h.lon = +ll.lon.toFixed(4); h.lat = +ll.lat.toFixed(4)
      status.value = `峰点已设为 ${h.lon}°E, ${h.lat}°N —— 目标引导；实际峰值落点由物理合成决定，生成后据实给出实际峰值`
      refresh()
      return
    }
    if (mode.value !== 'gauss' && mode.value !== 'pam') return
    if (mode.value === 'gauss' && !curSetting.value) { appAlert('请先添加一个波束设置'); return }
    const aw = activeWidth()
    const s = snapGround(+ll.lon.toFixed(4), +ll.lat.toFixed(4), null, null)
    pushUndo()
    beams.value.push({ id: newId('bs'), lon: s.lon, lat: s.lat, thX: aw.thX, thY: aw.thY, rot: aw.rot, settingId: aw.id })
    refresh()
  }
  // ---- 峰点引导（赋形连续目标场）CRUD + 地图拾取 ----
  function addHotspot() {
    if (!Array.isArray(p.hotspots)) p.hotspots = []
    const h = { id: newId('hp'), lon: null, lat: null, boost: 3, width: null }   // width 空 = θ3（口径分辨率下限）
    p.hotspots.push(h)
    refresh()
    return h.id
  }
  function removeHotspot(id) {
    if (!Array.isArray(p.hotspots)) return
    p.hotspots = p.hotspots.filter((h) => h.id !== id)
    if (hotPickId.value === id) { hotPickId.value = null; placing.value = false }
    refresh()
  }
  // 拾取开关：再点同一行 = 取消；点另一行 = 换目标
  function pickHotspot(id) {
    if (placing.value && hotPickId.value === id) { hotPickId.value = null; placing.value = false; return }
    if (!Array.isArray(p.hotspots) || !p.hotspots.find((h) => h.id === id)) return
    hotPickId.value = id
    placing.value = true
    status.value = '在地图上点击拾取峰点位置（左键 / 右键均可）'
  }
  // placing 被外部关掉（切组/切模式/生成）→ 拾取目标一并复位
  watch(placing, (v) => { if (!v) hotPickId.value = null })
  function dragBeam(vi, ll, phase) {
    if (phase === 'end') { _drag = false; persist(); return }
    const b = beams.value[vi]
    if (!b || !ll) return
    _drag = true
    const s = snapGround(+ll.lon.toFixed(4), +ll.lat.toFixed(4), b, 0.22)
    b.lon = s.lon; b.lat = s.lat
  }
  function removeBeam(id) { pushUndo(); beams.value = beams.value.filter((b) => b.id !== id); refresh() }
  function removeBeamAt(vi) { const b = beams.value[vi]; if (b) removeBeam(b.id) }
  function clearBeams() { if (!beams.value.length) return; pushUndo(); beams.value = []; refresh() }
  function hexFill() {
    const pg = polysOf().find((x) => x.id === p.polyId && x.pts && x.pts.length >= 3)
    if (!pg) { appAlert('请先在下拉框选择一个 Polygon（需 ≥3 顶点，可在 Polygon 面板绘制）'); return }
    const pos = satPos()
    if (!pos) { appAlert('请先选择卫星'); return }
    if (mode.value === 'gauss' && !curSetting.value) { appAlert('请先添加一个波束设置'); return }
    // 间距：高斯＝当前设置的波束间距（Auto=波束宽）；相控阵＝Butler 波束间距（λ/Nd）
    const sp = mode.value === 'pam'
      ? (pam.value && pam.value.ok ? Math.max(pam.value.beamSpacingXDeg || 0, pam.value.beamSpacingYDeg || 0) : NaN)
      : Number(curSetting.value.spacing)
    if (!(sp > 0)) { appAlert('间距无效：须为大于 0 的角度值（Auto = 波束宽度）'); return }
    const centers = hexFillCenters({ satLon: pos.lon, satLat: pos.lat || 0, altKm: pos.altKm, polyPts: pg.pts, spacing: sp })
    if (!centers.length) { appAlert('该 Polygon 内没有布下任何波束中心：间距可能大于区域尺寸'); return }
    const aw = activeWidth()
    pushUndo()
    for (const c of centers) beams.value.push({ id: newId('bs'), lon: c.lon, lat: c.lat, thX: aw.thX, thY: aw.thY, rot: aw.rot, settingId: aw.id })
    status.value = mode.value === 'pam'
      ? `蜂窝布满：新增 ${centers.length} 个波束（Butler 间距 ${sp.toFixed(2)}°）`
      : `蜂窝布满：新增 ${centers.length} 个波束（间距 ${sp}° · 设置「${curSetting.value.name}」）`
    refresh()
  }

  // ---- 频率计划（相邻波束自动异色 b.fc；跨设置的混合宽度亦可）----
  const fcStats = computed(() => {
    const m = new Map()
    for (const b of beams.value) if (b.fc != null && b.fc >= 0) m.set(b.fc, (m.get(b.fc) || 0) + 1)
    return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([i, count]) => ({ i, css: fcCss(i), count }))
  })
  function assignFreqPlan() {
    const pos = satPos()
    if (!pos) { appAlert('请先选择卫星'); return }
    const valid = beams.value.filter((b) => Number.isFinite(b.lon) && Number.isFinite(b.lat) && b.thX > 0 && b.thY > 0)
    if (valid.length < 2) { appAlert('至少需要 2 个波束才能进行频率配色：先放置或蜂窝布满/批量表格添加'); return }
    const nodes = valid.map((b) => { const a = dirToAzEl(pos.lon, pos.lat || 0, pos.altKm, b.lon, b.lat); return { az: a.az, el: a.el, r: (b.thX + b.thY) / 4 } })
    const k = Math.max(2, Math.min(FC_PALETTE.length, Number(p.fcN) || 4))
    const r = colorFreqPlan(nodes, k)
    pushUndo()
    valid.forEach((b, i) => { b.fc = r.colors[i] })
    p.fcShow = true
    status.value = r.conflicts
      ? `频率配色：${k} 色下仍有 ${r.conflicts} 对相邻同色 —— 该布局 ${k} 色不足，可增加颜色数或加大波束间距`
      : `频率配色完成：${valid.length} 个波束 · ${k} 色，相邻波束互不同色（拖拽微调后可重新分配）`
    refresh()
  }
  function clearFreqPlan() {
    if (!beams.value.some((b) => b.fc != null)) return
    pushUndo()
    for (const b of beams.value) if (b.fc != null) delete b.fc
    status.value = '已清除频率配色'
    refresh()
  }

  // ---- 草图渲染（喂 redrawSats）：当前星的全部高斯组，激活组高亮可编辑、兄弟组压暗只读；整星连续编号 ----
  function sketchSpec() {
    if (!open.value) return null
    const pos = satPos()
    if (!pos) return null
    const grps = visibleGroups()
    const posKey = `${pos.lon.toFixed(3)},${(pos.lat || 0).toFixed(3)},${Math.round(pos.altKm)}`
    const lines = [], dots = [], labels = [], fills = []
    let gnum = 0                                    // 整星连续编号
    for (const g of grps) {
      const isActive = g.id === activeGroupId.value
      const gb = isActive ? beams.value : (g.beams || [])
      const gs = isActive ? settings.value : (g.settings || [])
      const gp = isActive ? p : g.p
      const alpha = isActive ? 1 : 0.4
      const lineW = Math.max(0.2, Number(gp.skWidth) || 1.5)
      const baseHex = cssNum(gp.skColor, cssNum(SKETCH_CSS))
      const numCss = isActive ? (/^#[0-9a-f]{6}$/i.test(String(gp.skNumColor || '')) ? gp.skNumColor : SKETCH_CSS) : DIM_NUM_CSS
      const fcOn = gp.fcShow !== false
      const fillOp = Math.max(0, Math.min(1, Number(gp.fcOpacity) || 0)) * (isActive ? 1 : 0.5)
      const dashOn = !!gp.skDash && gb.length <= 300
      const setColor = (sid) => { const s = gs.find((x) => x.id === sid); return s ? cssNum(s.color, baseHex) : baseHex }
      for (const b of gb) {
        if (!Number.isFinite(b.lon) || !Number.isFinite(b.lat) || !(b.thX > 0) || !(b.thY > 0)) { gnum++; continue }
        gnum++
        const rkey = `${b.lon},${b.lat},${b.thX},${b.thY},${b.rot || 0}|${posKey}`
        if (!b._ring || b._ring.key !== rkey) {
          const segs = beamSketchRing({ satLon: pos.lon, satLat: pos.lat || 0, altKm: pos.altKm, lon: b.lon, lat: b.lat, thX: b.thX, thY: b.thY, rot: b.rot || 0 })
          let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, refL = null
          for (const sg of segs) for (const q of sg) {
            let lo = q[0]
            if (refL == null) refL = lo
            while (lo - refL > 180) lo -= 360
            while (lo - refL < -180) lo += 360
            if (lo < x0) x0 = lo; if (lo > x1) x1 = lo
            if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1]
          }
          const ext = segs.length ? Math.max(0.05, Math.min((x1 - x0) * Math.cos((y0 + y1) / 2 * Math.PI / 180), y1 - y0)) : 0
          b._ring = { key: rkey, segs, ext }
        }
        const col = (fcOn && b.fc != null) ? fcHex(b.fc) : (b.settingId != null ? setColor(b.settingId) : baseHex)
        for (const sg of b._ring.segs) {
          if (dashOn) {
            for (let s0 = 0; s0 < sg.length - 1; s0 += 6) {
              const piece = sg.slice(s0, Math.min(s0 + 5, sg.length))
              if (piece.length >= 2) lines.push({ p: piece, color: col, width: lineW, opacity: 0.9 * alpha, closed: false, under: true })
            }
          } else lines.push({ p: sg, color: col, width: lineW, opacity: 0.9 * alpha, closed: false, under: true })
        }
        if (fcOn && b.fc != null && fillOp > 0 && b._ring.segs.length === 1) {
          const s0 = b._ring.segs[0], a = s0[0], z = s0[s0.length - 1]
          if (s0.length >= 4 && Math.abs(a[0] - z[0]) < 1e-9 && Math.abs(a[1] - z[1]) < 1e-9) fills.push({ p: s0.slice(0, -1), color: fcHex(b.fc), opacity: fillOp })
        }
        dots.push({ lon: b.lon, lat: b.lat, color: col, px: isActive ? 3.5 : 2.6, r: (isActive ? 3.5 : 2.6) * 0.0018 })
        if (gp.skNumShow !== false) {
          const text = String(gnum)
          const hpx = gp.skNumMode === 'fixed'
            ? (Number(gp.skNumSize) || 14) / 533
            : (b._ring.ext || 1) * Math.min(0.55, 1.3 / text.length) * ((Number(gp.skNumScale) || 100) / 100) / 57.2958
          labels.push({ lon: b.lon, lat: b.lat, text, hpx, color: numCss, alt: 40, top: true, cullPx: 5 })
        }
      }
    }
    // 赋形组峰点引导标记：点 + 虚线宽度环（目标坡半高全宽，下限 θ3）+ 编号；激活组亮、兄弟组压暗
    const HOT_HEX = 0xff9a3c, HOT_CSS = '#ff9a3c'
    for (const g of groups.value) {
      if (g.satFolder !== satFolder.value) continue
      const isActive = g.id === activeGroupId.value
      if ((isActive ? mode.value : g.mode) !== 'shaped') continue
      if (!isActive && !g.pinned) continue
      const gp = isActive ? p : (g.p || {})
      const hl = Array.isArray(gp.hotspots) ? gp.hotspots : []
      if (!hl.length) continue
      const sf = gp.simSame !== false ? Number(gp.fGHz) : Number(gp.fSim)
      const t3 = shapedTheta3db(sf, Number(gp.antD), Number(gp.taper))
      const alpha = isActive ? 1 : 0.45
      hl.forEach((h, hi) => {
        if (!Number.isFinite(Number(h.lon)) || !Number.isFinite(Number(h.lat))) return
        const w = Math.max(Number(h.width) > 0 ? Number(h.width) : 0, Number.isFinite(t3) && t3 > 0 ? t3 : 0)
        if (w > 0) {
          const segs = beamSketchRing({ satLon: pos.lon, satLat: pos.lat || 0, altKm: pos.altKm, lon: Number(h.lon), lat: Number(h.lat), thX: w, thY: w, rot: 0 })
          for (const sg of segs) for (let s0 = 0; s0 < sg.length - 1; s0 += 6) {   // 虚线：4 段画 2 段空
            const piece = sg.slice(s0, Math.min(s0 + 5, sg.length))
            if (piece.length >= 2) lines.push({ p: piece, color: HOT_HEX, width: 1.2, opacity: 0.85 * alpha, closed: false, under: true })
          }
        }
        dots.push({ lon: Number(h.lon), lat: Number(h.lat), color: HOT_HEX, px: isActive ? 4 : 3, r: (isActive ? 4 : 3) * 0.0018 })
        labels.push({ lon: Number(h.lon), lat: Number(h.lat), text: 'P' + (hi + 1), hpx: 12 / 533, color: isActive ? HOT_CSS : DIM_NUM_CSS, alt: 40, top: true, cullPx: 5 })
      })
    }
    return (lines.length || dots.length || fills.length) ? { lines, dots, labels, fills } : null
  }

  // ---- 生成天线（入覆盖树）----
  // 单组生成：gauss=组内全部（混合宽度）波束 → 一根天线；shaped=Polygon 并集 → 一根天线。
  async function generateGroup(g) {
    if (!g) return null
    const node = satNodeOf(g.satFolder)
    if (!node) { appAlert(`组「${g.name}」的卫星不存在`); return null }
    const pos = livePos(node)
    const name = String(g.name || '').trim() || defName(g.mode)
    const clash = node.antennas.find((a) => a.name === name && !a.synth)
    if (clash) { appAlert(`卫星「${node.satName}」下已有同名天线「${name}」且不是合成天线，请换一个组名`); return null }
    // 组名改过、且旧名的合成天线还在 → 先清理，避免留下孤儿天线
    if (g._genName && g._genName !== name) {
      const orphan = node.antennas.find((a) => a.name === g._genName && a.synth)
      if (orphan) { try { grd.removeAntenna(node.folder, g._genName) } catch { /* ignore */ } }
    }
    let key = null
    if (g.mode === 'gauss') {
      const valid = (g.beams || []).filter((b) => Number.isFinite(b.lon) && Number.isFinite(b.lat))
      if (!valid.length) { appAlert(`组「${name}」还没有波束：开启「地图放置」，或用蜂窝布满 / 批量表格添加`); return null }
      // 每波束按【其所属波束设置】的反射面算：波束宽 θ3、峰值 = 该设置反射面口径方向性（多种波束宽各自增益正确）。
      const setById = new Map((g.settings || []).map((s) => [s.id, s]))
      const reflCache = new Map()
      const reflForBeam = (b) => { const s = setById.get(b.settingId) || (g.settings || [])[0]; if (!s) return null; if (!reflCache.has(s.id)) reflCache.set(s.id, reflOf(s)); return reflCache.get(s.id) }
      const defs = valid.map((b) => {
        const ae = dirToAzEl(pos.lon, pos.lat || 0, pos.altKm, b.lon, b.lat)
        const rf = reflForBeam(b)
        const th3 = rf && rf.ok && rf.th3Design > 0 ? rf.th3Design : (Number(b.thX) || 1)
        const def = { az: ae.az, el: ae.el, thX: th3, thY: th3, rot: 0 }
        if (rf && rf.ok && Number.isFinite(rf.dirDbi)) def.peakDbi = rf.dirDbi   // 峰值 = 该设置反射面口径方向性（逐波束）
        return def
      })
      const text = buildGaussGrd({ satName: node.satName, satLon: pos.lon, satLat: pos.lat || 0, altKm: pos.altKm, effPct: 55, beams: defs })
      key = await grd.importSynthGrd(node.folder, name, text, { ctype: 'rel', levels: [-3] })
      if (key) {
        g._genName = name
        const rfs = [...reflCache.values()].filter((r) => r && r.ok)
        const th3s = [...new Set(rfs.map((r) => +r.th3Design.toFixed(3)))].sort((a, b) => a - b)
        const nSet = new Set(valid.map((b) => b.settingId)).size
        status.value = `已生成天线「${name}」：${defs.length} 个波束${nSet > 1 ? ' · ' + nSet + ' 种波束设置' : ''}${th3s.length ? ' · 波束宽 ' + th3s.map((t) => t + '°').join('/') : ''}（再点即按当前草图更新）`
      }
    } else if (g.mode === 'shaped') {
      const pgs = polysForP(g.p)
      if (!pgs.length) { appAlert(`赋形组「${name}」请先勾选至少一个 Polygon（需 ≥3 顶点）`); return null }
      const sf = g.p.simSame !== false ? Number(g.p.fGHz) : Number(g.p.fSim)
      const t3 = shapedTheta3db(sf, Number(g.p.antD), Number(g.p.taper))
      if (!(t3 > 0)) { appAlert('成分波束宽度无效：请检查（仿真）频率与口径'); return null }
      // 覆盖电平全由 Polygon 的「数值」栏决定（SATSOFT Use Polygon Labels）：每个 Polygon 数值 = 该区目标电平，
      // 按数值降序 → 内圈(高增益)在前、首个包含站点者胜（嵌套内高外低=锥度）。
      // 有数值 → value 模式：边界锚 = 最低数值（外圈保底电平）；全部无数值 → physical（按方向图积分定标）。
      const ordered = pgs.map((pg) => ({ pg, v: Number(pg.value) }))
        .sort((a, b) => (Number.isFinite(b.v) ? b.v : -Infinity) - (Number.isFinite(a.v) ? a.v : -Infinity))
      const vals = ordered.map((o) => o.v).filter(Number.isFinite)
      // 「按天线增益」→ physical（数值只提供分区相对锥度，绝对电平按方向图积分）；否则 value（数值当绝对覆盖值）
      const useVal = g.p.shapedMode !== 'physical' && vals.length > 0
      const V = useVal ? Math.min(...vals) : null
      const polysPts = ordered.map((o) => o.pg.pts.map((q) => [q[0], q[1]]))
      // 峰点引导（连续目标场）：坐标/增量齐全的行才进引擎；width 空 → 引擎取 θ3 下限
      const hotsIn = (Array.isArray(g.p.hotspots) ? g.p.hotspots : [])
        .filter((h) => h && Number.isFinite(Number(h.lon)) && Number.isFinite(Number(h.lat)) && Number.isFinite(Number(h.boost)) && Number(h.boost) !== 0)
      const r = buildShapedGrd({
        satName: node.satName, satLon: pos.lon, satLat: pos.lat || 0, altKm: pos.altKm,
        polysPts,
        polyTargets: ordered.map((o) => (Number.isFinite(o.v) ? o.v : NaN)),
        hotspots: hotsIn.map((h) => ({ lon: Number(h.lon), lat: Number(h.lat), boostDb: Number(h.boost), widthDeg: Number(h.width) > 0 ? Number(h.width) : null })),
        mode: useVal ? 'value' : 'physical', value: V,
        effPct: shapedApertureEff(g.p.taper).effPct, theta3: t3, apDm: Number(g.p.antD), fSimGHz: sf, pol: g.p.pol || ''
      })
      key = await grd.importSynthGrd(node.folder, name, r.text, { ctype: 'abs', levels: [+r.value.toFixed(1)] })
      if (key) {
        g._genName = name
        const head = pgs.length > 1 ? `${pgs.length} 个 Polygon 并集` : (pgs[0].name || 'Polygon')
        const taper = vals.length >= 2 ? ` · 分区目标 ${vals.length} 档（内高外低锥度）` : ''
        // 峰值实际落点（argmax）→ 地面经纬：如实报告，峰落在哪由物理合成决定（峰点引导只是目标，附报偏差）
        let pkNote = ''
        if (Array.isArray(r.peakAt)) {
          const gp2 = azElGround(pos.lon, pos.lat || 0, pos.altKm, r.peakAt[0], r.peakAt[1])
          if (gp2) {
            pkNote = ` · 峰值点 ${gp2.lon.toFixed(2)}°E, ${gp2.lat.toFixed(2)}°N`
            if (hotsIn.length) {
              let dMin = Infinity
              for (const h of hotsIn) { const d = gcKm(gp2.lon, gp2.lat, Number(h.lon), Number(h.lat)); if (d < dMin) dMin = d }
              pkNote += `（峰点引导 ${hotsIn.length} 处，实际峰距最近引导点 ${dMin < 10 ? dMin.toFixed(1) : Math.round(dMin)} km）`
            }
          }
        }
        // 按覆盖值 = 物理方向图（增益由口径/形状经 ∫P̂dΩ 定）＋ 显式功放偏置 P（把最低覆盖档抬到目标值）
        const paNote = useVal && Number.isFinite(r.physPeakDbi)
          ? ` · 物理峰值增益 ${r.physPeakDbi.toFixed(1)} dBi ＋ 功放偏置 ${r.paDb >= 0 ? '+' : ''}${r.paDb.toFixed(1)} dB`
          : ''
        status.value = `已生成赋形天线「${name}」：${head} · ${r.nBeams} 支成分波束激励优化${taper} · 峰值 ${r.peakDbi.toFixed(1)} · 区域内 ≥${r.value.toFixed(1)}（边界即等值线）${paNote} · 平顶纹波 ±${r.rippleDb.toFixed(1)} dB · Ω=${r.omegaDeg2.toFixed(2)} deg²${pkNote}${r.warn ? ' —— ' + r.warn : ''}`
      }
    } else if (g.mode === 'pam') {
      // 相控阵点波束群（SATSOFT §6.5）：每波束 → (az,el) 电扫指向，buildPamGrd 逐波束写 pamField 场（sinc 旁瓣/栅瓣/扫描损失内建）
      const valid = (g.beams || []).filter((b) => Number.isFinite(b.lon) && Number.isFinite(b.lat))
      if (!valid.length) { appAlert(`组「${name}」还没有波束：开启「地图放置」，或用蜂窝布满 / 批量表格添加`); return null }
      const gp = g.p
      const pamCfg = { Nx: Number(gp.pamNx), Ny: Number(gp.pamNy), dxWl: Number(gp.pamDx), dyWl: Number(gp.pamDy), R: Number(gp.pamR), tri: gp.pamTri === true, elem: gp.pamElem !== false, eff: Number(gp.pamEff), fGHz: Number(gp.pamFGHz) }
      const sol = solvePam(pamCfg)
      if (!sol.ok) { appAlert('相控阵参数无效：请检查阵元数 / 间距 / 频率'); return null }
      const beamsAe = valid.map((b) => { const ae = dirToAzEl(pos.lon, pos.lat || 0, pos.altKm, b.lon, b.lat); return { az: ae.az, el: ae.el } })
      const text = buildPamGrd({ satName: node.satName, satLon: pos.lon, satLat: pos.lat || 0, altKm: pos.altKm, pam: pamCfg, beams: beamsAe })
      key = await grd.importSynthGrd(node.folder, name, text, { ctype: 'rel', levels: [-3] })
      if (key) {
        g._genName = name
        const gl = sol.gratingInReal ? ` · ⚠ 栅瓣 @±${sol.gratingLobeDeg.toFixed(1)}°` : ''
        status.value = `已生成相控阵天线「${name}」：${valid.length} 个波束 · 阵 ${pamCfg.Nx}×${pamCfg.Ny} 单元（${pamCfg.dxWl}×${pamCfg.dyWl} λ）· 波束宽 ${sol.th3xDeg.toFixed(2)}°×${sol.th3yDeg.toFixed(2)}° · 峰值 ${sol.dirDbi.toFixed(1)} dBi · 交叉 ${sol.crossoverDb.toFixed(1)} dB · 可扫 ±${sol.scanMaxDeg.toFixed(0)}°${gl}`
      }
    }
    return key
  }
  // 生成激活组（面板底部按钮）
  async function generate() {
    commitActive()
    if (!curGroup.value) { appAlert('请先新建一个波束组'); return null }
    try { const k = await generateGroup(curGroup.value); if (k) persist(); return k } catch (e) { console.error('波束合成失败', e); appAlert('波束合成失败：' + ((e && e.message) || e)); return null }
  }
  // 全部生成：当前卫星下每个组各出一根天线
  async function generateAll() {
    commitActive()
    const gs = groups.value.filter((g) => g.satFolder === satFolder.value)
    if (!gs.length) { appAlert('当前卫星下还没有波束组'); return { ok: 0, total: 0 } }
    let ok = 0
    for (const g of gs) { try { const k = await generateGroup(g); if (k) ok++ } catch (e) { console.error('生成失败', g.name, e) } }
    if (ok) persist()   // _genName 等在 generateGroup 里写到 group 对象上，需落盘（组对象不在深监听里）
    status.value = `全部生成完成：${ok}/${gs.length} 个组已生成天线`
    return { ok, total: gs.length }
  }

  // ---- 批量表格数据层（useGridSelect 注入；列 [lon,lat,thX,thY,rot]，作用于激活组）----
  const TBL_COLS = ['lon', 'lat', 'thX', 'thY', 'rot']
  const num = (v) => { if (v == null || String(v).trim() === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
  const splitCells = (t) => (t.includes('\t') ? t.split('\t') : (t.includes(',') ? t.split(',') : t.split(/\s+/))).map((x) => x.trim())
  function setCell(b, k, v) {
    const n = num(v)
    if (k === 'lon' || k === 'lat') { if (n != null) b[k] = n; else if (String(v == null ? '' : v).trim() === '') b[k] = null }
    else if (k === 'rot') b[k] = n == null ? 0 : n
    else if (n != null && n > 0) b[k] = n                       // thX/thY 只收正数
  }
  function mkRow() { const aw = activeWidth(); return { id: newId('bs'), lon: null, lat: null, thX: aw.thX, thY: aw.thY, rot: aw.rot, settingId: aw.id } }
  function tblAddRow(at) {
    const list = beams.value
    const i = (at == null || at < 0 || at > list.length) ? list.length : at
    list.splice(i, 0, mkRow())
  }
  function tblUpdate(id, patch) {
    const b = beams.value.find((x) => x.id === id); if (!b) return
    for (const k of Object.keys(patch)) setCell(b, k, patch[k])
  }
  // 追加式批量粘贴：每行「经度 纬度 [宽X 宽Y 旋转]」，后三列缺省取激活设置
  function tblPasteAppend(text) {
    const aw = activeWidth()
    const add = []
    for (const line of String(text || '').split(/\r?\n/)) {
      const t = line.trim(); if (!t) continue
      const c = splitCells(t); if (c.length < 2) continue
      const lon = num(c[0]), lat = num(c[1])
      if (lon == null || lat == null) continue
      const b = { id: newId('bs'), lon, lat, thX: aw.thX, thY: aw.thY, rot: aw.rot, settingId: aw.id }
      if (num(c[2]) != null && num(c[2]) > 0) b.thX = num(c[2])
      if (num(c[3]) != null && num(c[3]) > 0) b.thY = num(c[3])
      if (num(c[4]) != null) b.rot = num(c[4])
      add.push(b)
    }
    if (add.length) beams.value = [...beams.value, ...add]
    return add.length
  }
  // Excel 式定位块粘贴：锚点行/列为左上角向右下填充，超出的行自动新建
  function tblPasteBlock(anchorId, startKey, text) {
    const grid = String(text || '').split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => splitCells(l))
    if (!grid.length) return 0
    const c0 = Math.max(0, TBL_COLS.indexOf(startKey))
    const list = [...beams.value]
    let idx = anchorId ? list.findIndex((r) => r.id === anchorId) : list.length
    if (idx < 0) idx = list.length
    grid.forEach((cells, ri) => {
      let r = list[idx + ri]
      if (!r) { r = mkRow(); list[idx + ri] = r }
      cells.forEach((val, ci) => { const key = TBL_COLS[c0 + ci]; if (key) setCell(r, key, val) })
    })
    beams.value = list.filter(Boolean)
    return grid.length
  }

  return {
    open, mode, satFolder, placing, adjusting, deleting, beams, settings, activeSettingId, status, p, curName,
    groups, activeGroupId, curGroup, curSetting, hasGroup, groupsForSat, beamNumOffset, groupStat,
    thetaAuto, dirDbi, crossX, crossY, shapedTheta3, shapedEff, shapedPeak, togglePoly,
    shapedSimF, shapedRefl, refl, pam,
    satNode, satNodeOf, satPos, openFor, close, placeAt, dragBeam, removeBeam, removeBeamAt, clearBeams, hexFill, sketchSpec,
    hotPickId, addHotspot, removeHotspot, pickHotspot,
    addGroup, removeGroup, renameGroup, duplicateGroup, toggleGroupVisible, selectGroup, setSat,
    addSetting, removeSetting, renameSetting, selectSetting, applySettingToBeams,
    generate, generateGroup, generateAll,
    fcStats, assignFreqPlan, clearFreqPlan, fcCss,
    canUndo, canRedo, pushUndo, dropUndo, undo, redo,
    tblAddRow, tblUpdate, tblPasteAppend, tblPasteBlock
  }
}
