// GEO 军用通信 / 预警 / 数据中继星精模（2026-10-07，只用公开资料）：Skynet 5……（其余随调研补齐）
//
// ★ 坐标：本平台本体系（+Z 对地、+X 东、+Y 南），原点 = 平台结构盒几何中心。
// ★ 数据：整星质量 / 收拢尺寸 / 在轨跨度 / 天线个数逐条出处（facts，发射手册与制造商 / 军方公开稿原文）；
//   本体尺寸、板长方向、天线位置口径只能按发射手册渲染图估（IMG / derived，写明怎么来的），其余为造型示意。

import { F, IMG, ILL } from './sources.mjs'
import { BODY, add, nrm, obox, cyl, cone, disc, patchGrid } from './kit.mjs'
import { group, fixedDish, addLaser } from './parts.mjs'
import { buildGeo, yokeForSpan, instrument } from './geokit.mjs'
import { comsat } from './geo-presets.mjs'

const S = {
  VA211: 'https://europeanspaceflight.com/wp-content/uploads/2023/11/VA211-launchkit.pdf',
  V175: 'https://web.archive.org/web/20081114095235id_/http://www.arianespace.com/images/launch-kits/launch-kit-pdf-eng/07_march_11.pdf',
  ESA_E3000_SA: 'https://connectivity.esa.int/projects/e3000-second-generation-solar-array',
  AFT_SKYNET5: 'https://web.archive.org/web/20260901161829id_/https://www.airforce-technology.com/projects/skynet-5-military-communications-satellite-system/',
  GOVUK_5D: 'https://assets.publishing.service.gov.uk/media/5a61bad340f0b60abc6755e2/s300_Skynet5D.jpg'
}
const P = (x, y, z) => [x, y, z]
const Z = [0, 0, 1]

// ───────────────────────────── Skynet 5（Eurostar E3000） ─────────────────────────────
//
// 每翼 5 块短板（2.28 m 沿翼展 × 3.05 m 横宽：ESA 第二代 E3000 短板；方向按跨度 34 m 反推）+ ADCS 配平小翼（铰在第 4 块的长边上、两翼各一
// 点对称——UK MoD 5D 渲染两翼都有；调研 eurostar_spacebus）；
// 轭长由跨度 34 m 扣本体与板长反推（≈3 m）。对地侧两根白色长杆天线（UHF，疑为螺旋）分处东西两缘、指向地球；
// 对地板一块有源接收相控阵 OBARA + 4 副可控 X 频段点波束小天线 + 两只全球波束喇叭（个数有出处、位置与口径为示意）。
function buildSkynet5(B) {
  const bus = { x: 2.5, y: 2.4, z: 3.8 }
  const flap = { tilt: 30, wing: 'both' }
  const hx = bus.x / 2, hz = bus.z / 2
  buildGeo(B, {
    bus: { ...bus, ribs: 3 },
    wings: { panels: 5, along: 2.28, across: 3.05, yokeLen: yokeForSpan(34, bus.y, 5, 2.28), yoke: 'V', yokeD: 0.06, flap },
    furniture: { omni: [-hx * 0.6, -0.75], horns: [[0.75, 0.75, 0.22], [0.75, -0.75, 0.22]] },
    extra: (B2) => {
      // 两根白色长杆天线（东西两缘、指向地球）
      const gU = group(B2, 'uhf_rods', 'UHF 长杆天线 × 2', 'feed')
      for (const s of [1, -1]) {
        const b = P(s * (hx + 0.22), 0.25, hz - 0.7), t = P(s * (hx + 0.22), 0.25, hz + 1.9)
        cyl(gU.mb('white_paint'), b, t, 0.14, 20, true, false)
        cone(gU.mb('white_paint'), t, 0.14, add(t, P(0, 0, 0.12)), 0.02, 20, false, true)
        obox(gU.mb('titanium'), BODY, P(s * (hx + 0.1), 0.25, hz - 0.5), P(0.12, 0.08, 0.1))
        B2.ap(`uhf_${s > 0 ? 'e' : 'w'}`, t, Z)
      }
      gU.flush()
      B2.point('uhf_rods', 30, P(0, 0.25, hz + 0.6))
      // 对地板：OBARA 有源接收阵（深色栅格面）+ 4 副可控 X 频段点波束天线
      const gA = group(B2, 'obara', '有源接收相控阵 OBARA', 'feed')
      const Fa = { o: P(-0.15, -0.2, hz + 0.02), x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }
      obox(gA.mb('dark_metal'), Fa, [0, 0, 0.03], [0.65, 0.65, 0.03])
      patchGrid(gA.mb('struct_light'), Fa, { nx: 8, ny: 8, px: 0.155, py: 0.155, w: 0.11, h: 0.11, t: 0.008, z0: 0.06 })
      gA.flush()
      B2.point('obara', 25, P(-0.15, -0.2, hz + 0.05))
      B2.ap('obara', P(-0.15, -0.2, hz + 0.08), Z)
      const gX = group(B2, 'x_spots', 'X 频段可控点波束天线 × 4', 'reflector')
      ;[[0.75, 0.0], [0.4, 0.75], [-0.85, 0.7], [0.75, -0.35]].forEach(([x, y], i) => {
        const base = P(x, y, hz + 0.012)
        cyl(gX.mb('mli_gold'), base, add(base, P(0, 0, 0.22)), 0.07, 14, false, true)
        const look = nrm(P(0.12 * Math.sign(x), 0.1 * Math.sign(y || 1), 1))
        fixedDish(gX, add(base, P(0, 0, 0.3)), look, { D: 0.6, fd: 0.38, reflMat: 'reflector', strutMat: 'carbon', na: 28, nr: 6 })
        B2.ap(`x_spot_${i + 1}`, add(base, P(0, 0, 0.5)), look)
      })
      gX.flush()
      B2.point('x_spots', 16, P(0.25, 0.3, hz + 0.3))
    }
  })
}

// ───────────────────────────── 通用小件：对地板碟群 / 相控阵面 ─────────────────────────────

/** 对地板上一簇小碟（可转点波束天线；为控节点数并成一个部件、不设关节）：list = [[x, y, D, tiltX?, tiltY?]…]。 */
function dishCluster(B, h, name, title, list) {
  const g = group(B, name, title, 'reflector')
  list.forEach(([x, y, D, tx = 0, ty = 0], i) => {
    const base = P(x, y, h[2] + 0.012)
    cyl(g.mb('mli_gold'), base, add(base, P(0, 0, 0.25)), 0.07, 14, false, true)
    const look = nrm(P(tx, ty, 1))
    fixedDish(g, add(base, P(0, 0, 0.32)), look, { D, fd: 0.38, reflMat: 'reflector', strutMat: 'carbon', na: 28, nr: 6 })
    B.ap(`${name}_${i + 1}`, add(base, P(0, 0, 0.32 + 0.3 * D)), look)
  })
  g.flush()
  B.point(name, 6 * list.length, P(0, 0, h[2] + 0.3))
}
/** 对地板相控阵面（白色平板 + 辐射单元栅格）：c = [x, y]、边长 w × l。 */
function phasedPanel(B, h, name, title, c, w, l, n = 10) {
  const g = group(B, name, title, 'feed')
  const Fa = { o: P(c[0], c[1], h[2] + 0.02), x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }
  obox(g.mb('white_paint'), Fa, [0, 0, 0.05], [w / 2, l / 2, 0.05])
  patchGrid(g.mb('struct_light'), Fa, { nx: n, ny: Math.max(2, Math.round((n * l) / w)), px: (w * 0.92) / n, py: (w * 0.92) / n, w: (w * 0.6) / n, h: (w * 0.6) / n, t: 0.006, z0: 0.1 })
  g.flush()
  B.point(name, 8 * w * l, P(c[0], c[1], h[2] + 0.07))
  B.ap(name, P(c[0], c[1], h[2] + 0.12), Z)
}

// ───────────────────────────── 型号表 ─────────────────────────────

const skynetFacts = {
  massKg: F(4700, 'kg', S.V175, { rep: 'Skynet 5A', quote: 'Total mass at lift-off 4,700 kg', note: '5B 4635 kg、5C 4638 kg、5D 约 4800 kg（各星 Arianespace 发射手册）' }),
  stowed: F([4.5, 2.9, 3.7], 'm', S.VA211, { quote: 'Dimensions 4.5 x 2.9 x 3.7 m', note: '收拢包络，未标轴向' }),
  span: F(34, 'm', S.VA211, { quote: 'Span in orbit 34 m' }),
  power: F(6, 'kW', S.VA211, { quote: 'On-board power > 6 kW (end of life)' }),
  platform: F('Eurostar E3000', '', S.V175, { quote: '3 axis stabilized 4.5 x 2.9 x 3.7 m 34 m EUROSTAR E3000S' }),
  wings: F(2, '翼', S.AFT_SKYNET5, { quote: 'Each satellite is equipped with two deployable solar arrays and batteries.' }),
  panelSize: F([3.05, 2.28], 'm', S.ESA_E3000_SA, { quote: 'Short version – panel size of 3.050 x 2.28 m', note: '按跨度反推 2.28 m 沿翼展（反之轭长为负）' }),
  panelsPerWing: IMG(5, '块', `${S.VA211}#page=7`, 'VA211 手册第 7 页渲染：每翼 5 块 + ADCS 小翼'),
  steerable: F(4, '副', S.AFT_SKYNET5, { quote: 'The satellite has four steerable downlinks, one global X-band downlink and one global X-band uplink.' }),
  obara: F('有源接收天线', '', S.AFT_SKYNET5, { quote: 'A high-performance on-board active receive antenna (OBARA) creates flexible global and regional beams for the global coverage.' }),
  bus: IMG([2.5, 2.4, 3.8], 'm', `${S.VA211}#page=7`, '收拢 4.5 × 2.9 × 3.7 m 扣收拢长杆天线（东西）与收拢太阳翼（南北）、对接环与对地件（竖轴）'),
  rods: IMG({ n: 2, L: 2.6, D: 0.28 }, 'm', `${S.VA211}#page=7`, '渲染：两根平行白杆指向地球，长约 1.1 倍板长'),
  look: IMG('金色 MLI 本体', '', S.GOVUK_5D, 'GOV.UK 缩略图（© Astrium 2010）'),
  flap: IMG('第 4 块长边、两翼各一', '', 'https://commons.wikimedia.org/wiki/File:Skynet_5D_in_orbit,_CGI.jpg', 'UK MoD 5D 渲染：灰色平板小翼两翼各一、位于外段板的长边上（尺寸 / 倾角示意）'),
  spotD: ILL(0.6, 'm', '可控点波束天线口径未公开（示意）')
}

const GU = (slug) => `https://space.skyrocket.de/doc_sdat/${slug}.htm`
const gcfg = (slug, cfg) => F(cfg, '', GU(slug), { quote: `Configuration: ${cfg}`, confidence: 'secondary' })
const gmass = (slug, v, text, note) => F(v, 'kg', GU(slug), { quote: `Mass: ${text}`, confidence: 'secondary', ...(note ? { note } : {}) })
// tags / aliases 放在 ...o 之后：型号自己的 tags 是追加的细分标签，不能把 geo 盖掉
const milDef = (o) => ({ rev: 1, family: 'geo-mil', ...o, tags: ['geo', ...(o.tags || [])], aliases: o.aliases || [],
  facts: { ...o.facts, shape: ILL(o.shape || '板数 / 本体比例 / 天线口径与摆位为平台典型外形示意', '', '未查到逐项原文') }, massKg: o.facts.massKg })
const MIL_MORE = [
  milDef({ id: 'wgs', maker: 'Boeing', title: 'WGS (Wideband Global SATCOM)', titleZh: 'WGS 宽带全球卫星通信', basis: 'Boeing 702HP，X 频段收发相控阵 + 10 副 Ka 可转天线', tags: ['milcom'],
    aliases: ['WGS F1', 'WGS F2', 'WGS F3', 'WGS F4', 'WGS F5', 'WGS F6', 'WGS F7', 'WGS F8', 'WGS F9', 'WGS 10'],
    facts: { massKg: gmass('wgs-1', 5987, '5987 kg'), platform: gcfg('wgs-1', 'BSS-702'),
      antennas: F('X 收发相控阵 + 10 副 Ka 可转天线', '', 'https://web.archive.org/web/20130226052225id_/http://www.boeing.com:80/defense-space/space/bss/factsheets/702/wgs/wgs_factsheet.html',
        { quote: '10 Ka-band beams served by independently steerable, diplexed antennas, including three with selectable RF polarization' }) },
    build: (B) => comsat(B, { platform: 'b702hp', refl: false, extra: (B2, { h }) => {
      phasedPanel(B2, h, 'x_tx_array', 'X 频段发射相控阵', [0.62, -0.55], 1.05, 1.05)
      phasedPanel(B2, h, 'x_rx_array', 'X 频段接收相控阵', [-0.62, -0.55], 0.95, 0.95)
      dishCluster(B2, h, 'ka_steer', 'Ka 可转点波束天线 × 10', [[1.0, 0.45, 0.6, 0.1, 0.1], [0.55, 0.85, 0.6], [0.0, 0.95, 0.6], [-0.55, 0.85, 0.6], [-1.0, 0.45, 0.6, -0.1, 0.1],
        [1.05, 1.25, 0.5], [-1.05, 1.25, 0.5], [0.3, 1.35, 0.5], [-0.3, 1.35, 0.5], [0.0, 0.3, 0.55]])
    } }) }),
  milDef({ id: 'aehf', maker: 'Lockheed Martin', title: 'AEHF (Advanced EHF)', titleZh: 'AEHF 先进极高频', basis: 'A2100M，相控阵 + 6 副上 / 下行碟 + 星间链', tags: ['milcom'],
    aliases: ['AEHF-1', 'AEHF-2', 'AEHF-3', 'AEHF-4', 'AEHF-5', 'AEHF-6'],
    facts: { massKg: gmass('aehf-1', 6168, '6168 kg'), platform: gcfg('aehf-1', 'A2100M'),
      antennas: F({ downlinkPA: 2, crosslinks: 2, updown: 2, uplinkPA: 1, dishes: 6, horns: 2 }, '', 'https://web.archive.org/web/20241202222531id_/https://media.defense.gov/2022/Apr/08/2002973439/-1/-1/1/AEHF%20FACTSHEET.PDF',
        { quote: 'Antennas: 2 Downlink Phased Arrays, 2 Crosslinks, 2 Uplink/Downlink Antennas, 1 Uplink Phased Array, 6 Uplink/Downlink Dish Antenna, 1 Each Uplink/Downlink earth coverage horns' }) },
    build: (B) => comsat(B, { platform: 'a2100', bus: [2.6, 2.6, 3.8], wing: { panels: 5 }, refl: false, furniture: { horns: [[0.95, -0.95, 0.24], [-0.95, -0.95, 0.24]] }, extra: (B2, { h }) => {
      phasedPanel(B2, h, 'uplink_pa', '上行相控阵', [0, -0.25], 1.2, 1.2, 12)
      phasedPanel(B2, h, 'downlink_pa_1', '下行相控阵 1', [0.85, 0.75], 0.55, 0.55, 6)
      phasedPanel(B2, h, 'downlink_pa_2', '下行相控阵 2', [-0.85, 0.75], 0.55, 0.55, 6)
      dishCluster(B2, h, 'updown_dishes', '上 / 下行碟形天线 × 6', [[0.95, 0.15, 0.55], [-0.95, 0.15, 0.55], [0.4, 1.05, 0.5], [-0.4, 1.05, 0.5], [0.3, -1.05, 0.45], [-0.3, -1.05, 0.45]])
      const gX = group(B2, 'crosslinks', '星间链路天线 × 2', 'reflector')
      for (const s of [1, -1]) {
        cyl(gX.mb('titanium'), P(s * (h[0] + 0.012), 0.3, h[2] - 0.4), P(s * (h[0] + 0.35), 0.3, h[2] - 0.4), 0.05, 12, false, true)
        fixedDish(gX, P(s * (h[0] + 0.4), 0.3, h[2] - 0.4), P(s, 0, 0), { D: 0.7, fd: 0.38, reflMat: 'reflector', na: 28, nr: 6 })
        B2.ap(`crosslink_${s > 0 ? 'e' : 'w'}`, P(s * (h[0] + 0.7), 0.3, h[2] - 0.4), P(s, 0, 0))
      }
      gX.flush()
    } }) }),
  milDef({ id: 'sbirs-geo', maker: 'Lockheed Martin', title: 'SBIRS GEO', titleZh: 'SBIRS 天基红外系统（GEO）', basis: 'A2100M / LM 2100M，扫描 + 凝视红外传感器', tags: ['early-warning'],
    aliases: ['SBIRS GEO-1', 'SBIRS GEO-2', 'SBIRS GEO-3', 'SBIRS GEO-4', 'SBIRS GEO-5', 'SBIRS GEO-6'],
    facts: { massKg: gmass('sbirs-geo-1', 4500, '~ 4500 kg'), platform: gcfg('sbirs-geo-1', 'A2100M'),
      dims: F({ ft: [49, 22, 20] }, 'ft', 'https://web.archive.org/web/20250522065831id_/https://media.defense.gov/2023/Feb/10/2003159902/-1/-1/1/SBIRS%20FACTSHEET.PDF', { quote: 'Satellite: Approximately 49 feet x 22 feet x 20 feet with all appendages', note: '≈14.9 × 6.7 × 6.1 m；传感器约 7 × 4 × 3 ft' }) },
    build: (B) => comsat(B, { platform: 'a2100', bus: [2.4, 2.4, 3.4], span: 14.9, wing: { panels: 2, along: 2.6 }, refl: false, extra: (B2, { h }) => {
      instrument(B2, { name: 'scanner', title: '扫描型红外传感器', c: P(-0.45, 0, h[2] + 0.5), size: [1.0, 1.0, 0.9], mat: 'mli_black' })
      const gS = group(B2, 'ir_telescopes', '红外望远镜遮光筒', 'sensor')
      cyl(gS.mb('mli_silver'), P(-0.45, 0, h[2] + 0.95), P(-0.45, 0, h[2] + 2.0), 0.36, 28, false, false)
      disc(gS.mb('dark_glass'), P(-0.45, 0, h[2] + 0.97), Z, 0.34, 28)
      cyl(gS.mb('mli_silver'), P(0.6, 0.1, h[2] + 0.3), P(0.75, 0.15, h[2] + 1.6), 0.3, 28, false, false)
      disc(gS.mb('dark_glass'), P(0.6, 0.1, h[2] + 0.32), Z, 0.28, 28)
      gS.flush()
      B2.ap('scanner', P(-0.45, 0, h[2] + 2.0), Z); B2.ap('starer', P(0.75, 0.15, h[2] + 1.6), Z)
      dishCluster(B2, h, 'sbirs_dl', '数传天线', [[0.85, -0.85, 0.5], [-0.9, -0.85, 0.5]])
    } }) }),
  milDef({ id: 'luch-5', maker: 'ISS Reshetnev', title: 'Luch-5 (data relay)', titleZh: 'Luch-5（俄罗斯数据中继）', basis: 'Ekspress-1000，两副单址天线', tags: ['relay'],
    aliases: ['LUCH-5A', 'LUCH-5B', 'LUCH-5V'],
    facts: { massKg: gmass('luch-5a', 1148, '1148 kg', 'Luch-5B 1350 kg（Ekspress-1000AM）'), platform: gcfg('luch-5a', 'Ekspress-1000A (3-Axis stabilized, 2 solar arrays)') },
    build: (B) => comsat(B, { platform: 'geostar', bus: [1.8, 1.9, 2.5], wing: { panels: 3, along: 2.0, across: 1.6 }, refl: false,
      gimbals: [{ name: 'sa_1', title: '单址天线 1', at: [0.55, 0.3], D: 1.8 }, { name: 'sa_2', title: '单址天线 2', at: [-0.55, 0.3], D: 1.8 }] }) }),
  milDef({ id: 'edrs-c', maker: 'OHB System', title: 'EDRS-C', titleZh: 'EDRS-C（欧洲数据中继）', basis: 'SmallGEO，激光通信终端 + Ka 馈电天线', tags: ['relay'], aliases: ['EDRS-C'],
    facts: { massKg: gmass('edrs-c', 3186, '3186 kg'), platform: gcfg('edrs-c', 'SmallGEO (LUXOR) bus') },
    build: (B) => comsat(B, { platform: 'geostar', bus: [2.0, 2.0, 3.2], wing: { panels: 2, along: 2.6, across: 1.9 }, refl: false,
      gimbals: [{ name: 'ka_feeder', title: 'Ka 馈电天线', at: [-0.4, 0.4], D: 1.6 }],
      extra: (B2, { h }) => {
        const g = group(B2, 'lct', '激光通信终端 LCT', 'sensor')
        addLaser(g, { base: P(0.5, -0.4, h[2] + 0.012), n: Z, look: nrm(P(0.3, -0.2, 1)), D: 0.25 })
        g.flush()
        B2.point('lct', 53, P(0.5, -0.4, h[2] + 0.3))
        B2.ap('lct', P(0.5, -0.4, h[2] + 0.6), Z)
      } }) }),
  milDef({ id: 'syracuse-4a', maker: 'Thales Alenia Space', title: 'Syracuse 4A', basis: 'Spacebus Neo 100 全电推，X / Ka', tags: ['milcom'], aliases: ['SYRACUSE 4A'],
    facts: { massKg: gmass('syracuse-4a', 3852, '3852 kg'), platform: gcfg('syracuse-4a', 'Spacebus-Neo-100') },
    build: (B) => comsat(B, { platform: 'sbneo', bus: [2.3, 2.5, 3.8], wing: { side: undefined }, refl: { E: [2.2], W: [2.2], deck: [1.2] },
      extra: (B2, { h }) => dishCluster(B2, h, 'spots', '可转点波束天线', [[0.75, 0.75, 0.6], [-0.75, 0.75, 0.6]]) }) }),
  milDef({ id: 'syracuse-4b', maker: 'Airbus Defence and Space', title: 'Syracuse 4B', basis: 'Eurostar E3000EOR，X / Ka', tags: ['milcom'], aliases: ['SYRACUSE 4B'],
    facts: { massKg: gmass('syracuse-4b', 3572, '3572 kg'), platform: gcfg('syracuse-4b', 'Eurostar-3000EOR') },
    build: (B) => comsat(B, { platform: 'e3000eor', wing: { panels: 4 }, refl: { E: [2.2], W: [2.2], deck: [1.2] },
      extra: (B2, { h }) => dishCluster(B2, h, 'spots', '可转点波束天线', [[0.75, 0.75, 0.6], [-0.75, 0.75, 0.6]]) }) })
]

export const GEO_MIL_MODELS = [
  { id: 'skynet-5', rev: 1, family: 'geo-mil', maker: 'EADS Astrium（现 Airbus Defence and Space）', title: 'Skynet 5', titleZh: 'Skynet 5（英国军用通信）', basis: 'Eurostar E3000，每翼 5 板 + 翼尖配平小翼',
    tags: ['geo', 'milcom', 'skynet'], aliases: ['SKYNET 5A', 'SKYNET 5B', 'SKYNET 5C', 'SKYNET 5D', '天网5'], massKg: skynetFacts.massKg, facts: skynetFacts, build: buildSkynet5 },
  ...MIL_MORE
]
