// 飞机内置实体模板数据（三期契约 DESIGN3 §1 P1b、E13；A3 规格 §7.3 记录形状、§7.4「飞机」）。
//
// 纯数据 + 小的派生计算；只 import components/air.mjs 的派生辅助与 ./common.mjs（不 import assembly / components/index，防环）。
// 汇总、校验、冻结与对外 API 在 models/entityTemplates.mjs（集成包）。巡航构型（不带起落架）。
//
// ★ 数值口径：
//   dims  = 研究表 research/entity-templates.json 的有出处字段，value / unit / source / confidence 逐字抄；note 是中性短句（不抄原文）。
//   prov  = 组件参数 ← 出处字段的映射（组件参数路径 '<compId>.<param>'）：
//     {dim, pick?, k?}          值 = dims[dim].value（对象型取 [pick]）× k（缺省 1）
//     {dims, derive, fn, with}  派生量：derive 是人读式子，fn 是机读式子名，with 是式子里用到的示意输入（单测按 fn 重算对拍）：
//       'mul'           dims[0] 的值 × Π with 的全部值                 （机身高 = 机身宽 × 高宽比；公务机机身宽 = 客舱内宽 × 壁厚比 …）
//       'vtailHeight'   heightM − with.gearClearM − bDown0 + z(fus 的 vtail 插座)       bDown0 = fus.heightM / 2
//       'vtailSpan'     2 × (heightM − with.gearClearM − bDown0 + z(fus 的 htail 插座)) / tan(ht.dihedralDeg)
//       'lengthMinusProp' lengthM − propReach(prop 组件参数)
//     heightM 为对象型（777：{min, max}）时 with.pick 指定取哪个键。插座 z 取 air.getFuselageSockets(fus 参数)。
//   垂尾高 / V 尾展长的通式：地面 z_g = 机腹（bDown0）+ 离地净空 gearClearM（示意）；垂尾顶 z = s_z − h；令 z_g − 垂尾顶 = 全机高。
//   模板一律 tailUpsweep = 1（尾锥顶线平直，s_z = −bUp0），此时垂尾高 = 全机高 − 净空 − 机身高。
//   长度一律不凭记忆填绝对米数：没有出处的长度要么留空走组件的自动式（翼根弦 0.2 × 翼展、小翼高 0.065 × 翼展、短舱长 1.9 × 最大径），
//   要么写成「有出处尺寸 × 示意比例」的派生（'mul'，with 里是比例，derive 写明比例名），进 prov、悬停显示出处 + 派生式；
//   无量纲 / 角度类（梢根比、后掠、上反、翼根位置比、尾锥比…）与离地净空 gearClearM 是示意值，不在 prov 里 = 示意。
//   G650 卫通罩外形没有出处（研究表只有 GAT-5510 天线扫掠体积）：按扫掠体积 × 包络比给个示意外形，不进 prov、界面描红，
//   needsInput 记 radomeLWHcm。
//   ops = 运行参数（E7 / E8 用）：只有 G650 有出处的初始巡航高度；其余 cruiseAltM = null（走航迹自带高度或 E7 缺省）。

import { GAT5530_URL, getFuselageSockets, propReach } from '../components/air.mjs'
import { dim, round9, record } from './common.mjs'

// ───────────────────────────── 出处 ─────────────────────────────

const U = Object.freeze({
  a320: 'https://aircraft.airbus.com/en/aircraft/a320-family/a320neo',
  a320ac: 'https://www.aircraft.airbus.com/sites/g/files/jlcbta126/files/2025-01/AC_A320_0624.pdf',
  a320tcds: 'https://www.easa.europa.eu/en/downloads/16507/en',
  b737: 'https://www.boeing.com/content/dam/boeing/v2/airports/acaps/737NG_REV_C.pdf',
  b737tcds: 'https://www.easa.europa.eu/en/downloads/7297/en',
  a330: 'https://aircraft.airbus.com/en/aircraft/a330/a330-300',
  a330tcds: 'https://www.easa.europa.eu/en/downloads/7518/en',
  b777: 'https://www.boeing.com/content/dam/boeing/v2/airports/acaps/777-200LR-300ER-F_Rev_G.pdf',
  b777tcds: 'https://www.easa.europa.eu/en/downloads/7521/en',
  g650: 'http://web.archive.org/web/20230412105624/https://www.gulfstream.com/en/aircraft/gulfstream-g650er/',
  mq9: 'http://web.archive.org/web/20250102145026/https://www.af.mil/About-Us/Fact-Sheets/Display/Article/104470/mq-9-reaper/',
  mq9old: 'http://web.archive.org/web/20210602135216/https://www.af.mil/About-Us/Fact-Sheets/Display/Article/104470/mq-9-reaper/',
  gat5530: GAT5530_URL,
  gat5510: 'https://www.viasat.com/products/terminals-and-radios/gat-5510/'
})

const GAT5530_DIMS = () => ({
  radomeLWHcm: dim({ L: 235, W: 107, H: 32 }, 'cm', U.gat5530, '机载卫通罩外形'),
  antennaSweptVolumeCm: dim({ D: 99.7, H: 28.7 }, 'cm', U.gat5530, '罩内天线扫掠体积')
})
/** GAT-5530 罩的 prov（组件参数逐项对应厂家数据表，cm → m）。 */
const GAT5530_PROV = (id) => ({
  [`${id}.lengthM`]: { dim: 'radomeLWHcm', pick: 'L', k: 0.01 },
  [`${id}.widthM`]: { dim: 'radomeLWHcm', pick: 'W', k: 0.01 },
  [`${id}.heightM`]: { dim: 'radomeLWHcm', pick: 'H', k: 0.01 },
  [`${id}.sweptDM`]: { dim: 'antennaSweptVolumeCm', pick: 'D', k: 0.01 },
  [`${id}.sweptHM`]: { dim: 'antennaSweptVolumeCm', pick: 'H', k: 0.01 }
})

// ───────────────────────────── 派生（与单测同式） ─────────────────────────────

const vOf = (d, pick) => (d.value !== null && typeof d.value === 'object' ? d.value[pick] : d.value)
/** 垂尾高：全机高 − 净空 − 机腹半高 + vtail 插座 z。 */
function vtailHeight(dims, pick, gearClearM, fus) {
  const s = getFuselageSockets(fus).find((q) => q.id === 'vtail')
  return vOf(dims.heightM, pick) - gearClearM - fus.heightM / 2 + s.pos[2]
}
/** V 尾展长：翼尖升到全机高。 */
function vtailSpan(dims, gearClearM, fus, dihedralDeg) {
  const s = getFuselageSockets(fus).find((q) => q.id === 'htail')
  return 2 * (dims.heightM.value - gearClearM - fus.heightM / 2 + s.pos[2]) / Math.tan(dihedralDeg * Math.PI / 180)
}

/** 比例派生：值 = dims[k] × Π w（与单测 recompute 'mul' 同式、同乘序）。 */
const mulV = (dims, k, w) => Object.values(w).reduce((s, x) => s * x, dims[k].value)
const mulP = (k, w, text) => ({ dims: [k], derive: text, fn: 'mul', with: { ...w } })

// ───────────────────────────── 通用装配（客机 / 公务机） ─────────────────────────────

/**
 * 机身 + 对称机翼（翼下短舱随机翼复制）+ 平尾 + 垂尾 + 背部卫通罩。o.fus / o.wing / o.eng / o.ht / o.vt / o.rdm 为各组件参数；
 * o.engAt = 'wing'（翼吊，挂 wing@eng1）或 'aft'（尾吊，挂 fus@aftEng、自带 mirrorXZ）；o.htAt = 'fus' | 'vt'（T 尾）。
 */
function jetDoc(name, o) {
  const comps = [
    { id: 'fus', type: 'air.fuselage', parent: null, params: o.fus },
    { id: 'wing', type: 'air.wing', parent: 'fus', attach: { mode: 'socket', socket: 'wing' }, params: o.wing, sym: { op: 'mirrorXZ' } }
  ]
  if (o.eng) {
    if (o.engAt === 'aft') comps.push({ id: 'eng', type: 'air.nacelle', parent: 'fus', attach: { mode: 'socket', socket: 'aftEng' }, params: o.eng, sym: { op: 'mirrorXZ' } })
    else comps.push({ id: 'eng', type: 'air.nacelle', parent: 'wing', attach: { mode: 'socket', socket: 'eng1' }, params: o.eng })
  }
  comps.push({ id: 'vt', type: 'air.vtail', parent: 'fus', attach: { mode: 'socket', socket: 'vtail' }, params: o.vt })
  comps.push(o.htAt === 'vt'
    ? { id: 'ht', type: 'air.htail', parent: 'vt', attach: { mode: 'socket', socket: 'tip' }, params: o.ht }
    : { id: 'ht', type: 'air.htail', parent: 'fus', attach: { mode: 'socket', socket: 'htail' }, params: o.ht })
  if (o.rdm) comps.push({ id: 'rdm', type: 'air.radome', parent: 'fus', attach: { mode: 'socket', socket: 'crown' }, params: o.rdm })
  return { kind: 'assembly', schema: 1, domain: 'aircraft', name, comps, density: {}, massTargetKg: null }
}
/** 记录收尾（领域 aircraft；urls / hover 见 common.record）。 */
const rec = (r) => record('aircraft', r)

// ───────────────────────────── 模板 ─────────────────────────────

// —— 空客 A320neo
const a320 = (() => {
  const dims = {
    wingspanM: dim(35.8, 'm', U.a320), lengthM: dim(37.57, 'm', U.a320), heightM: dim(11.76, 'm', U.a320),
    fuselageWidthM: dim(3.95, 'm', U.a320), horizontalTailSpanM: dim(12.45, 'm', U.a320ac, '机场规划手册前视图，平尾展长'),
    mmo: dim(0.82, 'Mach', U.a320), maxOperatingAltitudeFt: dim({ standard: 39100, mod30748: 39800, mod162744: 41000 }, 'ft', U.a320tcds, '型号合格证数据单，标准构型 39100 ft'),
    ...GAT5530_DIMS()
  }
  const w = { hRatio: 1.05 }, gc = { gearClearM: 1.75 }, ed = { engDRatio: 0.6 }
  const fus = { lengthM: dims.lengthM.value, widthM: dims.fuselageWidthM.value, heightM: dims.fuselageWidthM.value * w.hRatio, noseStyle: 'airliner', noseFrac: 0.1, tailFrac: 0.27, tailUpsweep: 1, wingXFrac: 0.36, wingZFrac: 0.3, htailXFrac: 0.84, vtailXFrac: 0.78, crownXFrac: 0.45 }
  const vtH = vtailHeight(dims, null, gc.gearClearM, fus)
  return rec({
    id: 'ent:a320neo', title: 'Airbus A320neo', titleZh: '空客 A320neo', representative: 'A320neo（带鲨鳍翼梢小翼）',
    dims,
    prov: {
      'fus.lengthM': { dim: 'lengthM' }, 'fus.widthM': { dim: 'fuselageWidthM' },
      'fus.heightM': { dims: ['fuselageWidthM'], derive: 'fuselageWidthM × hRatio', fn: 'mul', with: { ...w } },
      'wing.spanM': { dim: 'wingspanM' }, 'ht.spanM': { dim: 'horizontalTailSpanM' },
      'eng.diameterM': mulP('fuselageWidthM', ed, 'fuselageWidthM × engDRatio（短舱最大径 / 机身宽，示意比例）'),
      'vt.heightM': { dims: ['heightM'], derive: 'heightM − gearClearM − bDown0 + z(vtail 插座)', fn: 'vtailHeight', with: { ...gc } },
      'rdm.baseRadiusM': { dims: ['fuselageWidthM'], derive: 'fuselageWidthM × hRatio / 2', fn: 'mul', with: { ...w, half: 0.5 } },
      ...GAT5530_PROV('rdm')
    },
    ops: { mmo: { value: 0.82, source: U.a320 }, maxOperatingAltitudeFt: { value: 39100, source: U.a320tcds, pick: 'standard' }, cruiseAltM: null },
    needsInput: ['cruiseAltitudeFt', 'cruiseMach'],
    doc: jetDoc('空客 A320neo', {
      fus,
      wing: { spanM: dims.wingspanM.value, taper: 0.22, sweepDeg: 25, dihedralDeg: 5.1, kinkFrac: 0.35, winglet: 'sharklet', engines: 1, engYFrac: 0.32 },
      eng: { diameterM: mulV(dims, 'fuselageWidthM', ed), flatBottom: false, exhaust: 'separate' },
      ht: { spanM: dims.horizontalTailSpanM.value, sweepDeg: 29, dihedralDeg: 6 },
      vt: { heightM: vtH },
      rdm: { model: 'gat5530', lengthM: 235 * 0.01, widthM: 107 * 0.01, heightM: 32 * 0.01, sweptDM: 99.7 * 0.01, sweptHM: 28.7 * 0.01, baseRadiusM: dims.fuselageWidthM.value * w.hRatio * 0.5 }
    })
  })
})()

// —— 波音 737-800（带翼梢小翼）
const b737 = (() => {
  const dims = {
    wingspanM: dim(35.79, 'm', U.b737, '三视图读图'), lengthM: dim(39.47, 'm', U.b737), heightM: dim(12.55, 'm', U.b737, '三视图读图'),
    fuselageWidthM: dim(3.76, 'm', U.b737, '客舱剖面外廓宽，读图'), maxOperatingAltitudeFt: dim(41000, 'ft', U.b737tcds, '型号合格证数据单'),
    ...GAT5530_DIMS()
  }
  const w = { hRatio: 1.066 }, gc = { gearClearM: 1.6 }
  const ed = { engDRatio: 0.55 }, el = { engLRatio: 0.96 }, ep = { pylonRatio: 0.11 }, hs = { htSpanRatio: 0.4 }
  const fus = { lengthM: dims.lengthM.value, widthM: dims.fuselageWidthM.value, heightM: dims.fuselageWidthM.value * w.hRatio, noseStyle: 'airliner', noseFrac: 0.1, tailFrac: 0.28, tailUpsweep: 1, wingXFrac: 0.37, wingZFrac: 0.32, htailXFrac: 0.84, vtailXFrac: 0.78, crownXFrac: 0.45 }
  return rec({
    id: 'ent:b737-800', title: 'Boeing 737-800', titleZh: '波音 737-800', representative: '737-800（带融合式翼梢小翼）',
    dims,
    prov: {
      'fus.lengthM': { dim: 'lengthM' }, 'fus.widthM': { dim: 'fuselageWidthM' },
      'fus.heightM': { dims: ['fuselageWidthM'], derive: 'fuselageWidthM × hRatio', fn: 'mul', with: { ...w } },
      'wing.spanM': { dim: 'wingspanM' },
      'eng.diameterM': mulP('fuselageWidthM', ed, 'fuselageWidthM × engDRatio（短舱最大径 / 机身宽，示意比例）'),
      'eng.lengthM': mulP('fuselageWidthM', el, 'fuselageWidthM × engLRatio（短舱长 / 机身宽，示意比例：短舱贴翼的短涵道形）'),
      'eng.pylonHM': mulP('fuselageWidthM', ep, 'fuselageWidthM × pylonRatio（挂架净距 / 机身宽，示意比例）'),
      'ht.spanM': mulP('wingspanM', hs, 'wingspanM × htSpanRatio（平尾展 / 翼展，示意比例）'),
      'vt.heightM': { dims: ['heightM'], derive: 'heightM − gearClearM − bDown0 + z(vtail 插座)', fn: 'vtailHeight', with: { ...gc } },
      'rdm.baseRadiusM': { dims: ['fuselageWidthM'], derive: 'fuselageWidthM × hRatio / 2', fn: 'mul', with: { ...w, half: 0.5 } },
      ...GAT5530_PROV('rdm')
    },
    ops: { maxOperatingAltitudeFt: { value: 41000, source: U.b737tcds }, cruiseAltM: null },
    needsInput: ['mmo', 'cruiseAltitudeFt', 'cruiseMach'],
    doc: jetDoc('波音 737-800', {
      fus,
      wing: { spanM: dims.wingspanM.value, taper: 0.24, sweepDeg: 25, dihedralDeg: 6, kinkFrac: 0.33, winglet: 'blended', engines: 1, engYFrac: 0.27 },
      eng: { diameterM: mulV(dims, 'fuselageWidthM', ed), lengthM: mulV(dims, 'fuselageWidthM', el), flatBottom: true, exhaust: 'separate', pylonHM: mulV(dims, 'fuselageWidthM', ep), overhangFrac: 0.7 },
      ht: { spanM: mulV(dims, 'wingspanM', hs), sweepDeg: 30, dihedralDeg: 7 },
      vt: { heightM: vtailHeight(dims, null, gc.gearClearM, fus) },
      rdm: { model: 'gat5530', lengthM: 235 * 0.01, widthM: 107 * 0.01, heightM: 32 * 0.01, sweptDM: 99.7 * 0.01, sweptHM: 28.7 * 0.01, baseRadiusM: dims.fuselageWidthM.value * w.hRatio * 0.5 }
    })
  })
})()

// —— 空客 A330-300
const a330 = (() => {
  const dims = {
    wingspanM: dim(60.3, 'm', U.a330), lengthM: dim(63.66, 'm', U.a330), heightM: dim(16.79, 'm', U.a330),
    fuselageWidthM: dim(5.64, 'm', U.a330), mmo: dim(0.86, 'Mach', U.a330), maxOperatingAltitudeFt: dim(41450, 'ft', U.a330tcds, '型号合格证数据单'),
    ...GAT5530_DIMS()
  }
  const w = { hRatio: 1.0 }, gc = { gearClearM: 2.5 }
  const rc = { rootChordRatio: 0.176 }, wl = { wingletRatio: 0.045 }, ed = { engDRatio: 0.51 }, el = { engLRatio: 0.99 }, hs = { htSpanRatio: 0.32 }
  const fus = { lengthM: dims.lengthM.value, widthM: dims.fuselageWidthM.value, heightM: dims.fuselageWidthM.value * w.hRatio, noseStyle: 'airliner', noseFrac: 0.09, tailFrac: 0.26, tailUpsweep: 1, wingXFrac: 0.37, wingZFrac: 0.3, htailXFrac: 0.85, vtailXFrac: 0.79, crownXFrac: 0.45 }
  return rec({
    id: 'ent:a330-300', title: 'Airbus A330-300', titleZh: '空客 A330-300', representative: 'A330-300',
    dims,
    prov: {
      'fus.lengthM': { dim: 'lengthM' }, 'fus.widthM': { dim: 'fuselageWidthM' },
      'fus.heightM': { dims: ['fuselageWidthM'], derive: 'fuselageWidthM × hRatio', fn: 'mul', with: { ...w } },
      'wing.spanM': { dim: 'wingspanM' },
      'wing.rootChordM': mulP('wingspanM', rc, 'wingspanM × rootChordRatio（翼根弦 / 翼展，示意比例）'),
      'wing.wingletHM': mulP('wingspanM', wl, 'wingspanM × wingletRatio（小翼高 / 翼展，示意比例）'),
      'eng.diameterM': mulP('fuselageWidthM', ed, 'fuselageWidthM × engDRatio（短舱最大径 / 机身宽，示意比例）'),
      'eng.lengthM': mulP('fuselageWidthM', el, 'fuselageWidthM × engLRatio（短舱长 / 机身宽，示意比例）'),
      'ht.spanM': mulP('wingspanM', hs, 'wingspanM × htSpanRatio（平尾展 / 翼展，示意比例）'),
      'vt.heightM': { dims: ['heightM'], derive: 'heightM − gearClearM − bDown0 + z(vtail 插座)', fn: 'vtailHeight', with: { ...gc } },
      'rdm.baseRadiusM': { dims: ['fuselageWidthM'], derive: 'fuselageWidthM × hRatio / 2', fn: 'mul', with: { ...w, half: 0.5 } },
      ...GAT5530_PROV('rdm')
    },
    ops: { mmo: { value: 0.86, source: U.a330 }, maxOperatingAltitudeFt: { value: 41450, source: U.a330tcds }, cruiseAltM: null },
    needsInput: ['cruiseAltitudeFt', 'cruiseMach'],
    doc: jetDoc('空客 A330-300', {
      fus,
      wing: { spanM: dims.wingspanM.value, rootChordM: mulV(dims, 'wingspanM', rc), taper: 0.24, sweepDeg: 30, dihedralDeg: 5.7, kinkFrac: 0.33, winglet: 'sharklet', wingletHM: mulV(dims, 'wingspanM', wl), wingletCantDeg: 25, engines: 1, engYFrac: 0.31 },
      eng: { diameterM: mulV(dims, 'fuselageWidthM', ed), lengthM: mulV(dims, 'fuselageWidthM', el), flatBottom: false, exhaust: 'separate' },
      ht: { spanM: mulV(dims, 'wingspanM', hs), sweepDeg: 30, dihedralDeg: 7.5 },
      vt: { heightM: vtailHeight(dims, null, gc.gearClearM, fus) },
      rdm: { model: 'gat5530', lengthM: 235 * 0.01, widthM: 107 * 0.01, heightM: 32 * 0.01, sweptDM: 99.7 * 0.01, sweptHM: 28.7 * 0.01, baseRadiusM: dims.fuselageWidthM.value * w.hRatio * 0.5 }
    })
  })
})()

// —— 波音 777-300ER（斜削翼梢；机高取地面间隙表上限 = 包络口径）
const b777 = (() => {
  const dims = {
    wingspanM: dim(64.8, 'm', U.b777, '三视图读图'), lengthM: dim(73.86, 'm', U.b777, '读图'), fuselageWidthM: dim(6.2, 'm', U.b777, '读图'),
    heightM: dim({ min: 18.24, max: 18.85 }, 'm', U.b777, '地面间隙表垂尾顶，随装载姿态变化'),
    maxOperatingAltitudeFt: dim(43100, 'ft', U.b777tcds, '型号合格证数据单'),
    ...GAT5530_DIMS()
  }
  const w = { hRatio: 1.0 }, gc = { gearClearM: 3.4 }
  const ed = { engDRatio: 0.63 }, el = { engLRatio: 1.18 }, hs = { htSpanRatio: 0.33 }
  const fus = { lengthM: dims.lengthM.value, widthM: dims.fuselageWidthM.value, heightM: dims.fuselageWidthM.value * w.hRatio, noseStyle: 'airliner', noseFrac: 0.09, tailFrac: 0.25, tailUpsweep: 1, wingXFrac: 0.38, wingZFrac: 0.3, htailXFrac: 0.85, vtailXFrac: 0.8, crownXFrac: 0.45 }
  return rec({
    id: 'ent:b777-300er', title: 'Boeing 777-300ER', titleZh: '波音 777-300ER', representative: '777-300ER（斜削翼梢）',
    dims,
    prov: {
      'fus.lengthM': { dim: 'lengthM' }, 'fus.widthM': { dim: 'fuselageWidthM' },
      'fus.heightM': { dims: ['fuselageWidthM'], derive: 'fuselageWidthM × hRatio', fn: 'mul', with: { ...w } },
      'wing.spanM': { dim: 'wingspanM' },
      'eng.diameterM': mulP('fuselageWidthM', ed, 'fuselageWidthM × engDRatio（短舱最大径 / 机身宽，示意比例）'),
      'eng.lengthM': mulP('fuselageWidthM', el, 'fuselageWidthM × engLRatio（短舱长 / 机身宽，示意比例）'),
      'ht.spanM': mulP('wingspanM', hs, 'wingspanM × htSpanRatio（平尾展 / 翼展，示意比例）'),
      'vt.heightM': { dims: ['heightM'], derive: 'heightM(max) − gearClearM − bDown0 + z(vtail 插座)', fn: 'vtailHeight', with: { ...gc, pick: 'max' } },
      'rdm.baseRadiusM': { dims: ['fuselageWidthM'], derive: 'fuselageWidthM × hRatio / 2', fn: 'mul', with: { ...w, half: 0.5 } },
      ...GAT5530_PROV('rdm')
    },
    ops: { maxOperatingAltitudeFt: { value: 43100, source: U.b777tcds }, cruiseAltM: null },
    needsInput: ['mmo', 'cruiseAltitudeFt', 'cruiseMach'],
    doc: jetDoc('波音 777-300ER', {
      fus,
      wing: { spanM: dims.wingspanM.value, taper: 0.18, sweepDeg: 31.6, dihedralDeg: 6, kinkFrac: 0.33, winglet: 'raked', engines: 1, engYFrac: 0.3 },
      eng: { diameterM: mulV(dims, 'fuselageWidthM', ed), lengthM: mulV(dims, 'fuselageWidthM', el), flatBottom: false, exhaust: 'separate' },
      ht: { spanM: mulV(dims, 'wingspanM', hs), sweepDeg: 35, dihedralDeg: 7 },
      vt: { heightM: vtailHeight(dims, 'max', gc.gearClearM, fus) },
      rdm: { model: 'gat5530', lengthM: 235 * 0.01, widthM: 107 * 0.01, heightM: 32 * 0.01, sweptDM: 99.7 * 0.01, sweptHM: 28.7 * 0.01, baseRadiusM: dims.fuselageWidthM.value * w.hRatio * 0.5 }
    })
  })
})()

// —— 湾流 G650ER（尾吊双发、T 尾；机身宽 = 客舱内宽 × 壁厚比；卫通罩按 GAT-5510 扫掠体积 × 包络比）
const g650 = (() => {
  const dims = {
    wingspanM: dim(30.35, 'm', U.g650, '官网存档页'), lengthM: dim(30.4, 'm', U.g650), heightM: dim(7.82, 'm', U.g650),
    cabinWidthM: dim(2.49, 'm', U.g650, '客舱内宽，不是机身外径'),
    cruiseMachHighSpeed: dim(0.9, 'Mach', U.g650), cruiseMachLongRange: dim(0.85, 'Mach', U.g650), mmo: dim(0.925, 'Mach', U.g650),
    initialCruiseAltitudeFt: dim(41000, 'ft', U.g650), maxCruiseAltitudeFt: dim(51000, 'ft', U.g650),
    antennaSweptVolumeCm: dim({ D: 31.7, H: 33.3 }, 'cm', U.gat5510, '机载 Ka 小天线扫掠体积')
  }
  const w = { wallRatio: 1.12 }, hr = { hRatio: 1.0 }, gc = { gearClearM: 1.05 }
  // 卫通罩外形没有出处（研究表只有 GAT-5510 的天线扫掠体积）：扫掠体积 × 包络比只是示意外形，不进 prov（界面描红），needsInput 记 radomeLWHcm
  const env = { lRatio: 2.2, wRatio: 1.15, hRatio: 1.15 }
  const wp = { pitchRatio: 0.0336 }, rc = { rootChordRatio: 0.185 }, wl = { wingletRatio: 0.046 }
  const ed = { engDRatio: 0.6 }, el = { engLRatio: 1.25 }, ep = { pylonRatio: 0.18 }, vc = { vtChordRatio: 0.138 }, hs = { htSpanRatio: 0.336 }, hc = { htSpanRatio: 0.336, htChordRatio: 0.2157 }
  const fus = { lengthM: dims.lengthM.value, widthM: dims.cabinWidthM.value * w.wallRatio, heightM: dims.cabinWidthM.value * w.wallRatio * hr.hRatio, noseStyle: 'bizjet', noseFrac: 0.14, tailFrac: 0.3, tailUpsweep: 1, windowPitchM: mulV(dims, 'lengthM', wp), wingXFrac: 0.45, wingZFrac: 0.35, vtailXFrac: 0.72, aftEngXFrac: 0.76, aftEngZFrac: -0.45, crownXFrac: 0.6 }
  const sw = dims.antennaSweptVolumeCm.value
  return rec({
    id: 'ent:g650er', title: 'Gulfstream G650ER', titleZh: '湾流 G650ER', representative: 'G650ER（官网 2023-04 存档页）',
    dims,
    prov: {
      'fus.lengthM': { dim: 'lengthM' },
      'fus.widthM': { dims: ['cabinWidthM'], derive: 'cabinWidthM × wallRatio', fn: 'mul', with: { ...w } },
      'fus.heightM': { dims: ['cabinWidthM'], derive: 'cabinWidthM × wallRatio × hRatio', fn: 'mul', with: { ...w, ...hr } },
      'fus.windowPitchM': mulP('lengthM', wp, 'lengthM × pitchRatio（舷窗间距 / 全机长，示意比例）'),
      'wing.spanM': { dim: 'wingspanM' },
      'wing.rootChordM': mulP('wingspanM', rc, 'wingspanM × rootChordRatio（翼根弦 / 翼展，示意比例）'),
      'wing.wingletHM': mulP('wingspanM', wl, 'wingspanM × wingletRatio（小翼高 / 翼展，示意比例）'),
      'eng.diameterM': mulP('cabinWidthM', ed, 'cabinWidthM × engDRatio（短舱最大径 / 客舱内宽，示意比例）'),
      'eng.lengthM': mulP('cabinWidthM', el, 'cabinWidthM × engLRatio（短舱长 / 客舱内宽，示意比例）'),
      'eng.pylonHM': mulP('cabinWidthM', ep, 'cabinWidthM × pylonRatio（挂架净距 / 客舱内宽，示意比例）'),
      'vt.rootChordM': mulP('lengthM', vc, 'lengthM × vtChordRatio（垂尾根弦 / 全机长，示意比例）'),
      'ht.spanM': mulP('wingspanM', hs, 'wingspanM × htSpanRatio（平尾展 / 翼展，示意比例）'),
      'ht.rootChordM': mulP('wingspanM', hc, 'wingspanM × htSpanRatio × htChordRatio（平尾根弦 / 平尾展，示意比例）'),
      'vt.heightM': { dims: ['heightM'], derive: 'heightM − gearClearM − bDown0 + z(vtail 插座)', fn: 'vtailHeight', with: { ...gc } },
      'rdm.sweptDM': { dim: 'antennaSweptVolumeCm', pick: 'D', k: 0.01 },
      'rdm.sweptHM': { dim: 'antennaSweptVolumeCm', pick: 'H', k: 0.01 },
      'rdm.baseRadiusM': { dims: ['cabinWidthM'], derive: 'cabinWidthM × wallRatio × hRatio / 2', fn: 'mul', with: { ...w, ...hr, half: 0.5 } }
    },
    ops: {
      mmo: { value: 0.925, source: U.g650 }, cruiseMachHighSpeed: { value: 0.9, source: U.g650 }, cruiseMachLongRange: { value: 0.85, source: U.g650 },
      initialCruiseAltitudeFt: { value: 41000, source: U.g650 }, maxCruiseAltitudeFt: { value: 51000, source: U.g650 },
      cruiseAltM: { value: round9(41000 * 0.3048), source: U.g650, from: 'initialCruiseAltitudeFt' }
    },
    needsInput: ['fuselageDiameterM', 'radomeLWHcm'],
    doc: jetDoc('湾流 G650ER', {
      fus,
      wing: { spanM: dims.wingspanM.value, rootChordM: mulV(dims, 'wingspanM', rc), taper: 0.28, sweepDeg: 33, dihedralDeg: 3, kinkFrac: 0, winglet: 'blended', wingletHM: mulV(dims, 'wingspanM', wl), wingletCantDeg: 20, engines: 0, flapTracks: 2 },
      engAt: 'aft',
      eng: { diameterM: mulV(dims, 'cabinWidthM', ed), lengthM: mulV(dims, 'cabinWidthM', el), flatBottom: false, exhaust: 'mixed', pylonHM: mulV(dims, 'cabinWidthM', ep), overhangFrac: 0.45 },
      vt: { heightM: vtailHeight(dims, null, gc.gearClearM, fus), rootChordM: mulV(dims, 'lengthM', vc), taper: 0.55, sweepDeg: 35, dorsal: true },
      htAt: 'vt',
      ht: { spanM: mulV(dims, 'wingspanM', hs), rootChordM: mulV(dims, 'wingspanM', hc), taper: 0.45, sweepDeg: 30, dihedralDeg: -3 },
      rdm: { model: 'custom', lengthM: sw.D * 0.01 * env.lRatio, widthM: sw.D * 0.01 * env.wRatio, heightM: sw.H * 0.01 * env.hRatio, sweptDM: sw.D * 0.01, sweptHM: sw.H * 0.01, baseRadiusM: dims.cabinWidthM.value * w.wallRatio * hr.hRatio * 0.5 }
    })
  })
})()

// —— MQ-9A（V 尾 + 腹鳍、推进式螺旋桨、机头卫通鼓包、下颌光电球）
const mq9 = (() => {
  const dims = {
    wingspanM: dim(20.1, 'm', U.mq9, '事实页 2025-01 存档'), lengthM: dim(11, 'm', U.mq9), heightM: dim(3.8, 'm', U.mq9),
    ceilingFt: dim(50000, 'ft', U.mq9old, '2021 版事实页'), maxSpeedKtas: dim(240, 'kt', U.mq9old, '2021 版事实页')
  }
  const gc = { gearClearM: 1.25 }
  // 长度全部按有出处的全长 / 翼展 / 全机高 × 示意比例派生
  const pd = { propDRatio: 0.134 }, fw = { fusWRatio: 0.0864 }, fh = { fusWRatio: 0.0864, hRatio: 1.1 }, rc = { rootChordRatio: 0.07 }, ry = { rootYRatio: 0.041 }
  const hc = { htChordRatio: 0.055 }, vh = { ventralHRatio: 0.237 }, vc = { ventralChordRatio: 0.082 }, td = { turretRatio: 0.05 }
  const prop = { diameterM: mulV(dims, 'wingspanM', pd), blades: 3 }
  const fus = { lengthM: dims.lengthM.value - propReach(prop), widthM: mulV(dims, 'lengthM', fw), heightM: mulV(dims, 'lengthM', fh), noseStyle: 'uav', noseFrac: 0.13, tailFrac: 0.3, tailUpsweep: 0.5, windows: false, doors: false, fairing: false, wingXFrac: 0.4, wingZFrac: -0.1, htailXFrac: 0.9, vtailXFrac: 0.9, crownXFrac: 0.3 }
  const ht = { rootChordM: mulV(dims, 'wingspanM', hc), taper: 0.5, sweepDeg: 15, dihedralDeg: 45, tcRoot: 0.12, tcTip: 0.1 }
  ht.spanM = vtailSpan(dims, gc.gearClearM, fus, ht.dihedralDeg)
  const doc = {
    kind: 'assembly', schema: 1, domain: 'aircraft', name: 'MQ-9A', density: {}, massTargetKg: null,
    comps: [
      { id: 'fus', type: 'air.fuselage', parent: null, params: fus },
      { id: 'wing', type: 'air.wing', parent: 'fus', attach: { mode: 'socket', socket: 'wing' }, params: { spanM: dims.wingspanM.value, rootChordM: mulV(dims, 'wingspanM', rc), taper: 0.4, sweepDeg: 0, dihedralDeg: 0, kinkFrac: 0, tcRoot: 0.16, tcTip: 0.12, twistDeg: -2, winglet: 'none', engines: 0, flapTracks: 0, rootYM: mulV(dims, 'lengthM', ry) }, sym: { op: 'mirrorXZ' } },
      { id: 'ht', type: 'air.htail', parent: 'fus', attach: { mode: 'socket', socket: 'htail' }, params: ht },
      { id: 'vt', type: 'air.vtail', parent: 'fus', attach: { mode: 'socket', socket: 'ventral' }, params: { heightM: mulV(dims, 'heightM', vh), rootChordM: mulV(dims, 'lengthM', vc), taper: 0.5, sweepDeg: 30, tc: 0.1, dorsal: false } },
      { id: 'tur', type: 'air.turret', parent: 'fus', attach: { mode: 'socket', socket: 'chin' }, params: { diameterM: mulV(dims, 'lengthM', td) } },
      { id: 'prop', type: 'air.prop', parent: 'fus', attach: { mode: 'socket', socket: 'tail' }, params: prop }
    ]
  }
  return rec({
    id: 'ent:mq9', title: 'MQ-9A Reaper', titleZh: 'MQ-9A 无人机', representative: 'MQ-9A（事实页）',
    dims,
    prov: {
      'fus.lengthM': { dims: ['lengthM'], derive: 'lengthM − propReach(prop)', fn: 'lengthMinusProp', with: {} },
      'fus.widthM': mulP('lengthM', fw, 'lengthM × fusWRatio（机身宽 / 全长，示意比例）'),
      'fus.heightM': mulP('lengthM', fh, 'lengthM × fusWRatio × hRatio（机身高 = 机身宽 × 高宽比，示意比例）'),
      'wing.spanM': { dim: 'wingspanM' },
      'wing.rootChordM': mulP('wingspanM', rc, 'wingspanM × rootChordRatio（翼根弦 / 翼展，示意比例）'),
      'wing.rootYM': mulP('lengthM', ry, 'lengthM × rootYRatio（翼根外露站位 / 全长，示意比例）'),
      'ht.spanM': { dims: ['heightM'], derive: '2 × (heightM − gearClearM − bDown0 + z(htail 插座)) / tan(ht.dihedralDeg)', fn: 'vtailSpan', with: { ...gc } },
      'ht.rootChordM': mulP('wingspanM', hc, 'wingspanM × htChordRatio（V 尾根弦 / 翼展，示意比例）'),
      'vt.heightM': mulP('heightM', vh, 'heightM × ventralHRatio（腹鳍高 / 全机高，示意比例）'),
      'vt.rootChordM': mulP('lengthM', vc, 'lengthM × ventralChordRatio（腹鳍根弦 / 全长，示意比例）'),
      'tur.diameterM': mulP('lengthM', td, 'lengthM × turretRatio（光电球径 / 全长，示意比例）'),
      'prop.diameterM': mulP('wingspanM', pd, 'wingspanM × propDRatio（桨径 / 翼展，示意比例）')
    },
    ops: { ceilingFt: { value: 50000, source: U.mq9old }, maxSpeedKtas: { value: 240, source: U.mq9old }, cruiseAltM: null },
    needsInput: ['cruiseSpeedKt', 'cruiseAltitudeFt'],
    doc
  })
})()

export const AIR_TEMPLATES = [a320, b737, a330, b777, g650, mq9]
