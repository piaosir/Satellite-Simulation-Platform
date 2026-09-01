// 显示时区档位自测（src/shared/tz.js）。运行：npm test
// 被测文件是渲染端 ESM（不依赖 Vue/DOM），故本测试自身也是 .mjs。
//
// 这一层回答的是「屏上那个时刻是哪个时区的时刻」。会出错的地方全在【分量取值与反解】上：
//   ① 取分量 —— 固定偏移档不能再走 utc?getUTC*:get* 那种两分支（它只有两档，第三档必错）；
//   ② 往返闭合 —— 屏上读到什么，键入同一串就得跳回同一瞬间（「跳到时刻」/ 时窗起点两处靠它）；
//   ③ 刻度午夜对齐 —— 主刻度必须落在【显示档位】的整点上，否则标签一片 xx:37 的碎数；
//   ④ 本机档随夏令时逐时刻取偏移 —— 拿此刻的偏移去格式化半年前的时刻会整体偏 1 h；
//   ⑤ 老存档 —— NGSO 的 'beijing' 档折成 +480，越界值退回默认档而不是把界面钉在 NaN 上。
import { tzOffMin, tzOffLabel, tzTag, tzParts, tzToMs, tzOptions, normTzMode, isFixedTz, TZ_HOUR_MIN, TZ_HOUR_MAX } from '../../../src/shared/tz.js'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const p2 = (n) => String(n).padStart(2, '0')
const fmt = (ms, mode) => { const t = tzParts(ms, mode); return `${t.y}-${p2(t.mo)}-${p2(t.d)} ${p2(t.h)}:${p2(t.mi)}:${p2(t.s)}` }
const LOCAL_OFF = -new Date().getTimezoneOffset()

// ==================== ① 取分量 ====================
{
  const T = Date.UTC(2026, 7, 31, 12, 2, 45)   // 2026-08-31 12:02:45 UTC
  ok('① UTC 档', fmt(T, 'utc') === '2026-08-31 12:02:45', fmt(T, 'utc'))
  ok('① 固定 +8', fmt(T, 480) === '2026-08-31 20:02:45', fmt(T, 480))
  ok('① 固定 −5', fmt(T, -300) === '2026-08-31 07:02:45', fmt(T, -300))
  ok('① 固定 −12（边界档）', fmt(T, -720) === '2026-08-31 00:02:45', fmt(T, -720))
  ok('① 固定 +14 跨到次日', fmt(T, 840) === '2026-09-01 02:02:45', fmt(T, 840))
  ok('① 半时区偏移（本机档在印度等地就是这个数）', fmt(T, 330) === '2026-08-31 17:32:45', fmt(T, 330))
  // 本机档＝运行机自己的换算，与 Date 的 get* 逐字段一致（这一档的口径就是「平台原来那一档」）
  const d = new Date(T), t = tzParts(T, 'local')
  ok('① 本机档与 Date.get* 逐字段一致',
    t.y === d.getFullYear() && t.mo === d.getMonth() + 1 && t.d === d.getDate() && t.h === d.getHours() && t.mi === d.getMinutes() && t.s === d.getSeconds(),
    fmt(T, 'local'))
  ok('① 偏移量：UTC=0 / 固定档取自身 / 本机档取系统',
    tzOffMin('utc', T) === 0 && tzOffMin(-300, T) === -300 && tzOffMin('local', T) === -new Date(T).getTimezoneOffset())
}

// ==================== ② 往返闭合 ====================
{
  const CASES = [Date.UTC(2026, 0, 15, 3, 4, 5), Date.UTC(2026, 6, 15, 21, 44, 5), Date.UTC(2026, 2, 8, 7, 30, 0), Date.UTC(2026, 10, 1, 5, 30, 0)]
  for (const mode of ['utc', 'local', 480, -300, -720, 840, 330]) {
    let good = true, wrong = ''
    for (const base of CASES) {
      const t = tzParts(base, mode)
      const back = tzToMs(mode, t.y, t.mo, t.d, t.h, t.mi, t.s)
      if (back !== base) { good = false; wrong = fmt(base, mode) }
    }
    ok('② 往返闭合 · 档位 ' + String(mode), good, wrong || '4 个时刻全闭合')
  }
  ok('② 缺秒按 0 补', tzToMs(480, 2026, 8, 31, 20, 2) === Date.UTC(2026, 7, 31, 12, 2, 0))
  ok('② 日期残缺给 NaN（调用方据此不落库）', Number.isNaN(tzToMs(480, NaN, 8, 31, 0, 0, 0)))
}

// ==================== ③ 刻度午夜对齐（computeTicks 里那条式子） ====================
{
  // 时间轴主刻度以「左边缘所在日的午夜」为基准，午夜必须是【显示档位】的午夜
  const midnightOf = (leftMs, mode) => {
    const off = tzOffMin(mode, leftMs) * 60000
    const d = new Date(leftMs + off)
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - off
  }
  for (const mode of ['utc', 'local', 480, -300, 840, 330]) {
    const left = Date.UTC(2026, 7, 31, 15, 37, 12)
    const mid = midnightOf(left, mode), t = tzParts(mid, mode), h6 = tzParts(mid + 6 * 3600000, mode)
    ok('③ 午夜对齐 · 档位 ' + String(mode),
      t.h === 0 && t.mi === 0 && t.s === 0 && mid <= left && left - mid < 26 * 3600000 && h6.mi === 0 && h6.s === 0,
      `${fmt(mid, mode)} ｜ +6h → ${fmt(mid + 6 * 3600000, mode)}`)
  }
}

// ==================== ④ 本机档跟着夏令时走 ====================
{
  // 运行机在无夏令时的时区（如国内）时这一条恒成立且无信息量，故只在两个偏移真的不同时才判
  const jan = Date.UTC(2026, 0, 15, 17, 0, 0), jul = Date.UTC(2026, 6, 15, 17, 0, 0)
  const oJan = tzOffMin('local', jan), oJul = tzOffMin('local', jul)
  if (oJan === oJul) {
    ok('④ 本机时区无夏令时（本机 ' + tzOffLabel(LOCAL_OFF) + '，跳过）', true)
  } else {
    ok('④ 冬夏两个时刻各按各的偏移换算',
      tzParts(jan, 'local').h === new Date(jan).getHours() && tzParts(jul, 'local').h === new Date(jul).getHours(),
      `${tzOffLabel(oJan)} / ${tzOffLabel(oJul)}`)
    ok('④ 角标也跟着那一刻走（不是拿此刻的偏移糊全年）', tzTag('local', jan) !== tzTag('local', jul))
  }
  // 固定档恒不动：这正是它与本机档的分界（STK 的 UTC offset 同口径）
  ok('④ 固定档不含夏令时', tzOffMin(-300, jan) === -300 && tzOffMin(-300, jul) === -300)
}

// ==================== ⑤ 角标 / 老存档 / 菜单 ====================
{
  ok('⑤ 角标：0 → UTC，整点不带分', tzOffLabel(0) === 'UTC' && tzOffLabel(480) === 'UTC+8' && tzOffLabel(840) === 'UTC+14')
  ok('⑤ 角标：负号是 U+2212（与时间读数同一个字面）', tzOffLabel(-300) === 'UTC−5', tzOffLabel(-300))
  ok('⑤ 角标：半时区带分', tzOffLabel(330) === 'UTC+5:30' && tzOffLabel(-210) === 'UTC−3:30')
  ok('⑤ 老存档 beijing → +480（NGSO 那一档）', normTzMode('beijing') === 480)
  ok('⑤ 存档里的数字串也认（localStorage 存的是 String）', normTzMode('480') === 480 && normTzMode(480) === 480)
  ok('⑤ 越界 / 乱码 / 缺省退回默认档',
    normTzMode(9999, 'local') === 'local' && normTzMode('乱码', 'utc') === 'utc' && normTzMode(undefined, 'local') === 'local' && normTzMode(null, 'utc') === 'utc')
  ok('⑤ 档位判别', isFixedTz(480) && !isFixedTz('utc') && !isFixedTz('local'))

  const opts = tzOptions(Date.UTC(2026, 7, 31, 12, 0, 0))
  ok('⑤ 菜单 = 本机 + UTC + 整点偏移（去掉 0，不与 UTC 撞）', opts.length === 2 + (TZ_HOUR_MAX - TZ_HOUR_MIN), String(opts.length))
  ok('⑤ 菜单次序：本机 → UTC → −12 … +14',
    opts[0].value === 'local' && opts[1].value === 'utc' && opts[2].value === TZ_HOUR_MIN * 60 && opts[opts.length - 1].value === TZ_HOUR_MAX * 60)
  ok('⑤ 菜单标签互不重复', new Set(opts.map((o) => o.label)).size === opts.length)
  ok('⑤ 本机档在菜单里带当刻偏移角标', opts[0].tag === tzOffLabel(LOCAL_OFF), opts[0].tag)
  ok('⑤ 每个菜单档位都能真的拿去格式化', opts.every((o) => /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(fmt(Date.now(), o.value))))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
