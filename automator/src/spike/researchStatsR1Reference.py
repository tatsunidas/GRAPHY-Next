"""researchStatsPluginCheck.ts [5] の参照値。プラグインとは別実装（statsmodels / scipy / 総当たり）で、
同じ CSV から中央値分割・BH 補正・多変量 Cox を計算して JSON で出す。
usage: researchStatsR1Reference.py <features.csv> <clinical.csv> <out.json>
"""
import csv, json, sys
import numpy as np
import scipy.stats as st
from statsmodels.duration.hazard_regression import PHReg
from statsmodels.duration.survfunc import survdiff

feat = list(csv.DictReader(open(sys.argv[1])))
clin = {r["CaseLabel"]: r for r in csv.DictReader(open(sys.argv[2]))}
ids = [r["CaseLabel"] for r in feat]
names = [k for k in feat[0] if k != "CaseLabel"]
time = np.array([float(clin[i]["time"]) for i in ids]); ev = np.array([int(clin[i]["event"]) for i in ids]); age = np.array([float(clin[i]["age"]) for i in ids])
X = {k: np.array([float(r[k]) for r in feat]) for k in names}

def cidx(t, e, risk):
    c = m = 0.0
    for i in range(len(t)):
        if e[i] != 1: continue
        for j in range(len(t)):
            if t[j] > t[i]:
                m += 1
                c += 1 if risk[i] > risk[j] else (0.5 if risk[i] == risk[j] else 0)
    return c / m

rows = {}
for k, x in X.items():
    g = (x > np.median(x)).astype(int)
    chi, p = survdiff(time, ev, g)
    hg = PHReg(time, g[:, None].astype(float), status=ev, ties="efron").fit(disp=0)
    z = (x - x.mean()) / x.std(ddof=1)
    hz = PHReg(time, z[:, None], status=ev, ties="efron").fit(disp=0)
    rows[k] = {"n_low": int((g == 0).sum()), "n_high": int((g == 1).sum()), "p": float(p), "hr_group": float(np.exp(hg.params[0])), "hr_sd": float(np.exp(hz.params[0])), "p_sd": float(hz.pvalues[0])}
q = st.false_discovery_control([rows[k]["p"] for k in names], method="bh")
for k, v in zip(names, q): rows[k]["q"] = float(v)
sel = [k for k in names if rows[k]["q"] < 0.05]
out = {"rows": rows, "selected": sel}
if sel:
    M = np.column_stack([(X[k] - X[k].mean()) / X[k].std(ddof=1) for k in sel] + [age])
    m = PHReg(time, M, status=ev, ties="efron").fit(disp=0)
    mc = PHReg(time, age[:, None], status=ev, ties="efron")
    fc = mc.fit(disp=0)
    out["model"] = {"terms": sel + ["age"], "hr": np.exp(m.params).tolist(), "p": m.pvalues.tolist(), "cindex": cidx(time, ev, M @ m.params),
                    "added_chi2": float(2 * (m.llf - fc.llf)), "added_p": float(st.chi2.sf(2 * (m.llf - fc.llf), len(sel)))}
json.dump(out, open(sys.argv[3], "w"))
