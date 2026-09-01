// 调制方式的单一口径：制式族 + 星座阶数 M ⇄ 名字 ⇄ 调制因子（bit/符号）。
//
// 由来：全平台原先只有一张写死的名字→因子对照表（constants.js 的 MODULATION_FACTORS），
// 查不到就 `|| 2` 静默按 QPSK 算。于是「表里填一个没有的调制方式」不会报错，只会把符号率、
// 载波带宽、门限换算整条链悄悄算错 2 倍——最难查的那一类。
//
// 现在名字不再是唯一入口：任何 `M + 族后缀` 的名字都能解析出因子，而 M 限定为 2 的整数次幂
// （2…4096）。这不是偷懒的正则：现行体制里星座阶数恒是 2 的幂，log2(M) 才是整数 bit/符号；
// 放开成任意 M 就等于允许「6PSK」这种既不存在、又算出 2.585 bit/符号的东西。
//
// 三个族（对齐工程界的写法，也对齐用户给的那套 Modulation 面板）：
//   M-PSK  —— M=2 即「1 bit/符号」(BPSK)，M=4 即 QPSK，再往上按 8PSK/16PSK… 写
//   M-APSK —— DVB-S2/S2X 的环状星座
//   M-QAM  —— 方形/十字星座（3GPP NR 与地面链路常用）
// 「1 bit/符号」不另立一族：它就是 M-PSK 的 M=2，两处都留反而会造出两个都叫 BPSK 的选项。

const { MODULATION_FACTORS, MODULATION_OPTIONS } = require('./constants.js');

const ORDER_MIN = 2;
const ORDER_MAX = 4096;   // 12 bit/符号，远超现行体制（256APSK = 8）

const MOD_FAMILIES = [
  { key: 'psk', label: 'M-PSK', suffix: 'PSK' },
  { key: 'apsk', label: 'M-APSK', suffix: 'APSK' },
  { key: 'qam', label: 'M-QAM', suffix: 'QAM' }
];

// M 必须是 [2, 4096] 内 2 的整数次幂
function isValidOrder(m) {
  const n = Number(m);
  return Number.isInteger(n) && n >= ORDER_MIN && n <= ORDER_MAX && (n & (n - 1)) === 0;
}
// 该族允许的 M 列表（下拉里逐项列出，用户也可直接键入）
function ordersOf(familyKey) {
  const out = [];
  for (let m = ORDER_MIN; m <= (familyKey === 'qam' ? 4096 : 1024); m *= 2) {
    if (familyKey === 'apsk' && m < 16) continue;   // APSK 环状星座从 16 起（8APSK 现行标准里没有）
    if (familyKey === 'qam' && m < 4) continue;     // 2QAM 不存在
    out.push(m);
  }
  return out;
}

// 该族是否允许这个 M（APSK 从 16 起、QAM 从 4 起，见 ordersOf）
const isValidOrderFor = (familyKey, m) => isValidOrder(m) && ordersOf(familyKey).indexOf(Number(m)) > -1;

// 族 + M → 规范名。M-PSK 的 2 / 4 按行业写法出 BPSK / QPSK，不写 2PSK / 4PSK。
function composeModulation(familyKey, order) {
  const fam = MOD_FAMILIES.find((f) => f.key === familyKey);
  if (!fam || !isValidOrderFor(familyKey, order)) return '';
  const m = Number(order);
  if (fam.key === 'psk') { if (m === 2) return 'BPSK'; if (m === 4) return 'QPSK'; }
  return String(m) + fam.suffix;
}

// 名字 → { family, order, factor }；解析不出返回 null（调用方据此判「这不是一个调制方式」）
const NAME_RE = /^(\d+)\s*(APSK|QAM|PSK)$/i;
function parseModulation(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s) return null;
  const up = s.toUpperCase();
  if (up === 'BPSK') return { family: 'psk', order: 2, factor: 1 };
  if (up === 'QPSK') return { family: 'psk', order: 4, factor: 2 };
  const m = NAME_RE.exec(up);
  if (!m) return null;
  const order = Number(m[1]);
  const fam = MOD_FAMILIES.find((f) => f.suffix === m[2].toUpperCase());
  // ★ 阶数按族收紧（APSK 从 16 起、QAM 从 4 起）：让「合法的调制方式」全平台只有一种口径 ——
  //   表格里挡下 8APSK，引擎却认得它，两处对不上迟早出「界面不让填、老配置却算得出」的怪事
  if (!fam || !isValidOrderFor(fam.key, order)) return null;
  return { family: fam.key, order, factor: Math.round(Math.log2(order)) };
}

/**
 * 调制因子（bit/符号）。
 * ★ 查不到返回 null 而不是回落到 2 —— 「不知道」和「等于 QPSK」是两件事，
 *   让调用方自己决定要不要兜底（现有各处一律 `?? 2`，行为与改动前逐位相同）。
 */
function modFactorOf(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s) return null;
  if (MODULATION_FACTORS[s] != null) return MODULATION_FACTORS[s];              // 先查内置名（含 8QAM 这类不按 log2 记的历史条目）
  const up = s.toUpperCase();
  for (const k of Object.keys(MODULATION_FACTORS)) if (k.toUpperCase() === up) return MODULATION_FACTORS[k];
  const p = parseModulation(s);
  return p ? p.factor : null;
}
// 是不是一个平台认得的调制方式
const isKnownModulation = (name) => modFactorOf(name) != null;

/**
 * 下拉用的选项表：内置那 11 项在前（照 MODULATION_OPTIONS 的顺序），
 * 再把 extra 里能解析、又不在内置表里的名字补在后面（表里既有的自定义档不能从自己的下拉里消失）。
 * 每项带 family / order / factor，供界面分组与读数。
 */
function modulationOptions(extra) {
  const seen = new Set();
  const out = [];
  const push = (value) => {
    const key = String(value).toUpperCase();
    if (!value || seen.has(key)) return;
    const p = parseModulation(value);
    const factor = modFactorOf(value);
    if (factor == null) return;
    seen.add(key);
    out.push({ value, label: value, family: p ? p.family : null, order: p ? p.order : null, factor });
  };
  for (const o of MODULATION_OPTIONS) push(o.value);
  for (const v of (extra || [])) push(v);
  return out;
}

module.exports = {
  MOD_FAMILIES, ORDER_MIN, ORDER_MAX,
  isValidOrder, isValidOrderFor, ordersOf, composeModulation, parseModulation, modFactorOf, isKnownModulation, modulationOptions
};
