// 滚轮缩放口径自测（src/shared/wheelStep.js）。运行：npm test
//
// 一句口径：一格滚轮 = 底部状态栏那条缩放读数走 p 个百分点。判据全从这句话来：
//   ① 什么算「一格」（三种 deltaMode + 平滑滚动拆成的小事件）；
//   ② p=3 时一格恰好 0.03（两张图同一把尺子）；
//   ③ 两端钳在 0 / 1.2，不越界；
//   ④ 方向不变：deltaY > 0 = 缩小 = t 减小。
import { wheelNotches, stepZoomT } from '../../../src/shared/wheelStep.js'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const near = (a, b, eps = 1e-12) => Math.abs(a - b) <= eps
const TMAX = 1.2

// ==================== ① 什么算一格 ====================
{
  ok('① deltaY=100（Windows 标准鼠标）= 1 格', wheelNotches({ deltaY: 100, deltaMode: 0 }) === 1)
  ok('① deltaY=−100 = −1 格', wheelNotches({ deltaY: -100, deltaMode: 0 }) === -1)
  ok('① 不给 deltaMode 也按像素算', wheelNotches({ deltaY: 100 }) === 1)
  ok('① deltaMode=1（行）三行 = 1 格', wheelNotches({ deltaY: 3, deltaMode: 1 }) === 1)
  ok('① deltaMode=1 一行 = 1/3 格', near(wheelNotches({ deltaY: 1, deltaMode: 1 }), 1 / 3))
  ok('① deltaMode=2（页）一页 = 1 格', wheelNotches({ deltaY: 1, deltaMode: 2 }) === 1)
  ok('① deltaY=0 / 非数 / 空事件 → 0 格',
    wheelNotches({ deltaY: 0 }) === 0 && wheelNotches({ deltaY: NaN }) === 0 && wheelNotches({}) === 0 && wheelNotches(null) === 0)
}

// ==================== ② p=3 一格恰好 0.03 ====================
{
  const t1 = stepZoomT(0.5, wheelNotches({ deltaY: -100 }), 3, TMAX)
  ok('② 向上滚一格：0.5 → 0.53', near(t1, 0.53, 1e-12), `${t1}`)
  const t2 = stepZoomT(0.5, wheelNotches({ deltaY: 100 }), 3, TMAX)
  ok('② 向下滚一格：0.5 → 0.47（方向不变）', near(t2, 0.47, 1e-12), `${t2}`)

  // 改成 10 立刻就是 10 个百分点
  ok('② p=10 一格走 0.10', near(stepZoomT(0.5, 1, 10, TMAX), 0.40, 1e-12))
  ok('② p=1 一格走 0.01（与 ± 按钮同步）', near(stepZoomT(0.5, 1, 1, TMAX), 0.49, 1e-12))
  ok('② p=20 一格走 0.20', near(stepZoomT(0.5, -1, 20, TMAX), 0.70, 1e-12))
  ok('② 不给 p 时回落 3', near(stepZoomT(0.5, 1, undefined, TMAX), 0.47, 1e-12))
}

// ==================== ③ 平滑滚动 / 精密触控板 ====================
{
  // 四个 25 像素的小事件 = 一格
  let t = 0.5
  for (let i = 0; i < 4; i++) t = stepZoomT(t, wheelNotches({ deltaY: -25 }), 3, TMAX)
  ok('③ 四个 25 px 小事件之和 = 一格', near(t, 0.53, 1e-12), `${t}`)

  // 十个 10 像素也一样
  let u = 0.5
  for (let i = 0; i < 10; i++) u = stepZoomT(u, wheelNotches({ deltaY: -10 }), 3, TMAX)
  ok('③ 十个 10 px 小事件之和 = 一格', near(u, 0.53, 1e-12), `${u}`)

  // 一次给两格（快滚）
  ok('③ 一次 deltaY=200 = 两格', near(stepZoomT(0.5, wheelNotches({ deltaY: -200 }), 3, TMAX), 0.56, 1e-12))
}

// ==================== ④ 两端钳住 ====================
{
  ok('④ 缩到底钳在 0', stepZoomT(0.02, 5, 3, TMAX) === 0)
  ok('④ 放到底钳在 1.2', stepZoomT(1.19, -5, 3, TMAX) === 1.2)
  ok('④ 已在 0 继续缩仍是 0', stepZoomT(0, 1, 3, TMAX) === 0)
  ok('④ 已在 1.2 继续放仍是 1.2', stepZoomT(1.2, -1, 3, TMAX) === 1.2)
  ok('④ 不给 tmax 时按 1.2', stepZoomT(1.19, -5, 3) === 1.2)
  ok('④ 起点非数按 0 起算', near(stepZoomT(NaN, -1, 3, TMAX), 0.03, 1e-12))
  ok('④ 零格不动', stepZoomT(0.5, 0, 3, TMAX) === 0.5)
}

// ==================== ⑤ 来回滚可逆（无累积漂移） ====================
{
  let t = 0.6
  for (let i = 0; i < 50; i++) t = stepZoomT(t, 1, 3, TMAX)     // 先缩 50 格（中途会撞底）
  for (let i = 0; i < 50; i++) t = stepZoomT(t, -1, 3, TMAX)    // 再放 50 格
  ok('⑤ 撞底之后回不到原处是对的（钳位不可逆）', t === 1.2, `${t}`)

  let s = 0.6
  for (let i = 0; i < 10; i++) s = stepZoomT(s, 1, 3, TMAX)
  for (let i = 0; i < 10; i++) s = stepZoomT(s, -1, 3, TMAX)
  ok('⑤ 不撞底则来回精确回原处', near(s, 0.6, 1e-12), `${s}`)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
