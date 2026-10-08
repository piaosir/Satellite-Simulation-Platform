// 自动几何搜索起点自测（src/shared/geoT0.js + 三窗接线）。运行：npm test
// 被测文件是渲染端 ESM（不依赖 Vue/DOM），故本测试自身也是 .mjs。
//
// 这一层回答的是「这一批几何从哪一刻起扫」：
//   ① 档位归一 —— 老配置（无此键）与乱码一律回时间轴档，不沿用别的值；
//   ② 存档 —— 缺省不写键（老配置载入再存逐字不变）；非缺省两键都落盘；
//   ③ 取值 —— 三档各取各的钟；指定档时刻坏了退回时间轴，不送 null（主进程会按轨道历元另编一个起点）；
//   ④ 时刻框 —— 按显示时区档位读写、往返闭合；键到一半的年份（0002）不收；
//   ⑤ 三窗接线 —— 起点经同一个咽喉取值、随场景存取、入指纹（NGSO / 再生式指纹是挑字段的，漏了就不落盘）。
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { GEO_T0_MODES, normGeoT0Mode, normGeoT0ISO, geoT0State, resolveGeoT0ISO, sceneSecondISO, t0InputValue, parseT0Input } from '../../../src/shared/geoT0.js'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const SCENE = Date.UTC(2026, 0, 15, 3, 4, 5, 678), NOW = Date.UTC(2026, 9, 6, 12, 0, 0, 123)
const clock = { scene: () => SCENE, now: () => NOW }

// ==================== ① 档位归一 ====================
ok('① 三档齐全、缺省档在首位', GEO_T0_MODES.map((m) => m.v).join() === 'scene,now,fixed')
ok('① 合法档位原样', normGeoT0Mode('now') === 'now' && normGeoT0Mode('fixed') === 'fixed' && normGeoT0Mode('scene') === 'scene')
ok('① 缺省 / 乱码 → 时间轴', [undefined, null, '', 'auto', 0, 'NOW'].every((v) => normGeoT0Mode(v) === 'scene'))
ok('① 时刻规范成带 Z 的 ISO', normGeoT0ISO('2026-03-01T08:00:00+08:00') === '2026-03-01T00:00:00.000Z', normGeoT0ISO('2026-03-01T08:00:00+08:00'))
ok('① 坏时刻 → 空串', ['', 'abc', null, undefined, 123].every((v) => normGeoT0ISO(v) === ''))

// ==================== ② 存档 ====================
ok('② 缺省不写键', JSON.stringify(geoT0State('scene', '')) === '{}' && JSON.stringify(geoT0State(undefined, undefined)) === '{}')
ok('② 老配置载入再存逐字不变', JSON.stringify(geoT0State(normGeoT0Mode(undefined), normGeoT0ISO(undefined))) === '{}')
ok('② 系统时钟档只写档位', JSON.stringify(geoT0State('now', '')) === '{"geoT0Mode":"now"}')
ok('② 指定档两键都写', JSON.stringify(geoT0State('fixed', '2026-02-03T04:05:06Z')) === '{"geoT0Mode":"fixed","geoT0ISO":"2026-02-03T04:05:06.000Z"}')
ok('② 切回时间轴仍留着指定过的时刻（再切回指定不丢）', JSON.stringify(geoT0State('scene', '2026-02-03T04:05:06.000Z')) === '{"geoT0Mode":"scene","geoT0ISO":"2026-02-03T04:05:06.000Z"}')
ok('② 坏档位存成缺省', JSON.stringify(geoT0State('乱码', '')) === '{}')

// ==================== ③ 取值 ====================
ok('③ 时间轴档取场景时刻', resolveGeoT0ISO('scene', '2026-02-03T04:05:06Z', clock) === new Date(SCENE).toISOString())
ok('③ 系统时钟档取系统时间', resolveGeoT0ISO('now', '2026-02-03T04:05:06Z', clock) === new Date(NOW).toISOString())
ok('③ 指定档取存的时刻', resolveGeoT0ISO('fixed', '2026-02-03T04:05:06Z', clock) === '2026-02-03T04:05:06.000Z')
ok('③ 指定档时刻坏了退回时间轴', resolveGeoT0ISO('fixed', 'bad', clock) === new Date(SCENE).toISOString() && resolveGeoT0ISO('fixed', '', clock) === new Date(SCENE).toISOString())
ok('③ 老配置（无键）＝时间轴档', resolveGeoT0ISO(undefined, undefined, clock) === new Date(SCENE).toISOString())
ok('③ 不注入时钟也能取（node 下无 localStorage → 系统钟）', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(resolveGeoT0ISO('scene', '')))
ok('③ 切到指定的初值取整到秒', sceneSecondISO(clock) === '2026-01-15T03:04:05.000Z', sceneSecondISO(clock))

// ==================== ④ 时刻框 ====================
{
  const iso = '2026-08-31T12:02:45.000Z'
  ok('④ UTC 档显示', t0InputValue(iso, 'utc') === '2026-08-31T12:02:45', t0InputValue(iso, 'utc'))
  ok('④ 固定 +8 档显示', t0InputValue(iso, 480) === '2026-08-31T20:02:45', t0InputValue(iso, 480))
  ok('④ 固定 −5 档显示', t0InputValue(iso, -300) === '2026-08-31T07:02:45', t0InputValue(iso, -300))
  ok('④ 秒为 0 省掉「:00」（与 datetime-local 规范化后的 value 同写法）', t0InputValue('2026-08-31T12:02:00Z', 'utc') === '2026-08-31T12:02')
  ok('④ 坏时刻显示空框', t0InputValue('', 'utc') === '' && t0InputValue('bad', 480) === '')
  ok('④ UTC 档解析', parseT0Input('2026-08-31T12:02:45', 'utc') === iso)
  ok('④ 固定 +8 档解析', parseT0Input('2026-08-31T20:02:45', 480) === iso)
  ok('④ 不带秒按 0 秒', parseT0Input('2026-08-31T20:02', 480) === '2026-08-31T12:02:00.000Z')
  let closed = true
  for (const mode of ['utc', 'local', 480, -300, 330, 840, -720]) {
    for (const t of [Date.UTC(2026, 0, 1, 0, 0, 0), Date.UTC(2026, 6, 15, 23, 59, 59), Date.UTC(2031, 11, 31, 16, 30, 7)]) {
      const s = new Date(t).toISOString()
      if (parseT0Input(t0InputValue(s, mode), mode) !== s) { closed = false; console.log('   往返不闭合:', mode, s, t0InputValue(s, mode)) }
    }
  }
  ok('④ 各档位往返闭合（屏上读到什么，键入同一串就回到同一瞬间）', closed)
  ok('④ 键到一半的年份不收', parseT0Input('0002-08-31T12:02', 'utc') === null && parseT0Input('0202-08-31T12:02', 480) === null)
  ok('④ 空串 / 乱码不收', parseT0Input('', 'utc') === null && parseT0Input('abc', 'utc') === null && parseT0Input(null, 'utc') === null)
}

// ==================== ⑤ 三窗接线 ====================
{
  const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../..')
  const W = { NGSO: 'src/ngso/NgsoLinkBudgetApp.vue', 再生式: 'src/regen/RegenLinkBudgetApp.vue', 端到端: 'src/e2e/E2eLinkBudgetApp.vue' }
  for (const [name, rel] of Object.entries(W)) {
    const s = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    ok(`⑤ ${name}：起点经 resolveGeoT0ISO 取值`, s.includes('resolveGeoT0ISO(geoT0Mode.value, geoT0ISO.value)'))
    ok(`⑤ ${name}：搜索起点不再直接读时间轴`, !/sceneNowISO\(\)/.test(s))
    ok(`⑤ ${name}：随场景存`, s.includes('geoT0State(geoT0Mode.value, geoT0ISO.value)'))
    ok(`⑤ ${name}：随场景取（老场景回时间轴）`, s.includes('normGeoT0Mode(st.geoT0Mode)') && s.includes('normGeoT0ISO(st.geoT0ISO)'))
    ok(`⑤ ${name}：功能区有起点选择`, s.includes('v-model="geoT0Mode"') && s.includes('GEO_T0_MODES'))
  }
  for (const name of ['NGSO', '再生式']) {
    const s = fs.readFileSync(path.join(ROOT, W[name]), 'utf8')
    ok(`⑤ ${name}：起点入指纹（挑字段的指纹漏了就不落盘）`, s.includes('geoT0: geoT0State(s.geoT0Mode, s.geoT0ISO)'))
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
