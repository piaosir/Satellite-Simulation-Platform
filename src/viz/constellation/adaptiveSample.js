// 选中卫星轨道/星下点轨迹的自适应时间采样（Vue 端与小程序端共用，两处调用勿再各写一份）。
//
// 背景：一个周期均匀采 N=120 点对近圆轨道足够（相邻点地面跳变 ~3°），但大椭圆轨道（如再入前的
// Cluster II，e≈0.9、周期 54h）按开普勒第二定律过近地点时几十分钟横扫近半个地球，27min 步长下
// 相邻采样点地面跳变可达 130°+，2D 平面图把它们连成横贯地图的直线弦（>180° 才断线的反经线逻辑
// 拦不住 <180° 的大跳变），3D 轨迹/轨道圈近地点段同样呈折线状。
//
// 方案：均匀 N 点起步，对相邻点地面跳变超过 MAX_STEP_DEG 的时间段递归二分加密。
//  - 近圆轨道跳变 ~3° 不触发细分，输出与原均匀采样完全一致（零回归）；
//  - 大椭圆轨道只在近地点段局部加密，代价与轨迹总弧长成正比（e=0.9 约多推演几百点，SGP4 微秒级）；
//  - 经度差先归一到 ≤180° 再判跳变——真实反经线穿越差值很小，不会被误细分；
//  - 深度上限硬保证终止；中点推演失败则该段放弃细分退化为直连（温和降级）。
import sat from './satellite.js';

const MAX_STEP_DEG = 4;   // 相邻点地面跳变阈值：高于近圆轨道基线(~3.2°)不触发，远低于失真弦(130°+)
const MAX_DEPTH = 7;      // 单段最多二分 7 层(×128)：TANGO 近地点 27min 步长加密到 ~12.6s、跳变 ~1°

// 一个周期内自适应采样。返回 [{ t, pv, gd, lat, lon }]：
//   t 采样时刻(Date)、pv=sat.propagate 结果（含 ECI position，供调用方按需转轨道圈坐标）、
//   gd=逐时刻 gmst 的大地坐标（弧度制，星下点）、lat/lon 为 gd 的度数形式。
// 推演失败的时刻直接跳过（与原实现一致）。
export function sampleOrbitAdaptive(rec, t0, periodMin, N = 120) {
  const evalAt = (t) => {
    const pv = sat.propagate(rec, t);
    if (!pv || !pv.position) return null;
    const gd = sat.eciToGeodetic(pv.position, sat.gstime(t));
    return { t, pv, gd, lat: sat.degreesLat(gd.latitude), lon: sat.degreesLong(gd.longitude) };
  };
  const jumpDeg = (a, b) => {
    let dl = Math.abs(a.lon - b.lon);
    if (dl > 180) dl = 360 - dl;                        // 反经线穿越归一：±180 附近的真实小位移不误判
    return Math.max(dl, Math.abs(a.lat - b.lat));
  };
  const out = [];
  const refine = (a, b, depth) => {                     // 追加 (a,b] 之间的加密点与 b 本身
    if (depth < MAX_DEPTH && jumpDeg(a, b) > MAX_STEP_DEG) {
      const m = evalAt(new Date((a.t.getTime() + b.t.getTime()) / 2));
      if (m) { refine(a, m, depth + 1); refine(m, b, depth + 1); return }
    }
    out.push(b);
  };
  let prev = null;
  for (let k = 0; k <= N; k++) {
    const s = evalAt(new Date(t0.getTime() + (k / N) * periodMin * 60000));
    if (!s) continue;
    if (prev) refine(prev, s, 0); else out.push(s);
    prev = s;
  }
  return out;
}
