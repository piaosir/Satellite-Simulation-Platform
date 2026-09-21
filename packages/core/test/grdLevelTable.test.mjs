// 电平表纯函数（src/viz/grd/levelTable.js）：粘贴解析与生成器。运行：npm test
import assert from 'node:assert'
import { parseLevelValues, levelValuesText, levelValues } from '../../../src/viz/grd/levelTable.js'

let pass = 0
const ok = (c, m) => { assert.ok(c, m); pass++ }
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); pass++ }

// ---- 粘贴解析 ----
eq(parseLevelValues('-1 -2 -3'), [-1, -2, -3], '空格分隔')
eq(parseLevelValues('-1,-2,-3'), [-1, -2, -3], '逗号分隔')
eq(parseLevelValues('-1;-2;-3'), [-1, -2, -3], '分号分隔')
eq(parseLevelValues('-1\n-2\r\n-3'), [-1, -2, -3], '换行分隔（含 CRLF）')
eq(parseLevelValues('  42.5 ,, 41 \n 39.75  '), [42.5, 41, 39.75], '多余分隔与空白')
eq(parseLevelValues('-1 dB\t-2dB'), [-1, -2], '带单位后缀按数值前缀取')
eq(parseLevelValues('abc; ; --'), [], '全是非数值 → 空表')
eq(parseLevelValues(''), [], '空串')
eq(parseLevelValues(null), [], 'null')
eq(parseLevelValues('1e1 -0.5'), [10, -0.5], '科学计数与小数')

// ---- 复制文本 ----
eq(levelValuesText([-1, -2, -3]), '-1 -2 -3', '复制＝空格分隔')
eq(parseLevelValues(levelValuesText([-1.25, -3.5, 42])), [-1.25, -3.5, 42], '复制 → 粘贴回环')

// ---- 生成器 ----
eq(levelValues(-1, -1, 5), [-1, -2, -3, -4, -5], '起始 −1 间隔 −1 五档')
eq(levelValues(42, 0.5, 3), [42, 42.5, 43], '正间隔')
eq(levelValues(-3, 0, 2), [-3, -3], '零间隔（合法：两档同值）')
eq(levelValues(0, 0.1, 4), [0, 0.1, 0.2, 0.3], '浮点累加按 4 位收口（无 0.30000000000000004）')
ok(levelValues(0, 1, 0).length === 1, '档数 0 → 夹到 1 档')
ok(levelValues(0, 1, 999).length === 64, '档数上限 64')
ok(levelValues(0, 1, -5).length === 1, '负档数 → 夹到 1 档')
eq(levelValues(-1, -1, 2.6), [-1, -2, -3], '档数取整（2.6 → 3）')

console.log(`grdLevelTable.test.mjs：${pass} 条断言全绿`)
