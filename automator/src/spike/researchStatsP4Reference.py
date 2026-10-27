"""researchStatsPluginCheck.ts [9] の参照値。プラグインとは別実装（scipy・scikit-learn・statsmodels）で、
同じ CSV・シードから、パイプライン（テスト集合の分割・品質管理・入れ子の交差検証・最終モデル・テストの AUC）を計算する。
乱数（xoshiro128**）と分割の約束だけはプラグインと同じ定義で書き直している（分割を比べるため）。
usage: researchStatsP4Reference.py <features.csv> <clinical.csv> <seed> <test_fraction> <corr_threshold> <out.json>
"""
import csv, json, sys
import numpy as np
import scipy.stats as st
import statsmodels.api as sm
from sklearn.metrics import roc_auc_score
from sklearn.preprocessing import StandardScaler
from statsmodels.duration.hazard_regression import PHReg

M = 0xFFFFFFFF


class Rng:
    def __init__(self, seed):
        a = seed & M
        s = []
        for _ in range(4):
            a = (a + 0x9E3779B9) & M
            t = a ^ (a >> 16)
            t = (t * 0x21F0AAAD) & M
            t ^= t >> 15
            t = (t * 0x735A2D97) & M
            t ^= t >> 15
            s.append(t & M)
        self.s = s

    def u32(self):
        s = self.s
        rotl = lambda x, k: ((x << k) | (x >> (32 - k))) & M
        result = (rotl((s[1] * 5) & M, 7) * 9) & M
        t = (s[1] << 9) & M
        s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3]; s[2] ^= t
        s[3] = rotl(s[3], 11)
        return result

    def int(self, n):
        limit = 2**32 - (2**32 % n)
        x = self.u32()
        while x >= limit:
            x = self.u32()
        return x % n


def shuffle(ix, rng):
    a = list(ix)
    for i in range(len(a) - 1, 0, -1):
        j = rng.int(i + 1)
        a[i], a[j] = a[j], a[i]
    return a


def folds(n, strata, K, rng):
    keys = sorted(set(strata)) if strata is not None else [0]
    out = [-1] * n
    pos = 0
    for key in keys:
        mem = [i for i in range(n) if (strata[i] if strata is not None else 0) == key]
        for i in shuffle(mem, rng):
            out[i] = pos % K
            pos += 1
    return out


def holdout(n, strata, frac, rng):
    keys = sorted(set(strata)) if strata is not None else [0]
    test = [False] * n
    for key in keys:
        mem = shuffle([i for i in range(n) if (strata[i] if strata is not None else 0) == key], rng)
        t = int(np.floor(len(mem) * frac + 0.5))  # JavaScript の Math.round と同じ（.5 は上へ）
        for q in range(t):
            test[mem[q]] = True
    return test


def impute(X, train, do):
    Xa = np.array([[np.nan if v is None else v for v in r] for r in X], dtype=float)
    m = Xa.shape[1]
    med, usable = [], []
    for j in range(m):
        col = Xa[train, j]
        pres = col[~np.isnan(col)]
        med.append(float(np.median(pres)) if do and len(pres) else None)
        usable.append(bool(len(pres) > 0) if do else bool(len(pres) == len(col) and len(col) > 0))
    out = Xa.copy()
    if do:
        for j in range(m):
            if med[j] is not None:
                out[np.isnan(out[:, j]), j] = med[j]
    return out, med, usable


def rank(Xi, usable, task, rows):
    ps = []
    for j in range(Xi.shape[1]):
        if not usable[j] or np.isnan(Xi[rows, j]).any():
            continue
        x = Xi[rows, j]
        if task["kind"] == "binary":
            y = task["y"][rows]
            if len(np.unique(x)) < 2:
                continue
            p = st.mannwhitneyu(x[y == 1], x[y == 0], alternative="two-sided", method="asymptotic", use_continuity=True).pvalue
        else:
            if len(np.unique(x)) < 2:
                continue
            try:
                r = PHReg(task["time"][rows], x.reshape(-1, 1), status=task["event"][rows], ties="efron").fit(disp=0)
                p = float(r.pvalues[0])
            except Exception:
                continue
        if np.isfinite(p):
            ps.append((p, j))
    return [j for _, j in sorted(ps)]


def fit_topk(Xi, med, task, train, ranking, k):
    cols = ranking[:k]
    if not cols:
        return None
    sc = StandardScaler().fit(Xi[np.ix_(train, cols)])
    # StandardScaler は n で割る SD。src/core は n−1 なので、ここで n−1 に直す（定義の違いを明示して揃える）
    n = len(train)
    sd = np.sqrt(sc.var_ * n / (n - 1))
    if (sd <= 0).any():
        return None
    Z = (Xi[np.ix_(train, cols)] - sc.mean_) / sd
    if task["kind"] == "binary":
        try:
            res = sm.Logit(task["y"][train], sm.add_constant(Z, has_constant="add")).fit(disp=0, method="newton", maxiter=200, tol=1e-12)
        except Exception:
            return None
        if not res.mle_retvals["converged"] or np.abs(res.params).max() > 50:
            return None
        beta = res.params
        pred = lambda i: (None if np.isnan(Xi[i, cols]).any() else float(1 / (1 + np.exp(-(beta[0] + ((Xi[i, cols] - sc.mean_) / sd) @ beta[1:])))))
    else:
        try:
            res = PHReg(task["time"][train], Z, status=task["event"][train], ties="efron").fit(disp=0)
        except Exception:
            return None
        beta = res.params
        pred = lambda i: (None if np.isnan(Xi[i, cols]).any() else float(((Xi[i, cols] - sc.mean_) / sd) @ beta))
    return {"cols": cols, "predict": pred, "means": sc.mean_.tolist(), "sds": sd.tolist(), "medians": med}


def cindex(time, event, risk):
    conc = comp = 0.0
    for i in range(len(time)):
        if event[i] != 1:
            continue
        for j in range(len(time)):
            if time[j] <= time[i]:
                continue
            comp += 1
            conc += 1.0 if risk[i] > risk[j] else (0.5 if risk[i] == risk[j] else 0.0)
    return None if comp == 0 else conc / comp


def score(task, rows, pred):
    ok = [(i, v) for i, v in zip(rows, pred) if v is not None]
    if task["kind"] == "binary":
        lab = [int(task["y"][i]) for i, _ in ok]
        if len(set(lab)) < 2:
            return None
        return float(roc_auc_score(lab, [v for _, v in ok]))
    ii = [i for i, _ in ok]
    return cindex(task["time"][ii], task["event"][ii], [v for _, v in ok])


def choose(X, task, T, spec, rng):
    fo = folds(len(T), None, spec["innerK"], rng)
    K = spec["kCandidates"]
    pooled = [[None] * len(T) for _ in K]
    per = [[] for _ in K]
    for f in range(spec["innerK"]):
        tin = [T[p] for p in range(len(T)) if fo[p] != f]
        pos = [p for p in range(len(T)) if fo[p] == f]
        tout = [T[p] for p in pos]
        Xi, med, us = impute(X, tin, spec["impute"])
        rk = rank(Xi, us, task, tin)
        for a, k in enumerate(K):
            m = fit_topk(Xi, med, task, tin, rk, k)
            pr = [None if m is None else m["predict"](i) for i in tout]
            for p, v in zip(pos, pr):
                pooled[a][p] = v
            per[a].append(None if m is None else score(task, tout, pr))
    scores = []
    for a in range(len(K)):
        if task["kind"] == "binary":
            scores.append(score(task, T, pooled[a]))
        else:
            v = [x for x in per[a] if x is not None]
            scores.append(sum(v) / len(v) if v else None)
    best = None
    for a, s in enumerate(scores):
        if s is None:
            continue
        if best is None or s > scores[best] + 1e-12 or (abs(s - scores[best]) <= 1e-12 and K[a] < K[best]):
            best = a
    return (None if best is None else K[best]), scores, fo


def nested(X, task, dev, spec, rng):
    rows, outer, inner, preds, pooled = [], [], [], [], []
    for r in range(spec["repeats"]):
        strata = None if spec["strata"] is None else spec["strata"]
        asg = folds(len(dev), strata, spec["outerK"], rng)
        outer.append(asg)
        inn = []
        pr = [None] * len(dev)
        for f in range(spec["outerK"]):
            T = [dev[p] for p in range(len(dev)) if asg[p] != f]
            pos = [p for p in range(len(dev)) if asg[p] == f]
            V = [dev[p] for p in pos]
            k, sc, fo = choose(X, task, T, spec, rng)
            inn.append(fo)
            row = {"k": k, "innerScores": sc, "cols": [], "score": None}
            if k is not None:
                Xi, med, us = impute(X, T, spec["impute"])
                m = fit_topk(Xi, med, task, T, rank(Xi, us, task, T), k)
                if m is not None:
                    row["cols"] = m["cols"]
                    v = [m["predict"](i) for i in V]
                    for p, x in zip(pos, v):
                        pr[p] = x
                    row["score"] = score(task, V, v)
            rows.append(row)
        inner.append(inn)
        preds.append(pr)
        pooled.append(score(task, dev, pr) if task["kind"] == "binary" else None)
    k, sc, fo = choose(X, task, dev, spec, rng)
    Xi, med, us = impute(X, dev, spec["impute"])
    fm = fit_topk(Xi, med, task, dev, rank(Xi, us, task, dev), k)
    final = {"k": k, "scores": sc, "folds": fo, "cols": fm["cols"], "means": fm["means"], "sds": fm["sds"], "medians": fm["medians"],
             "testPred": [fm["predict"](i) for i in range(len(X)) if i not in set(dev)]}
    return {"folds": rows, "outerAssign": outer, "innerAssign": inner, "pred": preds, "pooled": pooled, "final": final}




def spearman(a, b):
    ok = [i for i in range(len(a)) if a[i] is not None and b[i] is not None]
    if len(ok) < 3:
        return None
    r = st.spearmanr([a[i] for i in ok], [b[i] for i in ok]).statistic
    return None if not np.isfinite(r) else float(r)


def qc(X, rows, names, thr):
    cand = list(range(len(names)))
    removed = []
    cand2 = []
    for j in cand:
        vals = [X[i][j] for i in rows if X[i][j] is not None]
        if len(set(vals)) >= 2:
            cand2.append(j)
        else:
            removed.append(names[j])
    cols = {j: [X[i][j] for i in rows] for j in cand2}
    order = sorted(cand2, key=lambda j: (sum(v is None for v in cols[j]), j))
    kept = []
    for j in order:
        hit = any((lambda r: r is not None and abs(r) >= thr)(spearman(cols[j], cols[k])) for k in kept)
        if hit:
            removed.append(names[j])
        else:
            kept.append(j)
    return sorted(kept), removed


def delong_se(s, y):
    P, N = s[y == 1], s[y == 0]
    psi = lambda a, b: 1.0 if a > b else (0.5 if a == b else 0.0)
    v10 = np.array([np.mean([psi(p, q) for q in N]) for p in P]); v01 = np.array([np.mean([psi(p, q) for p in P]) for q in N])
    return float(np.sqrt(v10.var(ddof=1) / len(P) + v01.var(ddof=1) / len(N)))


feat = list(csv.DictReader(open(sys.argv[1])))
clin = {r["CaseLabel"]: r for r in csv.DictReader(open(sys.argv[2]))}
seed, frac, thr = int(sys.argv[3]), float(sys.argv[4]), float(sys.argv[5])
ids = [r["CaseLabel"] for r in feat]
names = [k for k in feat[0] if k != "CaseLabel"]
X = [[float(r[k]) if r[k] not in ("", "NA") else None for k in names] for r in feat]
y = np.array([1 if clin[i]["outcome"] == "resp" else 0 for i in ids])
task = {"kind": "binary", "y": y}
n = len(ids)

rng = Rng(seed)
split_seed = rng.u32()
test = holdout(n, y.tolist(), frac, Rng(split_seed))
dev = [i for i in range(n) if not test[i]]
keep, removed = qc(X, dev, names, thr)
Xk = [[r[j] for j in keep] for r in X]
spec = {"outerK": 5, "innerK": 4, "repeats": 2, "kCandidates": [1, 2, 4], "strata": [int(y[i]) for i in dev], "impute": False}
res = nested(Xk, task, dev, spec, rng)
fin = res["final"]
test_rows = [i for i in range(n) if test[i]]
pred = np.array(fin["testPred"])
yt = y[test_rows]
auc = float(roc_auc_score(yt, pred))
se = delong_se(pred, yt)
out = {
    "splitSeed": split_seed, "testIds": sorted(ids[i] for i in test_rows), "dev": len(dev), "test": len(test_rows),
    "kept": [names[j] for j in keep], "removed": removed,
    "folds": [{"k": f["k"], "score": f["score"], "features": [names[keep[j]] for j in f["cols"]]} for f in res["folds"]],
    "pooled": res["pooled"],
    "final": {"k": fin["k"], "features": [names[keep[j]] for j in fin["cols"]]},
    "testAuc": auc, "testLower": max(0.0, auc - 1.959963984540054 * se), "testUpper": min(1.0, auc + 1.959963984540054 * se),
}
json.dump(out, open(sys.argv[6], "w"))
