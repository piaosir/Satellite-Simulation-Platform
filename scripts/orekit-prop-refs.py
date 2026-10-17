# Orekit 参考星历 / 力模型对拍夹具生成器（packages/core/utils/prop 的独立参照）。
#
# Orekit 是 Apache-2.0 的开源航天动力学库（CS GROUP），这里经 orekit-jpype（PyPI，Apache-2.0）调用：
#   pip install orekit-jpype          # 本次用的是 orekit_jpype 13.1.9（内含 orekit-13.1.9.jar，构建 2026-10-03）
#   git clone https://gitlab.orekit.org/orekit/orekit-data.git    # 闰秒、DE440（lnxp1990.440）、EOP
#   python scripts/orekit-prop-refs.py --orekit-data <orekit-data 目录> --sw-csv <CelesTrak SW-All.csv>
#   （本次夹具：orekit-data 提交 2422a7d「Updated to October 2026」；SW-All.csv 2026-10-17 下载）
# 输出：packages/core/test/fixtures/prop/*.json.gz（JS 测试 packages/core/test/prop*.test.mjs 读取）。
#
# 「相同力模型」的做法（两边逐项对齐，差异只剩实现本身）：
#   重力场：从 packages/core/utils/prop/data/egm2008_70.js 读出同一份 EGM2008 系数（base64 双精度），按 gravity.js 的
#     零潮汐折算写成 ICGEM 文件喂给 Orekit 的 HolmesFeatherstoneAttractionModel；GM / a_e 取 EGM2008 的值。
#   地固系：Orekit FramesFactory.getGTOD(False)（IERS 1996 口径的 IAU-76/80，不加 EOP ⇒ UT1 = UTC、无章动修正），
#     与 frames.js 的 J2000→FIXED 链同口径（差 1997 起时差方程两小项 ≤ 0.0027″，frames 夹具里量出来）。
#   日月：Orekit 读 DE440；JS 侧用本脚本导出的同一 DE440 位置表（tabulatedEphemeris），GM 取 DE440 头文件常数。
#     另导出 1990–2100 年的 DE440 采样，供 JS 测解析历表（ERFA epv00 / moon98）本身的精度。
#   光压：SolarRadiationPressure + IsotropicRadiationSingleCoefficient（P = 4.56e-6 N/m² @ 149597870 km），
#     Orekit 13 的 ConicallyShadowedLightFluxModel（球形地球 R = 6378.137 km，R☉ = 695700 km）。
#   阻力：DragForce + IsotropicDrag，NRLMSISE00（时标 UTC，地方时取平太阳时 MEAN —— Orekit 13.1.8 起提供，正是
#     NRLMSISE-00 参考驱动的定义）。空间天气：JS 读 CelesTrak SW-All.csv；Orekit 的 CssiSpaceWeatherData 读本脚本
#     把同一段 CSV 逐行转写成的 CSSI TXT（v1.2 定宽格式），两边输入逐位一致；F10.7 / Ap 取值也一并导出逐项核对。
#     （不直接用 orekit-data 自带的 SpaceWeather-All-v1.2.txt：CelesTrak 的 TXT 与 CSV 在日 Ap 恰为 x.5 时取整不同。）
#   固体潮：Orekit SolidTides（IERS 2010 全模型：第一步 + 第二步 + 极潮，UT1 用 orekit-data 的 EOP）；JS 侧只有
#     第一步，差异即「第二步 + 极潮」的量级，单列一个算例量出来。
#   积分器：DormandPrince853（ToleranceProvider 缺省容差表，位置容差 dP = 1e-7 m；最大步长 LEO 5 s、GTO 10 s、GEO 60 s、
#     GEO 一年 300 s），直角坐标，输出点逐个 propagate 到达。容差是实测定的：dP = 1e-4 m 时 70×70 的 LEO 一天就积出
#     20 m；dP = 1e-6 m、步长 30 s 时 LEO 光压（每圈两次进出地影）7 天积出 2 m；收紧到上述设置后再收紧，结果变化 < 2 cm。
import argparse, base64, json, math, os, re, struct, sys, tempfile

ap = argparse.ArgumentParser()
ap.add_argument('--orekit-data', required=True)
ap.add_argument('--sw-csv', required=True)
ap.add_argument('--out', default=None)
args = ap.parse_args()

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OUT = args.out or os.path.join(ROOT, 'packages', 'core', 'test', 'fixtures', 'prop')
os.makedirs(OUT, exist_ok=True)

import orekit_jpype as orekit
orekit.initVM()
from java.io import File
from java.util import ArrayList
from org.orekit.data import DataContext, DirectoryCrawler
from org.orekit.time import AbsoluteDate, TimeScalesFactory
from org.orekit.frames import FramesFactory
from org.orekit.utils import Constants, IERSConventions, PVCoordinates
from org.orekit.bodies import CelestialBodyFactory, GeodeticPoint, OneAxisEllipsoid
from org.orekit.orbits import CartesianOrbit, OrbitType
from org.orekit.propagation import SpacecraftState, ToleranceProvider
from org.orekit.propagation.numerical import NumericalPropagator
from org.orekit.propagation.events import EclipseDetector, EventsLogger
from org.orekit.propagation.events.handlers import ContinueOnEvent
from org.orekit.forces.gravity import HolmesFeatherstoneAttractionModel, ThirdBodyAttraction, SolidTides
from org.orekit.forces.gravity.potential import GravityFieldFactory, ICGEMFormatReader, TideSystem
from org.orekit.forces.radiation import SolarRadiationPressure, IsotropicRadiationSingleCoefficient
from org.orekit.forces.drag import DragForce, IsotropicDrag
from org.orekit.models.earth.atmosphere import NRLMSISE00
from org.orekit.models.earth.atmosphere.data import CssiSpaceWeatherData
from org.hipparchus.ode.nonstiff import DormandPrince853Integrator
from org.hipparchus.geometry.euclidean.threed import Vector3D

dpm = DataContext.getDefault().getDataProvidersManager()
dpm.addProvider(DirectoryCrawler(File(os.path.abspath(args.orekit_data))))

# ---------- EGM2008：与 JS 同一份系数 ----------
src = open(os.path.join(ROOT, 'packages', 'core', 'utils', 'prop', 'data', 'egm2008_70.js'), encoding='utf-8').read()
def b64block(key):
    m = re.search(key + r": \((.*?)\)", src, re.S)
    return base64.b64decode(''.join(re.findall(r"'([A-Za-z0-9+/=]+)'", m.group(1))))
CB, SB = b64block('C'), b64block('S')
NC = len(CB) // 8
C = list(struct.unpack('<%dd' % NC, CB)); S = list(struct.unpack('<%dd' % NC, SB))
NMAX = 70
GM = 3986004.415e8; AE = 6378136.3
# gravity.js：ΔC̄20perm = A0·H0·k20（同一求值次序）
DC20 = 4.4228e-8 * -0.31460 * 0.30190
tri = lambda n, m: n * (n + 1) // 2 + m
gdir = tempfile.mkdtemp(prefix='egm-')
def write_icgem(name, c20, tide):
    with open(os.path.join(gdir, name), 'w') as f:
        f.write('begin_of_head\nproduct_type gravity_field\nmodelname %s\nearth_gravity_constant %r\nradius %r\n'
                'max_degree %d\nerrors formal\nnorm fully_normalized\ntide_system %s\nend_of_head\n' % (name, GM, AE, NMAX, tide))
        f.write('key L M C S sigma_C sigma_S\n')
        for n in range(0, NMAX + 1):
            for m in range(0, n + 1):
                c = C[tri(n, m)]; s = S[tri(n, m)]
                if n == 2 and m == 0: c = c20
                f.write('gfc %d %d %r %r 0.0 0.0\n' % (n, m, c, s))
write_icgem('EGM2008zt70.gfc', C[3] + DC20, 'zero_tide')
write_icgem('EGM2008tf70.gfc', C[3], 'tide_free')
dpm.addProvider(DirectoryCrawler(File(gdir)))
def gravity_provider(name, n, m):
    GravityFieldFactory.clearPotentialCoefficientsReaders()
    GravityFieldFactory.addPotentialCoefficientsReader(ICGEMFormatReader(name, False))
    return GravityFieldFactory.getNormalizedProvider(n, m)

utc = TimeScalesFactory.getUTC()
eme = FramesFactory.getEME2000()
gtod = FramesFactory.getGTOD(False)
earth = OneAxisEllipsoid(Constants.WGS84_EARTH_EQUATORIAL_RADIUS, Constants.WGS84_EARTH_FLATTENING, gtod)
earthSphere = OneAxisEllipsoid(Constants.WGS84_EARTH_EQUATORIAL_RADIUS, 0.0, gtod)
sun = CelestialBodyFactory.getSun(); moon = CelestialBodyFactory.getMoon()
# 空间天气：把 SW-All.csv 的 2025-03-01…2025-08-31 段原样转成 CSSI TXT（v1.2 定宽格式）给 Orekit，
# 与 JS 读的 CSV 逐位同值（CelesTrak 两种产品的日 Ap 在 x.5 处取整不同，不能各读各的，见 spaceWeather.js 头注）。
SW_FROM, SW_TO = '2025-03-01', '2025-08-31'
with open(args.sw_csv, encoding='utf-8') as f:
    SW_HEAD = f.readline().rstrip('\n')
    SW_ROWS = [ln.rstrip('\n') for ln in f if SW_FROM <= ln[:10] <= SW_TO]
def csv_to_cssi_txt(head, rows):
    ix = {c: i for i, c in enumerate(head.split(','))}
    out = ['DATATYPE CssiSpaceWeather', 'VERSION 1.2', '# converted from CelesTrak SW-All.csv by scripts/orekit-prop-refs.py',
           'NUM_OBSERVED_POINTS %d' % len(rows), 'BEGIN OBSERVED']
    for line in rows:
        f = line.split(',')
        g = lambda k: f[ix[k]]
        y, m, d = map(int, g('DATE').split('-'))
        s = '%4d %02d %02d%5d%3d' % (y, m, d, int(g('BSRN')), int(g('ND')))   # 月 / 日补零：Orekit 用 Integer.parseInt 读，不认空格
        s += ''.join('%3d' % int(g('KP%d' % i)) for i in range(1, 9)) + '%4d' % int(g('KP_SUM'))
        s += ''.join('%4d' % int(g('AP%d' % i)) for i in range(1, 9)) + '%4d' % int(g('AP_AVG'))
        s += '%4.1f%2d%4d' % (float(g('CP')), int(g('C9')), int(g('ISN')))
        s += '%6.1f%2d' % (float(g('F10.7_ADJ')), 0)
        s += '%6.1f%6.1f%6.1f%6.1f%6.1f' % (float(g('F10.7_ADJ_CENTER81')), float(g('F10.7_ADJ_LAST81')),
                                           float(g('F10.7_OBS')), float(g('F10.7_OBS_CENTER81')), float(g('F10.7_OBS_LAST81')))
        assert len(s) == 130, s
        out.append(s)
    out += ['END OBSERVED', 'NUM_DAILY_PREDICTED_POINTS 0', 'BEGIN DAILY_PREDICTED', 'END DAILY_PREDICTED',
            'NUM_MONTHLY_FIT_POINTS 0', 'BEGIN MONTHLY_FIT', 'END MONTHLY_FIT']
    return '\n'.join(out) + '\n'
swdir = tempfile.mkdtemp(prefix='sw-')
SW_TXT = os.path.join(swdir, 'SW-converted.txt')
with open(SW_TXT, 'w') as f:
    f.write(csv_to_cssi_txt(SW_HEAD, SW_ROWS))
from org.orekit.data import DataSource
cssi = CssiSpaceWeatherData(DataSource(File(SW_TXT)), utc)
MASS = 1000.0

import datetime as _dt
def date_of_ms(ms):
    # JS 的 UTC 毫秒是 POSIX 时间（不计闰秒）：按日历分量建 AbsoluteDate，不能从 1970 起 shiftedBy（会多出 ~29 个闰秒）
    whole = math.floor(ms / 1000.0)
    t = _dt.datetime(1970, 1, 1, tzinfo=_dt.timezone.utc) + _dt.timedelta(seconds=whole)
    return AbsoluteDate(t.year, t.month, t.day, t.hour, t.minute, float(t.second) + (ms / 1000.0 - whole), utc)
def v3(v): return [float(v.getX()) / 1000.0, float(v.getY()) / 1000.0, float(v.getZ()) / 1000.0]
def V(a): return Vector3D(float(a[0]) * 1000.0, float(a[1]) * 1000.0, float(a[2]) * 1000.0)

def coe2rv(mu, a, e, i, raan, argp, nu):
    p = a * (1 - e * e); r = p / (1 + e * math.cos(nu))
    xp, yp = r * math.cos(nu), r * math.sin(nu)
    sq = math.sqrt(mu / p); vxp, vyp = -sq * math.sin(nu), sq * (e + math.cos(nu))
    cO, sO, cw, sw, ci, si = math.cos(raan), math.sin(raan), math.cos(argp), math.sin(argp), math.cos(i), math.sin(i)
    R = [[cO * cw - sO * sw * ci, -cO * sw - sO * cw * ci], [sO * cw + cO * sw * ci, -sO * sw + cO * cw * ci], [sw * si, cw * si]]
    return [R[k][0] * xp + R[k][1] * yp for k in range(3)], [R[k][0] * vxp + R[k][1] * vyp for k in range(3)]

MU_KM = GM / 1e9
D2R = math.pi / 180

def build(case, with_events=False):
    fm = case['forces']
    t0 = date_of_ms(case['t0Ms'])
    pv = PVCoordinates(V(case['r0']), V(case['v0']))
    orbit = CartesianOrbit(pv, eme, t0, GM)
    tol = ToleranceProvider.getDefaultToleranceProvider(case.get('dP', 1e-7)).getTolerances(orbit, OrbitType.CARTESIAN)
    integ = DormandPrince853Integrator(1e-4, case.get('maxStepSec', 5.0), tol[0], tol[1])
    prop = NumericalPropagator(integ)
    prop.setOrbitType(OrbitType.CARTESIAN)
    prop.setInitialState(SpacecraftState(orbit).withMass(MASS))
    g = fm.get('gravity')
    if g:
        prov = gravity_provider('EGM2008tf70.gfc' if g.get('tideSystem') == 'tide-free' else 'EGM2008zt70.gfc', g['degree'], g['order'])
        prop.addForceModel(HolmesFeatherstoneAttractionModel(gtod, prov))
    if fm.get('thirdBody'):
        prop.addForceModel(ThirdBodyAttraction(sun))
        prop.addForceModel(ThirdBodyAttraction(moon))
    if fm.get('srp'):
        s = fm['srp']
        prop.addForceModel(SolarRadiationPressure(sun, earthSphere, IsotropicRadiationSingleCoefficient(s['areaToMass'] * MASS, s['cr'])))
    if fm.get('drag'):
        d = fm['drag']
        atm = NRLMSISE00(cssi, sun, earth, utc).withLocalSolarTimeMode(NRLMSISE00.LocalSolarTimeMode.MEAN)
        prop.addForceModel(DragForce(atm, IsotropicDrag(d['areaToMass'] * MASS, d['cd'])))
    if fm.get('tides'):
        ts = TideSystem.TIDE_FREE if (g and g.get('tideSystem') == 'tide-free') else TideSystem.ZERO_TIDE
        if fm['tides'] == 'step1':
            # 只有第一步（IERS 2010 式 6.6 / 6.7，表 6.3 的名义 Love 数），不含频率相关修正与极潮 —— 与 JS tides.js 同模型
            prop.addForceModel(SolidTides(gtod, AE, GM, ts, IERSConventions.IERS_2010.getLoveNumbers(), sun, moon))
        else:
            ut1 = TimeScalesFactory.getUT1(IERSConventions.IERS_2010, True)
            prop.addForceModel(SolidTides(gtod, AE, GM, ts, IERSConventions.IERS_2010, ut1, sun, moon))
    logger = None
    if with_events:
        logger = EventsLogger()
        for kind in ('penumbra', 'umbra'):
            det = EclipseDetector(sun, Constants.SUN_RADIUS, earthSphere).withThreshold(1e-7).withMaxCheck(30.0).withHandler(ContinueOnEvent())
            det = det.withPenumbra() if kind == 'penumbra' else det.withUmbra()
            prop.addEventDetector(logger.monitorDetector(det))
    return prop, t0, logger

def run(case, with_events=False):
    prop, t0, logger = build(case, with_events)
    out = []
    n = int(round(case['durationSec'] / case['outStepSec']))
    for k in range(n + 1):
        st = prop.propagate(t0.shiftedBy(k * case['outStepSec']))
        p = st.getPVCoordinates(eme)
        out.append([k * case['outStepSec']] + [round(x, 7) for x in v3(p.getPosition())])
    ev = []
    if logger:
        for e in logger.getLoggedEvents():
            det = e.getEventDetector()
            # 监视器包装了原始探测器：按 getTotalEclipse 区分本影 / 半影
            inner = det.getDetector() if hasattr(det, 'getDetector') else det
            kind = 'umbra' if inner.getTotalEclipse() else 'penumbra'
            ev.append({'kind': kind, 'increasing': bool(e.isIncreasing()), 'tSec': float(e.getState().getDate().durationFrom(t0))})
        ev.sort(key=lambda x: x['tSec'])
    return out, ev

def ephem_table(t0ms, t1ms, step_s):
    sunT, moonT = [], []
    t = t0ms
    while t <= t1ms + 1e-6:
        d = date_of_ms(t)
        sunT.append([t] + v3(sun.getPosition(d, eme)))
        moonT.append([t] + v3(moon.getPosition(d, eme)))
        t += step_s * 1000.0
    return {'stepSec': step_s, 'sun': sunT, 'moon': moonT}

def save(name, obj):
    # gzip（mtime = 0，同输入同字节）；JS 测试用 zlib.gunzipSync 读
    import gzip
    path = os.path.join(OUT, name + '.gz')
    raw = json.dumps(obj, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    with open(path, 'wb') as f:
        f.write(gzip.compress(raw, compresslevel=9, mtime=0))
    print('wrote', name + '.gz', os.path.getsize(path), 'bytes')

META = {
    'generator': 'scripts/orekit-prop-refs.py',
    'orekit': 'orekit-13.1.9（orekit_jpype 13.1.9）',
    'orekitData': 'gitlab.orekit.org/orekit/orekit-data（DE-440-ephemerides/lnxp1990.440、tai-utc、EOP）',
    'spaceWeather': 'CelesTrak SW-All.csv 的 2025-03-01…2025-08-31 段（Orekit 读其 CSSI TXT 转写）',
    'integrator': 'DormandPrince853，ToleranceProvider dP = 1e-7 m，CARTESIAN，maxStep 见各算例（缺省 5 s）',
    'frames': 'EME2000 惯性；地固 GTOD(applyEOPCorr = false)',
    'mass': MASS, 'gm': GM, 'ae': AE,
    'gmSun': float(sun.getGM()), 'gmMoon': float(moon.getGM()),
}

# ---------- 1) 地固系：EME2000 → GTOD 旋转矩阵 ----------
frames = []
for k in range(24):
    ms = 946728000000.0 + k * 1.37e11 / 3 + 12345.0     # 2000-01-01 起约 4.3 年一步，跨到 2032 年
    d = date_of_ms(ms)
    tr = eme.getStaticTransformTo(gtod, d)
    cols = [tr.transformVector(u) for u in (Vector3D.PLUS_I, Vector3D.PLUS_J, Vector3D.PLUS_K)]
    # 行主序 M，v_gtod = M·v_eme：第 j 列 = e_j 变换后的分量
    m = [float(c) for row in ((cols[0].getX(), cols[1].getX(), cols[2].getX()), (cols[0].getY(), cols[1].getY(), cols[2].getY()), (cols[0].getZ(), cols[1].getZ(), cols[2].getZ())) for c in row]
    frames.append({'tMs': ms, 'm': m})

# ---------- 2) DE440 日月位置采样（测解析历表精度） ----------
eph = []
t = 946728000000.0     # 2000-01-01T12Z
while t < 4102444800000.0:   # 2100-01-01
    d = date_of_ms(t)
    eph.append([t] + v3(sun.getPosition(d, eme)) + v3(moon.getPosition(d, eme)))
    t += 37.3 * 86400e3
save('orekitFramesEphem.json', {'meta': META, 'frames': frames, 'ephem': eph})

# ---------- 3) NRLMSISE-00 密度与空间天气取值抽查 ----------
LEO_T0 = 1748736000000.0     # 2025-06-01T00:00:00Z
dens = []
import random
rnd = random.Random(20261017)
for k in range(120):
    ms = LEO_T0 - 20 * 86400e3 + rnd.random() * 60 * 86400e3
    lat = rnd.uniform(-89, 89) * D2R; lon = rnd.uniform(-180, 180) * D2R; h = rnd.uniform(120e3, 900e3)
    d = date_of_ms(ms)
    pf = earth.transform(GeodeticPoint(lat, lon, h))
    pe = gtod.getStaticTransformTo(eme, d).transformPosition(pf)
    atm = NRLMSISE00(cssi, sun, earth, utc).withLocalSolarTimeMode(NRLMSISE00.LocalSolarTimeMode.MEAN)
    rho = float(atm.getDensity(d, pe, eme))
    apa = [float(x) for x in cssi.getAp(d)]
    dens.append({'tMs': ms, 'r': v3(pe), 'rho': rho, 'f107': float(cssi.getDailyFlux(d)), 'f107A': float(cssi.getAverageFlux(d)), 'ap': apa})
# 同期 SW-All.csv 片段（JS 测试用，自包含；Orekit 读的正是它的 TXT 转写）
save('orekitDensity.json', {'meta': META, 'swCsv': SW_HEAD + '\n' + '\n'.join(SW_ROWS) + '\n', 'samples': dens})

# ---------- 4) 传播算例 ----------
GEO_T0 = 1789862400000.0     # 2026-09-20T00:00:00Z（秋分附近，GEO 每天过地影）
cases = []
r, v = coe2rv(MU_KM, 6378.137 + 450.0, 0.0012, 51.6 * D2R, 30 * D2R, 40 * D2R, 10 * D2R)
cases.append({'name': 'leo-grav21', 't0Ms': LEO_T0, 'r0': r, 'v0': v, 'durationSec': 7 * 86400.0, 'outStepSec': 600.0,
              'forces': {'gravity': {'degree': 21, 'order': 21}}})
cases.append({'name': 'leo-full', 't0Ms': LEO_T0, 'r0': r, 'v0': v, 'durationSec': 7 * 86400.0, 'outStepSec': 600.0, 'events': True,
              'forces': {'gravity': {'degree': 21, 'order': 21}, 'thirdBody': True, 'srp': {'cr': 1.3, 'areaToMass': 0.01},
                         'drag': {'cd': 2.2, 'areaToMass': 0.01}}})
cases.append({'name': 'leo-drag', 't0Ms': LEO_T0, 'r0': r, 'v0': v, 'durationSec': 7 * 86400.0, 'outStepSec': 600.0,
              'forces': {'gravity': {'degree': 21, 'order': 21}, 'drag': {'cd': 2.2, 'areaToMass': 0.01}}})
cases.append({'name': 'leo-srp', 't0Ms': LEO_T0, 'r0': r, 'v0': v, 'durationSec': 7 * 86400.0, 'outStepSec': 600.0, 'events': True,
              'forces': {'gravity': {'degree': 21, 'order': 21}, 'srp': {'cr': 1.3, 'areaToMass': 0.01}}})
cases.append({'name': 'leo-grav70', 't0Ms': LEO_T0, 'r0': r, 'v0': v, 'durationSec': 2 * 86400.0, 'outStepSec': 600.0,
              'forces': {'gravity': {'degree': 70, 'order': 70}}})
cases.append({'name': 'leo-tides1', 't0Ms': LEO_T0, 'r0': r, 'v0': v, 'durationSec': 7 * 86400.0, 'outStepSec': 600.0,
              'forces': {'gravity': {'degree': 21, 'order': 21, 'tideSystem': 'tide-free'}, 'thirdBody': True, 'tides': 'step1'}})
cases.append({'name': 'leo-tides', 't0Ms': LEO_T0, 'r0': r, 'v0': v, 'durationSec': 7 * 86400.0, 'outStepSec': 600.0,
              'forces': {'gravity': {'degree': 21, 'order': 21, 'tideSystem': 'tide-free'}, 'thirdBody': True, 'tides': 'iers2010'}})
cases.append({'name': 'leo-notides', 't0Ms': LEO_T0, 'r0': r, 'v0': v, 'durationSec': 7 * 86400.0, 'outStepSec': 600.0,
              'forces': {'gravity': {'degree': 21, 'order': 21, 'tideSystem': 'tide-free'}, 'thirdBody': True}})
rg, vg = coe2rv(MU_KM, 42164.17, 0.0002, 0.05 * D2R, 60 * D2R, 30 * D2R, 200 * D2R)
cases.append({'name': 'geo-full', 't0Ms': GEO_T0, 'r0': rg, 'v0': vg, 'durationSec': 7 * 86400.0, 'outStepSec': 1800.0, 'maxStepSec': 60.0, 'events': True,
              'forces': {'gravity': {'degree': 8, 'order': 8}, 'thirdBody': True, 'srp': {'cr': 1.3, 'areaToMass': 0.02}}})
rt, vt = coe2rv(MU_KM, (6378.137 * 2 + 400 + 35786) / 2, (35786 - 400) / (6378.137 * 2 + 400 + 35786), 27 * D2R, 100 * D2R, 180 * D2R, 0.0)
cases.append({'name': 'gto', 't0Ms': GEO_T0, 'r0': rt, 'v0': vt, 'durationSec': 7 * 86400.0, 'outStepSec': 900.0, 'maxStepSec': 10.0,
              'forces': {'gravity': {'degree': 8, 'order': 8}, 'thirdBody': True, 'srp': {'cr': 1.3, 'areaToMass': 0.015}}})

for c in cases:
    out, ev = run(c, c.get('events', False))
    c['ref'] = out
    if c.get('events'): c['eclipses'] = ev
    if c['forces'].get('thirdBody') or c['forces'].get('srp') or c['forces'].get('tides'):
        c['ephemTable'] = ephem_table(c['t0Ms'] - 86400e3, c['t0Ms'] + c['durationSec'] * 1000 + 86400e3, 3 * 3600.0)
    save('orekit-' + c['name'] + '.json', {'meta': META, 'case': c})

# ---------- 5) GEO 一年：倾角矢量 ----------
for i0 in (0.05, 1.0):
    rg, vg = coe2rv(MU_KM, 42164.17, 0.0002, i0 * D2R, 60 * D2R, 30 * D2R, 200 * D2R)
    c = {'name': 'geo-year-i%s' % i0, 't0Ms': GEO_T0, 'r0': rg, 'v0': vg, 'durationSec': 365 * 86400.0, 'outStepSec': 86400.0, 'maxStepSec': 300.0,
         'forces': {'gravity': {'degree': 8, 'order': 8}, 'thirdBody': True, 'srp': {'cr': 1.3, 'areaToMass': 0.02}}}
    prop, t0, _ = build(c)
    ref = []
    for k in range(366):
        st = prop.propagate(t0.shiftedBy(k * 86400.0))
        p = st.getPVCoordinates(eme)
        ref.append([k * 86400.0] + [round(x, 7) for x in v3(p.getPosition())] + [round(x, 10) for x in v3(p.getVelocity())])
    c['ref'] = ref
    save('orekit-geo-year-i%s.json' % i0, {'meta': META, 'case': c})
print('done')
