// 冒烟测试：验证链路引擎在纯 Node 环境下可计算（不依赖 Electron / 任何 npm 包）
// 运行： node packages/core/smoke-test.js

const core = require('./index.js');

console.log('=== satlink-core 冒烟测试 ===\n');

// GEO：传入最小参数（Ku 频段），其余走引擎内置默认
const r = core.calculateLinkBudget({ frequencyBand: 'Ku', satelliteName: '测试星' }, {});
console.log('[GEO] success =', r.success);
if (!r.success) {
  console.error('[GEO] 计算失败：', r.message);
  process.exit(1);
}
const data = r.data || {};
const keys = Object.keys(data);
console.log('[GEO] 结果字段数 =', keys.length);

// 打印若干标量结果（自动挑前 24 个 number/string 字段）
const scalars = keys
  .filter((k) => ['number', 'string'].includes(typeof data[k]))
  .slice(0, 24);
for (const k of scalars) {
  const v = data[k];
  console.log('   ', k, '=', typeof v === 'number' ? Number(v.toFixed ? v.toFixed(3) : v) : v);
}

console.log('\n[NGSO] 引擎可用 =', typeof core.calculateLinkBudgetNGSO === 'function');
console.log('\n=== 冒烟测试通过：引擎在桌面端 Node 可运行 ===');
