// SATCAT 代码表构建：CelesTrak 三张代码页 → src/shared/satcatCodes.js（生成物提交进仓库，运行时不联网）。
//
// 为什么生成而不是运行时抓：代码表一年动不了几次（新增一个发射场 / 一个国家首次发星），
// 而空间态势报告每次生成都要把上万行的 OWNER / LAUNCH_SITE 代码翻成人看得懂的名字 ——
// 这是查表，不是取数。取数（SATCAT 本身）走 omm.js 的四级众包链路，代码表跟着安装包走。
//
// 数据源（2026-09-16 实测，均 200；CelesTrak 认 satsim 自己的 UA，无需伪装浏览器）
//   所有者    https://celestrak.org/satcat/sources.php       132 条  <tr align=center><td>CODE</td><td>NAME</td></tr>
//   发射场    https://celestrak.org/satcat/launchsites.php    41 条  代码包在 <a href="javascript:openmap(…)"> 里
//   运行状态  https://celestrak.org/satcat/status.php          8 条  第二列 <br><i>…</i> 是补充说明，只取 <br> 前的正名
//   字段定义  https://celestrak.org/satcat/satcat-format.php         OBJECT_TYPE / ORBIT_TYPE / DATA_STATUS_CODE
//             这三张是封闭小集合（4 / 5 / 3 项），页面是散文不是表格，故在本文件里写死并注明出处。
//
// ★ 上游表不全：satcat.csv 里实际出现的 OWNER 有 4 个不在 sources.php 里（JOR / KWT / SVK / UGA
//   —— 约旦 / 科威特 / 斯洛伐克 / 乌干达，都是近年首次发星的国家，CelesTrak 的页面没跟上）。
//   补在 MANUAL_OWNER 里，并由 satcatCodes.test.mjs 扫真实快照兜底：未命中代码数必须为 0。
//
// ★ 主权口径与平台一致（见 src/viz/globe3d/data/frozen.js 的台港澳红线、词典已删「中华民国」）：
//   涉台港澳的代码中文名一律「中国台湾 / 中国香港 / 中国澳门」，英文 `Taiwan, China` 等 ——
//   SOVEREIGN_OVERRIDE 在这里改名，统计仍按 SATCAT 原代码分行，不合并、不改数。
//
// 用法  node scripts/build-satcat-codes.mjs [--offline <目录>]
//   --offline 从本地已存的三张 html 读（离线重跑 / 复核用），缺省联网抓。

import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'src', 'shared', 'satcatCodes.js')

const PAGES = {
  owner: 'https://celestrak.org/satcat/sources.php',
  site: 'https://celestrak.org/satcat/launchsites.php',
  status: 'https://celestrak.org/satcat/status.php'
}

// ——————————————————————————————————————————————————————————————
// 中文名（手工，标准译名）。国家取通行国名，机构保留简称：「全称（简称）」。
// 多国联署的代码（CHBZ / FGER / …）用「/」连，与英文原表一致。
// ——————————————————————————————————————————————————————————————
const ZH_OWNER = {
  AB: '阿拉伯卫星通信组织（ARABSAT）', ABS: '亚洲广播卫星公司（ABS）',
  AC: '亚洲卫星通信公司（AsiaSat）', ALG: '阿尔及利亚', ANG: '安哥拉', ARGN: '阿根廷',
  ARM: '亚美尼亚', ASRA: '奥地利', AUS: '澳大利亚', AZER: '阿塞拜疆', BEL: '比利时',
  BELA: '白俄罗斯', BERM: '百慕大', BGD: '孟加拉国', BHR: '巴林', BHUT: '不丹',
  BOL: '玻利维亚', BRAZ: '巴西', BUL: '保加利亚', BWA: '博茨瓦纳', CA: '加拿大',
  CHBZ: '中国/巴西', CHTU: '中国/土耳其', CHLE: '智利',
  CIS: '独立国家联合体（原苏联）', COL: '哥伦比亚', CRI: '哥斯达黎加',
  CZCH: '捷克（原捷克斯洛伐克）', DEN: '丹麦', DJI: '吉布提', ECU: '厄瓜多尔',
  EGYP: '埃及', ESA: '欧洲空间局（ESA）', ESRO: '欧洲空间研究组织（ESRO）',
  EST: '爱沙尼亚', ETH: '埃塞俄比亚', EUME: '欧洲气象卫星应用组织（EUMETSAT）',
  EUTE: '欧洲通信卫星组织（EUTELSAT）', FGER: '法国/德国', FIN: '芬兰', FR: '法国',
  FRIT: '法国/意大利', GER: '德国', GHA: '加纳', GLOB: '全球星公司（Globalstar）',
  GREC: '希腊', GRSA: '希腊/沙特阿拉伯', GUAT: '危地马拉', HRV: '克罗地亚',
  HUN: '匈牙利', IM: '国际移动卫星组织（Inmarsat）', IND: '印度', INDO: '印度尼西亚',
  IRAN: '伊朗', IRAQ: '伊拉克', IRID: '铱星公司（Iridium）', IRL: '爱尔兰',
  ISRA: '以色列', ISRO: '印度空间研究组织（ISRO）', ISS: '国际空间站', IT: '意大利',
  ITSO: '国际通信卫星组织（Intelsat）', JOR: '约旦', JPN: '日本', KAZ: '哈萨克斯坦',
  KEN: '肯尼亚', KWT: '科威特', LAOS: '老挝', LKA: '斯里兰卡', LTU: '立陶宛',
  LUXE: '卢森堡', MA: '摩洛哥', MALA: '马来西亚', MCO: '摩纳哥', MDA: '摩尔多瓦',
  MEX: '墨西哥', MMR: '缅甸', MNE: '黑山', MNG: '蒙古', MUS: '毛里求斯',
  NATO: '北大西洋公约组织（NATO）', NETH: '荷兰', NICO: '新 ICO 公司（New ICO）',
  NIG: '尼日利亚', NKOR: '朝鲜', NOR: '挪威', NPL: '尼泊尔', NZ: '新西兰',
  O3B: 'O3b 网络公司', ORB: '轨道通信公司（ORBCOMM）', PAKI: '巴基斯坦', PERU: '秘鲁',
  POL: '波兰', POR: '葡萄牙', PRC: '中国', PRY: '巴拉圭', PRES: '中国/欧洲空间局',
  QAT: '卡塔尔', RASC: '泛非卫星通信公司（RascomStar-QAF）', ROC: '中国台湾',
  ROM: '罗马尼亚', RP: '菲律宾', RWA: '卢旺达', SAFR: '南非', SAUD: '沙特阿拉伯',
  SDN: '苏丹', SEAL: '海上发射公司（Sea Launch）', SEN: '塞内加尔', SES: 'SES 公司',
  SGJP: '新加坡/日本', SING: '新加坡', SKOR: '韩国', SLB: '所罗门群岛', SPN: '西班牙',
  STCT: '新加坡/中国台湾', SVK: '斯洛伐克', SVN: '斯洛文尼亚', SWED: '瑞典',
  SWTZ: '瑞士', TBD: '待定', THAI: '泰国', TMMC: '土库曼斯坦/摩纳哥', TUN: '突尼斯',
  TURK: '土耳其', UAE: '阿拉伯联合酋长国', UGA: '乌干达', UK: '英国', UKR: '乌克兰',
  UNK: '未知', URY: '乌拉圭', US: '美国', USBZ: '美国/巴西', VAT: '梵蒂冈',
  VENZ: '委内瑞拉', VTNM: '越南', ZWE: '津巴布韦'
}

const ZH_SITE = {
  AFETR: '美国空军东部试验场（佛罗里达，美国）',
  AFWTR: '美国空军西部试验场（加利福尼亚，美国）',
  ALCLC: '阿尔坎塔拉发射中心（马拉尼昂，巴西）',
  ANDSP: '安德亚航天发射场（诺尔兰，挪威）',
  BOS: '鲍恩轨道发射场（昆士兰，澳大利亚）',
  CAS: '加那利空域',
  DLS: '栋巴罗夫斯基发射场（俄罗斯）',
  ERAS: '东部靶场空域',
  FRGUI: '圭亚那航天中心（库鲁，法属圭亚那）',
  HGSTR: '哈马吉尔航天测控靶场（阿尔及利亚）',
  JJSLA: '济州岛海上发射区（韩国）',
  JSC: '酒泉卫星发射中心（中国）',
  KODAK: '科迪亚克发射场（阿拉斯加，美国）',
  KSCUT: '内之浦宇宙空间观测所（日本）',
  KWAJ: '美国陆军夸贾林环礁靶场（USAKA）',
  KYMSC: '卡普斯京亚尔导弹与航天发射场（俄罗斯）',
  NSC: '罗老宇航中心（韩国）',
  PLMSC: '普列谢茨克导弹与航天发射场（俄罗斯）',
  RLLB: '火箭实验室发射场（马希亚半岛，新西兰）',
  SCSLA: '南海海上发射区（中国）',
  SEAL: '海上发射平台（移动）',
  SEMLS: '塞姆南卫星发射场（伊朗）',
  SMTS: '沙赫鲁德导弹试验场（伊朗）',
  SNMLP: '圣马科发射平台（印度洋，肯尼亚）',
  SPKII: '纪伊航天港（日本）',
  SRILR: '萨迪什·达万航天中心（印度）',
  SUBL: '潜艇发射平台（移动）',
  SVOBO: '斯沃博德内发射场（俄罗斯）',
  TAISC: '太原卫星发射中心（中国）',
  TANSC: '种子岛宇宙中心（日本）',
  TYMSC: '丘拉塔姆导弹与航天中心（拜科努尔，哈萨克斯坦）',
  UNK: '未知',
  VOSTO: '东方航天发射场（俄罗斯）',
  WLPIS: '瓦勒普斯岛（弗吉尼亚，美国）',
  WOMRA: '伍默拉（澳大利亚）',
  WRAS: '西部靶场空域',
  WSC: '文昌航天发射场（中国）',
  XICLF: '西昌卫星发射中心（中国）',
  YAVNE: '亚夫内发射场（以色列）',
  YSLA: '黄海海上发射区（中国）',
  YUN: '云松发射场（朝鲜）'
}

const ZH_STATUS = {
  '+': '运行', '-': '停运', P: '部分运行', B: '备份', S: '备用',
  X: '延寿', D: '已陨落', '?': '未知'
}

// ★ 主权口径：上游英文名在这里一并改掉（中文由 ZH_OWNER 直接给对）。
const SOVEREIGN_OVERRIDE = {
  ROC: { en: 'Taiwan, China' },
  STCT: { en: 'Singapore/Taiwan, China' }
}

// ★ sources.php 未收录、但 satcat.csv 里实际在用的所有者代码（2026-09-16 实测缺这 4 个）。
const MANUAL_OWNER = {
  JOR: 'Jordan', KWT: 'Kuwait', SVK: 'Slovakia', UGA: 'Uganda'
}

// satcat-format.php 的封闭小集合，页面是散文不是表格，写死在这里。
const OBJECT_TYPE = {
  PAY: { en: 'Payload', zh: '载荷' },
  'R/B': { en: 'Rocket body', zh: '火箭体' },
  DEB: { en: 'Debris', zh: '碎片' },
  UNK: { en: 'Unknown', zh: '未知' }
}
const ORBIT_TYPE = {
  ORB: { en: 'Orbiting', zh: '在轨' },
  LAN: { en: 'Landed', zh: '着陆' },
  IMP: { en: 'Impacted', zh: '撞击或再入' },
  DOC: { en: 'Docked', zh: '停靠' },
  'R/T': { en: 'Roundtrip', zh: '往返' }
}
const DATA_STATUS = {
  NCE: { en: 'No current elements', zh: '无当前根数' },
  NIE: { en: 'No initial elements', zh: '无初始根数' },
  NEA: { en: 'No elements available', zh: '根数不公开' }
}
// ORBIT_CENTER 非地球时的天体代码（satcat-format.php）。纯数字 = 停靠母体的 NORAD 号，不在表内。
const ORBIT_CENTER = {
  EA: { en: 'Earth', zh: '地球' },
  EL: { en: 'Earth-Moon libration point', zh: '地月平动点' },
  EL1: { en: 'Earth-Sun L1', zh: '日地 L1 点' },
  EL2: { en: 'Earth-Sun L2', zh: '日地 L2 点' },
  EM: { en: 'Earth-Moon barycenter', zh: '地月系' },
  SU: { en: 'Sun', zh: '太阳' },
  ME: { en: 'Mercury', zh: '水星' },
  VE: { en: 'Venus', zh: '金星' },
  MO: { en: 'Moon', zh: '月球' },
  MA: { en: 'Mars', zh: '火星' },
  AS: { en: 'Asteroid', zh: '小行星' },
  JU: { en: 'Jupiter', zh: '木星' },
  SA: { en: 'Saturn', zh: '土星' },
  SS: { en: 'Solar system escape', zh: '飞出太阳系' }
}

// ——————————————————————————————————————————————————————————————

function get (url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 30000, headers: { 'User-Agent': 'satsim-snapshot' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`${url} → HTTP ${res.statusCode}`)); return }
      const bufs = []
      res.on('data', (b) => bufs.push(b))
      res.on('end', () => resolve(Buffer.concat(bufs).toString('utf8')))
    })
    req.on('timeout', () => { req.destroy(new Error('超时')) })
    req.on('error', reject)
  })
}

// CelesTrak 的两张表里带重音的拉丁字母全是命名实体（T&uuml;rkiye / And&oslash;ya / …）。
// ★ 未命中的实体绝不能原样留下 —— 生成物直接进英文报告，纸上就会印出 `T&uuml;rkiye`。
//   故：① 常见拉丁实体逐条收全；② 收不到的用 DOMParser 兜不住（Node 里没有），改为
//   命中失败即抛错，把漏网的实体名打出来，逼着在这里补一条，而不是静默带病生成。
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–',
  // 元音变音 / 带撇 / 带抑扬符（德 / 法 / 西 / 葡 / 北欧）
  auml: 'ä', euml: 'ë', iuml: 'ï', ouml: 'ö', uuml: 'ü', yuml: 'ÿ',
  Auml: 'Ä', Euml: 'Ë', Iuml: 'Ï', Ouml: 'Ö', Uuml: 'Ü',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', yacute: 'ý',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  agrave: 'à', egrave: 'è', igrave: 'ì', ograve: 'ò', ugrave: 'ù',
  Agrave: 'À', Egrave: 'È', Igrave: 'Ì', Ograve: 'Ò', Ugrave: 'Ù',
  acirc: 'â', ecirc: 'ê', icirc: 'î', ocirc: 'ô', ucirc: 'û',
  Acirc: 'Â', Ecirc: 'Ê', Icirc: 'Î', Ocirc: 'Ô', Ucirc: 'Û',
  atilde: 'ã', ntilde: 'ñ', otilde: 'õ', Atilde: 'Ã', Ntilde: 'Ñ', Otilde: 'Õ',
  aring: 'å', Aring: 'Å', aelig: 'æ', AElig: 'Æ', oslash: 'ø', Oslash: 'Ø',
  ccedil: 'ç', Ccedil: 'Ç', szlig: 'ß', eth: 'ð', ETH: 'Ð', thorn: 'þ', THORN: 'Þ',
  // 标点与符号
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  hellip: '…', deg: '°', middot: '·', times: '×', reg: '®', copy: '©', trade: '™'
}
const missedEntities = new Set()
function unescapeHtml (s) {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, n) => {
      if (n in ENTITIES) return ENTITIES[n]
      const low = n.toLowerCase()
      if (low in ENTITIES) return ENTITIES[low]
      missedEntities.add(n)
      return m
    })
}

// 两列表格 → { code: name }。
//   keepBreak=false（sources / launchsites）：<br> 是名字里的折行，换成空格。
//   keepBreak=true （status）：<br> 之后是斜体补充说明，整段丢掉，只留正名。
function parseTwoColTable (html, { cutAtBreak = false } = {}) {
  const out = {}
  for (const [, tr] of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1])
    if (tds.length !== 2) continue
    const code = unescapeHtml(tds[0].replace(/<[^>]+>/g, '')).trim()
    let cell = tds[1]
    if (cutAtBreak) cell = cell.split(/<br\s*\/?>/i)[0]
    else cell = cell.replace(/<br\s*\/?>/gi, ' ')
    const name = unescapeHtml(cell.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
    if (code && name) out[code] = name
  }
  return out
}

function esc (s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") }
function keyOf (k) { return /^[A-Za-z_$][\w$]*$/.test(k) ? k : `'${esc(k)}'` }

function emitTable (name, obj) {
  const lines = Object.keys(obj).sort().map((k) => {
    const v = obj[k]
    return `  ${keyOf(k)}: { en: '${esc(v.en)}', zh: '${esc(v.zh)}' }`
  })
  return `export const ${name} = {\n${lines.join(',\n')}\n}\n`
}

async function main () {
  const offlineAt = process.argv.includes('--offline')
    ? process.argv[process.argv.indexOf('--offline') + 1]
    : null
  const read = async (which, file) => (offlineAt
    ? fs.readFileSync(path.join(offlineAt, file), 'utf8')
    : get(PAGES[which]))

  const ownerHtml = await read('owner', 'sources.html')
  const siteHtml = await read('site', 'launchsites.html')
  const statusHtml = await read('status', 'status.html')

  const ownerEn = { ...parseTwoColTable(ownerHtml), ...MANUAL_OWNER }
  const siteEn = parseTwoColTable(siteHtml)
  const statusEn = parseTwoColTable(statusHtml, { cutAtBreak: true })

  if (Object.keys(ownerEn).length < 100) throw new Error(`所有者表只解析出 ${Object.keys(ownerEn).length} 条，页面结构可能变了`)
  if (Object.keys(siteEn).length < 30) throw new Error(`发射场表只解析出 ${Object.keys(siteEn).length} 条，页面结构可能变了`)
  if (Object.keys(statusEn).length !== 8) throw new Error(`状态表解析出 ${Object.keys(statusEn).length} 条（应为 8）`)

  const merge = (en, zh, label) => {
    const out = {}
    const missing = []
    for (const [code, name] of Object.entries(en)) {
      const ov = SOVEREIGN_OVERRIDE[code] || {}
      if (!zh[code]) missing.push(code)
      out[code] = { en: ov.en || name, zh: zh[code] || ov.en || name }
    }
    if (missing.length) console.warn(`  ⚠ ${label} 缺中文名：${missing.join(' ')}`)
    return out
  }

  const OWNER = merge(ownerEn, ZH_OWNER, '所有者')
  const LAUNCH_SITE = merge(siteEn, ZH_SITE, '发射场')
  const OPS_STATUS = merge(statusEn, ZH_STATUS, '运行状态')

  // 有一个实体没解码就停：生成物直接进英文报告，`T&uuml;rkiye` 上了纸才发现太晚
  if (missedEntities.size) throw new Error(`有未收录的 HTML 实体：${[...missedEntities].join(' ')} —— 补进 ENTITIES 再重跑`)

  const stamp = new Date().toISOString().slice(0, 10)
  const body = `// SATCAT 代码表 —— 由 scripts/build-satcat-codes.mjs 生成，请勿手改。
// 生成日期 ${stamp}。源：celestrak.org/satcat 的 sources.php / launchsites.php / status.php，
// 以及 satcat-format.php 的字段定义（OBJECT_TYPE / ORBIT_TYPE / DATA_STATUS_CODE / ORBIT_CENTER）。
// 中文名、主权口径改写、上游漏收的 4 个所有者代码都在生成脚本里，改名改那里再重跑。
//
// 用法：\`ownerName(code, lang)\` 一类查不到时原样回退代码本身 —— 报告里不留空。

${emitTable('OWNER', OWNER)}
${emitTable('LAUNCH_SITE', LAUNCH_SITE)}
${emitTable('OPS_STATUS', OPS_STATUS)}
${emitTable('OBJECT_TYPE', OBJECT_TYPE)}
${emitTable('ORBIT_TYPE', ORBIT_TYPE)}
${emitTable('DATA_STATUS', DATA_STATUS)}
${emitTable('ORBIT_CENTER', ORBIT_CENTER)}
// ★ 活跃载荷判据用的状态码集合（CelesTrak status.php：运行 / 部分运行 / 备份 / 备用 / 延寿）。
export const ACTIVE_STATUS = ['+', 'P', 'B', 'S', 'X']

const pick = (table) => (code, lang) => {
  const k = String(code == null ? '' : code).trim()
  const hit = table[k]
  if (!hit) return k
  return lang === 'en' ? hit.en : hit.zh
}

export const ownerName = pick(OWNER)
export const launchSiteName = pick(LAUNCH_SITE)
export const opsStatusName = pick(OPS_STATUS)
export const objectTypeName = pick(OBJECT_TYPE)
export const orbitTypeName = pick(ORBIT_TYPE)
export const dataStatusName = pick(DATA_STATUS)

// ORBIT_CENTER 特殊：纯数字是停靠母体的 NORAD 号，不是天体代码 —— 原样回退（上层会拿它去编目里查名字）。
export const orbitCenterName = pick(ORBIT_CENTER)
`
  fs.writeFileSync(OUT, body.replace(/\r?\n/g, '\n'), 'utf8')
  console.log(`✓ ${path.relative(ROOT, OUT)}`)
  console.log(`  所有者 ${Object.keys(OWNER).length} · 发射场 ${Object.keys(LAUNCH_SITE).length} · 状态 ${Object.keys(OPS_STATUS).length}`)
}

main().catch((e) => { console.error('✗', e.message); process.exit(1) })
