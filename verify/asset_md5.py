#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""APK ↔ 源码素材一致性（md5 清单，≥43 件）+ 翅膀对称真实量测。

P2-3（R7-01 顺手修）：翅膀对称检查改为对本包最终素材真实量测，
不再复读 pipeline_report.json 的中间体数值。

量测口径（与 pipeline 修形前后口径一致）：
- 图像：源码树最终素材 game/sprites/housefly_{1,2,3}_wing.webp（翅膀叠加层，即打进 APK 的同一文件；
  主精灵 housefly_*.webp 为身体+翅膀合成图，左右天然不对称，不作为对称门禁对象）
- 身体轴：身体像素（alpha>16）包围盒，axis = round((min_x + max_x + 1) / 2)
- span_l / span_r：翅膀像素（alpha>16）在轴左 / 右侧的水平伸展距离
- span_diff_pct = |span_l - span_r| / max(span_l, span_r) × 100
- area_l / area_r：轴左 / 右侧翅膀像素数；area_diff_pct 同理
- 门禁：两项均 ≤ 10%
"""
import zipfile, hashlib, os, json, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
GAME = os.path.join(ROOT, "../src/app/src/main/assets")
APK = os.path.join(ROOT, "../src/app/build/outputs/apk/release/app-release.apk")
EV = os.path.join(ROOT, "../artifacts/evidence")

def md5(b): return hashlib.md5(b).hexdigest()

# 源码侧
src = {}
for dp, dn, fn in os.walk(GAME):
    for f in fn:
        p = os.path.join(dp, f)
        rel = os.path.relpath(p, GAME)
        src[rel] = md5(open(p, "rb").read())

# APK 侧
apk = {}
with zipfile.ZipFile(APK) as z:
    for n in z.namelist():
        if n.startswith("assets/") and not n.endswith("/"):
            apk[n[len("assets/"):]] = md5(z.read(n))

missing_in_apk = sorted(set(src) - set(apk))
missing_in_src = sorted(set(apk) - set(src))
mismatch = sorted(k for k in set(src) & set(apk) if src[k] != apk[k])
common = len(set(src) & set(apk))


def measure_wing(path):
    """对单张最终素材做翅膀对称真实量测（口径见模块 docstring）。"""
    from PIL import Image
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    px = im.load()
    xs = [x for y in range(h) for x in range(w) if px[x, y][3] > 16]
    min_x, max_x = min(xs), max(xs)
    axis = round((min_x + max_x + 1) / 2)
    span_l = span_r = 0
    area_l = area_r = 0
    for y in range(h):
        for x in range(w):
            if px[x, y][3] > 16:
                if x < axis:
                    area_l += 1
                    span_l = max(span_l, axis - x)
                elif x > axis:
                    area_r += 1
                    span_r = max(span_r, x - axis)
    pct = lambda a, b: round(abs(a - b) / max(a, b) * 100, 2) if max(a, b) else 0.0
    return {
        "image": "%dx%d" % (w, h), "axis": axis,
        "span_l": span_l, "span_r": span_r,
        "span_diff_pct": pct(span_l, span_r),
        "area_l": area_l, "area_r": area_r,
        "area_diff_pct": pct(area_l, area_r),
        "measure_axis_rule": "axis=round((min_x+max_x+1)/2), body bbox alpha>16",
        "alpha_threshold": 16, "gate_pct": 10,
    }


# 翅膀对称真实量测（P2-3：直接量最终素材，不再复读 pipeline_report）
wing = {}
for name in ("housefly_1", "housefly_2", "housefly_3"):
    p = os.path.join(GAME, "game/sprites/%s_wing.webp" % name)
    wing[name] = measure_wing(p)
wing_ok = all(
    v["span_diff_pct"] <= 10 and v["area_diff_pct"] <= 10 for v in wing.values()
)

out = {
    "suite": "asset_manifest",
    "source_file_count": len(src), "apk_asset_count": len(apk), "common": common,
    "count_gate_43plus": common >= 43,
    "missing_in_apk": missing_in_apk, "missing_in_src": missing_in_src, "md5_mismatch": mismatch,
    "wing_symmetry_after": wing, "wing_symmetry_ok": wing_ok,
    "wing_symmetry_method": "real-measure on final *_wing.webp overlays (P2-3), axis=body bbox alpha>16, gate<=10%",
    "files": {k: {"src": src[k], "apk": apk.get(k)} for k in sorted(set(src) & set(apk))},
    "pass": common >= 43 and not missing_in_apk and not missing_in_src and not mismatch and wing_ok,
}
json.dump(out, open(os.path.join(EV, "asset_manifest.json"), "w"), ensure_ascii=False, indent=1)
print(json.dumps({k: v for k, v in out.items() if k != "files"}, ensure_ascii=False, indent=1))
sys.exit(0 if out["pass"] else 1)
