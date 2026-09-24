// 自动匹配：卫星（名称 / NORAD / 轨道类别 / 所在组）→ 模型 id（任务书 §5.8 末段；设计契约 §3.4 prefs、§3.5 id、§6.3）。
//
// 规则按序匹配，第一条命中且其候选模型「可用」的就返回：
//   ① 碎片 / 火箭体（名字带 DEB、R/B）→ id:null（不配模型，页面照旧画点——给一块碎片套卫星外形是误导）
//   ② 具名规则（≥ 60 条）：CelesTrak / SATCAT 名称正则（个别加 NORAD 号兜底）→ NASA 3D 模型；
//      候选按优先顺序列出，available 里没有的自动试下一个；一个都没有就落到下一条规则（任务书口径）。
//   ③ 大型平板 LEO 星座（按名称前缀或 entry.group）→ param:flat-leo
//   ④ 立方星（名字带 1U–12U / CUBESAT / 已知 3U 系列）→ param:cubesat-<n>u
//   ⑤ 轨道类别 GEO（orbitKind，来自页面 cardFor().kind）→ prefs.geoDefault（缺省 = 默认卫星 param:default-sat；是 NASA id 但不可用时
//      退回默认卫星；旧模板 id（别名表）按 paramTemplates.resolveParamModelId 静默换成现行 id）；
//      orbitKind 缺失时，GEO 通信运营商名称兜底（只在 orbitKind 未知时生效，免得把 MEO / IGSO 星错配）
//   ⑥ 其余（上面都没命中的星）→ 默认卫星 param:default-sat（2026-09-24 用户：东四增强型外形作默认卫星模型）
//
// ★ NASA id 必须真在 scripts/nasa3d/include-list.json 的七组里且有 glb（单测逐条核对）；多文件条目按契约 §3.5：
//   第 1 个文件 nasa:<slug>、之后 nasa:<slug>~<n>（按文件名排序）。这里只用到 aquarius-b~2（「(unfurled)」展开态）。
// ★ 变体取舍（看过原件的材质名 / 尺寸后定的）：aqua-a 的材质是 Aqua 的 HSB/AIRS 仪器但外形较粗，优先 aqua-c（AIRS/AMSR-E 细节）；
//   aura-c 为完整 Aura 外形（OMI），aura-d 混了 AQUA/GPM 的贴图放最后；tdrs-d 材质名 NGTDRSS（新一代外形）配 TDRS 8–13，
//   tdrs-a / trds-e 配第一代 TDRS 1–7；ISS 优先 iss-d（IGOAL 完整构型，近米制）。
// ★ 相近平台代用（写在规则 note 里）：Landsat 9→Landsat 8（同构）、JASON-3→OSTM/Jason-2（同 Proteus 平台）、
//   NOAA 20（JPSS-1）→Suomi NPP（同 BCP-2000 平台）、GRACE-FO→GRACE、GOES-R 系列→GOES（模型是 N/O/P 外形，只有这一个）。
//
// 导出：
//   match({name, noradId, orbitKind, group}, {available?:Set<string>, prefs?:{geoDefault}}) → {id:string|null, rule:string}
//   normalizeName(s)   名称归一（NFKC、大写、空白折叠）
//   RULES              具名规则表（冻结）：{key, re:RegExp, norad?:number[], ids:string[], note?}
//   ruleNasaIds()      具名规则引用到的全部 NASA id（去重）
//   CONSTELLATION_RULES / GEO_NAME_HINT / DEFAULT_MODEL_ID（= paramTemplates.DEFAULT_MODEL_ID）

import { DEFAULT_MODEL_ID, resolveParamModelId } from './paramTemplates.mjs'

export { DEFAULT_MODEL_ID }

const N = (slug, n = 1) => (n > 1 ? `nasa:${slug}~${n}` : `nasa:${slug}`)
const R = (key, re, ids, extra = {}) => Object.freeze({ key, re, ids: Object.freeze(ids.map((x) => (Array.isArray(x) ? N(...x) : N(x)))), ...extra })

// NASA slug 常量（长 slug 写一次）
const TDRS_A = 'tracking-and-data-relay-satellites-tdrs-a', TDRS_B = 'tracking-and-data-relay-satellites-tdrs-b'
const TDRS_D = 'tracking-and-data-relay-satellites-tdrs-d', TDRS_E = 'tracking-and-data-relay-satellites-trds-e'
const ICESAT2 = 'ice-clouds-and-land-elevation-satellite-2-icesat-2'
const ICESAT = 'ice-clouds-and-land-elevation-satellite-icesat'

/** 具名规则（顺序即优先级；更具体的在前）。 */
export const RULES = Object.freeze([
  R('iss', /^ISS(\s*\(.*\))?$/, ['international-space-station-iss-d-igoal', 'international-space-station-iss-b', 'international-space-station-iss-a'], { norad: [25544] }),
  R('hst', /^(HST|HUBBLE( SPACE TELESCOPE)?)$/, ['hubble-space-telescope-a', 'hubble-space-telescope-b'], { norad: [20580] }),
  R('tdrs-gen1', /^TDRS[ -]?[1-7]$/, [TDRS_A, TDRS_E, TDRS_B]),
  R('tdrs-gen2-3', /^TDRS[ -]?(8|9|1[0-3])$/, [TDRS_D, TDRS_E, TDRS_A]),
  R('tdrs', /^TDRS\b/, [TDRS_D, TDRS_A]),
  R('goes', /^GOES[ -]?\d+/, ['geostationary-operational-environmental-satellites'], { note: '模型为 GOES-N/O/P 外形；GOES-R 系列无独立模型，同用它' }),
  R('landsat-1-3', /^LANDSAT[ -]?[123]$/, ['landsat-1-2-and-3']),
  R('landsat-4-5', /^LANDSAT[ -]?[45]$/, ['landsat-4-and-5']),
  R('landsat-7', /^LANDSAT[ -]?7$/, ['landsat-7']),
  R('landsat-8-9', /^(LANDSAT[ -]?[89]|LDCM)$/, ['landsat-8'], { note: 'Landsat 9 与 Landsat 8 同构' }),
  R('aqua', /^(AQUA|EOS[ -]?PM[ -]?1)$/, ['aqua-c', 'aqua-b', 'aqua-a'], { norad: [27424] }),
  R('terra', /^(TERRA|EOS[ -]?AM[ -]?1)$/, ['terra'], { norad: [25994] }),
  R('aura', /^(AURA|EOS[ -]?CHEM[ -]?1?)$/, ['aura-c', 'aura-b', 'aura-a', 'aura-d']),
  R('jason-1', /^JASON[ -]?1$/, ['jason-1']),
  R('jason-2', /^(JASON[ -]?2|OSTM)\b/, ['ocean-surface-topography-mission-ostm-jason-2']),
  R('jason-3', /^JASON[ -]?3$/, ['ocean-surface-topography-mission-ostm-jason-2', 'jason-1'], { note: '同 Proteus 平台，用 Jason-2 外形' }),
  R('sentinel-6', /^(SENTINEL[ -]?6|MICHAEL FREILICH)/, ['jason-continuity-of-service-sentinel-6']),
  R('topex', /^TOPEX/, ['topex-poseidon']),
  R('suomi-npp', /^(SUOMI\b|NPP$|NPOESS PREPARATORY)/, ['suomi-national-polar-orbiting-partnership-suomi-npp']),
  R('noaa-20', /^(NOAA[ -]?20|JPSS[ -]?1)$/, ['suomi-national-polar-orbiting-partnership-suomi-npp'], { note: 'JPSS-1 与 Suomi NPP 同为 BCP-2000 平台' }),
  R('noaa-poes', /^NOAA[ -]?(1[0-9]|[6-9])$/, ['polar-operational-environmental-satellite-poes']),
  R('trmm', /^TRMM$/, ['tropical-rainfall-measuring-mission-trmm']),
  R('gpm', /^GPM\b/, ['global-precipitation-measurement']),
  R('oco-2', /^OCO[ -]?2$/, ['orbiting-carbon-observatory-oco-2']),
  R('grace-fo', /^GRACE[ -]?FO\b/, ['gravity-recovery-and-climate-experiment-grace-a', 'gravity-recovery-and-climate-experiment-grace-b'], { note: 'GRACE-FO 外形与 GRACE 相近' }),
  R('grace', /^GRACE( [12AB])?$/, ['gravity-recovery-and-climate-experiment-grace-a', 'gravity-recovery-and-climate-experiment-grace-b']),
  R('icesat-2', /^ICESAT[ -]?2$/, [`${ICESAT2}-c`, `${ICESAT2}-a`, `${ICESAT2}-b`]),
  R('icesat', /^ICESAT$/, [`${ICESAT}-a`, `${ICESAT}-b`]),
  R('cloudsat', /^CLOUDSAT$/, ['cloudsat-c', 'cloudsat-b', 'cloudsat-a']),
  R('calipso', /^CALIPSO$/, ['cloud-aerosol-lidar-and-infrared-pathfinder-satellite-calipso']),
  R('swift', /^SWIFT$/, ['swift']),
  R('fermi', /^(FERMI|GLAST)\b/, ['fermi-gamma-ray-large-area-space-telescope']),
  R('tess', /^TESS$/, ['transiting-exoplanet-survey-satellite-tess-b', 'transiting-exoplanet-survey-satellite-tess-a']),
  R('chandra', /^(CXO|CHANDRA|AXAF)\b/, ['chandra-x-ray-observatory']),
  R('hinode', /^(HINODE|SOLAR[ -]?B)\b/, ['hinode-solar-b']),
  R('suzaku', /^(SUZAKU|ASTRO[ -]?E2?)$/, ['suzaku']),
  R('rhessi', /^R?HESSI$/, ['hessi-rhessi']),
  R('eo-1', /^EO[ -]?1$/, ['earth-observing-1-eo-1']),
  R('cygnss', /^CYG(NSS|FM\d*)\b/, ['cyclone-global-navigation-satellite-system-cygnss']),
  R('icon', /^ICON$/, ['ionospheric-connection-explorer-icon']),
  R('ibex', /^IBEX$/, ['interstellar-boundary-explorer-ibex']),
  R('themis', /^THEMIS\b/, ['time-history-of-events-and-macroscale-interactions-during-substorms-themis']),
  R('mms', /^MMS[ -]?[1-4]$/, ['magnetospheric-multiscale-mms-a', 'magnetospheric-multiscale-mms-b']),
  R('van-allen', /^(RBSP|VAN ALLEN)\b/, ['van-allen-probes']),
  R('cluster-ii', /^(CLUSTER II\b|SAMBA$|SALSA$|RUMBA$|TANGO$)/, ['cluster-ii', 'cluster']),
  R('geotail', /^GEOTAIL$/, ['geotailsat']),
  R('polar', /^POLAR$/, ['polar']),
  R('fuse', /^FUSE$/, ['far-ultraviolet-spectroscopic-explorer']),
  R('swas', /^SWAS$/, ['submillimeter-wave-astronomy-satellite-swas']),
  R('hete', /^HETE\b/, ['high-energy-transient-explorer']),
  R('wire', /^WIRE$/, ['wide-field-infrared-explorer-wire']),
  R('sac-c', /^SAC[ -]?C$/, ['satellite-for-scientific-applications-sac-c']),
  R('aquarius', /^(SAC[ -]?D|AQUARIUS)\b/, [['aquarius-b', 2], 'aquarius-a'], { note: 'aquarius-b~2 = 反射面展开态（unfurled）' }),
  R('radarsat-1', /^RADARSAT([ -]1)?$/, ['radar-satellite-1-radarsat-1']),
  R('quikscat', /^QUIKSCAT$/, ['quick-scatterometer-quikscat']),
  R('seastar', /^(SEASTAR|ORBVIEW[ -]?2)$/, ['seastar']),
  R('acrimsat', /^ACRIMSAT$/, ['active-cavity-irradiance-monitor-satellite-acrimsat-a', 'active-cavity-irradiance-monitor-satellite-acrimsat-b']),
  R('aim', /^AIM$/, ['aeronomy-of-ice-in-the-mesosphere']),
  R('cnofs', /^C\/?NOFS$/, ['communication-and-navigation-outage-forecast-system-cnofs']),
  R('toms', /^TOMS\b/, ['total-ozone-mapping-spectrometer-toms']),
  R('firefly', /^FIREFLY$/, ['firefly']),
  R('icecube', /^ICECUBE$/, ['cubesat-icecube']),
  R('mirata', /^MIRATA$/, ['cubesat-mirata']),
  R('cgro', /^(CGRO|GRO|COMPTON\b.*)$/, ['gamma-ray-observatory']),
  R('dscovr', /^DSCOVR$/, ['deep-space-climate-observatory-dscovr-triana']),
  R('wind', /^WIND$/, ['wind']),
  R('ace', /^ACE$/, ['advanced-composition-explorer']),
  R('mir', /^MIR$/, ['mir']),
  R('tselina-2', /\bTSELINA[ -]?2\b/, ['tselina-2']),
  R('agena', /^AGENA\b/, ['agena-target-vehicle']),
  R('spartan', /^SPARTAN\b/, ['spartan-201'])
])

/** 大型平板 LEO 星座：名称前缀或页面组键（ConstellationMap3D 的 GROUPS）→ param:flat-leo。 */
export const CONSTELLATION_RULES = Object.freeze([
  Object.freeze({ key: 'starlink', re: /^STARLINK\b/, groups: ['starlink'] }),
  Object.freeze({ key: 'oneweb', re: /^ONEWEB\b/, groups: ['oneweb'] }),
  Object.freeze({ key: 'kuiper', re: /^KUIPER\b/, groups: ['kuiper'] }),
  Object.freeze({ key: 'guowang', re: /^(HULIANWANG|GUOWANG|SATNET)\b/, groups: ['guowang'] }),
  Object.freeze({ key: 'qianfan', re: /^(QIANFAN|SPACESAIL|THOUSAND SAILS|G60)\b/, groups: ['qianfan'] })
])

/** 只在 orbitKind 未知时用的 GEO 通信运营商名称兜底（★ 不含 GSAT：CelesTrak 的伽利略导航星也叫 GSAT0xxx）。 */
export const GEO_NAME_HINT = /^(ZHONGXING|CHINASAT|APSTAR|ASIASAT|TIANLIAN|TIANTONG|INTELSAT|SES[ -]?\d|EUTELSAT|ASTRA \d|HOTBIRD|TELSTAR|ECHOSTAR|DIRECTV|INMARSAT|THURAYA|ARABSAT|BADR|TURKSAT|MEASAT|THAICOM|JCSAT|SUPERBIRD|KOREASAT|OPTUS|NILESAT|HISPASAT|AMAZONAS|YAMAL|EXPRESS[ -]AM|INSAT|NIGCOMSAT|LAOSAT|PAKSAT|ALCOMSAT|BELINTERSAT|VENESAT|TUPAC|NSS[ -]?\d|AMC[ -]?\d|GALAXY \d|VIASAT[ -]?\d|JUPITER \d|ABS[ -]?\d|AZERSPACE|YAHSAT|AL YAH|SKYNET 5)/

const DEBRIS_RE = /(\bDEB\b|\bR\/B\b|ROCKET BODY|\bAKM\b|\bPKM\b)/
const CUBESAT_SIZE_RE = /(?:^|[^0-9.])(1\.5|12|1|2|3|6)\s?U\b/
const CUBESAT_WORD_RE = /CUBE ?SAT/
const CUBESAT_3U_SERIES = /^(FLOCK|DOVE|LEMUR)\b/   // Planet Dove、Spire LEMUR-2 均为 3U

/** 名称归一：全角→半角（NFKC）、大写、首尾去空白、内部空白折叠。 */
export function normalizeName(s) {
  return String(s ?? '').normalize('NFKC').toUpperCase().replace(/\s+/g, ' ').trim()
}

/** 具名规则引用到的全部 NASA id（单测拿它逐条对 include-list）。 */
export function ruleNasaIds() {
  const out = []
  for (const r of RULES) for (const id of r.ids) if (!out.includes(id)) out.push(id)
  return out
}

/**
 * 自动匹配。
 * @param {{name?:string, noradId?:number|string, orbitKind?:string, group?:string}} sat
 *        orbitKind 取 classifyOrbit 的 GEO / IGSO / MEO / LEO / HEO（大小写不敏感）；group 取 entry.group
 * @param {{available?:Set<string>|string[], prefs?:{geoDefault?:string}}} [opts]
 *        available：manifest 里的模型 id 集合；不给 = 视为全部可用（manifest 未就绪时的试算）。param: 模型运行时生成，恒可用。
 *        prefs.geoDefault 是旧模板 id（别名表）时按别名换成现行 id
 * @returns {{id:string|null, rule:string}}  rule 为命中规则的 key（'iss'、'constellation:starlink'、'cubesat:3u'、'geo-default'、'fallback'…）
 */
export function match(sat, opts = {}) {
  const s = sat || {}
  const name = normalizeName(s.name)
  const norad = Number(s.noradId)
  const kind = String(s.orbitKind ?? '').toUpperCase()
  const group = String(s.group ?? '').toLowerCase()
  const av = opts.available ? (opts.available instanceof Set ? opts.available : new Set(opts.available)) : null
  const ok = (id) => typeof id === 'string' && (id.startsWith('param:') || !av || av.has(id))

  if (name && DEBRIS_RE.test(name)) return { id: null, rule: 'debris' }

  for (const r of RULES) {
    const hit = (name && r.re.test(name)) || (Number.isFinite(norad) && r.norad && r.norad.includes(norad))
    if (!hit) continue
    const id = r.ids.find(ok)
    if (id) return { id, rule: r.key }
    // 候选都不可用：落到下一条规则（通常最终落到星座 / GEO / 通用）
  }

  for (const c of CONSTELLATION_RULES) {
    if ((name && c.re.test(name)) || c.groups.includes(group)) return { id: 'param:flat-leo', rule: `constellation:${c.key}` }
  }

  const m = CUBESAT_SIZE_RE.exec(name)
  if (m) return { id: `param:cubesat-${m[1]}u`, rule: `cubesat:${m[1]}u` }
  if (CUBESAT_3U_SERIES.test(name)) return { id: 'param:cubesat-3u', rule: 'cubesat:3u-series' }
  if (CUBESAT_WORD_RE.test(name)) return { id: 'param:cubesat-3u', rule: 'cubesat:default-3u' }

  const geoByName = !kind && name && GEO_NAME_HINT.test(name)
  if (kind === 'GEO' || geoByName) {
    const pref = opts.prefs && typeof opts.prefs.geoDefault === 'string' && opts.prefs.geoDefault ? resolveParamModelId(opts.prefs.geoDefault) : DEFAULT_MODEL_ID
    return { id: ok(pref) ? pref : DEFAULT_MODEL_ID, rule: geoByName ? 'geo-name-hint' : 'geo-default' }
  }
  return { id: DEFAULT_MODEL_ID, rule: 'fallback' }
}
