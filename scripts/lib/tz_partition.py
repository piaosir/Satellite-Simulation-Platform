# 时区面平面剖分（构建期，只被 scripts/build-timezones.mjs 调用；需要 Python 3.10+、shapely ≥ 2.1、numpy）
#
# 输入：本平台底图（某一档的 TopoJSON）、TBB 2026e 陆地时区面（1970 合并版）、NE 10m 时区面与日界线、
#       构建脚本备好的 meta（zone1970.tab 国家码、ISO3→ISO2、各单元的候选归属、台港澳与乌鲁木齐两条规则）。
# 输出：一张覆盖全球的平面剖分 faces（陆地 / 海区 / 内陆水域），坐标为经纬度浮点，交给 Node 侧建拓扑。
#
# 口径（任务书 §2.3 / §2.4）：
#   · 陆地几何一律用底图单元原坐标；多时区单元按 TBB 时区面切开，缝隙（底图与 OSM 国界、岸线不重合处）
#     按 Voronoi 最近归属分给相邻块 —— 长条缝不会整条并给一块。
#   · 单元的时区按「归属国」取：TBB 在此处标的时区属于该国（zone1970.tab 国家码）就用它，
#     否则取该国离这块地最近的时区；中国一律北京时间（Asia/Urumqi 当别名并入 Asia/Shanghai），
#     台港澳三个冻结单元各用自己的 tzdb 时区。
#   · 海区 15° 航海带固定偏移；日界线三处凸区按 NE 时区面的名义偏移；与大洋不连通的水面记内陆水域。
#   · 最后把所有边界线统一结点化、多边形化，再按「争议叠加 > 陆地块 > 海区 > 水域」的优先级回填属性，
#     保证公共边逐点相同（Node 侧建拓扑时共享弧靠的就是坐标逐位相等）。

import json
import math
import sys
import time

import numpy as np
import shapely
from shapely import STRtree, box
from shapely.geometry import LineString, MultiPoint, Polygon, shape
from shapely.ops import polylabel

KM_PER_DEG = 111.32


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def area_km2(g):
    """近似地表面积（km²）：逐个多边形按其质心纬度的 cos 修正。"""
    if g.is_empty:
        return 0.0
    tot = 0.0
    for p in getattr(g, 'geoms', [g]):
        if p.is_empty or p.geom_type != 'Polygon':
            continue
        c = p.centroid
        tot += p.area * KM_PER_DEG * KM_PER_DEG * max(0.05, math.cos(math.radians(c.y)))
    return tot


def polys_of(g):
    if g is None or g.is_empty:
        return []
    if g.geom_type == 'Polygon':
        return [g]
    if g.geom_type in ('MultiPolygon', 'GeometryCollection'):
        out = []
        for p in g.geoms:
            out.extend(polys_of(p))
        return out
    return []


def clean(g):
    if g is None or g.is_empty:
        return g
    if not g.is_valid:
        g = shapely.make_valid(g)
    ps = polys_of(g)
    if not ps:
        return Polygon()
    return shapely.union_all(ps) if len(ps) > 1 else ps[0]


# ---------------------------------------------------------------- 底图解码
def decode_topology(topo):
    sx, sy = topo['transform']['scale']
    tx, ty = topo['transform']['translate']
    arcs = []
    for a in topo['arcs']:
        x = y = 0
        pts = []
        for d in a:
            x += d[0]
            y += d[1]
            pts.append((x * sx + tx, y * sy + ty))
        arcs.append(pts)

    def ring(ids):
        out = []
        for k, i in enumerate(ids):
            seg = arcs[i] if i >= 0 else arcs[~i][::-1]
            out.extend(seg if k == 0 else seg[1:])
        return out

    def poly(rings):
        # 量化后退化的环（不足 4 点）：外环退化整块不要，洞退化只丢这个洞
        rs = [ring(r) for r in rings]
        if len(rs[0]) < 4:
            return None
        return Polygon(rs[0], [h for h in rs[1:] if len(h) >= 4])

    def geom(g):
        if g['type'] == 'Polygon':
            p = poly(g['arcs'])
            return clean(p) if p is not None else Polygon()
        if g['type'] == 'MultiPolygon':
            ps = [p for p in (poly(r) for r in g['arcs']) if p is not None]
            if not ps:
                return Polygon()
            return clean(shapely.MultiPolygon(ps) if len(ps) > 1 else ps[0])
        return Polygon()

    units = []
    for g in topo['objects']['units']['geometries']:
        units.append({'p': g['properties'], 'g': geom(g)})
    return units, (sx, sy, tx, ty)


# ---------------------------------------------------------------- 主流程
def main():
    args = dict(a.split('=', 1) for a in sys.argv[1:])
    t0 = time.time()
    meta = json.load(open(args['meta'], encoding='utf-8'))
    topo = json.load(open(args['basemap'], encoding='utf-8'))
    detail = args['detail']
    tol = {'10m': 0.004, '50m': 0.02, '110m': 0.08}[detail]
    units, (sx, sy, tx, ty) = decode_topology(topo)
    # 极冠：NE 的南极面在部分档位止于约 −85°（110m 一条横边封口），底图 ownerAt 把更南的极冠直接判南极洲 ——
    # 这里同一口径，把南极单元向下补到 −90°，否则极冠会被当成海。
    for u in units:
        if u['p'].get('u') == 'ATA' and not u['g'].is_empty:
            minlat = u['g'].bounds[1]
            if minlat > ty + 1e-9:
                xmax = tx + round((180 - tx) / sx) * sx
                u['g'] = clean(shapely.union(u['g'], box(tx, ty, xmax, minlat + 1e-9)))
    log(f'[{detail}] 底图单元 {len(units)}，解码 {time.time() - t0:.1f}s')

    zone_codes = {z: set(c) for z, c in meta['zoneCodes'].items()}
    alias = meta['alias']                       # {'Asia/Urumqi': 'Asia/Shanghai'}
    iso2 = meta['iso2']                         # ISO3 / SU_A3 / 本平台单元 id → ISO2
    owners_of = meta['owners']                  # 单元 id → [候选归属]
    keep_own = set(meta['keepOwn'])             # 台港澳：归 CHN 时仍用自己的时区
    china_owner, china_zone = meta['chinaOwner'], meta['chinaZone']
    principal = meta['principal']               # ISO2 → 主时区

    # ---------- TBB 时区面（别名并入）+ 覆盖简化 ----------
    t1 = time.time()
    tbb = json.load(open(args['tbb'], encoding='utf-8'))
    by_zone = {}
    for f in tbb['features']:
        z = f['properties']['tzid']
        z = alias.get(z, z)
        by_zone.setdefault(z, []).append(shape(f['geometry']))
    del tbb
    zones = sorted(by_zone)
    geoms = [clean(shapely.union_all(by_zone[z]) if len(by_zone[z]) > 1 else by_zone[z][0]) for z in zones]
    del by_zone
    log(f'[{detail}] TBB {len(zones)} 区，读入 {time.time() - t1:.1f}s')
    t1 = time.time()
    try:
        simp = list(shapely.coverage_simplify(np.array(geoms, dtype=object), tol, simplify_boundary=True))
        simp = [clean(g) for g in simp]
        log(f'[{detail}] TBB 覆盖简化（容差 {tol}°）{time.time() - t1:.1f}s')
    except Exception as e:   # 覆盖不合法时退回逐面拓扑保持简化（相邻面公共边可能差一点，靠缝隙 Voronoi 兜住）
        log(f'[{detail}] coverage_simplify 失败（{e}），退回逐面简化')
        simp = [clean(shapely.simplify(g, tol, preserve_topology=True)) for g in geoms]
    del geoms
    tbb_tree = STRtree(simp)
    zone_idx = {z: i for i, z in enumerate(zones)}

    def zones_in(g):
        """g 内各 TBB 时区的面积（km²）。"""
        out = {}
        for i in tbb_tree.query(g, predicate='intersects'):
            inter = clean(shapely.intersection(simp[i], g))
            a = area_km2(inter)
            if a > 0:
                out[zones[i]] = out.get(zones[i], 0) + a
        return out

    def codes_of(*ids):
        s = set()
        for k in ids:
            if k and k in iso2 and iso2[k]:
                s.add(iso2[k])
        return s

    zone_class = meta.get('zoneClass', {})     # TBB 代表名 → 1970 年以来逐时刻相同的整类（构建脚本按 TZif 求的）

    def members(z):
        return zone_class.get(z) or [z]

    def accepted(z, codes):
        return any(zone_codes.get(m, set()) & codes for m in members(z))

    def localize(z, codes):
        """TBB 代表名 → 类里属于该国的那个（同类偏移逐时刻相同，只是名字对上国家，读数里的 IANA 名才不会张冠李戴）。"""
        if not z or not codes or zone_codes.get(z, set()) & codes:
            return z
        for m in members(z):
            if zone_codes.get(m, set()) & codes:
                return m
        return z

    def nearest_zone(codes, pt):
        """codes 里任一国家的时区中，离 pt 最近的那个；没有 TBB 面就退到 zone1970.tab 的主时区。"""
        best, bd = None, float('inf')
        for i, z in enumerate(zones):
            if not accepted(z, codes):
                continue
            d = simp[i].distance(pt)
            if d < bd:
                best, bd = z, d
        if best:
            return localize(best, codes)
        for c in sorted(codes):
            if c in principal:
                return principal[c]
        return None

    NEAR_OWN = 0.25     # 度：本国时区离单元代表点这么近，算「粗档几何偏了」而不是「海外飞地」

    def nearest_zone_d(codes, pt):
        """同 nearest_zone，但只认 TBB 面、连距离（度）一起返回：(时区, 距离) 或 None。"""
        best, bd = None, float('inf')
        for i, z in enumerate(zones):
            if not accepted(z, codes):
                continue
            d = simp[i].distance(pt)
            if d < bd:
                best, bd = z, d
        return (localize(best, codes), bd) if best else None

    def band_zone(lon):
        k = int(math.floor((lon + 7.5) / 15.0))
        k = max(-12, min(12, k))
        if lon >= 172.5:
            k = 12
        if lon < -172.5:
            k = -12
        return 'Etc/GMT' if k == 0 else ('Etc/GMT-%d' % k if k > 0 else 'Etc/GMT+%d' % (-k))

    owner_table.ctx = {'china_owner': china_owner, 'china_zone': china_zone, 'keep_own': keep_own,
                       'codes_of': lambda o: codes_of(o), 'accepted': accepted, 'nearest_zone': nearest_zone,
                       'localize': localize}

    # ---------- 陆地：逐单元求时区、多时区单元切块 ----------
    t1 = time.time()
    world_y1 = ty + math.floor((90 - ty) / sy) * sy
    world_x0, world_x1 = tx, tx + round((180 - tx) / sx) * sx
    bands = []
    for k in range(-12, 13):
        a, b = max(-180.0, 15 * k - 7.5), min(180.0, 15 * k + 7.5)
        if k == -12:
            a = world_x0
        if k == 12:
            b = world_x1
        bands.append((k, box(a, ty, b, world_y1)))

    sources = []      # [{'g', 'pri', 'attr'}]
    base_units = [u for u in units if not u['p'].get('dispute')]
    overlays = [u for u in units if u['p'].get('dispute')]
    n_split = 0
    split_log = []
    near_log = []     # 本国时区没压上、取了旁边本国时区（而不是此处邻国事实时区）的单元
    for u in base_units:
        p, g = u['p'], u['g']
        if g.is_empty:
            continue
        uid = p['u']
        codes = codes_of(uid, p.get('iso'), p.get('own0'))
        rep = g.representative_point()
        attr = {'k': 'land', 'u': uid}
        cand = sorted(set([p.get('own0')] + owners_of.get(uid, [])) - {None})
        mine = []                                 # [(pri, geom, zone)]
        if 'CN' in codes and uid not in keep_own:
            mine.append((2, g, china_zone))
        elif uid == 'ATA':
            # 南极只认各站的 Antarctica/* 楔形区：TBB 把南极点站（新西兰时间）画成一顶到 81°S 的极冠、
            # 昭和站一带并进了 Asia/Riyadh 的整条经带 —— 照用会在南极腹地拉出横贯的假日界线，其余一律按航海带
            acc = [z for z in zin_sorted(zones_in(g)) if z.startswith('Antarctica/')]
            pieces = []
            for z in acc:
                pz = clean(shapely.intersection(g, simp[zone_idx[z]]))
                if not pz.is_empty:
                    pieces.append((z, pz))
            rest = clean(shapely.difference(g, shapely.union_all([pz for _, pz in pieces]))) if pieces else g
            for k, bx in bands:
                pz = clean(shapely.intersection(rest, bx))
                if not pz.is_empty:
                    pieces.append((band_zone(15 * k), pz))
            mine.extend((3, pz, z) for z, pz in pieces)
            mine.append((2, g, band_zone(rep.x)))
            n_split += 1
        else:
            zin = zones_in(g)
            acc = {z: a for z, a in zin.items() if accepted(z, codes)}
            sig = []
            # 邻国的细缝已被「时区国家码须属于本单元」挡掉，这里只留面积下限（环礁天生细长，不能按宽度筛）
            for z in zin_sorted(acc):
                if acc[z] < 1:
                    continue
                pz = clean(shapely.intersection(g, simp[zone_idx[z]]))
                if not pz.is_empty:
                    sig.append((z, pz))
            if len(sig) >= 2:
                for z, pz in split_with_gaps(g, sig):
                    mine.append((3, pz, localize(z, codes)))
                main = max(sig, key=lambda t: area_km2(t[1]))[0]
                mine.append((2, g, localize(main, codes)))
                n_split += 1
                split_log.append(f'{uid}:{len(sig)}')
            else:
                # 本国时区优先；国家码对不上任何时区（英属塞浦路斯基地、联合国缓冲区、北塞这类没有 ISO 码的单元）
                # 就用 TBB 在此处标的事实时区；TBB 完全没覆盖才退到本国最近的时区 / 航海带。
                # ★ 本国时区一点没压上、但就在旁边（≤ NEAR_OWN）：是粗档几何偏了（50m 的澳门整块挪到了珠海那边），
                #   仍取本国时区 —— 否则会拿到邻国的事实时区（澳门成了 Asia/Shanghai）。离得远的（海外基地）照旧按事实时区。
                near = nearest_zone_d(codes, rep) if codes else None
                if sig:
                    z = sig[0][0]
                elif acc:
                    z = max(acc, key=acc.get)
                elif near and near[1] <= NEAR_OWN:
                    z = near[0]
                    if zin and max(zin, key=zin.get) != z:
                        near_log.append(f'{uid}:{z}')
                elif zin:
                    z = max(zin, key=zin.get)
                else:
                    z = near[0] if near else nearest_zone(codes, rep)
                mine.append((2, g, localize(z, codes) or band_zone(rep.x)))
        for pri, pg, z in mine:
            a2 = {**attr, 'z0': z}
            if len(cand) > 1:
                a2['zt'] = owner_table(z, cand, pg, uid)
            sources.append({'g': pg, 'pri': pri, 'attr': a2})

    log(f'[{detail}] 陆地基础单元 {len(base_units)}（切块 {n_split}）{time.time() - t1:.1f}s')
    log('    多时区单元 ' + ' '.join(sorted(split_log)))
    if near_log:
        log('    粗档几何偏离、改取旁边本国时区 ' + ' '.join(sorted(near_log)))

    # 争议叠加：不切块；事实时区取面积最大的 TBB 时区，候选归属逐个求
    for k, u in enumerate(overlays):
        p, g = u['p'], u['g']
        if g.is_empty:
            continue
        uid = p['u']
        zin = zones_in(g)
        rep = g.representative_point()
        oc = codes_of(p.get('iso'), p.get('own0'))
        z0 = localize(max(zin, key=zin.get), oc) if zin else (nearest_zone(oc, rep) or band_zone(rep.x))
        cand = sorted(set([p.get('own0')] + owners_of.get(uid, [])) - {None})
        attr = {'k': 'land', 'u': p.get('host'), 'd': uid, 'z0': z0}
        attr['zt'] = owner_table(z0, cand, g, uid)
        sources.append({'g': g, 'pri': 10 + k, 'attr': attr})

    # ---------- 海区 ----------
    t1 = time.time()
    land = shapely.union_all([u['g'] for u in units if not u['g'].is_empty])
    world = box(world_x0, ty, world_x1, world_y1)
    water = clean(shapely.difference(world, land))
    wparts = sorted(polys_of(water), key=lambda q: -q.area)
    ocean_parts = [wparts[0]] if wparts else []
    inland = wparts[1:]
    ref = meta.get('inlandRef')                 # 10m 档判出来的内陆水域代表点：粗档里断开的海峡不误判
    if ref is not None and wparts:
        # 大洋恒取最大那块；其余水面里含 10m 内陆参照点的才算内陆（粗档里断开的海峡、并进大洋的潟湖都不误判）
        ocean_parts, inland = [wparts[0]], []
        for q in wparts[1:]:
            hit = any(q.contains(shapely.Point(x, y)) for x, y in ref)
            (inland if hit else ocean_parts).append(q)
    ocean = shapely.union_all(ocean_parts)

    # 日界线凸区：NE 日界线里两端都落在 ±180° 且偏离经线的那几段，与经线围成的面
    idl = json.load(open(args['idl'], encoding='utf-8'))
    bulges = []
    for part in idl:
        xs = [c[0] for c in part]
        # NE shapefile 里的端点离 ±180° 有 1e-3° 级误差：按 0.01° 容差认端点、并吸附到图幅边
        if abs(abs(part[0][0]) - 180) > 0.01 or abs(abs(part[-1][0]) - 180) > 0.01:
            continue
        edge = 180.0 if part[0][0] > 0 else -180.0
        if max(abs(x - edge) for x in xs) < 0.5:
            continue
        ring = [(world_x1 if c[0] >= 179.99 else world_x0 if c[0] <= -179.99 else c[0], c[1]) for c in part]
        bg = clean(Polygon(ring + [ring[0]]))
        if not bg.is_empty:
            bulges.append(bg)
    bulge = shapely.union_all(bulges) if bulges else Polygon()
    netz = json.load(open(args['netz'], encoding='utf-8'))
    sea_zones = []
    for k, bx in bands:
        bz = clean(shapely.difference(bx, bulge))
        if not bz.is_empty:
            sea_zones.append((60 * k, bz))
    covered = 0.0
    def snap_edge(g):
        # NE 时区面在 ±180° 处的坐标带 1e-2° 级误差：吸附到图幅边，否则凸区里沿图边留一条细缝
        return shapely.transform(g, lambda c: np.column_stack([
            np.where(c[:, 0] >= 179.99, world_x1, np.where(c[:, 0] <= -179.99, world_x0, c[:, 0])), c[:, 1]]))
    for f in netz['features']:
        gz = clean(shapely.intersection(clean(snap_edge(shape(f['geometry']))), bulge))
        if gz.is_empty:
            continue
        sea_zones.append((int(round(float(f['properties']['zone']) * 60)), gz))
        covered += gz.area
    if bulge.area > 0 and abs(covered - bulge.area) / bulge.area > 1e-3:
        raise SystemExit(f'日界线凸区未被 NE 时区面铺满：{covered:.4f} / {bulge.area:.4f}')
    for off, zg in sea_zones:
        sz = clean(shapely.intersection(ocean, zg))
        if not sz.is_empty:
            sources.append({'g': sz, 'pri': 1, 'attr': {'k': 'sea', 'off': off}})
    for q in inland:
        sources.append({'g': q, 'pri': 0, 'attr': {'k': 'water'}})
    log(f'[{detail}] 海区：大洋 {len(ocean_parts)} 块、内陆水域 {len(inland)} 块、凸区 {len(bulges)}，{time.time() - t1:.1f}s')

    # ---------- 统一结点化 + 多边形化 + 回填属性 ----------
    t1 = time.time()
    lines = shapely.union_all([shapely.boundary(s['g']) for s in sources if not s['g'].is_empty] + [shapely.boundary(world)])
    faces = polys_of(shapely.polygonize(list(shapely.get_parts(lines))))
    log(f'[{detail}] 结点化 + 多边形化：{len(faces)} 面，{time.time() - t1:.1f}s')
    t1 = time.time()
    src_geoms = [s['g'] for s in sources]
    tree = STRtree(src_geoms)
    attrs = []
    orphan_ix = []
    for fi, f in enumerate(faces):
        rp = f.representative_point()
        best = None
        for i in tree.query(rp, predicate='intersects'):
            if best is None or sources[i]['pri'] > sources[best]['pri']:
                best = i
        attrs.append(sources[best]['attr'] if best is not None else None)
        if best is None:
            orphan_ix.append(fi)
    # 无主面（各来源的边界因清理 / 求交差一丝而夹出的细缝）：并给共边最长的邻面
    orphan_area = 0.0
    if orphan_ix:
        ftree = STRtree(faces)
        for _ in range(3):
            left = []
            for fi in orphan_ix:
                f = faces[fi]
                best, bl = None, 0.0
                for j in ftree.query(f, predicate='intersects'):
                    if j == fi or attrs[j] is None:
                        continue
                    l = shapely.intersection(shapely.boundary(f), shapely.boundary(faces[j])).length
                    if l > bl:
                        best, bl = j, l
                if best is None:
                    left.append(fi)
                else:
                    attrs[fi] = attrs[best]
                    orphan_area += area_km2(f)
                    if area_km2(f) > 20:
                        log(f'    细缝 {area_km2(f):.0f} km² {[round(v, 2) for v in f.bounds]} → {attrs[best]}')
            orphan_ix = left
            if not orphan_ix:
                break
        for fi in orphan_ix:
            rp = faces[fi].representative_point()
            attrs[fi] = {'k': 'sea', 'off': 60 * max(-12, min(12, int(math.floor((rp.x + 7.5) / 15.0))))}
    # 属性完全相同的面并成一个多部件面（群岛的每个小岛原本各自一面）：属性开销与运行时面数都降一个量级；
    # 锚点取最大那一块的 polylabel
    groups = {}
    for fi, f in enumerate(faces):
        key = json.dumps(attrs[fi], sort_keys=True, ensure_ascii=False)
        groups.setdefault(key, []).append(f)
    out = []
    for key, fs in groups.items():
        big = max(fs, key=lambda q: q.area)
        out.append({**json.loads(key), 'a': anchor(big), 'g': [poly_coords(q) for q in fs]})
    log(f'[{detail}] 回填属性 {time.time() - t1:.1f}s，无主细缝并入邻面 {orphan_area:.1f} km²，仍无主 {len(orphan_ix)}')

    res = {'detail': detail, 'faces': out}
    if detail == '10m':
        res['inlandRef'] = [[q.representative_point().x, q.representative_point().y] for q in inland]
    json.dump(res, open(args['out'], 'w', encoding='utf-8'), ensure_ascii=False)
    log(f'[{detail}] 完成 {time.time() - t0:.1f}s')



def zin_sorted(d):
    """按面积从大到小、同面积按名字，保证构建结果可复现。"""
    return sorted(d, key=lambda z: (-d[z], z))


def owner_table(z0, cand, g, uid):
    """候选归属 → 时区：z0 属于该国就用 z0，否则取该国离这块地最近的时区（中国一律北京时间，台港澳例外）。"""
    M = owner_table.ctx
    tab = {}
    rep = g.representative_point()
    for o in cand:
        if o in ('disputed', 'none'):
            continue
        if o == M['china_owner']:
            tab[o] = z0 if uid in M['keep_own'] else M['china_zone']
            continue
        codes = M['codes_of'](o)
        if not codes:
            continue
        tab[o] = M['localize'](z0, codes) if M['accepted'](z0, codes) else (M['nearest_zone'](codes, rep) or z0)
    return tab


def split_with_gaps(g, sig):
    """多时区单元：各有效时区面切出的块 + 缝隙按 Voronoi 最近块分配。返回 [(zone, geom)]。"""
    pieces = [(z, pz) for z, pz in sig if not pz.is_empty]
    allp = shapely.union_all([pz for _, pz in pieces])
    gap = clean(shapely.difference(g, allp))
    extra = {z: [] for z, _ in pieces}
    for q in polys_of(gap):
        if q.area < 1e-10:
            continue
        near = [(z, pz) for z, pz in pieces if pz.distance(q) < 1e-7]
        if not near:
            z = min(pieces, key=lambda t: t[1].distance(q))[0]
            extra[z].append(q)
            continue
        if len(near) == 1:
            extra[near[0][0]].append(q)
            continue
        # 沿各块与缝隙相邻的边界取样点，Voronoi 分区后按样点归属切缝
        pts, lab = [], []
        qb = q.buffer(1e-6)
        for z, pz in near:
            edge = shapely.intersection(shapely.boundary(pz), qb)
            if edge.is_empty:
                continue
            seg = shapely.segmentize(edge, 0.01)
            for c in shapely.get_coordinates(seg):
                pts.append((c[0], c[1]))
                lab.append(z)
        # 同一坐标只留一次；落在两块交界上的点（两边各取到一次、标签不同）没有归属意义，直接丢掉
        seen = {}
        for (x, y), z in zip(pts, lab):
            key = (round(x, 7), round(y, 7))
            seen[key] = z if seen.get(key, z) == z else None
        pts = [k for k, z in seen.items() if z is not None]
        lab = [seen[k] for k in pts]
        if len(pts) < 2 or len(set(lab)) < 2:
            extra[(lab[0] if lab else near[0][0])].append(q)
            continue
        cells = shapely.voronoi_polygons(MultiPoint(pts), extend_to=q.envelope.buffer(1.0), ordered=True)
        per = {}
        for cell, z in zip(cells.geoms, lab):
            per.setdefault(z, []).append(cell)
        for z, cs in per.items():
            part = clean(shapely.intersection(q, shapely.union_all(cs)))
            if not part.is_empty:
                extra[z].append(part)
    out = []
    for z, pz in pieces:
        out.append((z, clean(shapely.union_all([pz] + extra[z])) if extra[z] else pz))
    return out


def anchor(f):
    """标注锚点：在 cos(φ) 拉伸的局部平面里取 polylabel，半径折回「纬度度」。"""
    p = max(polys_of(f), key=lambda q: q.area)
    c = p.centroid
    k = max(0.05, math.cos(math.radians(c.y)))
    sc = shapely.affinity.scale(p, xfact=k, yfact=1.0, origin=(0, 0))
    tol = max(1e-4, min(0.05, math.sqrt(sc.area) / 200))
    try:
        lp = polylabel(sc, tolerance=tol)
    except Exception:
        lp = sc.representative_point()
    r = shapely.distance(lp, sc.exterior)
    for h in sc.interiors:
        r = min(r, shapely.distance(lp, h))
    return [round(lp.x / k, 3), round(lp.y, 3), round(float(r), 3)]


def poly_coords(f):
    return [[[x, y] for x, y in f.exterior.coords]] + [[[x, y] for x, y in h.coords] for h in f.interiors]


if __name__ == '__main__':
    import shapely.affinity  # noqa: F401  (anchor 用)
    main()
