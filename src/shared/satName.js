// 卫星库条目名跟随所选星（GEO / NGSO / 再生式共用口径）。
//
// 库条目名是「配置」标签，不等于星名——同一颗星常有多份转发器/工作点配置（如「CS10R C12B」
// 「CS10R C13B」），所以不能无脑把条目名钉死成星名。但条目名若从来没被用户改过，换星后留着
// 上一颗星的名字就是错的：曾出现「条目名 GPS BIIR-5（PRN 22） / 实选 QIANFAN-1」的错位，
// 加上方向图那颗星，一个配置里能同时报出三个星名。
//
// 判据：名字仍等于上一颗星的星名（＝一直跟着星走，没被自定义过），或还是新建时的默认名。
// 满足才跟随，否则一律不动用户自己起的名字。
export const isAutoSatCfgName = (nm) => {
  const s = String(nm == null ? '' : nm).trim()
  return !s || s === '默认卫星' || /^卫星\d+( \d+)*$/.test(s)
}

// cfg: 卫星库条目；prevSatName: 取星前的星名；nextSatName: 新星名；siblings: 同库全部条目（重名自动加序号）
export function followSatCfgName(cfg, prevSatName, nextSatName, siblings) {
  const next = String(nextSatName == null ? '' : nextSatName).trim()
  if (!cfg || !next) return false
  const cur = String(cfg.name == null ? '' : cfg.name).trim()
  const prev = String(prevSatName == null ? '' : prevSatName).trim()
  if (!(isAutoSatCfgName(cur) || (prev && cur === prev))) return false
  if (cur === next) return false
  const taken = new Set((siblings || []).filter((c) => c !== cfg).map((c) => String(c.name == null ? '' : c.name).trim()))
  let out = next
  if (taken.has(out)) { let i = 2; while (taken.has(next + ' ' + i)) i++; out = next + ' ' + i }
  cfg.name = out
  return true
}
