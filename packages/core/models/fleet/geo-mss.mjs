// GEO 移动通信星精模（2026-10-07）：Inmarsat-4、Alphasat……（其余随调研补齐）
//
// ★ 坐标：本平台本体系（+Z 对地、+X 东、+Y 南），原点 = 平台结构盒几何中心。
// ★「geomobile」构型（Inmarsat-4 / Alphasat）：平台发射时竖立、在轨整星绕 Y 转 90° 飞行（ESA：「a 90 degree rotation of the satellite
//   flight orientation (for better accommodation of the feed/reflector configuration)」）——7 m 长轴东西向，发射顶面（L 频段馈源阵）朝东，
//   发射底面（对接环 + 远地点发动机）朝西；AstroMesh 大网状反射面由展开臂托在东端外、偏背地侧，口面斜对馈源阵，波束对地。
//   东 / 西哪一端放馈源原文未写（取东端，示意）。
// ★ 数据：质量 / 本体尺寸 / 翼展 / 板数 / 反射面口径 / 臂长逐条出处（facts）；单板尺寸、反射面偏置与焦距、臂的折点按渲染与跨度推算（IMG / derived）。

import { F, IMG, ILL } from './sources.mjs'
import { BODY, frameZX, toW, add, nrm, madd, obox, cyl, cone, disc, prism, ngon } from './kit.mjs'
import { group, nozzle } from './parts.mjs'
import { buildGeo, meshReflector, yokeForSpan } from './geokit.mjs'
import { comsat } from './geo-presets.mjs'

const S = {
  SPACENEWS_I4: 'https://spacenews.com/first-inmarsat-4-satellite-ready-for-launch/',
  INMARSAT_I4: 'https://web.archive.org/web/20180324040905/https://www.inmarsat.com/about-us/about-usour-satellites/inmarsat-4/',
  ILS_I4F1: 'https://www.ilslaunch.com/wp-content/uploads/2018/09/INMARSAT_4F1_MO.pdf',
  NGC_I4_DEPLOY: 'http://web.archive.org/web/20240201033828/https://news.northropgrumman.com/news/releases/photo-release-northrop-grumman-s-astromesh-reflector-successfully-deploys-on-inmarsat-4-satellite',
  NGC_I4_RENDER: 'https://s3.amazonaws.com/cms.ipressroom.com/295/files/201607/215274.jpg',
  ESA_E3000_SA: 'https://connectivity.esa.int/projects/e3000-second-generation-solar-array',
  VA214: 'https://europeanspaceflight.com/wp-content/uploads/2023/11/VA214-launchkit.pdf',
  ESA_ALPHASAT_DEPLOY: 'https://www.esa.int/Applications/Connectivity_and_Secure_Communications/Alphasat/Alphasat_deploys_its_giant_reflector_in_orbit',
  NGC_ALPHASAT: 'http://web.archive.org/web/20240201040958/https://news.northropgrumman.com/news/releases/photo-release-reflector-system-built-by-northrop-grumman-s-astro-aerospace-unit-deploys-successfully-aboard-alphasat-communications-satellite',
  NGC_ALPHASAT_BOOM: 'http://web.archive.org/web/20240201045748/https://news.northropgrumman.com/news/releases/photo-release-northrop-grumman-s-astro-aerospace-delivers-deployable-reflector-to-astrium-for-alphasat-i-xl-spacecraft',
  ESA_RESIL: 'https://resilience.esa.int/archives/news/alphasat',
  ESA_ALPHASAT_IMG: 'https://www.esa.int/var/esa/storage/images/esa_multimedia/images/2013/07/alphasat_artist_s_impression/12960027-1-eng-GB/Alphasat_artist_s_impression.jpg',
  EOP_ALPHASAT: 'https://www.eoportal.org/satellite-missions/alphasat'
}
const P = (x, y, z) => [x, y, z]
const Z = [0, 0, 1]

// ───────────────────────────── geomobile 构型（Inmarsat-4 / Alphasat） ─────────────────────────────
/**
 * o = { bus:{x（长轴，东西）, y, z}, faces, eastMat?（馈源端面材质）, wings, refl:{D, fd, dc, depth, bays, name, title}, boomFrom, elbow,
 *       feed:{nx, ny, pitch}（端面杯形螺旋阵）, deckBits?（对地面小件） }
 */
function buildGeomobile(B, o) {
  const hx = o.bus.x / 2, hy = o.bus.y / 2, hz = o.bus.z / 2
  buildGeo(B, {
    bus: { ...o.bus, faces: { ...(o.faces || {}), east: o.eastMat || 'mli_gold' }, ribs: 4, lae: false, adapterD: 0, rcs: false, trackers: 'north' },
    wings: o.wings,
    furniture: { omni: [-hx * 0.7, -hy * 0.6], aftOmni: false },
    extra: (B2) => {
      // 发射底面（西端面）：对接环 + 远地点发动机 + 四角姿控推力器
      const gW = group(B2, 'west_end', '西端面（对接环 / 远地点发动机）', 'thruster')
      const rO = Math.min(0.83, 0.45 * Math.min(o.bus.y, o.bus.z)), x0 = -hx - 0.012
      cyl(gW.mb('aluminum'), P(x0, 0, 0), P(x0 - 0.12, 0, 0), rO, 48, false, false)
      nozzle(gW.mb('titanium'), P(x0, 0, 0), P(-1, 0, 0), 0.15, 0.36, 32)
      for (const sy of [1, -1]) for (const sz of [1, -1]) nozzle(gW.mb('titanium'), P(x0, sy * (hy - 0.2), sz * (hz - 0.2)), nrm(P(-1, sy * 0.3, sz * 0.3)), 0.03, 0.08)
      gW.flush()
      B2.point('lae', 4.5, P(x0 - 0.15, 0, 0))
      // 东端面：L 频段杯形螺旋馈源阵（nx × ny 个杯 + 短螺旋帽），口面朝东
      const gF = group(B2, 'l_feed_array', 'L 频段馈源阵', 'feed')
      const fx = hx + 0.012, fe = o.feed
      obox(gF.mb('black_paint'), BODY, P(fx + 0.04, 0, 0), P(0.04, (fe.ny * fe.pitch) / 2 + 0.06, (fe.nx * fe.pitch) / 2 + 0.06))
      for (let i = 0; i < fe.nx; i++) for (let j = 0; j < fe.ny; j++) {
        const c = P(fx + 0.08, (j - (fe.ny - 1) / 2) * fe.pitch + (i % 2 ? fe.pitch / 4 : -fe.pitch / 4), (i - (fe.nx - 1) / 2) * fe.pitch)
        cyl(gF.mb('dark_metal'), c, add(c, P(0.09, 0, 0)), fe.pitch * 0.42, 10, false, false)
        cone(gF.mb('gold_metal'), add(c, P(0.02, 0, 0)), fe.pitch * 0.12, add(c, P(0.2, 0, 0)), fe.pitch * 0.05, 8, true, true)
      }
      gF.flush()
      B2.point('l_feed_array', 60, P(fx + 0.1, 0, 0))
      // 大网状反射面：焦点在馈源阵前方、视轴对地、偏置朝东
      const Fp = P(hx + 0.35, 0, 0)
      meshReflector(B2, [hx, hy, hz], { name: o.refl.name, title: o.refl.title, D: o.refl.D, fd: o.refl.fd, F: Fp, a: Z, u: P(1, 0, 0), dc: o.refl.dc, style: 'astromesh',
        bays: o.refl.bays, depth: o.refl.depth, trussMat: 'white_paint', boomFrom: o.boomFrom, elbow: o.elbow, feedArray: false })
      if (o.deckBits) o.deckBits(B2, { hx, hy, hz })
    }
  })
}

/** 对地面上的白色六边形小件（C 频段馈电 / 导航载荷天线一类，渲染可见、用途未证实）。 */
function hexPlates(B, list, hz) {
  const g = group(B, 'c_band', 'C 频段 / 导航天线（示意）', 'feed')
  for (const [x, y, r] of list) prism(g.mb('white_paint'), { o: P(x, y, hz + 0.012), x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }, ngon(6, r, 0), 0, 0.05)
  g.flush()
}

function buildInmarsat4(B) {
  const bus = { x: 7.0, y: 2.9, z: 2.3 }
  // ADCS 小翼（「sail」）：铰在第 4 块（共 5）的长边上、垂直阵面（Northrop / Panbo 图）
  const flap = { tilt: 90, mat: 'black_paint', faceMat: 'black_paint' }
  buildGeomobile(B, {
    bus, wings: { panels: 5, along: 3.915, across: 2.28, xRoot: -0.6, yokeLen: yokeForSpan(45, bus.y, 5, 3.915), yoke: 'V', yokeD: 0.06, flap, cell: 'gaas' },
    refl: { name: 'l_reflector', title: 'L 频段 AstroMesh 反射面（9 m）', D: 9, fd: 0.5, dc: 7.15, depth: 0.75, bays: 30 },
    boomFrom: P(3.5, 0.6, -0.75), elbow: P(5.0, 0.6, -2.0),
    feed: { nx: 10, ny: 12, pitch: 0.18 },
    deckBits: (B2, { hz }) => hexPlates(B2, [[-1.2, 0.5, 0.28], [-0.4, -0.6, 0.22]], hz)
  })
}

function buildAlphasat(B) {
  const bus = { x: 7.1, y: 2.5, z: 2.8 }
  // 单板沿翼展长：跨度 40 m 扣本体南北半宽、蒙皮、SADA 0.2、轭 2.8、3 道板缝 0.05 后四等分（≈3.90 m）
  const along = (40 / 2 - bus.y / 2 - 0.012 - 0.2 - 2.8 - 3 * 0.05) / 4
  buildGeomobile(B, {
    bus, eastMat: 'copper',
    wings: { panels: 4, along, across: 2.5, xRoot: -0.8, yokeLen: 2.8, yoke: 'V', yokeD: 0.06 },
    refl: { name: 'xl_reflector', title: 'L 频段 AstroMesh 反射面（11 m）', D: 11, fd: 0.5, dc: 11.15, depth: 0.9, bays: 32 },
    boomFrom: P(3.55, 0.7, -0.9), elbow: P(6.2, 0.7, -0.9),
    feed: { nx: 11, ny: 12, pitch: 0.19 },
    deckBits: (B2, { hx, hz }) => {
      // 激光通信终端 LCT（TDP1，0.6 × 0.6 × 0.7 m）与 Q/V 实验小碟（示意位置）
      const g = group(B2, 'tdp', '技术验证载荷（激光终端 / Q-V 小碟）', 'sensor')
      obox(g.mb('mli_silver'), BODY, P(-hx + 1.0, 0.3, hz + 0.35), P(0.3, 0.3, 0.35))
      cyl(g.mb('white_paint'), P(-hx + 1.0, 0.3, hz + 0.7), P(-hx + 1.0, 0.3, hz + 0.95), 0.16, 20, false, true)
      disc(g.mb('dark_glass'), P(-hx + 1.0, 0.3, hz + 0.955), Z, 0.12, 20)
      cyl(g.mb('aluminum'), P(-hx + 2.2, -0.5, hz + 0.012), P(-hx + 2.2, -0.5, hz + 0.35), 0.05, 12, false, true)
      cone(g.mb('reflector'), P(-hx + 2.2, -0.5, hz + 0.35), 0.05, P(-hx + 2.2, -0.5, hz + 0.5), 0.3, 24, true, false)
      g.flush()
      B2.ap('lct', P(-hx + 1.0, 0.3, hz + 0.96), Z)
    }
  })
}

// ───────────────────────────── 常规构型 + 大网状反射面（Thuraya / TerreStar / SkyTerra / MUOS / Inmarsat-6） ─────────────────────────────
/**
 * 平台预设整星 + 东（或西）侧展开臂托的大网状反射面：馈源阵立在对地板东缘（短塔上），视轴对地、偏置朝外，口面斜对馈源阵。
 * m = { D, style:'umbrella'|'astromesh', side?:'E'|'W', fd?, near?（近缘离馈源的水平距离）, ribs?, title, name }
 */
function bigMesh(B, h, m) {
  const s = m.side === 'W' ? -1 : 1, R = m.D / 2
  const F = P(s * (h[0] - 0.35), 0, h[2] + 0.9)
  meshReflector(B, h, { name: m.name || 'mss_reflector', title: m.title, D: m.D, fd: m.fd || 0.5, F, u: P(s, 0, 0), dc: R + (m.near ?? 1.2), style: m.style, ribs: m.ribs || 24,
    bays: 30, depth: 0.07 * m.D, trussMat: 'white_paint', boomFrom: P(s * h[0], 0.5, h[2] - 0.6), elbow: P(s * (h[0] + 1.2), 0.5, h[2] - 1.6),
    feedArray: { w: Math.min(1.8, 0.11 * m.D), h: Math.min(1.4, 0.08 * m.D) } })
}

// ───────────────────────────── 型号表 ─────────────────────────────

const i4Facts = {
  massKg: F(5945, 'kg', S.ILS_I4F1, { rep: 'Inmarsat-4 F1', quote: 'Separated Mass: 5,945 kg', note: 'F2 5958 kg（Sea Launch）、F3 5960 kg（ILS）；Inmarsat：5.96 t' }),
  identical: F('三星同构', '', S.SPACENEWS_I4, { quote: 'All three satellites are identical and interchangeable' }),
  body: F([7, 2.9, 2.3], 'm', S.SPACENEWS_I4, { quote: 'Main body dimensions: 7 x 2.9 x 2.3m', note: '7 m 为发射竖轴（「The main body is 7 metres high」）；在轨东西向（geomobile）' }),
  span: F(45, 'm', S.SPACENEWS_I4, { quote: 'Solar array span: 45m' }),
  reflector: F(9, 'm', S.NGC_I4_DEPLOY, { quote: 'the nine-meter (30-feet) diameter AstroMesh furlable mesh reflector and boom support system successfully deployed', note: 'Astrium：网面椭圆 9 × 12 m（80 m²）' }),
  feed: F(120, '单元', S.SPACENEWS_I4, { quote: 'Antenna feed array: 120 active elements in L-band' }),
  cells: F('Si + GaAs', '', S.INMARSAT_I4, { quote: 'Solar panels – combining conventional silicon with advanced gallium arsenide (GaAs) cells for optimum efficiency' }),
  platform: F('Eurostar E3000', '', S.ILS_I4F1, { quote: 'Platform: Eurostar E3000' }),
  panelsPerWing: IMG(5, '块', S.NGC_I4_RENDER, 'Northrop 官方渲染逐块数接缝'),
  panelSize: F([3.915, 2.28], 'm', S.ESA_E3000_SA, { quote: 'Long version – panel size of 3.915 x 2.28 m.', note: 'E3000 长板（LX 档 5 块）；3.915 m 沿翼展时轭长 ≈1 m 与渲染短轭吻合（反向则轭长 > 9 m）——适用于 I-4 属推断' }),
  geometry: IMG({ dc: 7.15, fd: 0.5, boomToRim: 3 }, 'm', S.NGC_I4_RENDER, '以本体长 7 m ≈ 455 px 为标度：端面至环缘臂长 ≈ 3 m、反射面口径 ≈ 本体长 1.5 倍'),
  flap: IMG('第 4 块长边、单翼', '', 'https://panbo.com/inmarsat-4-solar-sailor/', 'Panbo 图注「The flap at far left is a \"sail\"」：一块无电池板铰在第 4 块板长边、垂直阵面（尺寸示意）')
}
const alphasatFacts = {
  massKg: F(6650, 'kg', S.VA214, { quote: 'Total mass at lift-off approx. 6,650 kg' }),
  dims: F([7.1, 2.5, 2.8], 'm', S.VA214, { quote: 'Dimensions 7.1 x 2.5 x 2.8 m' }),
  span: F(40, 'm', S.VA214, { quote: 'Span in orbit 40 m' }),
  wings: F({ n: 2, panels: 4 }, '', S.ESA_ALPHASAT_DEPLOY, { quote: 'deploying its twin four-panel solar wings, spanning 40 m' }),
  reflector: F(11, 'm', S.ESA_ALPHASAT_DEPLOY, { quote: 'deployed its 11 m-diameter main antenna over the course of a day', note: 'Northrop：网面 14 × 11 m' }),
  boom: F(6, 'm', S.NGC_ALPHASAT_BOOM, { quote: 'unfold a 19 foot (6 meter) boom supporting the reflector above the satellite' }),
  reflMass: F(112, 'kg', S.NGC_ALPHASAT, { quote: 'Including launch support and deployment boom hardware, the total system weighs only 246 pounds (112 Kg).' }),
  rotation: F('整星绕 Y 转 90° 飞行', '', S.ESA_RESIL, { quote: 'to allow a 90 degree rotation of the satellite flight orientation (for better accommodation of the feed/reflector configuration)' }),
  platform: F('Alphabus', '', S.VA214, { quote: 'Platform ALPHABUS' }),
  lct: F([0.6, 0.6, 0.7], 'm', S.EOP_ALPHASAT, { quote: '0.6 m x 0.6 m x 0.7 m', confidence: 'secondary', note: 'TDP1 激光终端；安装面未查到（示意）' }),
  yoke: IMG(2.8, 'm', S.ESA_ALPHASAT_IMG, 'ESA 渲染：以本体长 7.1 m ≈ 250 px 为标度量三角连接架'),
  panelAlong: { value: null, basis: 'derived', from: '跨度 40 m、本体南北 2.5 m、轭 2.8 m、4 块板', how: '(40/2 − 1.25 − SADA − 2.8 − 3 × 板缝) / 4 ≈ 3.9 m（与 E3000 长板 3.915 m 同量级）' },
  look: IMG('金色 MLI 本体、馈源端面铜橙色、暖白网面 + 灰白桁架环', '', S.ESA_ALPHASAT_IMG, 'ESA 2013 官方渲染')
}

const GU = (slug) => `https://space.skyrocket.de/doc_sdat/${slug}.htm`
const gcfg = (slug, cfg) => F(cfg, '', GU(slug), { quote: `Configuration: ${cfg}`, confidence: 'secondary' })
const gmass = (slug, v, text, note) => F(v, 'kg', GU(slug), { quote: `Mass: ${text}`, confidence: 'secondary', ...(note ? { note } : {}) })
// tags / aliases 放在 ...o 之后：型号自己的 tags 是追加的细分标签，不能把 geo / mss 盖掉
const mssDef = (o) => ({ rev: 1, family: 'geo-mss', ...o, tags: ['geo', 'mss', ...(o.tags || [])], aliases: o.aliases || [],
  facts: { ...o.facts, shape: ILL(o.shape || '板数 / 本体比例 / 展开臂折点为平台典型外形示意', '', '未查到逐项原文') }, massKg: o.facts.massKg })
const MSS_MORE = [
  mssDef({ id: 'inmarsat-5', maker: 'Boeing Satellite Systems', title: 'Inmarsat-5 (Global Xpress)', titleZh: 'Inmarsat-5（Global Xpress）', basis: 'Boeing 702HP，Ka 多波束 + 可转点波束', tags: ['inmarsat', 'hts'],
    aliases: ['INMARSAT 5-F1', 'INMARSAT 5-F2', 'INMARSAT 5-F3', 'INMARSAT 5-F4'],
    facts: { massKg: gmass('inmarsat-5', 6070, '6070 kg; 3750 kg (BOL) (#1-3); 6086 kg (#4)'), platform: gcfg('inmarsat-5', 'BSS-702HP'),
      span: F(33.8, 'm', 'http://web.archive.org/web/20100902070756/http://www.boeing.com:80/defense-space/space/bss/factsheets/702/Inmarsat-5/Inmarsat-5.html', { confidence: 'secondary', note: 'Boeing 实况表：两翼各 5 块、太阳翼端到端 33.80 m' }) },
    build: (B) => comsat(B, { platform: 'b702hp', span: 33.8, refl: { E: [2.6], W: [2.6], deck: [1.5, 1.5], feedN: 19 },
      gimbals: [{ name: 'ka_steer_1', title: 'Ka 可转点波束 1', at: [0.75, 0.9], D: 0.9 }, { name: 'ka_steer_2', title: 'Ka 可转点波束 2', at: [-0.75, 0.9], D: 0.9 }] }) }),
  mssDef({ id: 'inmarsat-gx5', maker: 'Thales Alenia Space', title: 'Inmarsat GX5', basis: 'Spacebus 4000B2，Ka', tags: ['inmarsat', 'hts'], aliases: ['INMARSAT GX5'],
    facts: { massKg: gmass('inmarsat-5-5', 4007, '4007 kg'), platform: gcfg('inmarsat-5-5', 'Spacebus-4000B2') },
    build: (B) => comsat(B, { platform: 'sb4000', wing: { panels: 3, side: undefined }, refl: { E: [2.4], W: [2.4], deck: [1.3], feedN: 19 } }) }),
  mssDef({ id: 'inmarsat-6', maker: 'Airbus Defence and Space（L 频段反射面 Northrop Grumman）', title: 'Inmarsat-6', titleZh: 'Inmarsat-6（L + Ka 双频）', basis: 'Eurostar E3000EOR，9 m L 频段网状 + 9 副 Ka 多波束',
    tags: ['inmarsat'], aliases: ['INMARSAT 6-F1', 'INMARSAT 6-F2'],
    facts: { massKg: gmass('inmarsat-6', 5470, '5470 kg (#1)'), platform: gcfg('inmarsat-6', 'Eurostar-3000EOR'),
      antennas: F({ L: 9, ka: 9 }, '', GU('inmarsat-6'), { quote: 'I-6 F1 and F2 will carry a large 9 m aperture L-band antenna and nine multibeam Ka-band antennas', confidence: 'secondary' }) },
    build: (B) => comsat(B, { platform: 'e3000eor', wing: { panels: 5 }, refl: { E: [2.2], W: [2.2], deck: [1.4], feedN: 7 },
      extra: (B2, { h }) => bigMesh(B2, h, { D: 9, style: 'astromesh', side: 'W', title: 'L 频段 AstroMesh 反射面（9 m）', name: 'l_reflector' }) }) }),
  mssDef({ id: 'thuraya-2', maker: 'Boeing Satellite Systems（反射面 Northrop Grumman Astro Aerospace）', title: 'Thuraya-2 / 3', basis: 'Boeing GEM，12.25 m AstroMesh', tags: ['thuraya'],
    aliases: ['THURAYA-2', 'THURAYA-3'],
    facts: { massKg: gmass('thuraya-2', 5177, '5177 kg'), platform: gcfg('thuraya-2', 'BSS-GEM (Geomobile)'),
      reflector: F(12.25, 'm', GU('thuraya-2'), { quote: 'transmitting and receiving calls through a single 12.25 meter-aperture reflector', confidence: 'secondary', note: 'Boeing：展开后 12.25 × 16 m' }),
      span: F(40.4, 'm', 'http://web.archive.org/web/20021022053853/http://www.boeing.com:80/defense-space/space/bss/factsheets/geomobile/thuraya2_3/thuraya2_3.html', { confidence: 'secondary', note: 'Boeing 实况表：2 翼各 5 块、太阳翼端到端 40.4 m' }) },
    build: (B) => comsat(B, { platform: 'b702hp', span: 40.4, refl: { deck: [1.4] }, extra: (B2, { h }) => bigMesh(B2, h, { D: 12.25, style: 'astromesh', title: 'L 频段 AstroMesh 反射面（12.25 m）' }) }) }),
  mssDef({ id: 'thuraya-4', maker: 'Airbus Defence and Space', title: 'Thuraya-4 NGS', basis: 'Eurostar Neo 全电推，12 m L 频段天线', tags: ['thuraya'], aliases: ['THURAYA-4'],
    facts: { massKg: ILL(5000, 'kg', '发射质量未查到原文（示意）'), platform: gcfg('thuraya-4', 'Eurostar-Neo'),
      reflector: F(12, 'm', GU('thuraya-4'), { quote: 'will incorporate a large 12-meter L-band antenna', confidence: 'secondary' }) },
    build: (B) => comsat(B, { platform: 'eneo', refl: { deck: [1.4] }, extra: (B2, { h }) => bigMesh(B2, h, { D: 12, style: 'astromesh', title: 'L 频段大型反射面（12 m）' }) }) }),
  mssDef({ id: 'terrestar', maker: 'Space Systems/Loral（反射面 Harris）', title: 'TerreStar-1 / EchoStar 21', titleZh: 'TerreStar-1 / EchoStar 21（TerreStar-2）', basis: 'SSL-1300S，18 m S 频段伞状网状反射面',
    tags: ['terrestar', 'echostar'], aliases: ['TERRESTAR-1', 'ECHOSTAR 21', 'TERRESTAR-2'],
    facts: { massKg: gmass('terrestar-1', 6910, '6910 kg (#1); 6871 kg (#2)'), platform: gcfg('terrestar-1', 'SSL-1300S'),
      reflector: F(18, 'm', 'https://nssdc.gsfc.nasa.gov/nmc/spacecraft/display.action?id=2009-035A', { quote: 'TerreStar 1 has a mass of approximately 6,910 kg, and an 18 m deployable reflector.' }),
      span: F(32.44, 'm', 'http://web.archive.org/web/2010id_/http://arianespace.com/images/launch-kits/launch-kit-pdf-eng/DDP-TerreStar-1(GB).pdf', { quote: 'Span in orbit 32.44 m' }),
      wing: IMG('4 + 2 侧板（挂第 3 块）', '块', 'http://web.archive.org/web/2010id_/http://arianespace.com/images/launch-kits/launch-kit-pdf-eng/DDP-TerreStar-1(GB).pdf', 'Arianespace V189 手册渲染：每翼长单杆轭 → 4 块串联（第 1 块无电池、灰色），第 3 块两侧挂侧板') },
    build: (B) => comsat(B, { platform: 'ssl1300', bus: [2.6, 2.9, 4.6], span: 32.44, wing: { panels: 4, side: { at: 2 }, yoke: 'rod' }, refl: { deck: [1.2] },
      extra: (B2, { h }) => bigMesh(B2, h, { D: 18, style: 'umbrella', ribs: 24, title: 'S 频段伞状网状反射面（18 m）' }) }) }),
  mssDef({ id: 'skyterra-1', maker: 'Boeing Satellite Systems（反射面 Harris）', title: 'SkyTerra-1', basis: 'Boeing 702HP GEM，22 m L 频段反射面 + 1.5 m Ku 天线', tags: ['ligado'], aliases: ['SKYTERRA 1'],
    facts: { massKg: gmass('skyterra-1', 5390, '5390 kg (3200 kg BOL)'), platform: gcfg('skyterra-1', 'BSS-702GEM (Geomobile)'),
      reflector: F({ L: 22, Ku: 1.5 }, 'm', GU('skyterra-1'), { quote: 'The 22 meter L-band reflector for mobile terminal links will complement a 1.5 meter Ku-band antenna', confidence: 'secondary' }),
      span: F(41, 'm', 'http://web.archive.org/web/20090419161841/http://www.boeing.com:80/defense-space/space/bss/factsheets/geomobile/msv/msv.html', { confidence: 'secondary', note: 'Boeing MSV 实况表：2 翼各 5 块；在轨 高 22 m、宽 29 m、长 41 m' }) },
    build: (B) => comsat(B, { platform: 'b702hp', span: 41, refl: { deck: [1.5] }, extra: (B2, { h }) => bigMesh(B2, h, { D: 22, style: 'umbrella', ribs: 28, title: 'L 频段伞状网状反射面（22 m）' }) }) }),
  mssDef({ id: 'muos', maker: 'Lockheed Martin（反射面 Harris）', title: 'MUOS', titleZh: 'MUOS（美军移动用户目标系统）', basis: 'A2100M，大型 UHF 伞状网状反射面 ×2', tags: ['milcom'],
    aliases: ['MUOS-1', 'MUOS-2', 'MUOS-3', 'MUOS-4', 'MUOS-5'],
    facts: { massKg: gmass('muos-1', 6740, '6740 kg; 3812 kg (dry)'), platform: gcfg('muos-1', 'A2100M'),
      span: F(28.7, 'm', 'https://spaceflightnow.com/?p=3672', { confidence: 'secondary', note: 'Spaceflight Now：太阳翼端到端 94 ft（28.7 m）；每翼 5 块（spaceflight101）' }) }, shape: '两副网状反射面口径（≈14 m / 5.4 m）与摆位为示意',
    build: (B) => comsat(B, { platform: 'a2100', bus: [2.6, 2.6, 4.2], span: 28.7, wing: { panels: 5 }, refl: false,
      extra: (B2, { h }) => { bigMesh(B2, h, { D: 14, style: 'umbrella', ribs: 24, title: 'WCDMA 伞状网状反射面', name: 'uhf_main' }); bigMesh(B2, h, { D: 5.4, style: 'umbrella', side: 'W', ribs: 16, title: '传统 UHF 网状反射面', name: 'uhf_legacy', near: 0.6 }) } }) })
]

export const GEO_MSS_MODELS = [
  { id: 'inmarsat-4', rev: 1, family: 'geo-mss', maker: 'EADS Astrium（反射面 Northrop Grumman Astro Aerospace）', title: 'Inmarsat-4', titleZh: 'Inmarsat-4（国际海事卫星四代）',
    basis: 'Eurostar E3000 geomobile，9 m AstroMesh + 120 元馈源阵', tags: ['geo', 'mss', 'inmarsat'], aliases: ['INMARSAT 4-F1', 'INMARSAT 4-F2', 'INMARSAT 4-F3', 'I-4'],
    massKg: i4Facts.massKg, facts: i4Facts, build: buildInmarsat4 },
  { id: 'alphasat', rev: 1, family: 'geo-mss', maker: 'Astrium / Thales Alenia Space（反射面 Northrop Grumman Astro Aerospace）', title: 'Alphasat (Inmarsat-4A F4)', titleZh: 'Alphasat（Inmarsat-4A F4）',
    basis: 'Alphabus geomobile，11 m AstroMesh + 6 m 展开臂', tags: ['geo', 'mss', 'inmarsat'], aliases: ['ALPHASAT', 'INMARSAT-4A F4', 'I-XL'],
    massKg: alphasatFacts.massKg, facts: alphasatFacts, build: buildAlphasat },
  ...MSS_MORE
]
