"""researchStatsPluginCheck.ts [10]・[11] の参照値。プラグインとは別実装（statsmodels・scikit-learn）で計算する。

r5 モード: 画面で選ばれた特徴量で、多変量 Cox（Efron。標準化は SD の n−1）の HR・p、見かけの Harrell の C、
  Schoenfeld 残差（statsmodels）から Grambsch–Therneau の全体の検定（時間は 1 − KM(t−)）を計算する。
  usage: researchStatsR5Reference.py r5 <features.csv> <clinical.csv> <feature,feature,...> <out.json>
p4lasso モード: 固定ファイルのテスト症例を除いた開発集合で、画面に出た λ の L1 ロジスティック回帰
  （scikit-learn の saga、切片は罰則なし。C = 1/(nλ)）を解き、係数が 0 でない特徴量を出す。
  usage: researchStatsR5Reference.py p4lasso <features.csv> <clinical.csv> <lock.json> <lambda> <drop,features> <out.json>
"""
import csv
import json
import sys
import warnings

import numpy as np
import scipy.stats as st
from sklearn.linear_model import LogisticRegression
from statsmodels.duration.hazard_regression import PHReg


def read(path):
    with open(path, newline="") as f:
        rows = list(csv.reader(f))
    return rows[0], rows[1:]


def standardize(X):
    return (X - X.mean(axis=0)) / X.std(axis=0, ddof=1)


def harrell(time, event, risk):
    conc = comp = 0.0
    for i in range(len(time)):
        if event[i] != 1:
            continue
        for j in range(len(time)):
            if time[j] <= time[i]:
                continue
            comp += 1
            conc += 1.0 if risk[i] > risk[j] else 0.5 if risk[i] == risk[j] else 0.0
    return conc / comp


def r5(feat_path, clin_path, names, out):
    fh, fr = read(feat_path)
    ch, cr = read(clin_path)
    clin = {r[0]: r for r in cr}
    ids = [r[0] for r in fr if r[0] in clin]
    feat = {r[0]: r for r in fr}
    X = np.array([[float(feat[i][fh.index(n)]) for n in names] for i in ids])
    time = np.array([float(clin[i][ch.index("time")]) for i in ids])
    event = np.array([int(clin[i][ch.index("event")]) for i in ids])
    assert len(np.unique(time)) == len(time), "時間に同点がある（Efron と Breslow の残差が一致しない）"
    Z = standardize(X)
    r = PHReg(time, Z, status=event, ties="efron").fit()
    beta, V = np.asarray(r.params), np.asarray(r.cov_params())
    risk = Z @ beta
    rb = PHReg(time, Z, status=event, ties="breslow").fit()
    sr = rb.schoenfeld_residuals
    ev = np.where(event == 1)[0]
    ev = ev[np.argsort(time[ev])]
    resid = sr[ev]
    d = len(ev)
    order = np.argsort(time)
    km, at, g = 1.0, len(time), {}
    for i in order:
        g[i] = 1 - km
        if event[i] == 1:
            km *= 1 - 1 / at
        at -= 1
    xx = np.array([g[i] for i in ev])
    xx = xx - xx.mean()
    u = xx @ resid
    glob = float(d * u @ V @ u / (xx @ xx))
    per = [float((xx @ (resid @ V * d)[:, j]) ** 2 / (V[j, j] * d * (xx @ xx))) for j in range(len(names))]
    json.dump({
        "n": len(ids), "events": int(event.sum()), "hr": np.exp(beta).tolist(), "p": np.asarray(r.pvalues).tolist(),
        "cApparent": harrell(time, event, risk), "globalP": float(st.chi2.sf(glob, len(names))), "perP": [float(st.chi2.sf(c, 1)) for c in per],
    }, open(out, "w"))


def p4lasso(feat_path, clin_path, lock_path, lam, drop, out):
    fh, fr = read(feat_path)
    ch, cr = read(clin_path)
    test = set(json.load(open(lock_path))["testIds"])
    clin = {r[0]: r for r in cr}
    names = [n for n in fh[1:] if n not in drop]
    dev = [r for r in fr if r[0] not in test and r[0] in clin]
    X = standardize(np.array([[float(r[fh.index(n)]) for n in names] for r in dev]))
    y = np.array([1 if clin[r[0]][ch.index("outcome")] == "resp" else 0 for r in dev])
    n = len(y)
    m = LogisticRegression(C=1.0 / (n * lam), l1_ratio=1.0, solver="saga", tol=1e-12, max_iter=1_000_000, random_state=0)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        m.fit(X, y)
    coef = m.coef_[0]
    json.dump({"dev": n, "nonzero": [nm for nm, c in zip(names, coef) if abs(c) > 1e-8], "coef": dict(zip(names, coef.tolist()))}, open(out, "w"))


if __name__ == "__main__":
    if sys.argv[1] == "r5":
        r5(sys.argv[2], sys.argv[3], sys.argv[4].split(","), sys.argv[5])
    else:
        p4lasso(sys.argv[2], sys.argv[3], sys.argv[4], float(sys.argv[5]), [x for x in sys.argv[6].split(",") if x], sys.argv[7])
