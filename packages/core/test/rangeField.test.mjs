// 滑杆配数值框的纯逻辑（src/shared/ui/rangeFieldCore.js）：
//   ① 读数解析与倍率推断（18% ↔ 0.18、1.20× ↔ 1.2、0 值歧义、键入过台阶外的值）
//   ② 算式 / 全角 / 单位照抄 / 结尾 % 的键入
//   ③ 夹取与整数台阶取整（不吸附到台阶）
//   ④ 时刻文本解析
//   ⑤ 台阶口径：微调整齐档、读数横拖速率、落台阶、关节台阶（全库模板的台阶由 rangeSteps.test.mjs 逐条扫）
// 运行：npm test
import assert from 'node:assert'
import { normTyped, evalExpr, parseReadout, inferScale, settle, parseTyped, fmtDisplay, decimalsOf, parseDateTimeText, nudgeOf, nudgeTo, scrubRate, snapStep, fineStep } from '../../../src/shared/ui/rangeFieldCore.js'

let pass = 0
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); pass++ }
const near = (a, b, m, tol = 1e-12) => { assert.ok(Math.abs(a - b) <= tol, `${m}: ${a} vs ${b}`); pass++ }

// ① 读数解析
eq(parseReadout('18%'), { num: 18, numText: '18', dec: 0, pre: '', suf: '%' }, '百分数读数')
eq(parseReadout('1.20×'), { num: 1.2, numText: '1.20', dec: 2, pre: '', suf: '×' }, '倍率读数')
eq(parseReadout('1,000×').num, 1000, '千分位')
eq(parseReadout('−3.5 dB').num, -3.5, 'Unicode 减号')
eq(parseReadout('12dB').suf, 'dB', '单位后缀')
eq(parseReadout('—'), null, '无数字')

// 倍率推断
eq(inferScale(0.18, parseReadout('18%'), 0.01, 1), 100, '0.18 ↔ 18%')
eq(inferScale(1.2, parseReadout('1.20×'), 0.05, 2), 1, '1.2 ↔ 1.20×')
eq(inferScale(0.92, parseReadout('92'), 0.01, 1), 100, 'jpeg 质量 0.92 ↔ 92（无 % 号）')
eq(inferScale(0.452, parseReadout('45%'), 0.001, 1.2), 100, '缩放读数取整')
eq(inferScale(12, parseReadout('12'), 1, 32), 1, '字号')
eq(inferScale(0, parseReadout('0%'), 0.01, 1), 100, '0 值 + % + 上限 1 → 100')
eq(inferScale(0, parseReadout('0.00'), 0.05, 1), 1, '0 值无 % → 1')
eq(inferScale(0, parseReadout('0'), 1, 36), 1, '根数 0')
// 键入过 0.33（台阶 0.05）：模型 0.33、滑杆 DOM 被吸到 0.35 —— 放宽半台阶后仍认得是 1 倍
eq(inferScale(0.35, parseReadout('0.33'), 0.05, 1), 1, '台阶外的值')
eq(inferScale(0.35, parseReadout('33%'), 0.05, 1), 100, '台阶外的值（百分数）')
eq(inferScale(1.5, parseReadout('31.6×'), 0.01, 3), null, '对数刻度推不出线性倍率')

// ② 键入
eq(normTyped('１２．５'), '12.5', '全角数字')
eq(normTyped('（３＋１）×２'), '(3+1)*2', '全角括号与乘号')
eq(evalExpr('0.5*3'), 1.5, '乘法')
eq(evalExpr('(12+4)/2'), 8, '括号')
eq(evalExpr('-(-2)'), 2, '一元负号')
eq(evalExpr('1e-3'), 0.001, '科学计数')
eq(evalExpr('1,000'), 1000, '千分位逗号')
eq(evalExpr('2*'), NaN, '残缺算式')
eq(evalExpr('1/0'), NaN, '除零')
eq(evalExpr('alert(1)'), NaN, '非算式')
eq(evalExpr(''), NaN, '空')
eq(parseTyped('50%', '%'), 50, '照抄读数单位 %')
eq(parseTyped('1.5×', '×'), 1.5, '照抄读数单位 ×')
eq(parseTyped('50%', ''), 0.5, '无单位读数里打 50% = 0.5')
eq(parseTyped('３０', 'dB'), 30, '全角')
eq(parseTyped('12dB', 'dB'), 12, '带单位')
eq(parseTyped('abc', ''), NaN, '非法')

// ③ 夹取与取整
eq(settle(12, 0.1, 8, 0.1), { v: 8, clamped: true }, '越上界')
eq(settle(-1, 0, 1, 0.05), { v: 0, clamped: true }, '越下界')
eq(settle(0.33, 0, 1, 0.05), { v: 0.33, clamped: false }, '小数台阶不吸附')
eq(settle(33, 0, 100, 5), { v: 33, clamped: false }, '整数台阶不吸附到台阶')
eq(settle(12.6, 1, 32, 1), { v: 13, clamped: false }, '整数台阶按整数收')
eq(settle(100.4, 4, 2048, 4), { v: 100, clamped: false }, '像素')
eq(settle(0.1 + 0.2, 0, 1, 0.01).v, 0.3, '浮点噪声')
eq(settle(NaN, 0, 1, 0.1), null, 'NaN')
eq(fmtDisplay(0.35 * 100, 0), '35', '回填格式')
eq(fmtDisplay(1.25, 1), '1.3', '回填一位')
eq(decimalsOf(0.05), 2, '台阶小数位')
eq(decimalsOf(1e-7), 7, '科学计数小数位')

// ④ 时刻
const ref = { y: 2026, mo: 10, d: 14 }
eq(parseDateTimeText('2026-10-15 08:30:05', ref), { y: 2026, mo: 10, d: 15, h: 8, mi: 30, s: 5 }, '完整时刻')
eq(parseDateTimeText('2026/1/2 3:04', ref), { y: 2026, mo: 1, d: 2, h: 3, mi: 4, s: 0 }, '斜杠 + 省秒')
eq(parseDateTimeText('12:30', ref), { y: 2026, mo: 10, d: 14, h: 12, mi: 30, s: 0 }, '只打时分沿用日期')
eq(parseDateTimeText('１２：３０：１５', ref), { y: 2026, mo: 10, d: 14, h: 12, mi: 30, s: 15 }, '全角时分秒')
eq(parseDateTimeText('2026-10-20', ref), { y: 2026, mo: 10, d: 20, h: 0, mi: 0, s: 0 }, '只打日期 = 零点')
eq(parseDateTimeText('2026-10-20T06:00', ref).h, 6, 'ISO T')
eq(parseDateTimeText('25:00', ref), null, '小时越界')
eq(parseDateTimeText('12:30', null), null, '无参考日期')
eq(parseDateTimeText('hello', ref), null, '非时刻')
near(evalExpr('0.1+0.2'), 0.3, '加法', 1e-15)

// ⑤ 台阶口径：微调一档 = 约全程 1% 的整齐数；读数横拖按全程比例；关节台阶取 10 的整数次幂
eq(nudgeOf(0.1, 8, 0.01), 0.1, '线宽 → 0.1 一档')
eq(nudgeOf(0.5, 32, 0.1), 0.5, '字号 → 0.5 一档')
eq(nudgeOf(0, 1, 0.01), 0.01, '透明度 → 0.01 一档')
eq(nudgeOf(1, 64, 0.1), 1, '图标像素 → 1 一档')
eq(nudgeOf(0, 0.4, 0.001), 0.005, '描边比 → 0.005 一档')
eq(nudgeOf(1, 20, 0.1), 0.2, '滚轮比例 → 0.2 一档')
eq(nudgeOf(0, 36, 1), 1, '不细于台阶（根数）')
eq(nudgeOf(4, 2048, 1), 50, '台阶的整数倍')
eq(nudgeTo(12.37, 1, 0.5, 0.5, 32), 12.5, '拖出来的零碎值 ↑ 回到整齐数')
eq(nudgeTo(12.5, 1, 0.5, 0.5, 32), 13, '已在档上 ↑ 走一档')
eq(nudgeTo(12.37, -1, 0.5, 0.5, 32), 12, '↓ 同理')
eq(nudgeTo(12, -1, 0.5, 0.5, 32), 11.5, '已在档上 ↓ 走一档')
eq(nudgeTo(31.9, 1, 0.5, 0.5, 32), 32, '夹到上界')
eq(nudgeTo(0.3, 1, 0.1, 0.1, 8), 0.4, '浮点：0.3 / 0.1 不是整数也认在档上')
eq(nudgeTo(0.3, -1, 0.1, 0.1, 8), 0.2, '浮点（↓）')
near(scrubRate(0, 1, 0.01), 1 / 240, '横拖：240px 走完全程')
eq(scrubRate(0, 36, 1), 0.25, '横拖：粗台阶每档至少 4px')
eq(snapStep(3.237, 0.1, 8, 0.01), 3.24, '落到台阶')
eq(snapStep(0.333, 0.05, 1, 0.01), 0.33, '以 min 为基准')
eq(snapStep(9, 0.1, 8, 0.01), 8, '夹取')
eq(snapStep(0.12345, 0, 1, 0), 0.12345, '无台阶不吸附')
eq(fineStep(-180, 180, 1000), 0.1, '转角 360° → 0.1°')
eq(fineStep(0, 20, 1000), 0.01, '转角 20° → 0.01°')
eq(fineStep(0, 2, 1000), 0.001, '平移 2 → 0.001')
eq(fineStep(5, 5), 0.01, '零值域兜底')

console.log(`rangeField: ${pass} passed`)
