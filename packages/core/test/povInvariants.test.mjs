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
import { BORDER_DEF, DASH_PX, DASH_SCALE, BORDER_CLASSES, BORDER_DRAW, ORDER, CFG_KEY, fadeFactor, admFade } from '../../../src/viz/geo/borderStyle.js'
import { migrateLandOverrides } from '../../../src/viz/landPalette.js'

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
ok('⑩ 出厂默认下任意两类线不同时同色+同宽+同线型', same.length === 0, same.join(' ') || SEVEN.length + ' 类两两比过')
// 色系分两族：coast 独立于政治线；政治六类共用一个基色（靠线型/线宽/透明度分级，不靠颜色）
const polColors = new Set(SEVEN.filter(([c]) => c !== 'coast').map(([, k]) => String(BORDER_DEF[k + 'Color']).toLowerCase()))
ok('⑩b 政治要素共用一个基色系、海岸线自成一族',
  polColors.size === 1 && !polColors.has(String(BORDER_DEF.coastColor).toLowerCase()),
  '政治色 ' + [...polColors].join(',') + ' · 海岸 ' + BORDER_DEF.coastColor)
// 低等级靠透明度退后
const opa = ['admin0', 'indef', 'loc', 'claim', 'coast', 'prov', 'city'].map((k) => BORDER_DEF[k + 'Opacity'])
ok('⑩c 透明度按等级单调不增', opa.every((v, i) => i === 0 || v <= opa[i - 1]), opa.join(' ≥ '))
// 2D 没有 renderOrder，只能靠画的先后 → BORDER_DRAW 必须就是按 ORDER 从低到高排好的那一份
ok('⑩d 2D 绘制序与 3D 渲染次序一致',
  JSON.stringify(BORDER_DRAW) === JSON.stringify([...BORDER_CLASSES].sort((a, b) => ORDER[a] - ORDER[b])),
  BORDER_DRAW.join('→'))
// 国界压在最上、一/二级行政区退到海岸之下（★ 与改造前相反，见提交信息）
ok('⑩e 渲染次序：ADM2 < ADM1 < 海岸 < 主张 < 停火 < 未定 < 国界',
  ORDER.adm2 < ORDER.adm1 && ORDER.adm1 < ORDER.coast && ORDER.coast < ORDER.claim && ORDER.claim < ORDER.loc && ORDER.loc < ORDER.indefinite && ORDER.indefinite < ORDER.admin0)
// 主张线取 indefinite 的半周期（短虚）：两者都是 dash 时靠这个 + 线宽区分
ok('⑩f 主张线周期约为未定界的一半', Math.abs(DASH_SCALE.claim - 0.5) < 1e-9 && DASH_PX.dash && DASH_PX.dashdot.length === 4,
  'claim×' + DASH_SCALE.claim + ' · dashdot 四段')

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

console.log('\n' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
