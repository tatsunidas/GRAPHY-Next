"""researchStatsPluginCheck.ts [8] の参照値。プラグインとは別実装（pingouin の intraclass_corr、numpy・scipy）で、
同じ CSV から再現性（R3）の結果を計算して JSON で出す。pingouin が入った Python で実行する
（システムの環境を変えないよう、使い捨ての venv に入れる。RESEARCH_STATS_REF_PYTHON でその python を指す）。
usage: researchStatsR3Reference.py <condA.csv> <condB.csv> <condC.csv> <out.json>
"""
import csv, json, sys
import numpy as np
import pandas as pd
import pingouin as pg
import pingouin.reliability as _rel
import scipy.stats as st

_rel._postprocess_dataframe = lambda df: df  # CI95% を丸めない（計算は pingouin のまま）
files = sys.argv[1:4]
tables = [list(csv.DictReader(open(f))) for f in files]
maps = [{r["CaseLabel"]: r for r in t} for t in tables]
ids = [i for i in maps[0] if all(i in m for m in maps)]
unmatched = sorted({i for m in maps for i in m} - set(ids))
feats = [k for k in tables[0][0] if k not in ("CaseLabel",) and all(k in m[ids[0]] for m in maps)]
out = {"ids": len(ids), "unmatched": unmatched, "features": {}}
def cat(lower): return "poor" if lower < 0.5 else "moderate" if lower < 0.75 else "good" if lower <= 0.9 else "excellent"
for k in feats:
    try:
        cols = [[m[i][k] for i in ids] for m in maps]
        vals = np.array([[float(v) if v != "" else np.nan for v in c] for c in cols]).T
    except ValueError:
        continue  # 数でない値のある列は使わない
    ok = ~np.isnan(vals).any(axis=1)
    M = vals[ok]
    df = pd.DataFrame({"s": np.repeat(np.arange(len(M)), M.shape[1]), "c": np.tile(np.arange(M.shape[1]), len(M)), "v": M.reshape(-1)})
    t = pg.intraclass_corr(data=df, targets="s", raters="c", ratings="v").set_index("Type")
    lo = float(t.loc["ICC2", "CI95%"][0]); hi = float(t.loc["ICC2k", "CI95%"][1]); ic = float(t.loc["ICC2", "ICC"])
    lo1 = float(t.loc["ICC2", "CI95%"][0]); hi1 = float(t.loc["ICC2", "CI95%"][1])
    if not (np.isfinite(lo1) and np.isfinite(hi1)):
        # 誤差の分散が 0（全条件で同じ値）だと pingouin は信頼区間を NaN にする。区間は比べず、ICC と区分は別に確かめる
        out["features"][k] = {"n": int(ok.sum()), "icc": ic, "lower": None, "upper": None, "icc_t": max(0.0, ic), "lower_t": None, "upper_t": None, "category": None}
        continue
    out["features"][k] = {"n": int(ok.sum()), "icc": ic, "lower": lo1, "upper": hi1, "icc_t": max(0.0, ic), "lower_t": max(0.0, lo1), "upper_t": max(0.0, hi1), "category": cat(max(0.0, lo1))}
# Bland–Altman: f_shift, A → C
a = np.array([float(maps[0][i]["f_shift"]) for i in ids]); b = np.array([float(maps[2][i]["f_shift"]) for i in ids])
d = b - a; n = len(d); bias = d.mean(); sd = d.std(ddof=1); tq = st.t.ppf(0.975, n - 1)
se_b = sd / np.sqrt(n); se_l = np.sqrt(sd**2 * (1 / n + 1.96**2 / (2 * (n - 1))))
out["ba"] = {"n": n, "bias": float(bias), "bias_ci": [float(bias - tq * se_b), float(bias + tq * se_b)], "sd": float(sd),
             "lo": float(bias - 1.96 * sd), "hi": float(bias + 1.96 * sd)}
json.dump(out, open(sys.argv[4], "w"), allow_nan=False)
