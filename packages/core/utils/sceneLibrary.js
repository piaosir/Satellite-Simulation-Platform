// utils/sceneLibrary.js
// 应用场景仿真 —— 模块库的「内置 + 用户改写」合并层（纯 JS，平台无关）。
//
// 与 MODCOD 库（modcodTables.js）同一套形制，理由也一样：
// ★ 改写层【只存差异】，不存整份快照。没被动过的模块照旧吃内置表，于是软件升级时新增的模块、
//   修正过的参数能直接生效。若存整份快照，用户只改过一条 Ka 固定站的口径，其余一百多条就永远
//   冻结在他第一次打开这个页面的那个版本上 —— 这是同类「可编辑预设」最常见的坑。
//
// 存储形状（userData/data/sceneModules.json）：
//   { version: 1,
//     overrides: { '<内置 id>': { ...被改过的字段... } },   // 深合并回内置条目
//     custom:    [ { id: 'usr:xxxx', ... 完整条目 } ],       // 用户自建模块
//     hidden:    ['<内置 id>'] }                             // 用户隐藏的内置条目（不删，可恢复）
//
// ★ 自建 id 用 'usr:' 前缀与内置分家：改名不会让已存场景里的 libId 指空。

'use strict';

const A = require('./sceneLibData.js');
const B = require('./sceneLibData2.js');
const M = require('./sceneMedia.js');

const USER_PREFIX = 'usr:';
const isUserId = (id) => String(id == null ? '' : id).startsWith(USER_PREFIX);

// ── 内置表（两份数据文件拼成一张）──
// ★ 装载时先过一遍 JSON 往返：数据文件里的构造器（mk / B）用 Object.assign 拼壳，
//   没给的可选字段会留下一个【值为 undefined 的自有键】（children、rf、sense 之类）。
//   clone() 走 JSON 会把这些键丢掉，于是 base 有键、cur 没键 —— deepDiff 把它判成
//   「用户删了这个字段」，一条没改的模块也会记出 {children:null} 的差异。
//   实测：只改一条 Ka 固定站，改写层里记出 132 条 —— 「只存差异」当场破功。
//   在这里一次性归一，base 与 cur 从此结构可比。
const BUILTIN = JSON.parse(JSON.stringify([].concat(
  A.SATS, A.STATIONS, B.PLATFORMS, B.SENSORS, B.EDGE, B.RFPARTS, B.POWER, B.CENTER
)));
const BUILTIN_BY_ID = Object.create(null);
for (const m of BUILTIN) {
  if (BUILTIN_BY_ID[m.id]) throw new Error('[sceneLibrary] 内置模块 id 重复：' + m.id);
  BUILTIN_BY_ID[m.id] = m;
}

// ── 分类 ──
const CATS = [
  { key: 'A', zh: '空间段', en: 'Space segment', hint: '提供转发或再生的卫星' },
  { key: 'B', zh: '地面固定站', en: 'Fixed ground station', hint: '不动的射频接入点' },
  { key: 'C', zh: '移动平台', en: 'Mobile platform', hint: '会动的载体与动中通终端' },
  { key: 'D', zh: '感知末端', en: 'Sensing endpoint', hint: '业务流的源头' },
  { key: 'E', zh: '汇聚与边缘', en: 'Aggregation & edge', hint: '把多路末端并成一路上星' },
  { key: 'F', zh: '射频器件', en: 'RF components', hint: '天线与馈线，挂在别的模块上' },
  { key: 'G', zh: '供电', en: 'Power supply', hint: '决定占空比与可用度' },
  { key: 'H', zh: '中心与平台', en: 'Centre & platform', hint: '链路的落地终点' }
];

const GROUPS = {
  'geo-cn': '中国卫通 GEO', 'leo-iot': '低轨物联网星座', generic: '通用模板',
  vsat: '卫星宽带终端', 'iot-leo': '低轨物联终端', hub: '主站与信关站',
  'satcom-mobile': '动中通终端', lowalt: '低空无人终端', uav: '无人机与航空器',
  robot: '机器人', marine: '海上载体', vehicle: '车辆与工程机械', person: '人员',
  power: '电力', water: '水利', emergency: '应急与地灾', eco: '林草与生态',
  transport: '交通', video: '视频', gateway: '网关与终端', edge: '边缘计算',
  net: '网络设备', access: '接入与电台', pole: '智慧杆', antenna: '天线',
  rfpart: '射频部件', center: '中心平台', misc: '其他'
};

// ── 工具 ──
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

/** 深合并：src 覆盖 dst，数组整体替换（端口清单不做逐项合并，那会合出四不像） */
function deepMerge(dst, src) {
  if (src == null) return dst;
  if (Array.isArray(src) || typeof src !== 'object') return clone(src);
  const out = (dst && typeof dst === 'object' && !Array.isArray(dst)) ? Object.assign({}, dst) : {};
  for (const k of Object.keys(src)) out[k] = deepMerge(out[k], src[k]);
  return out;
}

/** 深比较取差异：返回 cur 相对 base 变了的部分（数组只要不逐位相等就整体记）。无差异返回 null */
function deepDiff(base, cur) {
  if (cur === undefined) return undefined;
  if (base === cur) return undefined;
  const bo = base && typeof base === 'object', co = cur && typeof cur === 'object';
  if (!bo || !co || Array.isArray(base) !== Array.isArray(cur)) {
    return JSON.stringify(base) === JSON.stringify(cur) ? undefined : clone(cur);
  }
  if (Array.isArray(cur)) return JSON.stringify(base) === JSON.stringify(cur) ? undefined : clone(cur);
  const out = {};
  let has = false;
  for (const k of Object.keys(cur)) {
    const d = deepDiff(base[k], cur[k]);
    if (d !== undefined) { out[k] = d; has = true; }
  }
  // base 有而 cur 没有的键：记成 null（显式删除），否则「删掉一个端口」存不下来。
  // base[k] 本身就是 undefined 的不算删除 —— 那是构造器留下的空键，不是用户动过。
  for (const k of Object.keys(base)) {
    if (!(k in cur) && base[k] !== undefined) { out[k] = null; has = true; }
  }
  return has ? out : undefined;
}

// ── 改写层归一 ──
function normalizeStore(v) {
  const s = { version: 1, overrides: {}, custom: [], hidden: [] };
  if (!v || typeof v !== 'object') return s;
  if (v.overrides && typeof v.overrides === 'object') {
    for (const k of Object.keys(v.overrides)) {
      if (BUILTIN_BY_ID[k] && v.overrides[k] && typeof v.overrides[k] === 'object') s.overrides[k] = clone(v.overrides[k]);
    }
  }
  if (Array.isArray(v.custom)) {
    const seen = new Set();
    for (const m of v.custom) {
      if (!m || typeof m !== 'object') continue;
      let id = String(m.id || '');
      if (!isUserId(id)) id = USER_PREFIX + (id || Math.random().toString(36).slice(2, 10));
      if (seen.has(id) || BUILTIN_BY_ID[id]) continue;
      seen.add(id);
      s.custom.push(Object.assign(clone(m), { id }));
    }
  }
  if (Array.isArray(v.hidden)) s.hidden = v.hidden.filter((k) => !!BUILTIN_BY_ID[k]);
  return s;
}

// ── 合并后的清单 ──
/**
 * @param {object} store 改写层（normalizeStore 后的）
 * @param {object} opt   { includeHidden: 是否把隐藏的内置条目也列出来（编辑页要，选择器不要） }
 * @returns 模块数组，每条带 builtin / modified / hidden 标志
 */
function listModules(store, opt) {
  const s = normalizeStore(store);
  const hidden = new Set(s.hidden);
  const out = [];
  for (const b of BUILTIN) {
    const ov = s.overrides[b.id];
    if (hidden.has(b.id) && !(opt && opt.includeHidden)) continue;
    const merged = ov ? deepMerge(b, ov) : clone(b);
    merged.builtin = true;
    merged.modified = !!ov;
    merged.hidden = hidden.has(b.id);
    out.push(merged);
  }
  for (const c of s.custom) {
    const m = clone(c);
    m.builtin = false; m.modified = false; m.hidden = false;
    out.push(m);
  }
  return out;
}

/** 单条（合并后）。找不到返回 null —— 场景里 libId 指空时上层要如实报错，不许静默兜底 */
function moduleOf(store, id) {
  if (!id) return null;
  const s = normalizeStore(store);
  if (BUILTIN_BY_ID[id]) {
    const ov = s.overrides[id];
    const m = ov ? deepMerge(BUILTIN_BY_ID[id], ov) : clone(BUILTIN_BY_ID[id]);
    m.builtin = true; m.modified = !!ov; m.hidden = s.hidden.includes(id);
    return m;
  }
  const c = s.custom.find((x) => x.id === id);
  if (!c) return null;
  const m = clone(c); m.builtin = false; m.modified = false; m.hidden = false;
  return m;
}

/**
 * 整份清单 → 改写层（只存差异）。编辑页保存走这条。
 * 传进来的 list 是「用户看到的那份」：内置条目改过的记差异，自建的整条存，
 * 内置里被删掉的记进 hidden（内置条目不许真删 —— 它在代码里，删了下次启动又回来）。
 */
function storeFromList(list) {
  const s = { version: 1, overrides: {}, custom: [], hidden: [] };
  const seen = new Set();
  for (const m of (list || [])) {
    if (!m || !m.id) continue;
    const id = String(m.id);
    seen.add(id);
    const base = BUILTIN_BY_ID[id];
    if (base) {
      if (m.hidden) { s.hidden.push(id); continue; }
      const cur = clone(m);
      delete cur.builtin; delete cur.modified; delete cur.hidden;
      const d = deepDiff(base, cur);
      if (d !== undefined) s.overrides[id] = d;
    } else {
      const cur = clone(m);
      delete cur.builtin; delete cur.modified; delete cur.hidden;
      if (!isUserId(cur.id)) cur.id = USER_PREFIX + cur.id;
      s.custom.push(cur);
    }
  }
  // 清单里没出现的内置条目 = 被删了 → 记 hidden
  for (const b of BUILTIN) if (!seen.has(b.id)) s.hidden.push(b.id);
  return s;
}

/** 新建一条自建模块的空壳 */
function blankModule(cat, name) {
  return {
    id: USER_PREFIX + Math.random().toString(36).slice(2, 10),
    cat: cat || 'D', group: 'misc', zh: name || '自定义模块', en: name || 'Custom module',
    symbol: 'sensor', ports: [], place: { modes: ['fixed'], mountable: false, hostCats: [] },
    tags: [], src: '自建'
  };
}

/** 从一条内置模块派生一份自建副本（「另存为」） */
function deriveModule(store, id, name) {
  const b = moduleOf(store, id);
  if (!b) return null;
  const m = clone(b);
  delete m.builtin; delete m.modified; delete m.hidden;
  m.id = USER_PREFIX + Math.random().toString(36).slice(2, 10);
  m.zh = name || (b.zh + ' 副本');
  m.en = name || (b.en + ' (copy)');
  m.src = '派生自 ' + b.id;
  return m;
}

// ── 校验 ──
/**
 * 一条模块的自检。返回 { errors, warn }。
 * ★ 只查「结构错」不查「填不全」：允许条目只填一半（缺的按端口介质的缺省档走），
 *   否则库就没人愿意维护。真正缺参数的报错留给计算时按需报。
 */
function validateModule(m) {
  const errors = [], warn = [];
  if (!m || !m.id) { errors.push('缺 id'); return { errors, warn }; }
  if (!CATS.some((c) => c.key === m.cat)) errors.push(`未知分类 ${m.cat}`);
  if (!m.zh) warn.push('没有中文名');
  const keys = new Set();
  for (const pt of (m.ports || [])) {
    if (!pt || !pt.key) { errors.push('端口缺 key'); continue; }
    if (keys.has(pt.key)) errors.push(`端口 key 重复：${pt.key}`);
    keys.add(pt.key);
    if (!M.mediaOf(pt.medium)) errors.push(`端口 ${pt.key} 的介质未知：${pt.medium}`);
    if (pt.dir && !['tx', 'rx', 'trx'].includes(pt.dir)) errors.push(`端口 ${pt.key} 方向非法：${pt.dir}`);
  }
  if (m.cat === 'A' && !m.sat) warn.push('空间段模块没有 sat 出厂值');
  // F 类分两种：天线（要 antenna 增益）与射频部件（LNB/BUC，本来就没有方向图）
  if (m.cat === 'F' && m.group === 'antenna' && !m.antenna) warn.push('天线没有 antenna 参数');
  return { errors, warn };
}

/** 全库自检（开发期兜底，冒烟测试调它） */
function validateAll(store) {
  const out = [];
  for (const m of listModules(store, { includeHidden: true })) {
    const v = validateModule(m);
    if (v.errors.length || v.warn.length) out.push({ id: m.id, zh: m.zh, ...v });
  }
  return out;
}

// ── 检索 ──
/** 按关键词搜（名称 / 型号 / 标签 / id），返回命中的 id 集合 */
function searchModules(store, kw) {
  const q = String(kw || '').trim().toLowerCase();
  if (!q) return listModules(store);
  return listModules(store).filter((m) => {
    const hay = [m.zh, m.en, m.id, m.vendor, m.model, (m.tags || []).join(' '), GROUPS[m.group] || m.group]
      .filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  });
}

/** 库树：分类 → 分组 → 条目 */
function libraryTree(store) {
  const list = listModules(store);
  const byCat = new Map();
  for (const c of CATS) byCat.set(c.key, { ...c, groups: new Map() });
  for (const m of list) {
    const c = byCat.get(m.cat) || byCat.get('D');
    if (!c.groups.has(m.group)) c.groups.set(m.group, { key: m.group, zh: GROUPS[m.group] || m.group, items: [] });
    c.groups.get(m.group).items.push(m);
  }
  return CATS.map((c) => {
    const e = byCat.get(c.key);
    return { ...c, groups: [...e.groups.values()] };
  }).filter((c) => c.groups.length);
}

module.exports = {
  USER_PREFIX, isUserId, BUILTIN, CATS, GROUPS,
  normalizeStore, listModules, moduleOf, storeFromList,
  blankModule, deriveModule, validateModule, validateAll,
  searchModules, libraryTree, deepMerge, deepDiff
};
