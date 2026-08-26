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

console.log('\n' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
