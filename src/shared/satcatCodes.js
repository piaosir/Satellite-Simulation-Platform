// SATCAT 代码表 —— 由 scripts/build-satcat-codes.mjs 生成，请勿手改。
// 生成日期 2026-09-16。源：celestrak.org/satcat 的 sources.php / launchsites.php / status.php，
// 以及 satcat-format.php 的字段定义（OBJECT_TYPE / ORBIT_TYPE / DATA_STATUS_CODE / ORBIT_CENTER）。
// 中文名、主权口径改写、上游漏收的 4 个所有者代码都在生成脚本里，改名改那里再重跑。
//
// 用法：`ownerName(code, lang)` 一类查不到时原样回退代码本身 —— 报告里不留空。

export const OWNER = {
  AB: { en: 'Arab Satellite Communications Organization', zh: '阿拉伯卫星通信组织（ARABSAT）' },
  ABS: { en: 'Asia Broadcast Satellite', zh: '亚洲广播卫星公司（ABS）' },
  AC: { en: 'Asia Satellite Telecommunications Company (ASIASAT)', zh: '亚洲卫星通信公司（AsiaSat）' },
  ALG: { en: 'Algeria', zh: '阿尔及利亚' },
  ANG: { en: 'Angola', zh: '安哥拉' },
  ARGN: { en: 'Argentina', zh: '阿根廷' },
  ARM: { en: 'Republic of Armenia', zh: '亚美尼亚' },
  ASRA: { en: 'Austria', zh: '奥地利' },
  AUS: { en: 'Australia', zh: '澳大利亚' },
  AZER: { en: 'Azerbaijan', zh: '阿塞拜疆' },
  BEL: { en: 'Belgium', zh: '比利时' },
  BELA: { en: 'Belarus', zh: '白俄罗斯' },
  BERM: { en: 'Bermuda', zh: '百慕大' },
  BGD: { en: 'Peoples Republic of Bangladesh', zh: '孟加拉国' },
  BHR: { en: 'The Kingdom of Bahrain', zh: '巴林' },
  BHUT: { en: 'The Kingdom of Bhutan', zh: '不丹' },
  BOL: { en: 'Bolivia', zh: '玻利维亚' },
  BRAZ: { en: 'Brazil', zh: '巴西' },
  BUL: { en: 'Bulgaria', zh: '保加利亚' },
  BWA: { en: 'Republic of Botswana', zh: '博茨瓦纳' },
  CA: { en: 'Canada', zh: '加拿大' },
  CHBZ: { en: 'China/Brazil', zh: '中国/巴西' },
  CHLE: { en: 'Chile', zh: '智利' },
  CHTU: { en: 'China/Türkiye', zh: '中国/土耳其' },
  CIS: { en: 'Commonwealth of Independent States (former USSR)', zh: '独立国家联合体（原苏联）' },
  COL: { en: 'Colombia', zh: '哥伦比亚' },
  CRI: { en: 'Republic of Costa Rica', zh: '哥斯达黎加' },
  CZCH: { en: 'Czech Republic (former Czechoslovakia)', zh: '捷克（原捷克斯洛伐克）' },
  DEN: { en: 'Denmark', zh: '丹麦' },
  DJI: { en: 'Republic of Djibouti', zh: '吉布提' },
  ECU: { en: 'Ecuador', zh: '厄瓜多尔' },
  EGYP: { en: 'Egypt', zh: '埃及' },
  ESA: { en: 'European Space Agency', zh: '欧洲空间局（ESA）' },
  ESRO: { en: 'European Space Research Organization', zh: '欧洲空间研究组织（ESRO）' },
  EST: { en: 'Estonia', zh: '爱沙尼亚' },
  ETH: { en: 'Ethiopia', zh: '埃塞俄比亚' },
  EUME: { en: 'European Organization for the Exploitation of Meteorological Satellites (EUMETSAT)', zh: '欧洲气象卫星应用组织（EUMETSAT）' },
  EUTE: { en: 'European Telecommunications Satellite Organization (EUTELSAT)', zh: '欧洲通信卫星组织（EUTELSAT）' },
  FGER: { en: 'France/Germany', zh: '法国/德国' },
  FIN: { en: 'Finland', zh: '芬兰' },
  FR: { en: 'France', zh: '法国' },
  FRIT: { en: 'France/Italy', zh: '法国/意大利' },
  GER: { en: 'Germany', zh: '德国' },
  GHA: { en: 'Republic of Ghana', zh: '加纳' },
  GLOB: { en: 'Globalstar', zh: '全球星公司（Globalstar）' },
  GREC: { en: 'Greece', zh: '希腊' },
  GRSA: { en: 'Greece/Saudi Arabia', zh: '希腊/沙特阿拉伯' },
  GUAT: { en: 'Guatemala', zh: '危地马拉' },
  HRV: { en: 'Republic of Croatia', zh: '克罗地亚' },
  HUN: { en: 'Hungary', zh: '匈牙利' },
  IM: { en: 'International Mobile Satellite Organization (INMARSAT)', zh: '国际移动卫星组织（Inmarsat）' },
  IND: { en: 'India', zh: '印度' },
  INDO: { en: 'Indonesia', zh: '印度尼西亚' },
  IRAN: { en: 'Iran', zh: '伊朗' },
  IRAQ: { en: 'Iraq', zh: '伊拉克' },
  IRID: { en: 'Iridium', zh: '铱星公司（Iridium）' },
  IRL: { en: 'Ireland', zh: '爱尔兰' },
  ISRA: { en: 'Israel', zh: '以色列' },
  ISRO: { en: 'Indian Space Research Organisation', zh: '印度空间研究组织（ISRO）' },
  ISS: { en: 'International Space Station', zh: '国际空间站' },
  IT: { en: 'Italy', zh: '意大利' },
  ITSO: { en: 'International Telecommunications Satellite Organization (INTELSAT)', zh: '国际通信卫星组织（Intelsat）' },
  JOR: { en: 'Jordan', zh: '约旦' },
  JPN: { en: 'Japan', zh: '日本' },
  KAZ: { en: 'Kazakhstan', zh: '哈萨克斯坦' },
  KEN: { en: 'Republic of Kenya', zh: '肯尼亚' },
  KWT: { en: 'Kuwait', zh: '科威特' },
  LAOS: { en: 'Laos', zh: '老挝' },
  LKA: { en: 'Democratic Socialist Republic of Sri Lanka', zh: '斯里兰卡' },
  LTU: { en: 'Lithuania', zh: '立陶宛' },
  LUXE: { en: 'Luxembourg', zh: '卢森堡' },
  MA: { en: 'Morroco', zh: '摩洛哥' },
  MALA: { en: 'Malaysia', zh: '马来西亚' },
  MCO: { en: 'Principality of Monaco', zh: '摩纳哥' },
  MDA: { en: 'Republic of Moldova', zh: '摩尔多瓦' },
  MEX: { en: 'Mexico', zh: '墨西哥' },
  MMR: { en: 'Republic of the Union of Myanmar', zh: '缅甸' },
  MNE: { en: 'Montenegro', zh: '黑山' },
  MNG: { en: 'Mongolia', zh: '蒙古' },
  MUS: { en: 'Mauritius', zh: '毛里求斯' },
  NATO: { en: 'North Atlantic Treaty Organization', zh: '北大西洋公约组织（NATO）' },
  NETH: { en: 'Netherlands', zh: '荷兰' },
  NICO: { en: 'New ICO', zh: '新 ICO 公司（New ICO）' },
  NIG: { en: 'Nigeria', zh: '尼日利亚' },
  NKOR: { en: 'Democratic People\'s Republic of Korea', zh: '朝鲜' },
  NOR: { en: 'Norway', zh: '挪威' },
  NPL: { en: 'Federal Democratic Republic of Nepal', zh: '尼泊尔' },
  NZ: { en: 'New Zealand', zh: '新西兰' },
  O3B: { en: 'O3b Networks', zh: 'O3b 网络公司' },
  ORB: { en: 'ORBCOMM', zh: '轨道通信公司（ORBCOMM）' },
  PAKI: { en: 'Pakistan', zh: '巴基斯坦' },
  PERU: { en: 'Peru', zh: '秘鲁' },
  POL: { en: 'Poland', zh: '波兰' },
  POR: { en: 'Portugal', zh: '葡萄牙' },
  PRC: { en: 'People\'s Republic of China', zh: '中国' },
  PRES: { en: 'People\'s Republic of China/European Space Agency', zh: '中国/欧洲空间局' },
  PRY: { en: 'Republic of Paraguay', zh: '巴拉圭' },
  QAT: { en: 'State of Qatar', zh: '卡塔尔' },
  RASC: { en: 'RascomStar-QAF', zh: '泛非卫星通信公司（RascomStar-QAF）' },
  ROC: { en: 'Taiwan, China', zh: '中国台湾' },
  ROM: { en: 'Romania', zh: '罗马尼亚' },
  RP: { en: 'Philippines (Republic of the Philippines)', zh: '菲律宾' },
  RWA: { en: 'Republic of Rwanda', zh: '卢旺达' },
  SAFR: { en: 'South Africa', zh: '南非' },
  SAUD: { en: 'Saudi Arabia', zh: '沙特阿拉伯' },
  SDN: { en: 'Republic of Sudan', zh: '苏丹' },
  SEAL: { en: 'Sea Launch', zh: '海上发射公司（Sea Launch）' },
  SEN: { en: 'Republic of Senegal', zh: '塞内加尔' },
  SES: { en: 'SES', zh: 'SES 公司' },
  SGJP: { en: 'Singapore/Japan', zh: '新加坡/日本' },
  SING: { en: 'Singapore', zh: '新加坡' },
  SKOR: { en: 'Republic of Korea', zh: '韩国' },
  SLB: { en: 'Solomon Islands', zh: '所罗门群岛' },
  SPN: { en: 'Spain', zh: '西班牙' },
  STCT: { en: 'Singapore/Taiwan, China', zh: '新加坡/中国台湾' },
  SVK: { en: 'Slovakia', zh: '斯洛伐克' },
  SVN: { en: 'Slovenia', zh: '斯洛文尼亚' },
  SWED: { en: 'Sweden', zh: '瑞典' },
  SWTZ: { en: 'Switzerland', zh: '瑞士' },
  TBD: { en: 'To Be Determined', zh: '待定' },
  THAI: { en: 'Thailand', zh: '泰国' },
  TMMC: { en: 'Turkmenistan/Monaco', zh: '土库曼斯坦/摩纳哥' },
  TUN: { en: 'Republic of Tunisia', zh: '突尼斯' },
  TURK: { en: 'Türkiye', zh: '土耳其' },
  UAE: { en: 'United Arab Emirates', zh: '阿拉伯联合酋长国' },
  UGA: { en: 'Uganda', zh: '乌干达' },
  UK: { en: 'United Kingdom', zh: '英国' },
  UKR: { en: 'Ukraine', zh: '乌克兰' },
  UNK: { en: 'Unknown', zh: '未知' },
  URY: { en: 'Uruguay', zh: '乌拉圭' },
  US: { en: 'United States', zh: '美国' },
  USBZ: { en: 'United States/Brazil', zh: '美国/巴西' },
  VAT: { en: 'Vatican City State', zh: '梵蒂冈' },
  VENZ: { en: 'Venezuela', zh: '委内瑞拉' },
  VTNM: { en: 'Vietnam', zh: '越南' },
  ZWE: { en: 'Republic of Zimbabwe', zh: '津巴布韦' }
}

export const LAUNCH_SITE = {
  AFETR: { en: 'Air Force Eastern Test Range, Florida, USA', zh: '美国空军东部试验场（佛罗里达，美国）' },
  AFWTR: { en: 'Air Force Western Test Range, California, USA', zh: '美国空军西部试验场（加利福尼亚，美国）' },
  ALCLC: { en: 'Alâcantara Launch Center, Maranhão, Brazil', zh: '阿尔坎塔拉发射中心（马拉尼昂，巴西）' },
  ANDSP: { en: 'Andøya Spaceport, Nordland, Norway', zh: '安德亚航天发射场（诺尔兰，挪威）' },
  BOS: { en: 'Bowen Orbital Spaceport, Queensland, Australia', zh: '鲍恩轨道发射场（昆士兰，澳大利亚）' },
  CAS: { en: 'Canaries Airspace', zh: '加那利空域' },
  DLS: { en: 'Dombarovskiy Launch Site, Russia', zh: '栋巴罗夫斯基发射场（俄罗斯）' },
  ERAS: { en: 'Eastern Range Airspace', zh: '东部靶场空域' },
  FRGUI: { en: 'Europe\'s Spaceport, Kourou, French Guiana', zh: '圭亚那航天中心（库鲁，法属圭亚那）' },
  HGSTR: { en: 'Hammaguira Space Track Range, Algeria', zh: '哈马吉尔航天测控靶场（阿尔及利亚）' },
  JJSLA: { en: 'Jeju Island Sea Launch Area, Republic of Korea', zh: '济州岛海上发射区（韩国）' },
  JSC: { en: 'Jiuquan Satellite Launch Center, PRC', zh: '酒泉卫星发射中心（中国）' },
  KODAK: { en: 'Kodiak Launch Complex, Alaska, USA', zh: '科迪亚克发射场（阿拉斯加，美国）' },
  KSCUT: { en: 'Uchinoura Space Center (Fomerly Kagoshima Space Center—University of Tokyo, Japan)', zh: '内之浦宇宙空间观测所（日本）' },
  KWAJ: { en: 'US Army Kwajalein Atoll (USAKA)', zh: '美国陆军夸贾林环礁靶场（USAKA）' },
  KYMSC: { en: 'Kapustin Yar Missile and Space Complex, Russia', zh: '卡普斯京亚尔导弹与航天发射场（俄罗斯）' },
  NSC: { en: 'Naro Space Complex, Republic of Korea', zh: '罗老宇航中心（韩国）' },
  PLMSC: { en: 'Plesetsk Missile and Space Complex, Russia', zh: '普列谢茨克导弹与航天发射场（俄罗斯）' },
  RLLB: { en: 'Rocket Lab Launch Base, Mahia Peninsula, New Zealand', zh: '火箭实验室发射场（马希亚半岛，新西兰）' },
  SCSLA: { en: 'South China Sea Launch Area, PRC', zh: '南海海上发射区（中国）' },
  SEAL: { en: 'Sea Launch Platform (mobile)', zh: '海上发射平台（移动）' },
  SEMLS: { en: 'Semnan Satellite Launch Site, Iran', zh: '塞姆南卫星发射场（伊朗）' },
  SMTS: { en: 'Shahrud Missile Test Site, Iran', zh: '沙赫鲁德导弹试验场（伊朗）' },
  SNMLP: { en: 'San Marco Launch Platform, Indian Ocean (Kenya)', zh: '圣马科发射平台（印度洋，肯尼亚）' },
  SPKII: { en: 'Space Port Kii, Japan', zh: '纪伊航天港（日本）' },
  SRILR: { en: 'Satish Dhawan Space Centre, India (Formerly Sriharikota Launching Range)', zh: '萨迪什·达万航天中心（印度）' },
  SUBL: { en: 'Submarine Launch Platform (mobile)', zh: '潜艇发射平台（移动）' },
  SVOBO: { en: 'Svobodnyy Launch Complex, Russia', zh: '斯沃博德内发射场（俄罗斯）' },
  TAISC: { en: 'Taiyuan Satellite Launch Center, PRC', zh: '太原卫星发射中心（中国）' },
  TANSC: { en: 'Tanegashima Space Center, Japan', zh: '种子岛宇宙中心（日本）' },
  TYMSC: { en: 'Tyuratam Missile and Space Center, Kazakhstan (Also known as Baikonur Cosmodrome)', zh: '丘拉塔姆导弹与航天中心（拜科努尔，哈萨克斯坦）' },
  UNK: { en: 'Unknown', zh: '未知' },
  VOSTO: { en: 'Vostochny Cosmodrome, Russia', zh: '东方航天发射场（俄罗斯）' },
  WLPIS: { en: 'Wallops Island, Virginia, USA', zh: '瓦勒普斯岛（弗吉尼亚，美国）' },
  WOMRA: { en: 'Woomera, Australia', zh: '伍默拉（澳大利亚）' },
  WRAS: { en: 'Western Range Airspace', zh: '西部靶场空域' },
  WSC: { en: 'Wenchang Satellite Launch Site, PRC', zh: '文昌航天发射场（中国）' },
  XICLF: { en: 'Xichang Satellite Launch Center, PRC', zh: '西昌卫星发射中心（中国）' },
  YAVNE: { en: 'Yavne Launch Facility, Israel', zh: '亚夫内发射场（以色列）' },
  YSLA: { en: 'Yellow Sea Launch Area, PRC', zh: '黄海海上发射区（中国）' },
  YUN: { en: 'Yunsong Launch Site (Sohae Satellite Launching Station), Democratic People\'s Republic of Korea (North Korea)', zh: '云松发射场（朝鲜）' }
}

export const OPS_STATUS = {
  '+': { en: 'Operational', zh: '运行' },
  '-': { en: 'Nonoperational', zh: '停运' },
  '?': { en: 'Unknown', zh: '未知' },
  B: { en: 'Backup/Standby', zh: '备份' },
  D: { en: 'Decayed', zh: '已陨落' },
  P: { en: 'Partially Operational', zh: '部分运行' },
  S: { en: 'Spare', zh: '备用' },
  X: { en: 'Extended Mission', zh: '延寿' }
}

export const OBJECT_TYPE = {
  DEB: { en: 'Debris', zh: '碎片' },
  PAY: { en: 'Payload', zh: '载荷' },
  'R/B': { en: 'Rocket body', zh: '火箭体' },
  UNK: { en: 'Unknown', zh: '未知' }
}

export const ORBIT_TYPE = {
  DOC: { en: 'Docked', zh: '停靠' },
  IMP: { en: 'Impacted', zh: '撞击或再入' },
  LAN: { en: 'Landed', zh: '着陆' },
  ORB: { en: 'Orbiting', zh: '在轨' },
  'R/T': { en: 'Roundtrip', zh: '往返' }
}

export const DATA_STATUS = {
  NCE: { en: 'No current elements', zh: '无当前根数' },
  NEA: { en: 'No elements available', zh: '根数不公开' },
  NIE: { en: 'No initial elements', zh: '无初始根数' }
}

export const ORBIT_CENTER = {
  AS: { en: 'Asteroid', zh: '小行星' },
  EA: { en: 'Earth', zh: '地球' },
  EL: { en: 'Earth-Moon libration point', zh: '地月平动点' },
  EL1: { en: 'Earth-Sun L1', zh: '日地 L1 点' },
  EL2: { en: 'Earth-Sun L2', zh: '日地 L2 点' },
  EM: { en: 'Earth-Moon barycenter', zh: '地月系' },
  JU: { en: 'Jupiter', zh: '木星' },
  MA: { en: 'Mars', zh: '火星' },
  ME: { en: 'Mercury', zh: '水星' },
  MO: { en: 'Moon', zh: '月球' },
  SA: { en: 'Saturn', zh: '土星' },
  SS: { en: 'Solar system escape', zh: '飞出太阳系' },
  SU: { en: 'Sun', zh: '太阳' },
  VE: { en: 'Venus', zh: '金星' }
}

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
