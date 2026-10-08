// GEO 通信星精模（2026-10-07，简化口径）：国际高通量 / 固定 / 直播名星、亚洲卫星、东方红四号 / 四号增强型平台出口星。
//
// ★ 外形走平台预设（geo-presets.mjs：SSL-1300 / 波音 601HP·702HP·702MP·702SP / 欧洲星 E3000·E3000EOR·Neo / 空间客车 4000·Neo /
//   A2100 / GEOStar / 东四 / 东四增强），每型只给差异：反射面数量与口径、板数、翼展、特殊件。
// ★ 数据：平台与发射质量取 Gunter 星页原句（secondary）；有发射手册（Arianespace）的取收拢尺寸 / 在轨翼展原句（primary）；
//   反射面口径、板数等没有原文的按平台典型外形示意（ILL），写在 facts.shape 里。
// ★ 用户口径：国内具体星不做；东四 / 东四增强只作平台型号，配给出口星（白俄 / 老挝 / 玻利维亚 / 尼日利亚 / 阿尔及利亚 / 巴基斯坦）。

import { F, ILL, IMG } from './sources.mjs'
import { comsat } from './geo-presets.mjs'
import { instrument, meshReflector } from './geokit.mjs'
import { group, nozzle, addHall } from './parts.mjs'
import { BODY, obox, cyl, cone, disc, truss, nrm } from './kit.mjs'

const GU = (slug) => `https://space.skyrocket.de/doc_sdat/${slug}.htm`
const gcfg = (slug, cfg) => F(cfg, '', GU(slug), { quote: `Configuration: ${cfg}`, confidence: 'secondary' })
const gmass = (slug, v, text, note) => F(v, 'kg', GU(slug), { quote: `Mass: ${text}`, confidence: 'secondary', ...(note ? { note } : {}) })
const KIT = (va) => `https://europeanspaceflight.com/wp-content/uploads/2023/11/${va}-launchkit.pdf`
const P = (x, y, z) => [x, y, z]
const Z = [0, 0, 1]

/** 型号定义：platform + cfg（comsat 参数）+ facts；shape 记示意口径。 */
function M(o) {
  const facts = { ...o.facts, shape: ILL(o.shape || '反射面口径 / 板数 / 摆位按平台典型外形示意', '', '未查到逐项原文') }
  return { id: o.id, rev: 1, family: o.family || 'geo-comsat', maker: o.maker, title: o.title, titleZh: o.titleZh || o.title, basis: o.basis, tags: ['geo', 'comsat', ...(o.tags || [])],
    aliases: o.aliases || [], massKg: facts.massKg, facts, build: (B) => comsat(B, { platform: o.platform, ...(o.cfg || {}) }) }
}

// ───────────────────────────── 特殊件 ─────────────────────────────

/** MEV 在轨延寿飞行器：背地端对接探杆 + 抓捕机构、两根电推力器指向臂、对地端小碟。 */
function mevExtra(B, { h }) {
  const g = group(B, 'mev_dock', '对接机构（探杆 + 抓捕环）', 'other')
  cyl(g.mb('aluminum'), P(0, 0, -h[2] - 0.012), P(0, 0, -h[2] - 1.1), 0.06, 16, false, true)
  cone(g.mb('titanium'), P(0, 0, -h[2] - 1.1), 0.09, P(0, 0, -h[2] - 1.3), 0.02, 16, false, true)
  for (let k = 0; k < 3; k++) {
    const t = (2 * Math.PI * k) / 3, x = 0.55 * Math.cos(t), y = 0.55 * Math.sin(t)
    truss(g.mb('titanium'), [P(x, y, -h[2] - 0.012), P(x * 0.9, y * 0.9, -h[2] - 0.55)], 0.03, 8)
  }
  g.flush()
  const gE = group(B, 'mev_ep', '电推力器指向臂', 'thruster')
  for (const s of [1, -1]) {
    truss(gE.mb('titanium'), [P(s * h[0], 0.3, -h[2] + 0.3), P(s * (h[0] + 0.9), 0.3, -h[2] - 0.2)], 0.04, 10)
    addHall(gE, { exit: P(s * (h[0] + 0.95), 0.3, -h[2] - 0.32), dir: nrm(P(s * 0.3, 0, -1)), R: 0.08, L: 0.12, bodyMat: 'dark_metal' })
  }
  gE.flush()
  B.ap('mev_probe', P(0, 0, -h[2] - 1.3), P(0, 0, -1))
}
/** Intelsat 40e 托管的 NASA TEMPO 大气成像光谱仪（对地板上的仪器盒）。 */
function tempoExtra(B, { h }) {
  instrument(B, { name: 'tempo', title: 'NASA TEMPO 光谱仪（托管载荷）', c: P(0.55, -0.55, h[2] + 0.35), size: [0.75, 0.8, 0.6], mat: 'mli_silver', aperture: { dir: Z, w: 0.3, h: 0.25, shade: 0.15 } })
}
/** ViaSat-3：对地板上馈源阵 + 东侧长臂托大网状反射面（口径未公开，示意）。 */
function viasat3Extra(B, { h }) {
  meshReflector(B, h, { name: 'ka_reflector', title: 'Ka 大型可展开网状反射面', D: 12, fd: 0.5, F: P(h[0] - 0.3, 0, h[2] + 0.7), u: P(1, 0, 0), dc: 7.5,
    style: 'astromesh', bays: 30, depth: 0.8, trussMat: 'white_paint', boomFrom: P(h[0], 0.4, h[2] - 0.6), elbow: P(h[0] + 2.0, 0.4, h[2] - 2.2), feedArray: { w: 1.4, h: 1.1 } })
}

// ───────────────────────────── 型号表 ─────────────────────────────

const HTS = { feedN: 19 }
export const GEO_COMSAT_MODELS = [
  // —— 高通量（HTS）
  M({ id: 'viasat-1', title: 'ViaSat-1', maker: 'Space Systems/Loral', platform: 'ssl1300', basis: 'SSL-1300，Ka 多波束四反射面', tags: ['hts', 'viasat'], aliases: ['VIASAT-1'],
    facts: { massKg: gmass('viasat-1', 6740, '6740 kg'), platform: gcfg('viasat-1', 'SSL-1300'),
      wing: IMG('3 + 2 侧板（挂第 2 块）', '块', 'https://www.ilslaunch.com/wp-content/uploads/2018/09/ViaSat-1-Mission-Overview-final.pdf', 'ILS 任务手册渲染：每翼根板 + 中板（两长边各挂一块侧板）+ 翼尖板，十字形') },
    cfg: { wing: { panels: 3, side: { at: 1 }, yoke: 'rod' }, refl: { E: [2.6, 2.4], W: [2.6, 2.4], ...HTS }, ep: true } }),
  M({ id: 'viasat-2', title: 'ViaSat-2', maker: 'Boeing Satellite Systems', platform: 'b702hp', basis: 'Boeing 702HP，Ka 多波束', tags: ['hts', 'viasat'], aliases: ['VIASAT-2'],
    facts: { massKg: gmass('viasat-2', 6418, '6418 kg'), platform: gcfg('viasat-2', 'BSS-702HP'),
      stowed: F([6, 3, 2], 'm', 'http://web.archive.org/web/20220214091321id_/https://www.arianespace.com/wp-content/uploads/2017/05/VA237-launchkit-EN.pdf', { quote: 'DIMENSIONS 6 m x 3 m x 2 m (stowed configuration for launch)' }),
      panels: F(6, '块', 'http://web.archive.org/web/20240624143202/https://spaceflight101.com/ariane-5-va237/viasat-2/', { quote: 'The two deployable solar arrays each have six wings', confidence: 'secondary', note: '原文 wings 指板；翼展约 48 m（同页）' }),
      span: F(48, 'm', 'http://web.archive.org/web/20240624143202/https://spaceflight101.com/ariane-5-va237/viasat-2/', { confidence: 'secondary', note: 'spaceflight101：两翼端到端约 48 m' }) },
    cfg: { span: 48, wing: { panels: 6 }, refl: { E: [2.8, 2.6], W: [2.8, 2.6], ...HTS } } }),
  M({ id: 'viasat-3', title: 'ViaSat-3', maker: 'Boeing（平台）/ Viasat（载荷）', platform: 'b702mp', basis: 'Boeing 702MP+，大型可展开网状反射面', tags: ['hts', 'viasat'], aliases: ['VIASAT-3 F1', 'VIASAT-3 F2', 'VIASAT-3 AMERICAS'],
    facts: { massKg: gmass('viasat-3', 6418, '6418 kg (#3.1); ~6400 kg (#3.2, 3.3)'), platform: gcfg('viasat-3', 'BSS-702MP+'),
      boom: F('80–90 ft', '', 'https://www.cbsnews.com/news/viasat-antenna-unfurling-problem-viasat3-broadband-satellite/', { quote: "The boom's in the range of 80 to 90 feet (long)", confidence: 'secondary', note: '臂长未按此建模（示意）' }),
      span: F(43.9, 'm', 'https://www.viasat.com/news/latest-news/corporate/2022/viasat-3-achieves-flight-configuration/', { quote: 'each featuring eight panels with an overall wingspan of 144 feet' }),
      wing: IMG('4 + 4 侧板（第 2、3 块各挂一对）', '块', 'https://www.viasat.com/content/dam/us-site/corporate/dm-images/technology/vs3/hi-res/VS3F2-Webpage-F1-Satellite-Icon-3840x2160-8556901395-001.png', 'Viasat 官方线图：每翼 4 块串联，第 2、3 块两侧各挂一块侧板（双排十字，每翼 8 块）') },
    shape: '反射面口径 / 臂长为示意', cfg: { span: 43.9, wing: { panels: 4, along: 3.8, side: { at: [1, 2] }, yoke: 'rod' }, refl: { E: [2.4], W: [2.4] }, extra: viasat3Extra } }),
  M({ id: 'jupiter-3', title: 'Jupiter 3 (EchoStar 24)', maker: 'Maxar Technologies', platform: 'ssl1300', basis: 'Maxar 1300，14 块太阳板，超大 Ka 高通量', tags: ['hts', 'hughes'], aliases: ['JUPITER 3', 'ECHOSTAR 24'],
    facts: { massKg: gmass('jupiter-3', 9200, '~9200 kg; 5817 kg (dry)'), platform: gcfg('jupiter-3', 'SSL-1300'),
      panels: F(14, '块', 'http://web.archive.org/web/2024id_/https://maxar.com/press-releases/maxar-s-largest-ever-satellite-hughes-jupiter-3-performing-well-after-launch', { quote: 'The 14 solar panels on board when fully deployed could span a 10-story building' }),
      span: F(38.7, 'm', 'https://www.hughes.com/sites/hughes.com/files/2023-06/JUPITER-3-Fact-Sheet.pdf', { quote: 'Deployed Size: Solar arrays span 127 feet' }),
      wing: IMG('5 + 2 侧板（挂第 3 块）', '块', 'https://www.hughes.com/sites/hughes.com/files/2023-06/JUPITER-3-Fact-Sheet.pdf', 'Hughes 实况表内嵌渲染：每翼长单杆轭 → 5 块串联，第 3 块两侧各挂一块侧板（每翼 7 块，共 14 块）') },
    cfg: { bus: [3.0, 3.2, 5.2], span: 38.7, wing: { panels: 5, along: 2.9, across: 2.6, side: { at: 2 }, yoke: 'rod' }, refl: { E: [3.0, 2.8], W: [3.0, 2.8], deck: [2.2], ...HTS }, ep: true } }),
  M({ id: 'echostar-19', title: 'EchoStar 19 (Jupiter 2)', maker: 'Space Systems/Loral', platform: 'ssl1300', basis: 'SSL-1300，Ka 多波束', tags: ['hts', 'hughes'], aliases: ['ECHOSTAR 19', 'JUPITER 2'],
    facts: { massKg: gmass('jupiter-2', 6637, '6637 kg'), platform: gcfg('jupiter-2', 'SSL-1300'),
      wing: IMG('3 + 2 侧板（挂第 2 块）', '块', 'http://web.archive.org/web/20161220174544/http://www.ulalaunch.com/uploads/docs/Mission_Booklets/AV/av_echostarxix_mob.pdf', 'ULA 宇宙神 5 发射手册渲染：两翼都是十字形，每侧两副反射面叠放') },
    cfg: { wing: { panels: 3, side: { at: 1 }, yoke: 'rod' }, refl: { E: [2.6, 2.4], W: [2.6, 2.4], ...HTS }, ep: true } }),
  M({ id: 'echostar-17', title: 'EchoStar 17 (Jupiter 1)', maker: 'Space Systems/Loral', platform: 'ssl1300', basis: 'SSL-1300，Ka 多波束，翼展 26.07 m', tags: ['hts', 'hughes'], aliases: ['ECHOSTAR 17', 'JUPITER 1'],
    facts: { massKg: F(6100, 'kg', KIT('VA207'), { quote: 'Total mass at lift-off 6,100 kg' }), platform: gcfg('jupiter-1', 'SSL-1300'),
      stowed: F([8.0, 3.2, 3.1], 'm', KIT('VA207'), { quote: '8.0 x 3.2 x 3.1 m at launch' }), span: F(26.07, 'm', KIT('VA207'), { quote: 'Span in orbit 26.07 m' }),
      wing: IMG('3 + 2 侧板（挂第 2 块）', '块', 'https://web.archive.org/web/20120716211541/http://www.arianespace.com/images/launch-kits/launch-kit-pdf-eng/VA207-EchoStar-XVII-MSG-3-GB.pdf', 'Arianespace VA207 手册第 7 页渲染：两翼十字形（3 块串联、中间一块两侧挂侧板）') },
    cfg: { span: 26.07, wing: { panels: 3, side: { at: 1 }, yoke: 'rod' }, refl: { E: [2.6, 2.4], W: [2.6, 2.4], ...HTS }, ep: true } }),
  M({ id: 'sky-muster', title: 'Sky Muster (NBN)', maker: 'Space Systems/Loral', platform: 'ssl1300', basis: 'SSL-1300，Ka 101 个点波束', tags: ['hts', 'nbn'], aliases: ['SKY MUSTER 1', 'SKY MUSTER 2', 'NBN1A', 'NBN1B'],
    facts: { massKg: F(6440, 'kg', KIT('VA226'), { quote: 'Mass at liftoff 6,440 kg' }), stowed: F([8.5, 3, 3.5], 'm', KIT('VA226'), { quote: 'Dimensions 8.5 x 3 x 3.5 m' }),
      wing: IMG('3 + 2 侧板（挂第 2 块）', '块', 'http://web.archive.org/web/2021im_/http://spaceflight101.com/ariane-5-va226/wp-content/uploads/sites/44/2015/09/nbnco_lrg.jpg', 'SSL 高清渲染：两翼十字形（根板、中板两侧挂侧板、翼尖板）') },
    cfg: { wing: { panels: 3, side: { at: 1 }, yoke: 'rod' }, refl: { E: [2.6, 2.4], W: [2.6, 2.4], ...HTS }, ep: true } }),
  M({ id: 'ka-sat', title: 'KA-SAT', maker: 'EADS Astrium', platform: 'e3000', basis: 'Eurostar E3000，Ka 82 个点波束四反射面', tags: ['hts', 'eutelsat'], aliases: ['EUTELSAT KA-SAT 9A', 'KA-SAT'],
    facts: { massKg: gmass('ka-sat', 6150, '6150 kg'), platform: gcfg('ka-sat', 'Eurostar-3000'),
      panelsPerWing: IMG(4, '块', 'https://space.skyrocket.de/img_sat/kasat__1.jpg', '渲染：每翼 4 块直排，第 3 块长边挂一块 ADCS 小翼') },
    cfg: { wing: { panels: 4 }, refl: { E: [2.6, 2.6], W: [2.6, 2.6], ...HTS } } }),
  M({ id: 'konnect', title: 'Eutelsat Konnect', maker: 'Thales Alenia Space', platform: 'sbneo', basis: 'Spacebus Neo 100 全电推，Ka 高通量', tags: ['hts', 'eutelsat'], aliases: ['EUTELSAT KONNECT'],
    facts: { massKg: gmass('eutelsat-konnect', 3619, '3619 kg'), platform: gcfg('eutelsat-konnect', 'Spacebus-Neo-100'),
      panelsPerWing: IMG(4, '块', 'https://www.esa.int/ESA_Multimedia/Images/2019/01/Spacebus_Neo_Eutelsat_Konnect', 'ESA 渲染：每翼 4 块直排，东西每侧两副反射面叠放') },
    cfg: { bus: [2.3, 2.5, 3.8], wing: { panels: 4, side: undefined }, refl: { E: [2.4], W: [2.4], deck: [1.6], ...HTS } } }),
  M({ id: 'konnect-vhts', title: 'Eutelsat Konnect VHTS', maker: 'Thales Alenia Space', platform: 'sbneo', basis: 'Spacebus Neo 200 全电推，500 Gbps Ka', tags: ['hts', 'eutelsat'], aliases: ['EUTELSAT KONNECT VHTS'],
    facts: { massKg: gmass('eutelsat-konnect-vhts', 6396, '6396 kg'), platform: gcfg('eutelsat-konnect-vhts', 'Spacebus-Neo-200') },
    cfg: { bus: [2.8, 3.0, 5.0], wing: { panels: 5 }, refl: { E: [2.8, 2.6], W: [2.8, 2.6], deck: [2.0], ...HTS } } }),
  M({ id: 'ses-17', title: 'SES-17', maker: 'Thales Alenia Space', platform: 'sbneo', basis: 'Spacebus Neo 200 全电推，Ka 数字载荷', tags: ['hts', 'ses'], aliases: ['SES-17'],
    facts: { massKg: gmass('ses-17', 6411, '6411 kg'), platform: gcfg('ses-17', 'Spacebus-Neo-200'),
      wing: IMG('4 + 2 侧板（挂第 3 块）', '块', 'https://commons.wikimedia.org/wiki/File:Caspk_PSTSBN_100_SBNEO_og.jpg', 'Thales 高清渲染：两翼第 3 块两侧各挂一块侧板，外侧还有一块（十字）') },
    cfg: { bus: [2.8, 3.0, 5.0], wing: { panels: 4 }, refl: { E: [2.8, 2.6], W: [2.8, 2.6], deck: [2.0], ...HTS } } }),
  M({ id: 'intelsat-epic-702mp', title: 'Intelsat EpicNG (Boeing 702MP)', titleZh: 'Intelsat EpicNG（波音 702MP：33e / 35e / 37e）', maker: 'Boeing Satellite Systems', platform: 'b702mp',
    basis: 'Boeing 702MP，C / Ku 高通量点波束', tags: ['hts', 'intelsat'], aliases: ['INTELSAT 33E', 'INTELSAT 35E', 'INTELSAT 37E', 'IS-35E', 'IS-37E'],
    facts: { massKg: F(6438, 'kg', KIT('VA239'), { rep: 'Intelsat 37e', quote: 'Mass at liftoff: 6,438 kg', note: 'IS-35e 6761 kg（Gunter）' }), platform: gcfg('intelsat-37e', 'BSS-702MP'),
      stowed: F([7.9, 3.7, 3.2], 'm', KIT('VA239'), { rep: 'Intelsat 37e', quote: 'DIMENSIONS 7.9 m x 3.7 m x 3.2 m' }) },
    cfg: { refl: { E: [2.6], W: [2.6], deck: [1.5, 1.5, 1.2] } } }),
  M({ id: 'intelsat-32e', title: 'Intelsat 32e (SKY Brasil-1)', maker: 'Airbus Defence and Space', platform: 'e3000eor', basis: 'Eurostar E3000（等离子推力器），Ku / Ka', tags: ['intelsat'], aliases: ['INTELSAT 32E', 'IS-32E', 'SKY BRASIL-1'],
    facts: { massKg: gmass('intelsat-32', 6000, '6000 kg'), platform: gcfg('intelsat-32', 'Eurostar-3000X'),
      stowed: F([7.5, 2.9, 2.3], 'm', 'http://web.archive.org/web/20170310105237id_/http://www.arianespace.com/wp-content/uploads/2017/02/VA235-launchkit.pdf', { quote: 'DIMENSIONS 7.5 m x 2.9 m x 2.3 m' }) },
    cfg: { wing: { panels: 5 }, refl: { E: [2.6, 2.4], W: [2.6, 2.4], deck: [1.4] } } }),
  M({ id: 'intelsat-40e', title: 'Intelsat 40e (TEMPO)', maker: 'Maxar Technologies', platform: 'ssl1300', basis: 'Maxar 1300，Ku / Ka + NASA TEMPO 光谱仪', tags: ['intelsat'], aliases: ['INTELSAT 40E', 'IS-40E'],
    facts: { massKg: F(5440, 'kg', 'https://en.wikipedia.org/wiki/Intelsat_40e', { quote: 'Launch mass 5,440 kg (11,990 lb)', confidence: 'tertiary' }), platform: gcfg('intelsat-40e', 'SSL-1300 (FS-1300-140)'),
      panelsPerWing: IMG(3, '块', 'https://spaceflightnow.com/wp-content/uploads/2023/04/20230405is40etempoart.jpg', 'Maxar 在轨示意图：每翼 3 块长板直排') },
    cfg: { wing: { panels: 3 }, refl: { E: [2.6], W: [2.6], deck: [1.6], feedN: 7 }, ep: true, extra: tempoExtra } }),

  // —— 固定 / 直播（FSS / DTH）与亚洲卫星
  M({ id: 'asiasat-4', title: 'AsiaSat 4', titleZh: '亚洲 4 号', maker: 'Boeing Satellite Systems', platform: 'b601hp', basis: 'Boeing 601HP', tags: ['asiasat'], aliases: ['ASIASAT 4'],
    facts: { massKg: gmass('asiasat-4', 4137, '4137 kg'), platform: gcfg('asiasat-4', 'HS-601HP'),
      panels: F(4, '块', 'http://web.archive.org/web/20020804013907/http://www.boeing.com:80/defense-space/space/bss/factsheets/601/asiasat4/asiasat4.html', { quote: 'two sun-tracking four-panel solar wings', confidence: 'secondary' }),
      span: F(26.2, 'm', 'http://web.archive.org/web/20020804013907/http://www.boeing.com:80/defense-space/space/bss/factsheets/601/asiasat4/asiasat4.html', { confidence: 'secondary', note: 'Boeing 实况表：太阳翼端到端 86 ft（26.2 m）' }) }, cfg: { span: 26.2 } }),
  M({ id: 'asiasat-5', title: 'AsiaSat 5 / 7', titleZh: '亚洲 5 号 / 7 号', maker: 'Space Systems/Loral', platform: 'ssl1300', basis: 'SSL-1300LL', tags: ['asiasat'], aliases: ['ASIASAT 5', 'ASIASAT 7'],
    facts: { massKg: gmass('asiasat-5', 3760, '3760 kg (#5); 3813 kg (#7)'), platform: gcfg('asiasat-5', 'SSL-1300LL') },
    cfg: { bus: [2.4, 2.6, 3.4], wing: { panels: 3 }, refl: { E: [2.4], W: [2.4], deck: [1.3, 1.3] } } }),
  M({ id: 'asiasat-6', title: 'AsiaSat 6', titleZh: '亚洲 6 号', maker: 'Space Systems/Loral', platform: 'ssl1300', basis: 'SSL-1300LL，每翼 3 块', tags: ['asiasat'], aliases: ['ASIASAT 6'],
    facts: { massKg: gmass('asiasat-6', 3700, '3700 kg'), platform: gcfg('asiasat-6', 'SSL-1300LL') },
    cfg: { bus: [2.4, 2.6, 3.4], wing: { panels: 3 }, refl: { E: [2.5], W: [2.5], deck: [1.3] } } }),
  M({ id: 'asiasat-8', title: 'AsiaSat 8', titleZh: '亚洲 8 号', maker: 'Space Systems/Loral', platform: 'ssl1300', basis: 'SSL-1300LL', tags: ['asiasat'], aliases: ['ASIASAT 8', 'AMOS-7'],
    facts: { massKg: gmass('asiasat-8', 4535, '4535 kg'), platform: gcfg('asiasat-8', 'SSL-1300LL'),
      panelsPerWing: IMG(4, '块', 'https://spaceflightnow.com/falcon9/011/presskit.pdf', 'SpaceX 发射手册第 17 页渲染：每翼 4 块直排') },
    cfg: { bus: [2.4, 2.6, 3.6], wing: { panels: 4 }, refl: { E: [2.5], W: [2.5], deck: [1.2] } } }),
  M({ id: 'asiasat-9', title: 'AsiaSat 9', titleZh: '亚洲 9 号', maker: 'Space Systems/Loral', platform: 'ssl1300', basis: 'SSL-1300，十字形太阳翼', tags: ['asiasat'], aliases: ['ASIASAT 9'],
    facts: { massKg: gmass('asiasat-9', 6141, '6141 kg'), platform: gcfg('asiasat-9', 'SSL-1300'),
      span: F(31.166, 'm', 'https://www.russianspaceweb.com/asiasat-9.html', { quote: 'Spacecraft dimensions when deployed: 31.166 by 9.040 meters', confidence: 'secondary' }),
      wing: IMG('4 + 2 侧板（挂第 3 块）', '块', 'http://web.archive.org/web/2024im_/http://spaceflight101.com/proton-asiasat-9/wp-content/uploads/sites/183/2017/09/AsiaSat-9-hi-res.jpg', 'SSL 官方高清渲染：每翼长单杆轭 → 4 块串联，第 3 块两长边各挂一块侧板，外侧还有一块（十字形）') },
    shape: '反射面口径示意',
    cfg: { span: 31.166, wing: { panels: 4, side: { at: 2 }, yoke: 'rod' }, refl: { E: [2.6, 2.2], W: [2.6], deck: [1.4] } } }),
  M({ id: 'astra-2e', title: 'Astra 2E / 2F / 2G', maker: 'EADS Astrium', platform: 'e3000', basis: 'Eurostar E3000', tags: ['ses', 'astra'], aliases: ['ASTRA 2E', 'ASTRA 2F', 'ASTRA 2G'],
    facts: { massKg: gmass('astra-2e', 6020, '6020 kg (#2E); 5968 kg (#2F); 6020 kg (#2G)'), platform: gcfg('astra-2e', 'Eurostar-3000') },
    cfg: { wing: { panels: 5 }, refl: { E: [2.6], W: [2.6], deck: [1.6, 1.4] } } }),
  M({ id: 'astra-1p', title: 'Astra 1P (SES-24)', maker: 'Thales Alenia Space', platform: 'sbneo', basis: 'Spacebus Neo 200', tags: ['ses', 'astra'], aliases: ['ASTRA 1P', 'SES-24'],
    facts: { massKg: gmass('astra-1p', 5000, '~5000 kg'), platform: gcfg('astra-1p', 'Spacebus-Neo-200'),
      wing: IMG('4 + 2 侧板（挂第 3 块）', '块', 'https://space.skyrocket.de/img_sat/astra-1p__1.jpg', '渲染：两翼侧板挂倒数第二块、外侧还有一块（同 SES-17）') }, cfg: {} }),
  M({ id: 'hotbird-13f', title: 'Eutelsat Hot Bird 13F / 13G', maker: 'Airbus Defence and Space', platform: 'eneo', basis: 'Eurostar Neo 全电推', tags: ['eutelsat'], aliases: ['EUTELSAT HOTBIRD 13F', 'EUTELSAT HOTBIRD 13G'],
    facts: { massKg: gmass('hotbird-13f', 4500, '4500 kg'), platform: gcfg('hotbird-13f', 'Eurostar-Neo'),
      wing: IMG('4 + 3 侧板（第 2 块两侧、第 3 块单侧）', '块', 'https://www.esa.int/var/esa/storage/images/esa_multimedia/images/2018/11/artists_impression_of_the_eutelsat_hotbird_telecommunications_satellites/18900436-1-eng-GB/Artists_impression_of_the_Eutelsat_Hotbird_telecommunications_satellites.jpg',
        'ESA 高清渲染：每翼 4 块串联，第 2 块两侧各挂一块、第 3 块单侧一块（两翼点对称），每翼 7 块') }, cfg: {} }),
  M({ id: 'ses-14', title: 'SES-14', maker: 'Airbus Defence and Space', platform: 'e3000eor', basis: 'Eurostar E3000EOR', tags: ['ses'], aliases: ['SES-14'],
    facts: { massKg: gmass('ses-14', 4423, '4423 kg'), platform: gcfg('ses-14', 'Eurostar-3000EOR'),
      panelsPerWing: IMG(5, '块', 'https://space.skyrocket.de/img_sat/ses-14_gold__1.jpg', '渲染：右翼 ≥ 5 块直排（裁切），第 4 块长边挂 ADCS 小翼') }, cfg: { wing: { panels: 5 } } }),
  M({ id: 'ses-15', title: 'SES-15', maker: 'Boeing Satellite Systems', platform: 'b702sp', basis: 'Boeing 702SP 全电推', tags: ['ses'], aliases: ['SES-15'],
    facts: { massKg: gmass('ses-15', 2302, '2302 kg'), platform: gcfg('ses-15', 'BSS-702SP') }, cfg: {} }),
  M({ id: 'intelsat-9', title: 'Intelsat 9 series (IS-902/904/905/906)', titleZh: 'Intelsat 9 系列（902 / 904 / 905 / 906）', maker: 'Space Systems/Loral', platform: 'ssl1300', basis: 'FS1300 Extended，翼展 31 m',
    tags: ['intelsat'], aliases: ['INTELSAT 902', 'INTELSAT 904', 'INTELSAT 905', 'INTELSAT 906'],
    facts: { massKg: gmass('intelsat-9', 4725, '4725 kg'), platform: gcfg('intelsat-9', 'SSL-1300HL'),
      stowed: F([2.8, 3.5, 5.56], 'm', 'http://web.archive.org/web/20081114151959id_/http://www.arianespace.com/images/launch-kits/launch-kit-pdf-eng/01_aug_30.pdf', { rep: 'Intelsat 902', quote: 'Dimensions 2,80 m x 3,50 m x 5,56 m' }),
      span: F(31, 'm', 'http://web.archive.org/web/20081114151959id_/http://www.arianespace.com/images/launch-kits/launch-kit-pdf-eng/01_aug_30.pdf', { rep: 'Intelsat 902', quote: 'Span in orbit 31 m' }) },
    cfg: { bus: [2.6, 2.8, 4.6], span: 31, refl: { E: [2.5, 2.2], W: [2.5, 2.2], deck: [1.4, 1.2] } } }),
  M({ id: 'thaicom-4', title: 'Thaicom 4 (IPSTAR)', maker: 'Space Systems/Loral', platform: 'ssl1300', basis: 'SSL-1300S，Ku / Ka 点波束，在轨 8.1 × 10.1 × 26.0 m', tags: ['thaicom', 'hts'], aliases: ['THAICOM 4', 'IPSTAR', 'IPSTAR-1'],
    facts: { massKg: F(6505, 'kg', 'http://web.archive.org/web/20081114142807id_/http://www.arianespace.com/images/launch-kits/launch-kit-pdf-eng/05_agu_11.pdf', { quote: 'Total mass at lift-off 6.505 kg' }), platform: gcfg('ipstar-1', 'SSL-1300S'),
      dims: F([8.1, 10.1, 26.0], 'm', 'http://web.archive.org/web/20081114142807id_/http://www.arianespace.com/images/launch-kits/launch-kit-pdf-eng/05_agu_11.pdf', { quote: 'in orbit 8,1 x 10,1 x 26,0 m' }),
      wing: IMG('3 + 2 侧板（挂第 2 块）', '块', 'http://web.archive.org/web/20081114142807id_/http://www.arianespace.com/images/launch-kits/launch-kit-pdf-eng/05_agu_11.pdf', 'Arianespace 166 次飞行手册第 7 页渲染：两翼十字形') },
    cfg: { bus: [2.8, 3.0, 4.6], span: 26.0, wing: { panels: 3, side: { at: 1 }, yoke: 'rod' }, refl: { E: [3.4, 3.0], W: [3.4, 3.0], deck: [2.0, 2.0], ...HTS } } }),
  M({ id: 'turksat-5a', title: 'Türksat 5A', maker: 'Airbus Defence and Space', platform: 'e3000eor', basis: 'Eurostar E3000EOR', tags: ['turksat'], aliases: ['TURKSAT 5A'],
    facts: { massKg: gmass('turksat-5a', 3500, '3500 kg'), platform: gcfg('turksat-5a', 'Eurostar-3000EOR'),
      panelsPerWing: IMG(5, '块', 'https://space.skyrocket.de/img_sat/turksat-5a__2.jpg', '渲染：两翼各 5 块直排，一块 ADCS 小翼') }, cfg: { wing: { panels: 5 } } }),
  M({ id: 'turksat-5b', title: 'Türksat 5B', maker: 'Airbus Defence and Space', platform: 'e3000eor', basis: 'Eurostar E3000EOR，Ka 高通量', tags: ['turksat', 'hts'], aliases: ['TURKSAT 5B'],
    facts: { massKg: gmass('turksat-5b', 4500, '4500 kg'), platform: gcfg('turksat-5b', 'Eurostar-3000EOR') }, cfg: { refl: { E: [2.6], W: [2.6], deck: [1.5], ...HTS } } }),
  M({ id: 'mev', title: 'Mission Extension Vehicle (MEV-1 / MEV-2)', titleZh: '在轨延寿飞行器 MEV', maker: 'Northrop Grumman', platform: 'geostar', basis: 'GEOStar 平台，对接探杆 + 电推指向臂', tags: ['servicing'], aliases: ['MEV-1', 'MEV-2'],
    facts: { massKg: gmass('mev-1', 2326, '2326 kg (#1); 2875 kg (#2)'), platform: gcfg('mev-1', 'GEOStar-3') }, shape: '对接机构与电推臂按公开渲染示意',
    cfg: { wing: { panels: 5 }, refl: false, extra: (B, body) => mevExtra(B, body) } }),

  // —— 东方红四号 / 四号增强型平台（出口星）
  M({ id: 'dfh4', title: 'DFH-4 platform', titleZh: '东方红四号平台', maker: '中国空间技术研究院（CAST）', platform: 'dfh4', basis: '本体 2360 × 2100 × 3600 mm，出口星外形', tags: ['dfh4'],
    aliases: ['DFH-4', 'BELINTERSAT-1', 'LAOSAT 1', 'TKSAT-1', 'NIGCOMSAT 1R', 'ALCOMSAT 1'],
    facts: { massKg: gmass('nigcomsat-1', 5150, '5150 kg', '代表星 NigComSat-1R；Belintersat-1 5223 kg、Alcomsat-1 5225 kg、LaoSat-1（DFH-4S）5086 kg（Gunter）'),
      bus: F([2.36, 2.1, 3.6], 'm', 'https://www.cast.cn/news/2881', { quote: '尺寸：2360mm×2100mm×3600mm' }),
      platform: gcfg('belintersat-1', 'DFH-4 Bus') }, shape: '每翼板数与反射面口径按 CGWIC / CAST 官方图示意',
    cfg: {} }),
  M({ id: 'dfh4e', title: 'DFH-4E platform', titleZh: '东方红四号增强型平台', maker: '中国空间技术研究院（CAST）', platform: 'dfh4e', basis: '每翼 4 块 3.30 × 2.36 m，电推进，每侧双天线重叠', tags: ['dfh4'],
    aliases: ['DFH-4E', 'PAKSAT-MM1'],
    facts: { massKg: gmass('paksat-mm-1r', 5400, '5400 kg', '代表星 PakSat-MM1'), platform: gcfg('paksat-mm-1r', 'DFH-4E Bus'),
      panels: F({ n: 4, size: [3.3, 2.36] }, 'm', 'https://www.engineering.org.cn/engi/CN/10.1016/j.eng.2022.04.013', { quote: '1D, four solar panels 4 3.30 × 2.36 13.5' }),
      features: F('电推进、双天线重叠压紧和展开', '', 'https://cast.cn/news/2884', { quote: '采用电推进、大功率供配电、多层通信舱、大承载结构、通信舱高效热控、双天线重叠压紧和展开多项新技术' }) },
    shape: '本体尺寸 CAST 未公布（示意）；反射面口径示意', cfg: {} })
]
