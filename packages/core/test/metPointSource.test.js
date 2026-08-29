// metPointSource.test.js — 「站点值跟时间轴」的取数判定（metFetchPlan.pointSourceAt）
//
// 为什么这一段单独立测：按点的天气 API 只有**当前实况**与**未来逐小时预报**两样东西，没有历史。
// 于是「拖时间轴看该时刻的站点值」变成一个三分支判定，而三个边界（本小时 / 时效末尾 /
// 过去一小时）在真实时钟下极难复现。错一格的表现不是报错，是**表上有数、但那个数不是这一刻的**
// —— 比报错难发现得多，故判定必须是纯函数并在这里钉死。
const plan = require('../utils/metFetchPlan.js');

let pass = 0, fail = 0;
const ok = (n, v, extra) => { console.log((v ? 'PASS' : 'FAIL') + '  ' + n + (extra ? '   ' + extra : '')); v ? pass++ : fail++; };

const H = 3600000;
// 现在 = 2026-08-29 11:37Z（刻意不在整点上：整点对齐是这段逻辑的一半）
const NOW = Date.parse('2026-08-29T11:37:24Z');
const nowH = Date.parse('2026-08-29T11:00:00Z');
const at = (iso) => Date.parse(iso);

console.log('\n=== 三分支：过去 / 本小时 / 未来 ===');
ok('本小时 → 实况观测', plan.pointSourceAt(NOW, NOW, 0).mode === 'obs');
ok('本小时整点 → 实况观测', plan.pointSourceAt(nowH, NOW, 0).mode === 'obs');
ok('上一小时 → 仍算实况（就近整点，容一格）', plan.pointSourceAt(at('2026-08-29T10:30:00Z'), NOW, 0).mode === 'obs');
ok('★ 再往前一小时 → past，如实没有（不拿"现在"的观测冒充过去）',
  plan.pointSourceAt(at('2026-08-29T09:00:00Z'), NOW, 0).mode === 'past');
ok('往后一小时以上 → 逐小时预报', plan.pointSourceAt(at('2026-08-29T13:00:00Z'), NOW, 0).mode === 'fcst');

console.log('\n=== 整点对齐（逐小时产品只给整点，取值一律就近对齐）===');
ok('11:37 → 12:00（就近，不是向下取整）', plan.pointSourceAt(NOW, NOW, 0).tgt === at('2026-08-29T12:00:00Z'),
  new Date(plan.pointSourceAt(NOW, NOW, 0).tgt).toISOString());
ok('11:20 → 11:00', plan.pointSourceAt(at('2026-08-29T11:20:00Z'), NOW, 0).tgt === nowH);
ok('缺时刻 → 落在本小时', plan.pointSourceAt(NaN, NOW, 0).tgt === nowH && plan.pointSourceAt(NaN, NOW, 0).mode === 'obs');
// ★ 11:37 就近对齐到 12:00 —— 12:00 > nowH=11:00，若判定用的是「tgt > nowH ⇒ 预报」而不留
//   这一格容差，一打开界面（时钟就是现在）就会去买一次预报，而人要的只是"现在"的实况。
ok('★ 就近对齐到下一个整点时仍判为实况（否则一开界面就误买预报）',
  plan.pointSourceAt(NOW, NOW, 0).mode === 'obs');

console.log('\n=== 请求档：一次买够整条时间轴 ===');
const f6 = plan.pointSourceAt(at('2026-08-29T17:00:00Z'), NOW, 0);
ok('只看 +6 h → 落在最小档 24 h', f6.want === 24, `want=${f6.want} aheadH=${f6.aheadH}`);
const f6h48 = plan.pointSourceAt(at('2026-08-29T17:00:00Z'), NOW, 48 * H);
ok('★ 时间轴长 48 h 时，看 +6 h 也按 72 h 档买（拖到末帧不必再花一次请求）',
  f6h48.want === 72, `want=${f6h48.want}`);
ok('时间轴 120 h → 168 h 档', plan.pointSourceAt(at('2026-08-30T00:00:00Z'), NOW, 120 * H).want === 168);
ok('时间轴 300 h → 顶到 240 h 档（不越界）', plan.pointSourceAt(at('2026-08-30T00:00:00Z'), NOW, 300 * H).want === 240);
ok('档位一律取自给定档表', [24, 72, 168, 240].includes(plan.pointSourceAt(at('2026-08-31T00:00:00Z'), NOW, 0).want));

console.log('\n=== 时效边界（240 h）===');
ok('+240 h 仍在时效内', plan.pointSourceAt(nowH + 240 * H, NOW, 0).mode === 'fcst');
ok('★ +241 h 超时效 → far，留白而不是拿末帧顶替', plan.pointSourceAt(nowH + 241 * H, NOW, 0).mode === 'far');
ok('超时效时不给 want（不去发一次注定没用的请求）', plan.pointSourceAt(nowH + 300 * H, NOW, 0).want === null);
// horizonMs 只抬请求档，不该把「能不能看」这件事一起抬掉
ok('★ horizon 很长也不能让超时效的时刻变成可取',
  plan.pointSourceAt(nowH + 400 * H, NOW, 400 * H).mode === 'far');

console.log('\n=== 自定义档表 ===');
const c = plan.pointSourceAt(nowH + 30 * H, NOW, 0, [12, 48]);
ok('按传入的档表取档', c.want === 48, `want=${c.want}`);
ok('自定义档表的上限即时效', plan.pointSourceAt(nowH + 60 * H, NOW, 0, [12, 48]).mode === 'far');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
