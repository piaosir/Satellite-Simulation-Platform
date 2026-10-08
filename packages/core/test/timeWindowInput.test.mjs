// 起止时刻输入（src/shared/timeWindowInput.js）+ 三处起止时刻可自定义的接线（星间链路距离工具 / 干扰分析 NGSO / 工作台分析）。
// 运行：node packages/core/test/timeWindowInput.test.mjs
//   ① inputText / parseInput：UTC / 本机 / 固定偏移三种档位读写互逆（到分）、带秒的值也认
//   ② 半截年份不认：Chromium 的 datetime-local 每改一段发一次 change，年份敲到一半是 0002 / 0020 / 0202 —— 一律 NaN
//      （否则 0–99 年被当成 19xx）；按键序列模拟：只有敲完的那一下被收下
//   ③ 结束时刻 ⇄ 时长：endFromHours / hoursFromEnd（须晚于起始、上限可选）
//   ④ 三处界面：起止两个框都在、结束框改时长、失焦回到实际生效的值、起始缺省取时间轴此刻且不随配置存盘
import { readFileSync } from 'node:fs'
import { inputText, parseInput, endFromHours, hoursFromEnd, MIN_INPUT_YEAR } from '../../../src/shared/timeWindowInput.js'

let pass = 0, fail = 0
const ok = (cond, msg, extra) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + msg + (extra ? `  (${extra})` : '')); cond ? pass++ : fail++ }
const src = (p) => readFileSync(new URL('../../../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

// ① 读写
const T = Date.UTC(2026, 9, 7, 2, 30, 0)
ok(inputText(T, 'utc') === '2026-10-07T02:30', 'inputText UTC')
ok(inputText(T, 480) === '2026-10-07T10:30' && inputText(T, -300) === '2026-10-06T21:30', 'inputText 固定偏移（UTC+8 / UTC−5）')
const d = new Date(T), p2 = (n) => String(n).padStart(2, '0')
ok(inputText(T, 'local') === `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`, 'inputText 本机＝本机墙钟')
ok(inputText(NaN, 'utc') === '' && inputText(undefined) === '', 'inputText 无效给空串')
ok(parseInput('2026-10-07T02:30', 'utc') === T, 'parseInput UTC')
ok(parseInput('2026-10-07T10:30', 480) === T && parseInput('2026-10-06T21:30', -300) === T, 'parseInput 固定偏移')
ok(parseInput('2026-10-07T10:30', 'local') === new Date(2026, 9, 7, 10, 30).getTime(), 'parseInput 本机')
ok(parseInput('2026-10-07T02:30:45', 'utc') === T + 45000, '带秒的值也认')
let rt = true
for (const m of ['utc', 'local', 480, -300, 345]) for (const t of [T, T + 123456789, Date.UTC(2027, 1, 28, 23, 59, 59)]) if (parseInput(inputText(t, m), m) !== Math.floor(t / 60000) * 60000) rt = false
ok(rt, '各档位读写互逆（到分）')

// ② 半截年份
ok(MIN_INPUT_YEAR === 1000, '年份下限 1000')
ok(['0002-10-07T10:30', '0020-10-07T10:30', '0202-10-07T10:30', '0999-12-31T23:59'].every((v) => Number.isNaN(parseInput(v, 'utc')) && Number.isNaN(parseInput(v, 'local'))), '半截年份 0002 / 0020 / 0202 / 0999 → NaN（不被当 19xx）')
ok(parseInput('1999-12-31T23:59', 'utc') === Date.UTC(1999, 11, 31, 23, 59), '1999 年照收')
ok([null, undefined, '', 'abc', '2026-10-07', '2026/10/07 10:30'].every((v) => Number.isNaN(parseInput(v, 'utc'))), '空 / 只有日期 / 别的格式 → NaN')
// 按键序列模拟：结束框的年份段从 2026 改成 2027（起始 2026-10-07 00:00Z，原时长 24 h）
{
  const t0 = Date.UTC(2026, 9, 7, 0, 0)
  let hours = 24
  const setEnd = (v) => { const h = hoursFromEnd(t0, parseInput(v, 'utc')); if (Number.isFinite(h)) hours = h }
  const seen = []
  for (const v of ['0002-10-08T00:00', '0020-10-08T00:00', '0202-10-08T00:00', '2027-10-08T00:00']) { setEnd(v); seen.push(hours) }
  ok(seen.join() === [24, 24, 24, (Date.UTC(2027, 9, 8) - t0) / 3600e3].join(), '逐键：半截年份不动时长，敲完的那一下才收', seen.join(' → '))
  hours = 24
  for (const v of ['2026-10-01T00:00', '2026-10-15T00:00']) setEnd(v)   // 日段先敲 1（早于起始，不收）再敲 5
  ok(hours === 8 * 24, '逐键：日段中途早于起始的那一下不收，敲完才收', hours + ' h')
}

// ③ 结束时刻 ⇄ 时长
ok(endFromHours(T, 6) === T + 6 * 3600e3 && endFromHours(T, '1.5') === T + 1.5 * 3600e3, 'endFromHours')
ok([0, -1, NaN, 'x'].every((h) => Number.isNaN(endFromHours(T, h))) && Number.isNaN(endFromHours(NaN, 6)), 'endFromHours 时长 ≤ 0 / 无效 → NaN')
ok(hoursFromEnd(T, T + 90 * 60000) === 1.5, 'hoursFromEnd')
ok(Number.isNaN(hoursFromEnd(T, T)) && Number.isNaN(hoursFromEnd(T, T - 1)), '结束不晚于起始 → NaN（保持原时长）')
ok(Number.isNaN(hoursFromEnd(T, T + 721 * 3600e3, 720)) && hoursFromEnd(T, T + 720 * 3600e3, 720) === 720, '上限：恰好等于上限收，超过 → NaN')
ok(Number.isNaN(hoursFromEnd(NaN, T)) && Number.isNaN(hoursFromEnd(T, NaN)), '起止任一无效 → NaN')

// ④ 界面接线
const ISL = src('src/components/LbIslRangeTool.vue')
ok(/import \{ inputText, parseInput, endFromHours, hoursFromEnd \} from '\.\.\/shared\/timeWindowInput\.js'/.test(ISL) && !ISL.includes('function toLocalInput'), '星间距离工具：读写走共用模块')
ok(/<span class="irt-l">起始时刻<\/span>\s*<input v-model="t0Local" type="datetime-local"/.test(ISL), '星间距离工具：起始时刻框')
ok(/<span class="irt-l">结束时刻<\/span>\s*<input v-model\.lazy="t1Local" type="datetime-local" class="irt-in mono" @blur="\$event\.target\.value = t1Local" \/>/.test(ISL), '星间距离工具：结束时刻框（改时长，失焦回到生效值）')
ok(ISL.includes("set: (v) => { const h = hoursFromEnd(t0Ms(), parseInput(v, 'local')); if (Number.isFinite(h)) hours.value = h }"), '星间距离工具：改结束时刻＝改时长')
ok(/<input v-model\.lazy="hoursText"[^>]*@blur="\$event\.target\.value = hoursText"/.test(ISL) && !/<select v-model\.number="hours"/.test(ISL), '星间距离工具：时长可任填（不再只有 1 h–3 天几档）')
ok(ISL.includes("if (!(hours.value > 0) || hours.value > MAX_HOURS) { err.value = '时长须大于 0 且不超过 720 h'; return }") && ISL.includes('const MAX_HOURS = 720'), '星间距离工具：时长上限 720 h 在「计算」时报出')
ok(ISL.includes('const t0ISO = computed(() => new Date(t0Ms()).toISOString())'), '星间距离工具：起始框读不出按时间轴此刻')

const CI = src('src/ci/CiApp.vue'), CIJ = src('src/ci/useInterference.js')
ok(/起始时刻 UTC<input type="datetime-local" :value="ngsoStartText" @change="setNgsoStart\(\$event\.target\.value\)" @blur="\$event\.target\.value = ngsoStartText" \/>/.test(CI), '干扰分析：起始时刻框（UTC）')
ok(/<button class="ci-btn" title="起始时刻取时间轴当前时刻" @click="I\.ngsoStartNow\(\)">此刻<\/button>/.test(CI), '干扰分析：「此刻」')
ok(/<label v-if="\(ngso\.epochs\.mode \|\| 'single'\) === 'single'" class="wide"[^>]*>结束时刻 UTC<input type="datetime-local" :value="ngsoEndText" @change="setNgsoEnd\(\$event\.target\.value\)" @blur="\$event\.target\.value = ngsoEndText" \/>/.test(CI), '干扰分析：结束时刻框只在单历元档出现（多历元每个历元各开一窗、回归周期档时窗另定）')
ok(CI.includes("function setNgsoEnd(v) { const h = hoursFromEnd(ngsoT0(), parseInput(v, 'utc')); if (Number.isFinite(h)) ngso.horizonH = +h.toFixed(6) }"), '干扰分析：改结束时刻＝改时窗')
ok(CIJ.includes('startIso: minuteIso(sceneNowMs()),') && CIJ.includes('function ngsoStartNow() { ngso.startIso = minuteIso(sceneNowMs()) }') && /computeNgso, cancelNgso, estimateNgso, loadRainCdf, ngsoStartNow,/.test(CIJ), '干扰分析：起始缺省取时间轴此刻（取整分），「此刻」再取一次')
ok(!/startIso: ngso\.startIso/.test(CIJ) && !/ngso: \{[^}\n]*startIso/.test(CIJ), '干扰分析：起始时刻不随配置存盘（每次打开取时间轴此刻）')
ok(CIJ.includes('const startMs = ngso.startIso ? Date.parse(ngso.startIso) : sceneNowMs()'), '干扰分析：计算按框里的起始时刻')

const ANA = src('src/model/AnalysisTab.vue')
ok(ANA.includes("import { inputText, parseInput, endFromHours, hoursFromEnd } from '../shared/timeWindowInput.js'") && !ANA.includes('function parseT('), '工作台分析：读写走共用模块（按显示时区档）')
ok(/<label title="[^"]*">终点<\/label>\s*<input class="ci ana-t0" type="datetime-local" :value="t1Text" @change="setT1\(\$event\.target\.value\)" @blur="\$event\.target\.value = t1Text" \/>/.test(ANA), '工作台分析：终点框（失焦回到生效值）')
ok(ANA.includes('function setT1(v) { const h = hoursFromEnd(W.t0, parseInput(v, W.tz), 8760); if (Number.isFinite(h)) setHours(h) }'), '工作台分析：改终点＝改时长（≤ 8760 h，与时长框同一上限）')
ok(ANA.includes('function setT0(v) { const t = parseInput(v, W.tz); if (!Number.isFinite(t)) return; W.t0 = t; ana.invalidate() }'), '工作台分析：起点半截年份不收')

console.log(`\n${pass} pass, ${fail} fail`)
if (fail) process.exit(1)
