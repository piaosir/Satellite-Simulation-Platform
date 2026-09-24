// 挂点模板（任务书 §6.1「从模板套用」；DESIGN2 §3 卫星页）：TDRS / GOES / SSL-1300 / 默认卫星 / Landsat 8 / 3U 立方星各一份。
//   2026-09-24：原先那份 GEO 大平台模板改成「默认卫星」（对上 param:default-sat 的挂点名，几何与原模板逐位相同所以位姿不变）；
//   旧模板 id 静默别名到 'default-sat'（见 LEGACY_MOUNT_IDS；mountTemplate / applyMountTemplate 认，listMountTemplates 不列）。
//
// ★ fidelity 一律 'illustrative'（示意）：挂点位置是按公开外形估的量级，不是任何一颗星的总装数据；频率 / 口径 / 万向节限位取
//   公开资料里能对上的代表值（出处写在 source / note），查不到的键不写（消费端按缺省：fovDeg 缺 = 方向图 −3 dB、rateDegS 缺 = 不限速），
//   不编数。模板的用途是「一键铺出一套像样的挂点，再在表格里改」。
//   ★ 每条挂点的 spec 都带一个能定方向图的量（diameterM / hpbwDeg / gainDbi 至少一个）：星侧太阳侵入 ΔT 与 ΔG/T 不会因为
//     「没有方向图」静默记 0（单测逐条用 sunNoiseTemp 算一遍钉住）。全向天线按 0 dBi 各向同性名义值；相控阵取阵元方向图（见 TDRS note）。
//
// 字段合 schema.mjs 的 mount 口径（normalizeMount，单测逐条过一遍、零错误）：
//   { id, name, attachPoint, posBody[m], boresightBody, upBody（D1：对地挂点 [0,−1,0]）, fovDeg?, sysTempK,
//     gimbal:{type, limits:{a1Min,a1Max,a2Min,a2Max}, rateDegS?}, antennaRef:{kind:'param', spec:{diameterM?, freqGHz, efficiency?, gainDbi?, hpbwDeg?, pattern?}}, excludeNodes }
//   万向节角的几何含义见 gimbal.mjs（xy：a1 绕挂点 x 轴、视轴朝 up 偏为正；a2 绕 y 轴、视轴朝挂点 x 偏为正。对地挂点 up = −Y_B（GEO 顺行 = 北），
//   挂点 x = −X_B（西）→ a1 管南北、a2 管东西）。
//   antennaRef 的 freqGHz 取该天线的【接收】频率（星侧太阳侵入 ΔT 用接收频率，摸底 lb-sunoutage §1.4-3）；只发不收的天线取发射频率并在 note 标明。
//
// attachPoint：
//   · 参数化模型（param:default-sat / param:ssl1300 / param:cubesat-3u）用 paramBus 生成的挂点名（reflector_N_focus、nadir_center、zenith_center），
//     绑定这些模型时挂点位姿以模型为准（applyMountTemplate 覆盖 posBody / 视轴 / up），模板里的 posBody 只是同一位置的抄录；
//   · TDRS 用 STK 12 自带 tdrs.glb 的挂点名（MA_Attachpoint、SA_E_Attachpoint…）——用户从本机 STK 导入该模型时自动对上；
//     STK 文件不随本软件分发，模板只存名字（位置是自估的示意值，不抄 STK 模型的数）；NASA 的 TDRS 模型没有挂点，按模板 posBody 放；
//   · GOES / Landsat 8 的 NASA 模型没有挂点：attachPoint = null，posBody 是示意位置。
//
// 导出：MOUNT_TEMPLATES / listMountTemplates() / mountTemplate(id) / applyMountTemplate(id, {attachPoints, existingIds})

import { normalizeMount } from './schema.mjs'
import { isUpDegenerate } from './bodyFrame.mjs'

const NADIR = [0, 0, 1], ZENITH = [0, 0, -1], UP_N = [0, -1, 0]
const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o) } return o }
const gimbalNone = () => ({ type: 'none', limits: { a1Min: -180, a1Max: 180, a2Min: -90, a2Max: 90 } })

const T = [
  {
    id: 'tdrs', title: 'TDRS', titleZh: '跟踪与数据中继卫星（TDRS）', fidelity: 'illustrative', orbit: 'GEO',
    modelIds: ['nasa:tracking-and-data-relay-satellites-tdrs-d', 'nasa:tracking-and-data-relay-satellites-tdrs-a'],
    attitude: { law: 'nadir', params: {} },
    source: {
      note: '两副单址（SA）天线为双轴万向节反射面、多址（MA）为 S 频段相控阵（各代均为 ±13° 视场；第三代 47 阵元，32 个只收、常用 30 个做返向，' +
        '每个阵元都是全地球覆盖、波束在地面形成）、SGL 为对 White Sands 的 Ku 空地链路。' +
        'SA 限位取第一代 TDRS 主视场量级（东西 ±22.5°、南北 ±31°），SA 口径取第三代 4.6 m（15 ft），频率取 KuSA / SSA / MA 返向中心频率。' +
        'MA 的方向图取【阵元】：按 ±13° 视场取 −3 dB 全宽 26°（示意）——地面形成的窄波束随用户指向变，模板不写；星侧 ΔT 因此是阵元口径的量级。',
      refs: ['NASA Space Network Users’ Guide（SNUG，450-SNUG）', 'NASA TDRS 各代卫星资料', 'Commissioning of NASA’s 3rd Generation TDRS（AIAA 2018-2359）', 'https://ntrs.nasa.gov/citations/20160006333（第三代 MA 阵元构成）', 'https://www.eoportal.org/satellite-missions/tdrs']
    },
    mounts: [
      { id: 'sa_e', name: 'SA 单址天线（东）', attachPoint: 'SA_E_Attachpoint', posBody: [4, 0, 2], boresightBody: NADIR, upBody: UP_N, sysTempK: 500,
        gimbal: { type: 'xy', limits: { a1Min: -31, a1Max: 31, a2Min: -22.5, a2Max: 22.5 } },
        antennaRef: { kind: 'param', spec: { diameterM: 4.6, freqGHz: 15.0034, efficiency: 0.55, pattern: 'reflector' } }, excludeNodes: [] },
      { id: 'sa_w', name: 'SA 单址天线（西）', attachPoint: 'SA_W_Attachpoint', posBody: [-4, 0, 2], boresightBody: NADIR, upBody: UP_N, sysTempK: 500,
        gimbal: { type: 'xy', limits: { a1Min: -31, a1Max: 31, a2Min: -22.5, a2Max: 22.5 } },
        antennaRef: { kind: 'param', spec: { diameterM: 4.6, freqGHz: 15.0034, efficiency: 0.55, pattern: 'reflector' } }, excludeNodes: [] },
      { id: 'ma', name: 'MA 多址相控阵', attachPoint: 'MA_Attachpoint', posBody: [0, 0, 1.9], boresightBody: NADIR, upBody: UP_N, fovDeg: 26, sysTempK: 500,
        gimbal: gimbalNone(), antennaRef: { kind: 'param', spec: { freqGHz: 2.2875, hpbwDeg: 26, pattern: 'phasedArray' } }, excludeNodes: [] },
      { id: 'sgl', name: 'SGL 空地链路天线', attachPoint: 'SGL_Attachpoint', posBody: [0, -3, 1.6], boresightBody: NADIR, upBody: UP_N, sysTempK: 500,
        gimbal: { type: 'xy', limits: { a1Min: -9, a1Max: 9, a2Min: -9, a2Max: 9 } },
        antennaRef: { kind: 'param', spec: { diameterM: 2, freqGHz: 14.9, efficiency: 0.6, pattern: 'reflector' } }, excludeNodes: [] }
    ]
  },
  {
    id: 'goes', title: 'GOES', titleZh: '地球静止业务环境卫星（GOES）', fidelity: 'illustrative', orbit: 'GEO',
    modelIds: ['nasa:geostationary-operational-environmental-satellites'],
    attitude: { law: 'nadir', params: {} },
    source: {
      note: 'GOES-R 系列的对地业务天线：GRB（L 频段 1686.6 MHz，只发）、HRIT/EMWIN（1694.1 MHz，只发）、DCS 数据收集平台上行（UHF 401.9 MHz）、' +
        'CDA 指令上行（S 频段 2036 MHz）；全球波束（地球张角约 17.4°）。位置为示意。',
      refs: ['GOES-R Series Data Book（NOAA / NASA）', 'https://www.goes-r.gov/']
    },
    mounts: [
      { id: 'grb', name: 'GRB L 频段（只发）', attachPoint: null, posBody: [0.6, 0.4, 1.4], boresightBody: NADIR, upBody: UP_N, fovDeg: 17.4, sysTempK: 500,
        gimbal: gimbalNone(), antennaRef: { kind: 'param', spec: { freqGHz: 1.6866, hpbwDeg: 17.4, pattern: 'earthCoverage' } }, excludeNodes: [] },
      { id: 'hrit', name: 'HRIT/EMWIN（只发）', attachPoint: null, posBody: [0.6, -0.4, 1.4], boresightBody: NADIR, upBody: UP_N, fovDeg: 17.4, sysTempK: 500,
        gimbal: gimbalNone(), antennaRef: { kind: 'param', spec: { freqGHz: 1.6941, hpbwDeg: 17.4, pattern: 'earthCoverage' } }, excludeNodes: [] },
      { id: 'dcs', name: 'DCS 数据收集（UHF 接收）', attachPoint: null, posBody: [-0.6, 0.4, 1.4], boresightBody: NADIR, upBody: UP_N, fovDeg: 17.4, sysTempK: 500,
        gimbal: gimbalNone(), antennaRef: { kind: 'param', spec: { freqGHz: 0.4019, hpbwDeg: 17.4, pattern: 'earthCoverage' } }, excludeNodes: [] },
      { id: 'cda', name: 'CDA 指令接收（S 频段）', attachPoint: null, posBody: [-0.6, -0.4, 1.4], boresightBody: NADIR, upBody: UP_N, fovDeg: 17.4, sysTempK: 500,
        gimbal: gimbalNone(), antennaRef: { kind: 'param', spec: { freqGHz: 2.036, hpbwDeg: 17.4, pattern: 'earthCoverage' } }, excludeNodes: [] }
    ]
  },
  {
    id: 'ssl1300', title: 'SSL-1300', titleZh: 'SSL-1300 平台（TerreStar-1 代表星）', fidelity: 'illustrative', orbit: 'GEO',
    modelIds: ['param:ssl1300', 'nasa:space-systems-loral-ssl-1300'],
    attitude: { law: 'nadir', params: {} },
    source: {
      note: '与参数化模板 param:ssl1300 同一代表星 TerreStar-1：18 m S 频段网状反射面（MSS 2 GHz 频段，用户上行 2000–2020 MHz 取中心 2010 MHz）；' +
        'Ku 对地喇叭为通用示意。挂点名对上 paramBus 生成的 reflector_1_focus / nadir_center。',
      refs: ['TerreStar-1（SSL-1300S）公开资料：18 m S 频段反射面']
    },
    mounts: [
      { id: 'refl_s', name: 'S 频段 18 m 网状反射面', attachPoint: 'reflector_1_focus', posBody: [-7.903, 0, 4.537], boresightBody: NADIR, upBody: UP_N, sysTempK: 500,
        gimbal: gimbalNone(), antennaRef: { kind: 'param', spec: { diameterM: 18, freqGHz: 2.01, efficiency: 0.6, pattern: 'reflector' } }, excludeNodes: [] },
      { id: 'ku_horn', name: 'Ku 对地喇叭', attachPoint: 'nadir_center', posBody: [-9.403, 0, 3.037], boresightBody: NADIR, upBody: UP_N, fovDeg: 17.4, sysTempK: 500,
        gimbal: gimbalNone(), antennaRef: { kind: 'param', spec: { freqGHz: 14.25, hpbwDeg: 17.4, pattern: 'earthCoverage' } }, excludeNodes: [] }
    ]
  },
  {
    id: 'default-sat', title: 'Default satellite', titleZh: '默认卫星', fidelity: 'illustrative', orbit: 'GEO',
    modelIds: ['param:default-sat'],
    attitude: { law: 'nadir', params: {} },
    source: {
      note: '对上 param:default-sat 的四个反射面焦点挂点：东西两侧 2.5 m 偏馈反射面（C 频段上行 5925–6425 MHz 取 6175 MHz、Ku 上行 14.0–14.5 GHz 取 14.25 GHz），' +
        '对地板两副 1.2 m 可动点波束（Ku，X-Y 双轴、限位 ±9° 覆盖 GEO 可见地球盘）。测控天线频段因星而异，不放。',
      refs: ['ITU《无线电规则》第 5 条频率划分表：固定卫星业务（地对空）C 频段 5925–6425 MHz、Ku 频段 14.0–14.5 GHz']
    },
    mounts: [
      { id: 'refl_c_e', name: 'C 频段反射面（东）', attachPoint: 'reflector_1_focus', posBody: [1.08, 0, 1.605], boresightBody: NADIR, upBody: UP_N, sysTempK: 500,
        gimbal: gimbalNone(), antennaRef: { kind: 'param', spec: { diameterM: 2.5, freqGHz: 6.175, efficiency: 0.65, pattern: 'reflector' } }, excludeNodes: [] },
      { id: 'refl_ku_w', name: 'Ku 频段反射面（西）', attachPoint: 'reflector_2_focus', posBody: [-1.08, 0, 1.605], boresightBody: NADIR, upBody: UP_N, sysTempK: 500,
        gimbal: gimbalNone(), antennaRef: { kind: 'param', spec: { diameterM: 2.5, freqGHz: 14.25, efficiency: 0.65, pattern: 'reflector' } }, excludeNodes: [] },
      { id: 'spot_1', name: 'Ku 可动点波束 1', attachPoint: 'reflector_3_focus', posBody: [0, 0.35, 2.462], boresightBody: NADIR, upBody: UP_N, sysTempK: 500,
        gimbal: { type: 'xy', limits: { a1Min: -9, a1Max: 9, a2Min: -9, a2Max: 9 } },
        antennaRef: { kind: 'param', spec: { diameterM: 1.2, freqGHz: 14.25, efficiency: 0.6, pattern: 'reflector' } }, excludeNodes: [] },
      { id: 'spot_2', name: 'Ku 可动点波束 2', attachPoint: 'reflector_4_focus', posBody: [0, -0.35, 2.462], boresightBody: NADIR, upBody: UP_N, sysTempK: 500,
        gimbal: { type: 'xy', limits: { a1Min: -9, a1Max: 9, a2Min: -9, a2Max: 9 } },
        antennaRef: { kind: 'param', spec: { diameterM: 1.2, freqGHz: 14.25, efficiency: 0.6, pattern: 'reflector' } }, excludeNodes: [] }
    ]
  },
  {
    id: 'landsat8', title: 'Landsat 8', titleZh: '陆地卫星 8 号（Landsat 8）', fidelity: 'illustrative', orbit: 'LEO',
    modelIds: ['nasa:landsat-8'],
    attitude: { law: 'nadir', params: {} },
    source: {
      note: '705 km 太阳同步。X 频段载荷数据下行 8200.5 MHz（只发）走对地覆盖天线 ECA：半功率波束宽 120°、同时覆盖天底全视区，不带万向节' +
        '（Landsat 7 才是可动的 GXA）。S 频段测控：上行 2106.4 MHz（接收）、下行 2287.5 MHz，对地 / 天顶各一副全向（冗余成对，任意姿态可收发），' +
        '全向天线按 0 dBi（各向同性名义值）。',
      refs: ['Landsat 8 (L8) Data Users Handbook（USGS）', 'https://www.usgs.gov/landsat-missions/landsat-8', 'https://www.eoportal.org/satellite-missions/landsat-8-ldcm']
    },
    mounts: [
      { id: 'eca', name: 'X 频段对地覆盖天线 ECA（只发）', attachPoint: null, posBody: [0.8, 0.4, 1.2], boresightBody: NADIR, upBody: UP_N, fovDeg: 120, sysTempK: 500,
        gimbal: gimbalNone(), antennaRef: { kind: 'param', spec: { freqGHz: 8.2005, hpbwDeg: 120, pattern: 'earthCoverage' } }, excludeNodes: [] },
      { id: 's_nadir', name: 'S 频段测控（对地）', attachPoint: null, posBody: [-0.8, 0, 1.2], boresightBody: NADIR, upBody: UP_N, sysTempK: 500,
        gimbal: gimbalNone(), antennaRef: { kind: 'param', spec: { freqGHz: 2.1064, gainDbi: 0, pattern: 'omni' } }, excludeNodes: [] },
      { id: 's_zenith', name: 'S 频段测控（天顶）', attachPoint: null, posBody: [-0.8, 0, -1.4], boresightBody: ZENITH, upBody: UP_N, sysTempK: 500,
        gimbal: gimbalNone(), antennaRef: { kind: 'param', spec: { freqGHz: 2.1064, gainDbi: 0, pattern: 'omni' } }, excludeNodes: [] }
    ]
  },
  {
    id: 'cubesat3u', title: 'CubeSat 3U', titleZh: '3U 立方星', fidelity: 'illustrative', orbit: 'LEO',
    modelIds: ['param:cubesat-3u'],
    attitude: { law: 'nadir', params: {} },
    source: {
      note: '常见 3U 配置：对地 S 频段贴片（2.2 GHz 量级，半功率波束约 80°）、天顶 GNSS 贴片（L1 1575.42 MHz）、UHF 业余频段单极子（437 MHz，全向，按 0 dBi 名义值）。' +
        '挂点名对上 param:cubesat-3u 的 nadir_center / zenith_center。',
      refs: ['CubeSat Design Specification（Cal Poly）', 'https://www.cubesat.org/']
    },
    mounts: [
      { id: 's_patch', name: 'S 频段贴片（对地）', attachPoint: 'nadir_center', posBody: [0, 0, 0.164], boresightBody: NADIR, upBody: UP_N, fovDeg: 80, sysTempK: 500,
        gimbal: gimbalNone(), antennaRef: { kind: 'param', spec: { freqGHz: 2.2, hpbwDeg: 80, pattern: 'patch' } }, excludeNodes: [] },
      { id: 'gnss', name: 'GNSS 贴片（天顶）', attachPoint: 'zenith_center', posBody: [0, 0, -0.164], boresightBody: ZENITH, upBody: UP_N, fovDeg: 160, sysTempK: 500,
        gimbal: gimbalNone(), antennaRef: { kind: 'param', spec: { freqGHz: 1.57542, hpbwDeg: 100, pattern: 'patch' } }, excludeNodes: [] },
      { id: 'uhf', name: 'UHF 单极子', attachPoint: null, posBody: [0.05, 0, 0], boresightBody: [1, 0, 0], upBody: [0, 0, -1], sysTempK: 500,
        gimbal: gimbalNone(), antennaRef: { kind: 'param', spec: { freqGHz: 0.437, gainDbi: 0, pattern: 'omni' } }, excludeNodes: [] }
    ]
  }
]

/** 全部模板（只读）。 */
export const MOUNT_TEMPLATES = deepFreeze(T)

/** 旧模板 id 别名 → 现行 id（不进 listMountTemplates；老代码 / 老存档照样能套用）。 */
const LEGACY_MOUNT_IDS = Object.freeze({ dfh4: 'default-sat' })
const resolveMountTemplateId = (id) => (typeof id === 'string' && Object.hasOwn(LEGACY_MOUNT_IDS, id) ? LEGACY_MOUNT_IDS[id] : id)

/** 下拉用的目录：[{id, title, titleZh, fidelity, orbit, count, modelIds}] */
export function listMountTemplates() {
  return MOUNT_TEMPLATES.map((t) => ({ id: t.id, title: t.title, titleZh: t.titleZh, fidelity: t.fidelity, orbit: t.orbit, count: t.mounts.length, modelIds: t.modelIds.slice() }))
}

/** 一份模板的可改副本（纯数据）；旧 id 按别名取现行模板；未知 id 返回 null。 */
export function mountTemplate(id) {
  const rid = resolveMountTemplateId(id)
  const t = MOUNT_TEMPLATES.find((x) => x.id === rid)
  return t ? JSON.parse(JSON.stringify(t)) : null
}

/**
 * 套用模板 → 归一后的 mounts（直接进绑定表）与建议姿态律。
 *   · attachPoints（当前绑定模型 meta.attachPoints）里有同名挂点的：posBody / 视轴取挂点（模型为准），记进 matched；
 *     ★ up 仍取模板的（normalizeMount 再投到新视轴的法平面）：模板的万向节限位是按「up = 本体 −Y（北）」定义的 a1 南北 / a2 东西，
 *       而挂点节点的上向（局部 +X）在 STK 模型里没有统一语义——tdrs.glb 的 SA_E / SA_W 上向分别是本体 −X / +X（镜像安装），
 *       照搬会把 ±31° / ±22.5° 限位对调、且东西两副互为反号。模板 up 与挂点视轴平行（投影退化）时才退到挂点 up，再没有按 D1；
 *     没有的：attachPoint 置 null、位姿用模板值，记进 unmatched——不留悬空引用。
 *   · id 与 existingIds（该星已有 mount 的 id）撞了就加 _2、_3…（名字不改）。
 *   · 每条过 schema.normalizeMount；errors 汇总返回（模板本身零错误，单测钉住；有错只可能来自挂点数据）。
 * @param {string} id
 * @param {{attachPoints?:{name, posBody, dirBody, upBody}[], existingIds?:string[]}} [opts]
 * @returns {{mounts:object[], attitude:{law, params}, matched:string[], unmatched:string[], errors:string[]}|null}
 */
export function applyMountTemplate(id, opts = {}) {
  const t = mountTemplate(id)
  if (!t) return null
  const aps = Array.isArray(opts.attachPoints) ? opts.attachPoints : []
  const used = new Set(Array.isArray(opts.existingIds) ? opts.existingIds : [])
  const mounts = [], matched = [], unmatched = [], errors = []
  t.mounts.forEach((m, i) => {
    const src = { ...m }
    if (src.attachPoint) {
      const ap = aps.find((a) => a && a.name === src.attachPoint && Array.isArray(a.posBody))
      if (ap) {
        src.posBody = ap.posBody.slice()
        if (Array.isArray(ap.dirBody)) src.boresightBody = ap.dirBody.slice()
        if (isUpDegenerate(src.boresightBody, src.upBody)) {                // 与 normalizeMount 的 orthoUp 同一判据
          if (Array.isArray(ap.upBody) && !isUpDegenerate(src.boresightBody, ap.upBody)) src.upBody = ap.upBody.slice()
          else delete src.upBody                                  // normalizeMount 按 D1 缺省
        }
        matched.push(src.attachPoint)
      } else { unmatched.push(src.attachPoint); src.attachPoint = null }
    }
    let mid = src.id, k = 2
    while (used.has(mid)) mid = `${src.id}_${k++}`
    src.id = mid
    used.add(mid)
    const r = normalizeMount(src, { path: `${t.id}.mounts[${i}]` })
    errors.push(...r.errors)
    if (r.mount) mounts.push(r.mount)
  })
  return { mounts, attitude: t.attitude, matched, unmatched, errors }
}
