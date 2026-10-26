"""researchStatsPluginCheck.ts [7] の参照値。プラグインとは別実装（scikit-learn / statsmodels / scipy / 総当たり）で、
同じ CSV から判別（R2）の結果を計算して JSON で出す。
usage: researchStatsR2Reference.py <features.csv> <clinical.csv> <out.json>
"""
import csv, json, sys
import numpy as np
import scipy.stats as st
import statsmodels.api as sm
from sklearn.metrics import roc_auc_score

feat = list(csv.DictReader(open(sys.argv[1])))
clin = {r["CaseLabel"]: r for r in csv.DictReader(open(sys.argv[2]))}
ids = [r["CaseLabel"] for r in feat]
names = [k for k in feat[0] if k != "CaseLabel"]
X = np.column_stack([[float(r[k]) for r in feat] for k in names])
y = np.array([1 if clin[i]["outcome"] == "resp" else 0 for i in ids])
n, m = X.shape
ALPHA = 0.05

def delong_se(s, y):
    P, N = s[y == 1], s[y == 0]
    psi = lambda a, b: 1.0 if a > b else (0.5 if a == b else 0.0)
    v10 = np.array([np.mean([psi(p, q) for q in N]) for p in P]); v01 = np.array([np.mean([psi(p, q) for p in P]) for q in N])
    return float(np.sqrt(v10.var(ddof=1) / len(P) + v01.var(ddof=1) / len(N)))

def best_cut_acc(s, y, d):
    u = np.unique(s); best = None
    for a, b in zip(u[:-1], u[1:]):
        c = (a + b) / 2; pred = (s > c) if d == "higher" else (s < c)
        tp = int((pred & (y == 1)).sum()); fp = int((pred & (y == 0)).sum()); tn = int((~pred & (y == 0)).sum()); fn = int((~pred & (y == 1)).sum())
        v = (tp + tn) / len(y)
        if best is None or v > best[0] + 1e-12: best = (v, c, tp, fp, tn, fn)
    return {"cut": float(best[1]), "tp": best[2], "fp": best[3], "tn": best[4], "fn": best[5]}

rows = {}
for j, k in enumerate(names):
    a = roc_auc_score(y, X[:, j]); d = "lower" if a < 0.5 else "higher"
    auc = max(a, 1 - a)
    mw = st.mannwhitneyu(X[y == 1, j], X[y == 0, j], alternative="two-sided", method="asymptotic", use_continuity=True).pvalue
    rows[k] = {"direction": d, "auc": float(auc), "se": delong_se(X[:, j] if d == "higher" else -X[:, j], y), "p": float(mw), "cut": best_cut_acc(X[:, j], y, d)}
q = st.false_discovery_control([rows[k]["p"] for k in names], method="bh")
for k, v in zip(names, q): rows[k]["q"] = float(v)
meets = [j for j, k in enumerate(names) if rows[k]["q"] < ALPHA]
out = {"rows": rows, "meets": [names[j] for j in meets]}

def logit_fit(Z, yy):
    return sm.Logit(yy, sm.add_constant(Z, has_constant="add")).fit(method="newton", tol=1e-12, maxiter=200, disp=0)

if len(meets) >= 2:
    order = sorted(meets, key=lambda j: (rows[names[j]]["p"], j))[:2]
    mu = X[:, order].mean(0); sd = X[:, order].std(0, ddof=1); Z = (X[:, order] - mu) / sd
    f = logit_fit(Z, y); pred = f.predict(sm.add_constant(Z))
    out["combo"] = {"features": [names[j] for j in order], "apparent_auc": float(roc_auc_score(y, pred)), "apparent_se": delong_se(np.asarray(pred), y)}
    def select(idx):
        ps = [st.mannwhitneyu(X[idx][y[idx] == 1][:, j], X[idx][y[idx] == 0][:, j], alternative="two-sided", method="asymptotic", use_continuity=True).pvalue for j in range(m)]
        qq = st.false_discovery_control(ps, method="bh")
        keep = [j for j in range(m) if qq[j] < ALPHA]
        return sorted(keep, key=lambda j: (ps[j], j))[:2]
    preds = []; counts = [0] * m
    for i in range(n):
        tr = np.array([t for t in range(n) if t != i]); cols = select(tr)
        for j in cols: counts[j] += 1
        if not cols:
            preds.append(float(y[tr].mean())); continue
        mu2 = X[tr][:, cols].mean(0); sd2 = X[tr][:, cols].std(0, ddof=1)
        g = logit_fit((X[tr][:, cols] - mu2) / sd2, y[tr])
        z = (X[i, cols] - mu2) / sd2
        preds.append(float(1 / (1 + np.exp(-(g.params[0] + z @ g.params[1:])))))
    out["combo"]["loo_auc"] = float(roc_auc_score(y, preds)); out["combo"]["loo_counts"] = counts
    out["combo"]["loo_cm"] = {"tp": int(((np.array(preds) >= .5) & (y == 1)).sum()), "fp": int(((np.array(preds) >= .5) & (y == 0)).sum()), "tn": int(((np.array(preds) < .5) & (y == 0)).sum()), "fn": int(((np.array(preds) < .5) & (y == 1)).sum())}

def tree(Xs, ys, cands, stop=0.15, min_node=5, max_depth=6):
    nodes = []
    def grow(idx, depth, bl):
        nn = len(idx); pos = int(ys[idx].sum())
        label = bl if bl is not None else (1 if pos * 2 >= nn else 0)
        rec = {"depth": depth, "n": nn, "pos": pos, "feature": None, "direction": None, "cut": None, "label": int(label)}
        nodes.append(rec)
        if nn == 0: return
        if bl is not None:
            wrong = (nn - pos) if bl == 1 else pos
            if wrong / nn < stop or nn < min_node or depth >= max_depth: return
        best = None
        for j in cands:
            vals = np.unique(Xs[idx, j])
            for a, b in zip(vals[:-1], vals[1:]):
                c = (a + b) / 2
                for d in ("higher", "lower"):
                    pr = (Xs[idx, j] > c) if d == "higher" else (Xs[idx, j] < c)
                    correct = int((pr & (ys[idx] == 1)).sum() + (~pr & (ys[idx] == 0)).sum())
                    if best is None or correct > best[0]: best = (correct, j, d, c, pr)
        if best is None: return
        baseline = max(pos, nn - pos) if bl is None else (pos if bl == 1 else nn - pos)
        if best[0] <= baseline: return
        rec["feature"] = names[best[1]]; rec["direction"] = best[2]; rec["cut"] = float(best[3])
        grow(idx[best[4]], depth + 1, 1); grow(idx[~best[4]], depth + 1, 0)
    grow(np.arange(len(ys)), 0, None)
    return nodes
out["tree"] = tree(X, y, meets) if meets else []
json.dump(out, open(sys.argv[3], "w"), allow_nan=False)
