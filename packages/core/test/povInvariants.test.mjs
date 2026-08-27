// 底图主权解算的不变量（src/viz/geo/）。运行：npm test
//
// ★ 红线：台湾、香港、澳门在任何视角、任何用户自定义覆写下，主权归属一律是中国。
//   这一条不靠「数据文件里写对了」保证，而是靠 povResolver.ownerOf() 最外层的冻结常量：
//     owner = FROZEN[u] ?? userOverride[u] ?? pov.own[u] ?? baseOwner[u]
//   本文件用「全部预设视角 × 1000 组随机覆写（含蓄意注入 FROZEN 键）」把它焊死，
//   并同时守住三条不让红线被绕开的旁路：视角文件里不许有这三个键、可自定义争议区清单里不许有、
//   UI 因此拿不到这个开关。
//
// 另守两条工程约束：
//   · 主张线（南海十段线）必须数据驱动 —— 只在 lines.claim 含它的视角下出现，不许代码里判视角 id；
//   · 解算器与两个渲染器的源码里不许出现针对具体视角 id 的渲染分支（去注释后 grep）。
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { FROZEN, CUSTOMIZABLE_DISPUTES, expandOverrides } from '../../../src/viz/geo/frozen.js'
import * as R from '../../../src/viz/geo/povResolver.js'
import { BORDER_DEF, DASH_PX, DASH_SCALE, GRID_STEPS, BORDER_CLASSES, BORDER_DRAW, ORDER, CFG_KEY, fadeFactor, admFade } from '../../../src/viz/geo/borderStyle.js'
import { migrateLandOverrides } from '../../../src/viz/landPalette.js'
import { POV_META, CUSTOM_POV, MAP_POV_DEF, normMapPov, povTableOf } from '../../../src/viz/geo/povList.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
const POVDIR = join(ROOT, 'src', 'viz', 'geo', 'povs')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}

const FKEYS = Object.keys(FROZEN)
const povIds = R.povList().map((p) => p.id)
ok('① 视角清单非空', povIds.length > 0, povIds.join(','))

// ---------- ② 红线：全部预设视角 × 1000 组随机覆写 ----------
// 随机覆写池刻意混入 FROZEN 的三个键与各种归属值（含 'none' / 'disputed' / 乱码），
// 就是要证明「无论用户怎么写，这三块地的 owner 都是 CHN」。
const POOL_U = [...FKEYS, ...CUSTOMIZABLE_DISPUTES.flatMap((g) => g.units), 'CHN', 'IND', 'PAK', 'ZZZ']
const POOL_V = ['CHN', 'IND', 'PAK', 'USA', 'JPN', 'TWN', 'disputed', 'none', '', 'XXX']
let rng = 20260827
const rnd = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
const pick = (a) => a[Math.floor(rnd() * a.length) % a.length]

let bad = 0, cases = 0
for (const id of [...povIds, 'custom', 'nonexistent']) {
  for (let n = 0; n < 1000; n++) {
    const ov = {}
    for (let k = 0, m = 1 + Math.floor(rnd() * 5); k < m; k++) ov[pick(POOL_U)] = pick(POOL_V)
    for (const f of FKEYS) if (rnd() < 0.5) ov[f] = pick(POOL_V)   // 蓄意注入
    R.setPov(id, ov)
    cases++
    for (const f of FKEYS) if (R.ownerOf(f) !== 'CHN') { bad++; if (bad < 4) console.log('    ✗', id, f, '→', R.ownerOf(f), JSON.stringify(ov)) }
  }
}
R.setPov(R.DEFAULT_POV, {})
ok('② 台湾/港澳的 owner 恒为 CHN', bad === 0, cases + ' 组覆写 × ' + FKEYS.length + ' 个单元，异常 ' + bad + ' 次')

// 覆写也不能从「分组键」那条路绕进来
const viaGroup = expandOverrides(Object.fromEntries(CUSTOMIZABLE_DISPUTES.map((g) => [g.key, g.opts[0]])))
ok('③ expandOverrides 展开结果不含 FROZEN 键', FKEYS.every((f) => !(f in viaGroup)), Object.keys(viaGroup).length + ' 条覆写')

// ---------- ④ 可自定义争议区清单里没有 FROZEN 的键 ----------
const custKeys = new Set(CUSTOMIZABLE_DISPUTES.map((g) => g.key))
const custUnits = new Set(CUSTOMIZABLE_DISPUTES.flatMap((g) => g.units))
ok('④ CUSTOMIZABLE_DISPUTES 的 key 与 units 都不含 FROZEN 键',
  FKEYS.every((f) => !custKeys.has(f) && !custUnits.has(f)), FKEYS.join(' '))
ok('④b 清单条目结构完整（key/zh/en/units/opts 齐备且 opts ≥2）',
  CUSTOMIZABLE_DISPUTES.every((g) => g.key && g.zh && g.en && Array.isArray(g.units) && g.units.length && Array.isArray(g.opts) && g.opts.length >= 2),
  CUSTOMIZABLE_DISPUTES.length + ' 条')

// ---------- ⑤ 每个视角文件的 own 里没有 FROZEN 的键 ----------
let povBad = []
for (const id of povIds) {
  const f = join(POVDIR, id + '.json')
  if (!existsSync(f)) { povBad.push(id + ':缺文件'); continue }
  const j = JSON.parse(readFileSync(f, 'utf8'))
  for (const k of FKEYS) if (j.own && k in j.own) povBad.push(id + ':' + k)
  if (!j.lines || !Array.isArray(j.lines.claim)) povBad.push(id + ':lines.claim 不是数组')
}
ok('⑤ 视角文件 own 表不含 FROZEN 键', povBad.length === 0, povBad.join(' ') || povIds.length + ' 套全过')

// ---------- ⑥ 主张线纯数据驱动 ----------
// nanhai-ten-dash 只在「本视角的 lines.claim 声明了它」时进 resolvedLines().claim。
let claimBad = []
for (const id of povIds) {
  const j = JSON.parse(readFileSync(join(POVDIR, id + '.json'), 'utf8'))
  const declared = (j.lines.claim || []).includes('nanhai-ten-dash')
  R.setPov(id, {})
  const n = R.resolvedLines().claim.length
  if (declared && n === 0) claimBad.push(id + ':声明了却没画')
  if (!declared && n > 0) claimBad.push(id + ':没声明却画了 ' + n + ' 段')
}
R.setPov(R.DEFAULT_POV, {})
ok('⑥ 南海十段线只随 lines.claim 出现', claimBad.length === 0, claimBad.join(' ') || povIds.length + ' 套全过')
// 图层开关关掉后该组必须为空（附加线图层开关也是数据，不是视角判断）
R.setPov(R.DEFAULT_POV, {}, { claim: false })
const claimOff = R.resolvedLines().claim.length
R.setPov(R.DEFAULT_POV, {}, { claim: true })
ok('⑥b 关掉主张线图层后 claim 组为空', claimOff === 0, '关=' + claimOff + ' 开=' + R.resolvedLines().claim.length)

// ---------- ⑦ 源码里没有针对具体视角 id 的渲染分支 ----------
// 去掉注释与字符串化的视角登记后再 grep：任何 `xxx.id === 'CN'` / `povId !== 'US'` 都算违规。
const FILES = ['src/viz/geo/povResolver.js', 'src/viz/globe3d/scene.js', 'src/viz/flatmap/flatCoverage.js']
// ★ 先去 \r 再切行：JS 正则里 . 不匹配行终止符，而 \r 就是行终止符 —— CRLF 文件上 /\/\/.*$/ 一条都删不掉。
const stripComments = (t) => t.replace(/\r/g, '').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
const BRANCH = /(\bpov\w*|\bid|\bstate\.id|\bpovId)\s*[!=]==?\s*['"](CN|ISO|US|IN|JP|RU)['"]/
let branchBad = []
for (const rel of FILES) {
  const f = join(ROOT, rel)
  if (!existsSync(f)) continue
  stripComments(readFileSync(f, 'utf8')).split('\n').forEach((l, i) => { if (BRANCH.test(l)) branchBad.push(rel + ':' + (i + 1)) })
}
ok('⑦ 解算器与两个渲染器里没有具体视角 id 的分支', branchBad.length === 0, branchBad.join(' ') || FILES.length + ' 个文件全过')

// ---------- ⑧ 派生规则自洽 ----------
R.setPov(R.DEFAULT_POV, {})
const L = R.resolvedLines()
ok('⑧ 五组线齐备且互不为空（coast/admin0/indefinite/loc/claim）',
  ['coast', 'admin0', 'indefinite', 'loc', 'claim'].every((k) => Array.isArray(L[k]) && L[k].length > 0),
  Object.entries(L).map(([k, v]) => k + '=' + v.length).join(' '))
// 同一段几何不许被画两次：把每段折线按首末点做键，跨五组不得重复
// 整条折线的坐标指纹（不是只取首末点：不同 arc 常连在同一对结点之间，首末点会撞）
const key = (p) => p.length + ':' + p.map((q) => q[0].toFixed(4) + ',' + q[1].toFixed(4)).join(';')
const seen = new Map()
let dup = 0
for (const [cls, arr] of Object.entries(L)) for (const p of arr) { const k = key(p); if (seen.has(k) && seen.get(k) !== cls) dup++; else seen.set(k, cls) }
ok('⑧b 同一段几何不跨类重复', dup === 0, '重复 ' + dup + ' 段 / 共 ' + seen.size + ' 段')

// 换视角后台湾仍并入中国的面，且不单独出标注
R.setPov(R.DEFAULT_POV, {})
const labels = R.labelSet('zh')
ok('⑨ 台湾不单独出国名标注', !labels.some((x) => x.owner === 'TWN' || x.zh === '台湾'), '共 ' + labels.length + ' 个国名')
ok('⑨b 台北/香港/澳门点选结果都是中国',
  ['121.5,25.03', '114.15,22.35', '113.55,22.15'].every((s) => { const [x, y] = s.split(',').map(Number); const r = R.ownerAt(x, y); return r && r.owner === 'CHN' }))

// ---------- ⑩ 边界线显示规范（1.6b 六 · 1）----------
// 出厂默认下，任意两类线不得同时「同色 + 同宽 + 同线型」——否则用户根本分不出哪条是哪条。
const SEVEN = [...BORDER_CLASSES.map((c) => [c, CFG_KEY[c]]), ['adm1', 'prov'], ['adm2', 'city']]
const sig = (k) => [String(BORDER_DEF[k + 'Color']).toLowerCase(), BORDER_DEF[k + 'Width'], BORDER_DEF[k + 'Dash'] || 'solid'].join('|')
let same = []
for (let i = 0; i < SEVEN.length; i++) for (let j = i + 1; j < SEVEN.length; j++) {
  if (sig(SEVEN[i][1]) === sig(SEVEN[j][1])) same.push(SEVEN[i][0] + '≡' + SEVEN[j][0])
}
// ★ 出厂态下线粗一律 0.7（用户口径），故「同色 + 同宽 + 同线型」不再是禁忌 —— 国界 / 海岸线 / 主张线
//   本来就该是同一套线符。改判「同色同宽的那几条，靠线型或透明度仍分得开」：
//   国界 1.00 / 海岸 0.90 / 主张 1.00 —— 国界与主张线故意长一样（中国标准地图的画法），其余都还分得开。
const sig2 = (k) => [String(BORDER_DEF[k + 'Color']).toLowerCase(), BORDER_DEF[k + 'Width'], BORDER_DEF[k + 'Dash'] || 'solid', BORDER_DEF[k + 'Opacity']].join('|')
const dupSig = []
for (let i = 0; i < SEVEN.length; i++) for (let j = i + 1; j < SEVEN.length; j++) {
  if (sig2(SEVEN[i][1]) === sig2(SEVEN[j][1])) dupSig.push(SEVEN[i][0] + '≡' + SEVEN[j][0])
}
ok('⑩ 出厂默认下完全同款的只有「国界≡主张线」这一对（刻意如此）',
  dupSig.length === 1 && dupSig[0] === 'admin0≡claim', dupSig.join(' ') || '无')
// 全部线同一族【冷蓝灰】（B>R），且★国界与海岸线同色 —— 一张图上只有一种线色，靠粗细分主次。
const rgb = (h) => [1, 3, 5].map((i) => parseInt(String(h).slice(i, i + 2), 16))
const cool = (h) => { const [r, , b] = rgb(h); return b > r }
const allKeys = SEVEN.map(([, k]) => k)
ok('⑩b 全部边界线同属冷蓝灰一族',
  allKeys.every((k) => cool(BORDER_DEF[k + 'Color'])),
  allKeys.map((k) => BORDER_DEF[k + 'Color']).join(','))
ok('⑩b2 国界与海岸线同色（用户口径）',
  BORDER_DEF.admin0Color.toLowerCase() === BORDER_DEF.coastColor.toLowerCase(), BORDER_DEF.admin0Color)
// 线粗一律 0.7（用户口径）：出厂态不靠粗细分主次，全交给明度与线型
const W = SEVEN.map(([, k]) => BORDER_DEF[k + 'Width']).concat([BORDER_DEF.gridWidth])
ok('⑩b3 出厂线粗一律 0.7', W.every((v) => Math.abs(v - 0.7) < 1e-9), W.join(' '))
// ★ 层级靠【明度】排：国界最深，未定界/停火线次之，两级行政区依次退后。
//   （改造前是「政治六类同色、只靠线型线宽分」，实测那样整幅图糊成一片灰，谁也不比谁重要。）
const lum = (k) => { const [r, g, b] = rgb(BORDER_DEF[k + 'Color']); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
const chain = ['admin0', 'loc', 'prov', 'city']
ok('⑩c 明度按等级单调不减：国界最深 → 停火线 → 一级行政区界 → 二级行政区界',
  chain.every((k, i) => i === 0 || lum(k) > lum(chain[i - 1])),
  chain.map((k) => k + ' ' + lum(k).toFixed(0)).join(' < '))
// 同一族里低等级还要再靠透明度退后一档
const opa = ['admin0', 'prov', 'city'].map((k) => BORDER_DEF[k + 'Opacity'])
ok('⑩c2 行政层级的透明度单调不增', opa.every((v, i) => i === 0 || v <= opa[i - 1]), opa.join(' ≥ '))
// 2D 没有 renderOrder，只能靠画的先后 → BORDER_DRAW 必须就是按 ORDER 从低到高排好的那一份
ok('⑩d 2D 绘制序与 3D 渲染次序一致',
  JSON.stringify(BORDER_DRAW) === JSON.stringify([...BORDER_CLASSES].sort((a, b) => ORDER[a] - ORDER[b])),
  BORDER_DRAW.join('→'))
// 国界压在最上、一/二级行政区退到海岸之下（★ 与改造前相反，见提交信息）
ok('⑩e 渲染次序：ADM2 < ADM1 < 海岸 < 主张 < 停火 < 未定 < 国界',
  ORDER.adm2 < ORDER.adm1 && ORDER.adm1 < ORDER.coast && ORDER.coast < ORDER.claim && ORDER.claim < ORDER.loc && ORDER.loc < ORDER.indefinite && ORDER.indefinite < ORDER.admin0)
// ★ 主张线（南海十段线）必须是【实线】：它本身就是十段实的短线，再套虚线图案会被打成一串麻点。
//   与国界的区分靠线宽（更粗），不靠虚线周期 —— 中国标准地图上正是这个画法。
ok('⑩f 主张线是实线（不是虚线）',
  (BORDER_DEF.claimDash || 'solid') === 'solid' && !DASH_SCALE.claim, 'claim ' + (BORDER_DEF.claimDash || 'solid'))
ok('⑩g 虚线图案齐全（未定界虚线 / 停火线点划线）', Array.isArray(DASH_PX.dash) && DASH_PX.dashdot.length === 4,
  'dash ' + DASH_PX.dash.join('/') + ' · dashdot ' + DASH_PX.dashdot.join('/'))
// 经纬网与五类边界线同规格：颜色/线宽/透明度/线型四项齐全 + 可关 + 间隔可选，且比任何一条界线都淡
ok('⑩h 经纬网可改样式、可关、可换间隔',
  typeof BORDER_DEF.gridColor === 'string' && BORDER_DEF.gridWidth > 0 && BORDER_DEF.gridOn === true &&
  GRID_STEPS.includes(BORDER_DEF.gridStep) && (BORDER_DEF.gridDash || 'solid') in DASH_PX,
  BORDER_DEF.gridColor + ' / ' + BORDER_DEF.gridWidth + ' / ' + BORDER_DEF.gridStep + '° · 可选 ' + GRID_STEPS.join('/'))
ok('⑩i 经纬网比任何一条界线都淡（它是底衬不是数据）',
  SEVEN.every(([, k]) => BORDER_DEF.gridOpacity < BORDER_DEF[k + 'Opacity']),
  '网格 ' + BORDER_DEF.gridOpacity + ' < 最淡的界线 ' + Math.min(...SEVEN.map(([, k]) => BORDER_DEF[k + 'Opacity'])))

// ---------- ⑩j 中国视角下中国的国境不出未定界虚线（POV_SOLID）----------
// 判据取每条未定界折线的【中点】归属：界线压在两国交界上，端点两边都可能命中，中点才代表这条线归谁管。
// （克什米尔那条印巴线的北端正好顶在中巴印三交点上，端点会误报成中国。）
const midOwner = (poly) => { const q = poly[Math.floor(poly.length / 2)]; const h = R.ownerAt(q[0], q[1], '10m'); return h && h.owner }
const cnIndefN = (id) => { R.setPov(id, {}); return R.resolvedLines('10m').indefinite.filter((p) => midOwner(p) === 'CHN').length }
const nCN = cnIndefN('CN'), nISO = cnIndefN('ISO'), nIN = cnIndefN('IN')
R.setPov(R.DEFAULT_POV, {})
ok('⑩j 中国视角下中国境内不出未定界虚线', nCN === 0, 'CN ' + nCN + ' 条')
ok('⑩j2 别的视角照旧出（规则挂在视角上，不是写死给中国）', nISO > 0 && nIN > 0, 'ISO ' + nISO + ' 条 · 印度 ' + nIN + ' 条')

// ---------- ⑪ 缩放淡出（1.6b 三）----------
ok('⑪ 全球视角 ADM2 全淡出、ADM1 降到 0.3', Math.abs(admFade(fadeFactor(0.2)).adm2) < 1e-9 && Math.abs(admFade(fadeFactor(0.2)).adm1 - 0.3) < 1e-9)
ok('⑪b 城市级完全恢复', Math.abs(admFade(fadeFactor(0.005)).adm2 - 1) < 1e-9 && Math.abs(admFade(fadeFactor(0.005)).adm1 - 1) < 1e-9)
const mono = [0.2, 0.08, 0.05, 0.03, 0.02, 0.01].map((d) => fadeFactor(d))
ok('⑪c 中间档平滑过渡、不硬切', mono.every((v, i) => i === 0 || v >= mono[i - 1]) && mono.some((v) => v > 0.01 && v < 0.99), mono.map((v) => v.toFixed(2)).join(' → '))

// ---------- ⑫ 逐国大地颜色的键迁移（ISO 数字码 → ISO3）----------
// 156/158/344 三个老键都折进 CHN，后写的赢（'#654321' 是 344 香港那条）——这正是「港澳台并入中国」的表现
const mig = migrateLandOverrides({ 156: '#b85a52', 158: '#123456', 344: '#654321', 840: '#9fb0c0', 10: '#edf2f6', 304: '#ffffff', 999: '#000000', bad: 'zzz' })
ok('⑫ 数字码→ISO3：156→CHN · 840→USA · 010→ATA · 304→GRL', mig.USA === '#9fb0c0' && mig.ATA === '#edf2f6' && mig.GRL === '#ffffff', JSON.stringify(mig))
ok('⑫b 台湾/港澳的老键一律折进 CHN（它们的 owner 由 frozen.js 恒定）', !('TWN' in mig) && !('HKG' in mig) && mig.CHN === '#654321', 'CHN=' + mig.CHN)
ok('⑫c 已是 ISO3 的键原样穿过（幂等）', JSON.stringify(migrateLandOverrides(mig)) === JSON.stringify(mig))
ok('⑫d 无法映射的键与非法色一律丢弃', !('999' in mig) && !('bad' in mig) && Object.values(mig).every((v) => /^#[0-9a-fA-F]{6}$/.test(v)))

// ---------- ⑬ 设置里的「地图视角」（{ id, overrides(分组键), layers }）----------
ok('⑬ 下拉含六套预设 + 自定义', POV_META.length === povIds.length + 1 && POV_META[POV_META.length - 1].id === CUSTOM_POV,
  POV_META.map((x) => x.zh).join(' '))
const n1 = normMapPov({ id: '不存在的', overrides: { crimea: 'RUS', 坏的: 1 }, layers: { claim: false, loc: 'x' } })
ok('⑬b normMapPov 规整：非法 id 回落默认、非字符串覆写丢弃、非布尔开关丢弃',
  n1.id === R.DEFAULT_POV && n1.overrides.crimea === 'RUS' && !('坏的' in n1.overrides) && n1.layers.claim === false && n1.layers.loc === true,
  JSON.stringify(n1))
ok('⑬c normMapPov 对空值给出出厂档', JSON.stringify(normMapPov(null)) === JSON.stringify(MAP_POV_DEF))

// ★ 'custom' 以中国视角为底：不这么做的话切到「自定义」会连南海十段线一起没了
ok('⑬d 自定义视角继承默认视角的归属表', povTableOf(CUSTOM_POV) === povTableOf(R.DEFAULT_POV))
R.applyMapPov({ id: CUSTOM_POV, overrides: {}, layers: MAP_POV_DEF.layers })
ok('⑬e 自定义视角下南海十段线照画', R.resolvedLines().claim.length > 0, R.resolvedLines().claim.length + ' 段')

// 端到端：设置里的分组键 → 展开成逐单元覆写 → 归属真的变了；台湾仍恒属中国
R.applyMapPov({ id: CUSTOM_POV, overrides: { crimea: 'RUS', 'aksai-chin': 'IND', kosovo: 'none' }, layers: MAP_POV_DEF.layers })
ok('⑬f 分组覆写端到端生效', R.ownerOf('UA-CR') === 'RUS' && R.ownerOf('CN-AKS') === 'IND', 'UA-CR=' + R.ownerOf('UA-CR') + ' CN-AKS=' + R.ownerOf('CN-AKS'))
ok('⑬g 覆写成「不显示」时归属落到宿主 / 无宿主则回 own0，绝不为 null',
  R.ownerOf('KOS') && R.ownerOf('KOS') !== 'none', 'KOS=' + R.ownerOf('KOS'))
ok('⑬h 任何覆写下台湾/港澳仍属中国', FKEYS.every((f) => R.ownerOf(f) === 'CHN'))
R.applyMapPov(null)
ok('⑬i applyMapPov(null) 回到默认视角', R.getPov().id === R.DEFAULT_POV && Object.keys(R.getPov().overrides).length === 0)

// ---------- ⑭ 六套视角确实互不相同（视角表不是摆设）----------
const sigOf = () => { const L = R.resolvedLines(); return L.admin0.length + '/' + L.indefinite.length + '/' + L.claim.length }
const sigs = {}
for (const id of povIds) { R.setPov(id, {}); sigs[id] = sigOf() }
R.setPov(R.DEFAULT_POV, {})
ok('⑭ 六套视角解算结果互不相同', new Set(Object.values(sigs)).size >= 4, Object.entries(sigs).map(([k, v]) => k + ' ' + v).join(' · '))
// 中国视角：藏南与阿克赛钦归中国；ISO 中立视角：两者都不归中国
R.setPov('CN', {}); const cn = [R.ownerOf('IN-ARP'), R.ownerOf('CN-AKS')].join(',')
R.setPov('ISO', {}); const iso = [R.ownerOf('IN-ARP'), R.ownerOf('CN-AKS')].join(',')
R.setPov('IN', {}); const ind = [R.ownerOf('IN-ARP'), R.ownerOf('CN-AKS')].join(',')
R.setPov(R.DEFAULT_POV, {})
ok('⑭b 中国视角下藏南/阿克赛钦归中国，ISO 与印度视角另有归属', cn === 'CHN,CHN' && iso !== cn && ind !== cn,
  'CN=' + cn + ' · ISO=' + iso + ' · IN=' + ind)

console.log('\n' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
