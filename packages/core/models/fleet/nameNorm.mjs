// 名称归一（与 autoMatch.normalizeName 同式：NFKC 全角→半角、大写、空白折叠）。
// 单独成叶子模块：autoMatch 要 import 精模的 matchFleet，这里若反过来 import autoMatch 就成环。
export function normalizeName(s) {
  return String(s ?? '').normalize('NFKC').toUpperCase().replace(/\s+/g, ' ').trim()
}
