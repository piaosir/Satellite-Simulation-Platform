// 分享包 v3（配置多选 + 资源库多选）的编解码 / 依赖闭包 / 并库计划自测。运行：npm test
// 被测文件是渲染端 ESM（src/shared/lbShare.js），故本测试自身也是 .mjs。
//
// 关键不变式：
//   ① 编解码往返逐字段相等，中文与嵌套结构不失真；v1/v2 老包永远读得进来（v2 挂在 items[] 上的
//      lib 要被提到包级——那正是 v2 时代被 normItems 抹掉、导致对端静默算错的那份数据）；
//   ② 依赖闭包与引擎的解析顺序一致：空引用 = 库里第一份、未知 id 先按名字兜底再落第一份，
//      「打包进去的那一条」必须正是「对端会算的那一条」；
//   ③ 打包净化：本机资源指针（GEO/NGSO 的 grd、再生式的 ngsoSat.folder）一律剥掉，且
//      ngsoSat.mode 从 'tree' 降为 'manual'——否则对端会拿到「轨道号称来自天线树、树里却没这颗星」
//      的破状态，NGSO 那条 grd.satFolder 非空 ⟺ mode==='tree' 的不变式也会被打破；
//   ④ 宽松指纹只放过「被我们主动剥掉的那几项」：同参数同轨道 ⇒ 复用本机那颗星（沿用本机方向图），
//      参数或轨道不同 ⇒ 必须新建，绝不能并成一条；
//   ⑤ 计划即落盘：planImport 报的复用/新增/加序号，adoptLib 必须一字不差地执行；
//   ⑥ 体制不匹配的包一律拒收（而不是导进去再被过滤掉，让用户对着空列表发懵）。
import {
  encodeShare, decodeShare, bundleFileText, normalizeBundle, makeBundle, describeBundle, legacyItemsOf,
  resolveRefs, resolveRefId, lockedRefsOf, packEntry, packLib, planImport, adoptLib, pathOf, strictFp, looseFp, emptyLib
} from '../../../src/shared/lbShare.js'
import { stableStringify } from '../../../src/shared/configDirty.js'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
function throws(name, fn, want) {
  let msg = ''
  try { fn(); } catch (e) { msg = String(e && e.message || e) }
  ok(name, msg && (!want || msg.includes(want)), msg || '（没抛错）')
}

// —— 三个体制的库 spec（与各 App 里声明的一致，见 LinkBudgetApp / NgsoLinkBudgetApp / RegenLinkBudgetApp）——
const blankGrd = () => ({ satFolder: '', eirpKey: '', gtKey: '' })
const normGrd = (g) => ({ satFolder: (g && g.satFolder) || '', eirpKey: (g && g.eirpKey) || '', gtKey: (g && g.gtKey) || '' })
const baseEntry = (c) => ({ id: c.id, name: c.name, nameAuto: !!c.nameAuto, form: c.form })
let seq = 0
const mkSpec = (kind, arr, extra) => ({
  arr, label: kind, keys: [], pack: baseEntry, makeNew: () => ({ id: kind + '_n' + (++seq), name: '', form: {} }), ...extra
})
// GEO：卫星条目带 grd（方向图匹配），打包时清空
const geoSatSpec = (arr) => mkSpec('sat', arr, {
  keys: ['grd'],
  pack: (c) => ({ ...baseEntry(c), grd: normGrd(c.grd) }),
  sanitize: (e) => ({ ...e, grd: blankGrd() }),
  makeNew: () => ({ id: 'sat_n' + (++seq), name: '', form: {}, grd: blankGrd() })
})
// NGSO：卫星条目带 ngsoSat（轨道来源）+ grd；打包时清空 grd 并把 mode:'tree' 降为 'manual'
const blankNs = () => ({ mode: 'manual', orbit: null, name: '', noradId: null })
const ngsoSatSpec = (arr) => mkSpec('sat', arr, {
  keys: ['ngsoSat', 'grd'],
  pack: (c) => ({ ...baseEntry(c), ngsoSat: c.ngsoSat || blankNs(), grd: normGrd(c.grd) }),
  sanitize: (e) => ({ ...e, grd: blankGrd(), ngsoSat: { ...(e.ngsoSat || blankNs()), mode: (e.ngsoSat && e.ngsoSat.mode) === 'tree' ? 'manual' : ((e.ngsoSat && e.ngsoSat.mode) || 'manual') } }),
  makeNew: () => ({ id: 'sat_n' + (++seq), name: '', form: {}, ngsoSat: blankNs(), grd: blankGrd() })
})
// 再生式：树取星的 folder 在 ngsoSat 里
const regenSatSpec = (arr) => mkSpec('sat', arr, {
  keys: ['ngsoSat'],
  pack: (c) => ({ ...baseEntry(c), ngsoSat: c.ngsoSat || { mode: 'manual', orbit: null, name: '', noradId: null, folder: '' } }),
  sanitize: (e) => ({ ...e, ngsoSat: { ...(e.ngsoSat || {}), folder: '', mode: (e.ngsoSat && e.ngsoSat.mode) === 'tree' ? 'manual' : ((e.ngsoSat && e.ngsoSat.mode) || 'manual') } })
})

console.log('=== 链路预算分享包：编解码 / 闭包 / 并库计划 ===\n')

// ① 编解码往返
{
  const bundle = makeBundle({
    mod: 'GEO', from: 'master1',
    configs: [{ name: 'Ka 上行余量 3 dB', path: ['Ka 关口站', '试验'], state: { v: 2, rows: [{ stationId: 'es2', basebandId: 'bb1' }], satId: 'sat1' } }],
    lib: { es: [{ id: 'es2', name: '干线站 3.7m', form: { antennaDiameter: '3.7' } }], carrier: [], sat: [] }
  })
  const code = encodeShare(bundle)
  ok('分享码带 LBCFG1. 前缀', code.startsWith('LBCFG1.'))
  const back = decodeShare(code)
  ok('往返：配置名（中文）不失真', back.configs[0].name === 'Ka 上行余量 3 dB')
  ok('往返：文件夹路径不失真', back.configs[0].path.join('/') === 'Ka 关口站/试验')
  ok('往返：整包逐字段相等', stableStringify(back) === stableStringify(bundle))
  ok('往返：夹在聊天记录里也认得出', decodeShare('看下这个：\n' + code + '\n（发你了）').configs.length === 1)
  ok('文件文本可直读回来', stableStringify(decodeShare(bundleFileText(bundle))) === stableStringify(bundle))
  const d = describeBundle(bundle)
  ok('摘要计数正确', d.nConfig === 1 && d.nLib === 1, d.text)
}

// ② v1 / v2 兼容读
{
  const v1 = { app: 'satlink', kind: 'lbcfg', v: 1, name: '老配置', state: { rows: [] } }
  const b1 = normalizeBundle(v1)
  ok('v1 裸配置升级为 v3', b1.v === 3 && b1.configs.length === 1 && b1.configs[0].name === '老配置')
  // v2：lib 挂在 items 上（在线信箱那条路才带得出来），必须被提到包级
  const v2 = {
    app: 'satlink', kind: 'lbcfg', v: 2,
    items: [
      { name: 'A', state: { rows: [{ stationId: 'es1' }] }, lib: { es: [{ id: 'es1', name: '关口站', form: { antennaDiameter: '6.2' } }], carrier: [], sat: [] } },
      { name: 'B', state: { rows: [{ stationId: 'es1' }] }, lib: { es: [{ id: 'es1', name: '关口站', form: { antennaDiameter: '6.2' } }], carrier: [], sat: [] } }
    ]
  }
  const b2 = normalizeBundle(v2)
  ok('v2 两条配置都在', b2.configs.length === 2)
  ok('v2 的 items[].lib 提到包级并按 id 去重', b2.lib.es.length === 1 && b2.lib.es[0].name === '关口站')
  ok('v2 无 mod 字段 → 不拒收（按当前窗口处理）', b2.mod === '')
  throws('空包抛错', () => normalizeBundle({ configs: [], lib: emptyLib() }), '为空')
  throws('垃圾输入抛错', () => decodeShare('随便一段不是分享码的文字'), '格式不对')
  throws('空文本抛错', () => decodeShare('   '), '内容为空')
  const legacy = legacyItemsOf(makeBundle({ mod: 'GEO', configs: [{ name: 'A', state: { rows: [] } }], lib: { es: [{ id: 'es1', name: 'X', form: {} }], carrier: [], sat: [] } }))
  ok('给老客户端的 items[] 每条都挂着 lib', legacy.length === 1 && legacy[0].lib.es.length === 1)
  ok('只带库的包不给 items[]（老客户端本就处理不了）', legacyItemsOf(makeBundle({ mod: 'GEO', configs: [], lib: { es: [{ id: 'es1', name: 'X', form: {} }], carrier: [], sat: [] } })) === null)
}

// ③ 依赖闭包：与引擎解析顺序一致
{
  const libs = {
    es: [{ id: 'es1', name: '关口站' }, { id: 'es2', name: '干线站' }, { id: 'es3', name: '便携站' }],
    carrier: [{ id: 'bb1', name: '默认' }, { id: 'bb2', name: 'DVB' }],
    sat: [{ id: 'sat1', name: '中星6D' }, { id: 'sat2', name: '亚太6E' }]
  }
  const r = resolveRefs({ es: ['es3', '', 'es2'], carrier: [''], sat: ['sat2'] }, libs)
  ok('空引用解析成库里第一份', r.es.has('es1'), [...r.es].join(','))
  ok('显式引用原样保留', r.es.has('es3') && r.es.has('es2'))
  ok('载波空引用 → bb1', r.carrier.size === 1 && r.carrier.has('bb1'))
  ok('卫星按 id 命中', r.sat.size === 1 && r.sat.has('sat2'))
  const byName = resolveRefs({ es: ['干线站'], carrier: [], sat: [] }, libs)
  ok('未知 id 先按名字兜底（防御旧数据，与 resolveEs 同序）', byName.es.has('es2'))
  const miss = resolveRefs({ es: ['esXXX'], carrier: [], sat: [] }, libs)
  ok('名字也没命中 → 落第一份', miss.es.has('es1'))
  // resolveRefId：三窗打包前「把空引用钉成显式 id」都走它（sharePinRefs）
  ok('resolveRefId 空串 → 首条', resolveRefId(libs.es, '') === 'es1')
  ok('resolveRefId 命中 id', resolveRefId(libs.es, 'es3') === 'es3')
  ok('resolveRefId 按名字兜底', resolveRefId(libs.es, '便携站') === 'es3')
  ok('resolveRefId 空库 → 空串（不造 id）', resolveRefId([], 'es1') === '')
  // 多个场景的并集
  const refsOf = (st) => ({ es: st.rows.flatMap((x) => [x.stationId, x.rxStationId]), carrier: st.rows.map((x) => x.basebandId), sat: [st.satId] })
  const locked = lockedRefsOf([
    { rows: [{ stationId: 'es1', rxStationId: 'es2', basebandId: 'bb2' }], satId: 'sat1' },
    { rows: [{ stationId: 'es3', rxStationId: '', basebandId: '' }], satId: '' }
  ], refsOf, libs)
  ok('多场景闭包取并集', [...locked.es].sort().join(',') === 'es1,es2,es3', [...locked.es].join(','))
  ok('闭包含空引用解析出的首条', locked.carrier.has('bb1') && locked.carrier.has('bb2') && locked.sat.has('sat1'))
}

// ④ 打包净化：本机资源指针一律剥掉
{
  const geoSat = { id: 'sat1', name: '中星6D', nameAuto: false, form: { orbitPosition: '110.5' }, grd: { satFolder: 'lb:sat1', eirpKey: 'A|0', gtKey: 'B|0' } }
  const g = packEntry(geoSatSpec([geoSat]), geoSat)
  ok('GEO：方向图匹配被清空', g.grd.satFolder === '' && g.grd.eirpKey === '' && g.grd.gtKey === '')
  ok('GEO：参数照带', g.form.orbitPosition === '110.5' && g.name === '中星6D')

  const ngSat = { id: 'sat1', name: 'QIANFAN-1', form: { frequencyBand: 'Ku' }, grd: { satFolder: 'lb:sat1', eirpKey: 'A|0', gtKey: '' }, ngsoSat: { mode: 'tree', orbit: { a: 7000, i: 89 }, name: 'QIANFAN-1', noradId: 12345 } }
  const n = packEntry(ngsoSatSpec([ngSat]), ngSat)
  ok('NGSO：方向图匹配被清空', n.grd.satFolder === '')
  ok('NGSO：mode 从 tree 降为 manual（守住 grd 非空 ⟺ mode===tree 的不变式）', n.ngsoSat.mode === 'manual')
  ok('NGSO：轨道/星名/NORAD 是自包含数据，照带', n.ngsoSat.orbit.a === 7000 && n.ngsoSat.noradId === 12345 && n.ngsoSat.name === 'QIANFAN-1')

  const rgSat = { id: 'sat1', name: '再生星', form: {}, ngsoSat: { mode: 'tree', orbit: { a: 8000 }, name: 'X', noradId: 7, folder: 'grd:9' } }
  const rg = packEntry(regenSatSpec([rgSat]), rgSat)
  ok('再生式：取星 folder 被清空、mode 降级', rg.ngsoSat.folder === '' && rg.ngsoSat.mode === 'manual' && rg.ngsoSat.orbit.a === 8000)

  // 打包只收闭包里的那几条
  const arr = [{ id: 'es1', name: 'A', form: { d: '6.2' } }, { id: 'es2', name: 'B', form: { d: '3.7' } }, { id: 'es3', name: 'C', form: { d: '1.2' } }]
  const packed = packLib({ es: mkSpec('es', arr), carrier: mkSpec('carrier', []), sat: mkSpec('sat', []) }, { es: new Set(['es1', 'es3']), carrier: new Set(), sat: new Set() })
  ok('packLib 只收闭包内的条目', packed.es.map((e) => e.name).join(',') === 'A,C')
}

// ⑤ 并库计划：复用 / 宽松复用 / 新增加序号
{
  // 本机库：关口站 6.2m 已有；卫星「中星6D」参数相同但【本机已配好方向图】
  const es = [{ id: 'es1', name: '关口站 6.2m', form: { antennaDiameter: '6.2' } }, { id: 'es2', name: '干线站 3.7m', form: { antennaDiameter: '3.7' } }]
  const sat = [{ id: 'sat1', name: '中星6D', form: { orbitPosition: '110.5' }, grd: { satFolder: 'lb:sat1', eirpKey: 'ANT|0', gtKey: 'ANT|1' } }]
  const ctx = {
    mod: 'GEO',
    lib: { es: mkSpec('es', es), carrier: mkSpec('carrier', []), sat: geoSatSpec(sat) },
    getConfigs: () => []
  }
  const bundle = makeBundle({
    mod: 'GEO',
    configs: [],
    lib: {
      es: [
        { id: 'X1', name: '关口站 6.2m', form: { antennaDiameter: '6.2' } },     // 同内容 → 复用
        { id: 'X2', name: '关口站 6.2m', form: { antennaDiameter: '9.0' } },     // 异内容同名 → 新增加序号
        { id: 'X3', name: '新站型', form: { antennaDiameter: '4.5' } }           // 全新
      ],
      carrier: [],
      sat: [{ id: 'S1', name: '中星6D', form: { orbitPosition: '110.5' }, grd: { satFolder: '', eirpKey: '', gtKey: '' } }]
    }
  })
  const plan = planImport(bundle, ctx)
  const byId = Object.fromEntries(plan.lib.map((r) => [r.srcId, r]))
  ok('同内容 → 复用本机条目', byId.X1.action === 'reuse' && byId.X1.targetId === 'es1')
  ok('异内容同名 → 新增并加序号', byId.X2.action === 'new' && byId.X2.finalName === '关口站 6.2m 2', byId.X2.finalName)
  ok('全新条目 → 新增，名字原样', byId.X3.action === 'new' && byId.X3.finalName === '新站型')
  ok('卫星宽松复用（方向图沿用本机匹配）', byId.S1.action === 'reuse-loose' && byId.S1.targetId === 'sat1')
  ok('计数正确', plan.counts.libNew === 2 && plan.counts.libReuse === 2, `新增${plan.counts.libNew} 复用${plan.counts.libReuse}`)

  // 落盘要与计划一字不差
  const idMap = adoptLib(plan, ctx)
  ok('复用不新建条目（2 条本机 + 2 条新增，X1/S1 都没落地成新条目）', es.length === 4 && sat.length === 1, `es=${es.length} sat=${sat.length}`)
  ok('idMap：复用指向本机既有 id', idMap.es.X1 === 'es1' && idMap.sat.S1 === 'sat1')
  ok('idMap：新增指向新条目', !!idMap.es.X2 && idMap.es.X2 !== 'es1' && es.some((c) => c.id === idMap.es.X2))
  ok('新增条目按计划的名字落地', es.find((c) => c.id === idMap.es.X2).name === '关口站 6.2m 2')
  ok('新增条目参数照搬', es.find((c) => c.id === idMap.es.X2).form.antennaDiameter === '9.0')
  ok('并进来的名字钉成自定义（不替别人的库改名）', es.find((c) => c.id === idMap.es.X2).nameAuto === false)
  ok('本机那颗星的方向图没被动过', sat[0].grd.satFolder === 'lb:sat1')
}

// ⑤b 宽松指纹的边界：只放过被剥掉的那几项
{
  const local = [{ id: 'sat1', name: '本机星', form: { orbitPosition: '110.5' }, ngsoSat: { mode: 'tree', orbit: { a: 7000 }, name: 'A', noradId: 1 }, grd: { satFolder: 'lb:sat1', eirpKey: 'K', gtKey: '' } }]
  const spec = ngsoSatSpec(local)
  const same = { id: 'S', name: '来包星', form: { orbitPosition: '110.5' }, ngsoSat: { mode: 'manual', orbit: { a: 7000 }, name: 'A', noradId: 1 }, grd: { satFolder: '', eirpKey: '', gtKey: '' } }
  ok('同参数同轨道 → 宽松命中（不凭空多出一条重复星）', looseFp(spec, local[0]) === strictFp(spec, same))
  const diffOrbit = { ...same, ngsoSat: { ...same.ngsoSat, orbit: { a: 7200 } } }
  ok('轨道不同 → 宽松也不命中（两颗不同的星，绝不并成一条）', looseFp(spec, local[0]) !== strictFp(spec, diffOrbit))
  const diffForm = { ...same, form: { orbitPosition: '92.2' } }
  ok('参数不同 → 宽松也不命中', looseFp(spec, local[0]) !== strictFp(spec, diffForm))
  // 没声明 sanitize 的库（地球站/载波）不启用宽松匹配
  const esSpec = mkSpec('es', [{ id: 'es1', name: 'A', form: { d: '6.2' } }])
  ok('地球站库无 sanitize → 宽松指纹等同严格指纹', looseFp(esSpec, esSpec.arr[0]) === strictFp(esSpec, esSpec.arr[0]))
}

// ⑥ 体制隔离
{
  const ctx = { mod: 'GEO', lib: { es: mkSpec('es', []), carrier: mkSpec('carrier', []), sat: mkSpec('sat', []) }, getConfigs: () => [] }
  const plan = planImport(makeBundle({ mod: 'NGSO', configs: [{ name: 'X', state: { rows: [] } }], lib: emptyLib() }), ctx)
  ok('NGSO 的包在 GEO 窗口被拒收', !!plan.reject, plan.reject)
  ok('拒收信息点名了体制', plan.reject.includes('NGSO'))
  const okPlan = planImport(makeBundle({ mod: 'GEO', configs: [{ name: 'X', state: { rows: [] } }], lib: emptyLib() }), ctx)
  ok('同体制放行', !okPlan.reject)
  const oldPlan = planImport({ v: 2, items: [{ name: 'X', state: { rows: [] } }] }, ctx)
  ok('无 mod 的 GEO 老包放行（GEO 场景本就不带 orbitType）', !oldPlan.reject)
  // 老包（v2，无 mod）也要拦得住：NGSO/再生式的场景自带 state.orbitType，据此认体制
  const oldNgso = planImport({ v: 2, items: [{ name: 'X', state: { v: 2, orbitType: 'NGSO', rows: [] } }] }, ctx)
  ok('无 mod 的 NGSO 老包按 state.orbitType 认出并拒收', !!oldNgso.reject, oldNgso.reject)
}

// ⑦ 文件夹计划 + 配置重名
{
  const items = [
    { id: 'f1', type: 'folder', name: 'Ka 关口站', parentId: null },
    { id: 'c1', name: '已有配置', parentId: 'f1', state: {} },
    { id: 'c2', name: '根上的配置', parentId: null, state: {} }
  ]
  const ctx = { mod: 'GEO', lib: { es: mkSpec('es', []), carrier: mkSpec('carrier', []), sat: mkSpec('sat', []) }, getConfigs: () => items }
  const plan = planImport(makeBundle({
    mod: 'GEO', lib: emptyLib(),
    configs: [
      { name: '甲', path: ['Ka 关口站'], state: { rows: [] } },              // 文件夹已存在 → 复用
      { name: '乙', path: ['Ka 关口站', '试验'], state: { rows: [] } },      // 子文件夹要新建
      { name: '丙', path: ['Ka 关口站', '试验'], state: { rows: [] } },      // 同一个新文件夹，只建一次
      { name: '已有配置', path: ['Ka 关口站'], state: { rows: [] } },        // 同文件夹重名 → 加序号
      { name: '根上的配置', path: [], state: { rows: [] } }                  // 根目录重名 → 加序号
    ]
  }), ctx)
  const f = Object.fromEntries(plan.folders.map((x) => [x.name, x]))
  ok('已存在的文件夹被复用', f['Ka 关口站'] && f['Ka 关口站'].id === 'f1')
  ok('缺失的子文件夹计划新建', f['试验'] && f['试验'].id === null && f['试验'].parentKey === plan.folders[0].key)
  ok('共享路径前缀的文件夹只建一次', plan.counts.folderNew === 1, `folderNew=${plan.counts.folderNew}`)
  const byName = Object.fromEntries(plan.configs.map((c) => [c.srcName, c]))
  ok('同文件夹重名 → 加序号', byName['已有配置'].finalName === '已有配置 2' && byName['已有配置'].renamed)
  ok('根目录重名 → 加序号', byName['根上的配置'].finalName === '根上的配置 2')
  ok('不重名的原样', byName['甲'].finalName === '甲' && !byName['甲'].renamed)
  ok('路径文案可读', byName['乙'].pathText === 'Ka 关口站 / 试验', byName['乙'].pathText)
  ok('根目录路径文案', byName['根上的配置'].pathText === '（根目录）')
  // 同一批里两个同名配置进同一个新文件夹，也要各自唯一
  const plan2 = planImport(makeBundle({ mod: 'GEO', lib: emptyLib(), configs: [{ name: '同', path: ['新'], state: {} }, { name: '同', path: ['新'], state: {} }] }), ctx)
  ok('同批同名同目录 → 第二条加序号', plan2.configs[1].finalName === '同 2', plan2.configs[1].finalName)
}

// ⑧ pathOf：打包时取配置在树里的文件夹路径
{
  const items = [
    { id: 'f1', type: 'folder', name: '一层', parentId: null },
    { id: 'f2', type: 'folder', name: '二层', parentId: 'f1' },
    { id: 'c1', name: '深处的配置', parentId: 'f2', state: {} },
    { id: 'c2', name: '根上的', parentId: null, state: {} },
    { id: 'c3', name: '孤儿', parentId: 'nope', state: {} }
  ]
  ok('多层路径按根→叶', pathOf(items[2], items).join('/') === '一层/二层')
  ok('根上的配置路径为空', pathOf(items[3], items).length === 0)
  ok('孤儿（parentId 指向不存在的项）落根', pathOf(items[4], items).length === 0)
}

// ⑨ 同一个包连导两次：第二次应当全部命中复用（幂等，不会每导一次多一堆重复条目）
{
  const es = [{ id: 'es1', name: '关口站', form: { d: '6.2' } }]
  const ctx = { mod: 'GEO', lib: { es: mkSpec('es', es), carrier: mkSpec('carrier', []), sat: mkSpec('sat', []) }, getConfigs: () => [] }
  const bundle = makeBundle({ mod: 'GEO', configs: [], lib: { es: [{ id: 'X', name: '新站', form: { d: '4.5' } }], carrier: [], sat: [] } })
  const p1 = planImport(bundle, ctx); adoptLib(p1, ctx)
  ok('第一次导入：新增', p1.counts.libNew === 1 && es.length === 2)
  const p2 = planImport(bundle, ctx); const map2 = adoptLib(p2, ctx)
  ok('第二次导入：全部复用，库不再长', p2.counts.libNew === 0 && es.length === 2, `es=${es.length}`)
  ok('第二次的 idMap 指向第一次建的那条', map2.es.X === es[1].id)
}

// ⑩ 同一个包里出现两条一模一样的条目 → 只建一条，两个旧 id 都映射到它
{
  const es = []
  const ctx = { mod: 'GEO', lib: { es: mkSpec('es', es), carrier: mkSpec('carrier', []), sat: mkSpec('sat', []) }, getConfigs: () => [] }
  const plan = planImport(makeBundle({ mod: 'GEO', configs: [], lib: { es: [{ id: 'A', name: '站', form: { d: '6.2' } }, { id: 'B', name: '站', form: { d: '6.2' } }], carrier: [], sat: [] } }), ctx)
  const map = adoptLib(plan, ctx)
  ok('同批重复内容只建一条', es.length === 1, `es=${es.length}`)
  ok('两个旧 id 都映射到同一条', map.es.A === map.es.B && map.es.A === es[0].id)
}

// ⑪ 三个体制各自的「引用闭包 → 打包钉死 → 并库改写」三件套。
// 三个 App 里的 shareRefsOf / sharePinRefs / shareRemap 是各体制的镜像实现，这里按同一份口径校核它们的语义：
// 打包时空引用必须被钉成显式 id（否则到了对端就成了「用他库里第一份」——同一个包在两台机器上算出不同的数），
// 并库后每一处引用都必须换成本机 id（不留一个对端的 id）。
{
  const libs = {
    es: [{ id: 'es1', name: 'A' }, { id: 'es2', name: 'B' }],
    carrier: [{ id: 'bb1', name: 'C' }, { id: 'bb2', name: 'D' }],
    sat: [{ id: 'sat1', name: 'S1' }, { id: 'sat2', name: 'S2' }]
  }
  // —— GEO / NGSO：单一链路表 rows[]（发端 + 收端 + 载波）+ 场景级单选卫星 ——
  const geoRefs = (st) => {
    if (!st || !Array.isArray(st.rows)) return { es: [], carrier: [], sat: [] }
    const es = [], carrier = []
    for (const r of st.rows) { es.push(r.stationId || '', r.rxStationId || ''); carrier.push(r.basebandId || '') }
    return { es, carrier, sat: [st.satId || ''] }
  }
  const geoPin = (st) => {
    const s = JSON.parse(JSON.stringify(st))
    for (const r of s.rows) { r.stationId = resolveRefId(libs.es, r.stationId); r.rxStationId = resolveRefId(libs.es, r.rxStationId); r.basebandId = resolveRefId(libs.carrier, r.basebandId) }
    s.satId = resolveRefId(libs.sat, s.satId)
    return s
  }
  const geoRemap = (s, m) => {
    for (const r of s.rows) { if (r.stationId) r.stationId = m.es[r.stationId] || ''; if (r.rxStationId) r.rxStationId = m.es[r.rxStationId] || ''; if (r.basebandId) r.basebandId = m.carrier[r.basebandId] || '' }
    if (s.satId) s.satId = m.sat[s.satId] || ''
  }
  const geoSt = { v: 2, rows: [{ stationId: 'es2', rxStationId: '', basebandId: '' }], satId: '' }
  const gPinned = geoPin(geoSt)
  ok('GEO/NGSO：空引用被钉成显式 id', gPinned.rows[0].rxStationId === 'es1' && gPinned.rows[0].basebandId === 'bb1' && gPinned.satId === 'sat1',
    JSON.stringify(gPinned.rows[0]) + ' sat=' + gPinned.satId)
  ok('GEO/NGSO：闭包含钉死后的全部引用', (() => { const r = resolveRefs(geoRefs(gPinned), libs); return r.es.has('es1') && r.es.has('es2') && r.carrier.has('bb1') && r.sat.has('sat1') })())
  geoRemap(gPinned, { es: { es1: 'X1', es2: 'X2' }, carrier: { bb1: 'Y1' }, sat: { sat1: 'Z1' } })
  ok('GEO/NGSO：并库后引用全换成本机 id', gPinned.rows[0].stationId === 'X2' && gPinned.rows[0].rxStationId === 'X1' && gPinned.rows[0].basebandId === 'Y1' && gPinned.satId === 'Z1')

  // —— 再生式：四张表（地面上/下行 tx·rx + 星间微波 isl + 星间激光 laser），卫星按行引用 ——
  const rgRefs = (st) => {
    if (!st || !(st.v >= 2)) return { es: [], carrier: [], sat: [] }
    const es = [], carrier = [], sat = []
    for (const r of [...(st.tx || []), ...(st.rx || [])]) { es.push(r.stationId || ''); carrier.push(r.basebandId || ''); sat.push(r.satelliteId || '') }
    for (const r of [...(st.isl || []), ...(st.laser || [])]) { carrier.push(r.basebandId || ''); sat.push(r.txSatelliteId || '', r.rxSatelliteId || '') }
    return { es, carrier, sat }
  }
  const rgPin = (st) => {
    if (!st || !(st.v >= 2)) return st            // 旧结构自带内嵌库，原样带走（与三个 App 的 sharePinRefs 同一道门）
    const s = JSON.parse(JSON.stringify(st))
    for (const r of [...(s.tx || []), ...(s.rx || [])]) { r.stationId = resolveRefId(libs.es, r.stationId); r.basebandId = resolveRefId(libs.carrier, r.basebandId); r.satelliteId = resolveRefId(libs.sat, r.satelliteId) }
    for (const r of [...(s.isl || []), ...(s.laser || [])]) { r.basebandId = resolveRefId(libs.carrier, r.basebandId); r.txSatelliteId = resolveRefId(libs.sat, r.txSatelliteId); r.rxSatelliteId = resolveRefId(libs.sat, r.rxSatelliteId) }
    return s
  }
  const rgRemap = (s, m) => {
    for (const r of [...(s.tx || []), ...(s.rx || [])]) { if (r.stationId) r.stationId = m.es[r.stationId] || ''; if (r.basebandId) r.basebandId = m.carrier[r.basebandId] || ''; if (r.satelliteId) r.satelliteId = m.sat[r.satelliteId] || '' }
    for (const r of [...(s.isl || []), ...(s.laser || [])]) { if (r.basebandId) r.basebandId = m.carrier[r.basebandId] || ''; if (r.txSatelliteId) r.txSatelliteId = m.sat[r.txSatelliteId] || ''; if (r.rxSatelliteId) r.rxSatelliteId = m.sat[r.rxSatelliteId] || '' }
  }
  const rgSt = {
    v: 2, orbitType: 'REGEN',
    tx: [{ stationId: 'es2', basebandId: 'bb2', satelliteId: '' }],
    rx: [{ stationId: '', basebandId: '', satelliteId: 'sat2' }],
    isl: [{ basebandId: '', txSatelliteId: 'sat1', rxSatelliteId: '' }],
    laser: [{ basebandId: 'bb2', txSatelliteId: '', rxSatelliteId: 'sat2' }]
  }
  const rPinned = rgPin(rgSt)
  ok('再生式：四张表的空引用都被钉死', rPinned.rx[0].stationId === 'es1' && rPinned.tx[0].satelliteId === 'sat1' && rPinned.isl[0].rxSatelliteId === 'sat1' && rPinned.laser[0].txSatelliteId === 'sat1')
  const rRefs = resolveRefs(rgRefs(rPinned), libs)
  ok('再生式：闭包覆盖三库（星间行不带地球站）', rRefs.es.size === 2 && rRefs.carrier.size === 2 && rRefs.sat.size === 2,
    `es=${rRefs.es.size} carrier=${rRefs.carrier.size} sat=${rRefs.sat.size}`)
  rgRemap(rPinned, { es: { es1: 'X1', es2: 'X2' }, carrier: { bb1: 'Y1', bb2: 'Y2' }, sat: { sat1: 'Z1', sat2: 'Z2' } })
  const allIds = [rPinned.tx[0].stationId, rPinned.tx[0].basebandId, rPinned.tx[0].satelliteId, rPinned.rx[0].stationId, rPinned.rx[0].basebandId, rPinned.rx[0].satelliteId,
    rPinned.isl[0].basebandId, rPinned.isl[0].txSatelliteId, rPinned.isl[0].rxSatelliteId, rPinned.laser[0].basebandId, rPinned.laser[0].txSatelliteId, rPinned.laser[0].rxSatelliteId]
  ok('再生式：并库后没有一个对端 id 残留', allIds.every((v) => /^[XYZ]\d$/.test(v)), allIds.join(','))
  // 旧结构（v1，无 v 字段）自带内嵌库 → 不做闭包也不钉引用，原样带走交给 applyState 迁移
  ok('旧结构场景不参与闭包（自带内嵌库）', (() => { const r = rgRefs({ tx: [{ stationId: 'es2' }] }); return !r.es.length && !r.carrier.length && !r.sat.length })())
  const legacySt = { tx: [{ stationId: 'es2' }] }
  ok('旧结构场景不被钉引用（原样返回同一份，不误伤内嵌库的引用）', rgPin(legacySt) === legacySt)
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
