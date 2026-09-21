/**
 * 轨道源（orbit source）—— 日凌引擎与「卫星位置怎么来」之间的唯一接口。
 *
 * 引擎只认本模块返回的这几个成员，不认 satrec、不认 OMM 字段、不做坐标系转换：
 *   kind        'sgp4' | 'ephem'
 *   summary     { periodMin, inclDeg, ecc, epochIso }   区制守卫 / 预筛 margin / 历元读数只看这里
 *   span        null | { startMs, endMs }               null = 无限期（SGP4）
 *   posEcefKm(ms) → [x, y, z] | null                    ECEF（WGS84）km；null = 区间外 / 传播失败
 *   lonAt(ms)     → deg | NaN                           星下点经度，°E 正
 *
 * 这样划界，是为了将来接入「外部星历导入」（STK .e / CCSDS OEM / SP3 的时间标签状态矢量，
 * 按插值而非 SGP4 求位置）时，日凌引擎与窗口都不必再改：新增一种 kind='ephem' 的实现即可。
 * TEME / J2000 / ICRF / Fixed → ECEF 的转换是各实现自己的事，引擎只吃 ECEF。
 *
 * 本期只实现 SGP4/SDP4 一种：经 ngsoGeometry.buildSatrec(spec) 建 satrec（spec 形状见该函数），
 * 覆盖 type 'omm' | 'tle' | 'elements'；区间无限、posEcefKm 永不返回 null。
 */

var sat = require('../vendor/satellite.js');

var DEG = 180 / Math.PI;
var JD_UNIX = 2440587.5;          // 1970-01-01T00:00Z 的儒略日
var MS_PER_DAY = 86400e3;

/** 儒略日（UT）→ Unix 毫秒 */
function jdToMs(jd) { return (jd - JD_UNIX) * MS_PER_DAY; }
/** Unix 毫秒 → 儒略日（UT） */
function msToJd(ms) { return ms / MS_PER_DAY + JD_UNIX; }

function sgp4Source(spec) {
  // buildSatrec 是平台唯一的 satrec 构建口（OMM / TLE / 经典六根数三种来源），本模块不再抄一份
  var rec = require('./ngsoGeometry.js').buildSatrec(spec);
  if (!rec || (rec.error && rec.error !== 0) || !(rec.no > 0)) {
    throw new Error('轨道根数无法建立 SGP4 传播器');
  }
  var periodMin = (2 * Math.PI) / rec.no;   // rec.no 为 un-Kozai 后的平均运动 rad/min
  var epochIso = new Date(jdToMs(rec.jdsatepoch)).toISOString();
  return {
    kind: 'sgp4',
    summary: {
      periodMin: periodMin,
      inclDeg: rec.inclo * DEG,
      ecc: rec.ecco,
      epochIso: epochIso
    },
    span: null,                    // SGP4 可外推到任意时刻（精度另说），无覆盖区间
    posEcefKm: function (ms) {
      var d = new Date(ms);
      var pv = sat.propagate(rec, d);
      if (!pv || !pv.position) return null;
      var p = sat.eciToEcf(pv.position, sat.gstime(d));
      if (!(isFinite(p.x) && isFinite(p.y) && isFinite(p.z))) return null;
      return [p.x, p.y, p.z];
    },
    lonAt: function (ms) {
      var d = new Date(ms);
      var pv = sat.propagate(rec, d);
      if (!pv || !pv.position) return NaN;
      var gd = sat.eciToGeodetic(pv.position, sat.gstime(d));
      return sat.degreesLong(gd.longitude);
    }
  };
}

/**
 * 按轨道 spec 建轨道源。
 * @param spec { type:'omm'|'tle'|'elements', … }（见 ngsoGeometry.buildSatrec）
 *             将来的 { type:'ephem', … } 由星历导入那份工作实现
 */
function orbitSource(spec) {
  if (!spec || !spec.type) throw new Error('缺少轨道来源 orbit.type');
  if (spec.type === 'ephem') throw new Error('星历文件轨道源尚未实现');
  return sgp4Source(spec);
}

module.exports = {
  orbitSource: orbitSource,
  jdToMs: jdToMs,
  msToJd: msToJd
};
