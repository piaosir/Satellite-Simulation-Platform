// 干扰分析 · C/XPI 交叉极化干扰
//
// 频率复用把同一段频谱在两个正交极化上各用一遍，隔离全靠极化纯度。总的交叉极化鉴别度
// 是三段串联劣化的功率和（互不相关，故线性域相加）：
//
//     1/XPI_总 = 1/XPI_卫星 + 1/XPI_地球站 + 1/XPD_雨
//
// 三段各自的来源与可信度差别很大，UI 上必须分列——把它们糊成一个数，用户就无从判断
// 哪一段是瓶颈、该去治哪一段：
//
//   XPI_卫星    ← GRD 方向图的 P1/P2 分量之比，**在该站所在那一点**实测。这是本平台独有
//                的能力：GRD 里本来就存着共极化与反极化两个复场分量，取比值即逐点 XPD，
//                比任何包络都准。没有 GRD 时退回用户手填。
//   XPI_地球站  ← 天线极化纯度。GRD 是卫星天线的，管不到这一段，故只能由用户给——但
//                「给」不等于「填一个 XPD 数」：见下面 resolveXpd 的四种等价给法。
//   XPD_雨      ← ITU-R P.618-14 §4.1，链路预算引擎已实现，由调用方把算好的值传进来
//                （本模块不重复实现，避免两处口径漂移）。
//
// ⚠️ 诚实边界：GRD 只覆盖三段中的一段。拿卫星侧的 P1/P2 当作端到端 XPI，会偏乐观。
//    本模块的返回值里逐段标了 source，UI 须照实显示哪些段有实测、哪些段是填的。

const LOG10 = Math.log10;
const DEG = Math.PI / 180;
const lin = (db) => Math.pow(10, db / 10);
const num = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const fx = (v, n) => Number(v).toFixed(n === undefined ? 2 : n);

/**
 * 收下 GRD 采出的逐点 XPD（dB）。
 *
 * 入参应来自 grdSampler.sampleXpd —— 它已经做对了两件事：
 *   ① 共极化分量由**波束峰值处哪个分量占优**判定，不按 icomp 硬判。实测真实文件里多是
 *      第二个分量才是共极化（CS10R 300_X02G 峰值 P1=21.94 / P2=52.87 dB），按 P1 当共极化
 *      取出来会是个负数——曾把 −31.35 误当「取值不对」，其实是共极化认反了。
 *   ② 取**服务波束**（该点共极化最强者）的共/交比，而不是在各波束的比值里取最大。
 *
 * 故此处只做有效性判断，不再换算、也不再翻符号。
 *
 * @param {number|null} xpdDb  sampleXpd 的 xpdDb
 * @returns {{db:number, source:'grd'}|null}
 */
function xpdFromGrdRatio(xpdDb) {
  const v = Number(xpdDb);
  if (!Number.isFinite(v)) return null;
  // 仍留这道闸：负值只可能出现在波束零点区（共极化被抵消掉），那里的 XPD 无工程意义
  if (v <= 0) return null;
  return { db: v, source: 'grd' };
}

// ---------------------------------------------------------------------------
// 天线极化纯度的几种等价给法
// ---------------------------------------------------------------------------
//
// 工程上手里拿到的从来不是「XPD = 30 dB」这句话本身，而是它的几种等价表述：
//
//   · 圆极化天线的规格书给的是**轴比** AR（dB）；
//   · 天线出厂或在站测试报告给的是**共极化与交叉极化两条曲线的电平**；
//   · 线极化还有一项与天线本身无关的独立劣化：馈源极化面与来波的**对准误差角** τ。
//
// 这三者与 XPD 之间都是闭合的解析关系，没有任何近似与经验系数。既然如此就该由本模块换算
// ——逼用户先自己在计算器上按一遍再填个数进来，既容易按错，也把「这个数是怎么来的」丢了，
// 结果表里只剩一个查无对证的 30。
//
// ⚠️ 这里换算出的是**天线的**极化鉴别度，不含链路上的雨致去极化（那是第三段，走 P.618）。

/**
 * 轴比 → XPD（圆极化）。
 *
 * 轴比 r（电压比）= 10^(AR_dB/20)。把椭圆极化按旋向分解成同旋 + 反旋两个圆分量，二者
 * 幅度比 ρ = (r−1)/(r+1)，故
 *
 *     XPD = 20·lg((r+1)/(r−1))
 *
 * 校验点：AR = 0.55 dB → XPD = 30.0 dB。工程上常见的入网要求正是「主瓣 −1 dB 等值线内
 * XPD ≥ 30 dB」，业界惯用的轴比门限 0.5～0.6 dB 与之对得上——两套说法本就是一回事。
 *
 * AR ≤ 0 即理想圆极化（无反旋分量），XPD → ∞：返回 null，由调用方按「本段无劣化」处理，
 * 与三段合成里「缺段不参与求和」的口径一致。
 */
function xpdFromAxialRatio(axialRatioDb) {
  const ar = num(axialRatioDb, null);
  if (ar == null || ar <= 0) return null;
  const r = Math.pow(10, ar / 20);
  if (!(r > 1)) return null;                       // 数值下溢（AR 小到 10^(AR/20) 舍成 1）
  const db = 20 * LOG10((r + 1) / (r - 1));
  if (!Number.isFinite(db)) return null;
  return { db, source: 'axialRatio', note: `轴比 ${fx(ar)} dB → ${fx(db)} dB` };
}

/**
 * 实测共 / 交极化电平 → XPD = 共 − 交。
 *
 * 两个电平只要**同一口径**（都是 dBi，或都是相对峰值的 dB）即可，差值与口径无关。
 * 差值 ≤ 0 说明交叉极化不弱于共极化：不是极化纯度差，是读错了曲线或读在了零点区
 * （与 GRD 那一路 xpdFromGrdRatio 踩过的坑同源），此处一律判无效。
 */
function xpdFromLevels(coPolDb, xPolDb) {
  const co = num(coPolDb, null), xp = num(xPolDb, null);
  if (co == null || xp == null) return null;
  const db = co - xp;
  if (db <= 0) return null;
  return { db, source: 'levels', note: `实测 共 ${fx(co, 1)} / 交 ${fx(xp, 1)} dB → ${fx(db)} dB` };
}

/**
 * 极化对准误差 τ → XPD（线极化）。
 *
 * 馈源极化面与来波极化面差 τ 时，共极化分量 ∝ cos τ、漏进正交口的分量 ∝ sin τ，故
 *
 *     XPD = 20·lg(cot τ) = −20·lg(tan τ)
 *
 * 量级感：τ = 1° → 35.2 dB，2° → 29.1 dB，45° → 0 dB。**这一项只对线极化有意义**——
 * 圆极化对天线绕视轴的旋转不敏感，对准误差不产生交叉极化。
 *
 * τ ≤ 0（完全对准）→ null（本项无劣化）；τ ≥ 90° 无物理意义 → null。
 */
function xpdFromAlignment(tiltDeg) {
  const t = num(tiltDeg, null);
  if (t == null || t <= 0 || t >= 90) return null;
  const db = -20 * LOG10(Math.tan(t * DEG));
  if (!Number.isFinite(db)) return null;
  return { db, source: 'align', note: `对准误差 ${fx(t, 2)}° → ${fx(db)} dB` };
}

/**
 * 一段 XPD 的统一解析口 —— 三段的入参都从这里过，故任一段都能用任一种给法。
 *
 * 收三类形状：
 *   number                       直接就是 XPD（dB），source 记 'manual'
 *   {db, source}                 已算好的一段（GRD 采样、P.618 雨衰走这条），原样收下
 *   {mode, ...}                  按给法换算：
 *       mode:'manual'      { db }
 *       mode:'axialRatio'  { axialRatioDb }
 *       mode:'levels'      { coPolDb, xPolDb }
 *   另：任一 mode 都可再带 alignDeg —— 极化对准误差是与天线极化纯度**互相独立**的一项
 *   劣化，与本项按功率合成（1/XPD = 1/XPD_天线 + 1/XPD_对准），并在 parts 里逐项留痕，
 *   免得又糊成一个数看不出谁是瓶颈。
 *
 * @returns {{db:number, source:string, note?:string, parts?:Array}|null}
 */
function resolveXpd(desc) {
  if (desc === undefined || desc === null || desc === '') return null;

  if (typeof desc !== 'object') {
    const v = num(desc, null);
    return v == null ? null : { db: v, source: 'manual' };
  }

  // 旧式 {db, source}：不换算，原样收下
  if (!desc.mode) {
    const v = num(desc.db, null);
    return v == null ? null : { db: v, source: desc.source || 'manual', note: desc.note || undefined };
  }

  let base = null;
  if (desc.mode === 'axialRatio') base = xpdFromAxialRatio(desc.axialRatioDb);
  else if (desc.mode === 'levels') base = xpdFromLevels(desc.coPolDb, desc.xPolDb);
  else {
    const v = num(desc.db, null);
    if (v != null) base = { db: v, source: 'manual' };
  }
  const align = xpdFromAlignment(desc.alignDeg);

  const parts = [];
  if (base) parts.push({ key: 'antenna', label: '天线极化纯度', ...base });
  if (align) parts.push({ key: 'align', label: '极化对准误差', ...align });
  if (!parts.length) return null;
  if (parts.length === 1) return { db: parts[0].db, source: parts[0].source, note: parts[0].note };

  const db = -10 * LOG10(parts.reduce((s, p) => s + lin(-p.db), 0));
  const headNote = base.note || `天线 ${fx(base.db)} dB`;
  return { db, source: base.source, note: `${headNote} ⊕ ${align.note} ⇒ ${fx(db)} dB`, parts };
}

/**
 * 三段合成总 XPI。
 *
 * @param {object} o
 *   satellite   {db, source} 或 number —— 卫星侧，来自 GRD（source:'grd'）或手填
 *   earthStation{db, source} 或 number —— 地球站侧，规格/手填
 *   rain        {db, source} 或 number —— 雨致 XPD，由链路预算引擎按 P.618-14 §4.1 算好传入
 *   （任一段缺省即视为「无此项劣化」，不参与求和；三段全缺 → 返回 null）
 *
 * @returns {{xpiDb, terms:[{key,label,db,source,sharePct}], missing:string[], grdBacked:boolean}|null}
 */
function combineXpi(o) {
  const opt = o || {};
  const spec = [
    ['satellite', '卫星天线'],
    ['earthStation', '地球站天线'],
    ['rain', '降雨去极化 P.618-14 §4.1']
  ];
  const terms = [];
  const missing = [];
  let sum = 0;

  for (const [key, label] of spec) {
    // 每段都过 resolveXpd：数字 / {db,source} / {mode,...} 三种形状一视同仁，
    // 故「由轴比换算」这类给法在卫星侧、地球站侧都能用，不是地球站专属
    const t = resolveXpd(opt[key]);
    if (!t) { missing.push(key); continue; }
    const l = lin(-t.db);
    sum += l;
    terms.push({ key, label, db: t.db, source: t.source, note: t.note || null, parts: t.parts || null, _lin: l });
  }
  if (!terms.length) return null;

  const xpiDb = -10 * LOG10(sum);
  for (const t of terms) { t.sharePct = (t._lin / sum) * 100; delete t._lin; }
  terms.sort((a, b) => b.sharePct - a.sharePct);

  return {
    xpiDb,
    terms,
    missing,
    // 只要卫星侧走的是 GRD 实测就置 true——UI 据此决定要不要打「实测方向图」的标
    grdBacked: terms.some((t) => t.key === 'satellite' && t.source === 'grd')
  };
}

/**
 * 便捷封装：直接从 GRD 采样值 + 两个手填值出总 XPI。
 * @param {number|null} grdRatioDb  pol:'P1/P2' 采样值（无 GRD 传 null）
 * @param {number|null} satManualDb 无 GRD 时的卫星侧手填值
 * @param {number|object|null} earthStation 数字，或 resolveXpd 的给法描述子（轴比 / 实测电平 / 对准误差）
 */
function xpiFromSources(grdRatioDb, satManualDb, earthStation, rainXpdDb) {
  const g = xpdFromGrdRatio(grdRatioDb);
  const sat = g || (num(satManualDb, null) == null ? null : { db: num(satManualDb, null), source: 'manual' });
  return combineXpi({
    satellite: sat,
    earthStation,
    rain: num(rainXpdDb, null) == null ? null : { db: num(rainXpdDb, null), source: 'p618' }
  });
}

module.exports = {
  xpdFromGrdRatio, xpdFromAxialRatio, xpdFromLevels, xpdFromAlignment,
  resolveXpd, combineXpi, xpiFromSources
};
