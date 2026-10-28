"""researchStatsPluginCheck.ts [12] の参照値。プラグインとは別実装（scikit-learn）で、画面が書き出した外側の分割をそのまま使って計算する。

候補が 1 つだけの設定（内側の選択が結果に効かない）で、外側の分割ごとに訓練の行で当てはめ、検証の行を予測する。
- svm: 訓練の行の平均・SD（n−1）で標準化、γ=scale は標準化した訓練の行から（sklearn の定義）。SVC(tol=1e-10, shrinking=False)。決定値。
- gbm: GradientBoostingClassifier（subsample=1）。random_state を 0〜4 で変えて予測が同じか（分岐の同点が効かないか）も記録する。
- rf: RandomForestClassifier。乱数列が違うので、random_state を 20 個変えた束ねた AUC の分布を出す。
usage: researchStatsModelsReference.py <svm|gbm|rf> <features.csv> <clinical.csv> <predictions.csv> <feature,feature,...> <params.json> <out.json>
"""
import csv
import json
import sys

import numpy as np
from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
from sklearn.metrics import roc_auc_score
from sklearn.svm import SVC


def read(path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.reader(f))
    return rows[0], rows[1:]


def main(kind, feat_path, clin_path, pred_path, names, params_path, out):
    p = json.load(open(params_path))
    fh, fr = read(feat_path)
    ch, cr = read(clin_path)
    ph, pr = read(pred_path)
    feat = {r[0]: r for r in fr}
    clin = {r[0]: r for r in cr}
    ids = [r[0] for r in pr]
    X = np.array([[float(feat[i][fh.index(n)]) for n in names] for i in ids])
    y = np.array([1 if clin[i][ch.index("outcome")] == "resp" else 0 for i in ids])
    reps = [h for h in ph if h.startswith("fold_repeat_")]
    res = {"n": len(ids), "repeats": []}
    for rh in reps:
        r = rh.split("_")[-1]
        fold = np.array([int(row[ph.index(rh)]) for row in pr])
        app = np.array([float(row[ph.index(f"pred_repeat_{r}")]) for row in pr])
        out_r = {"foldAuc": [], "pred": None, "invariant": None, "pooled": None, "pooledDist": None}

        def fit_predict(seed):
            pred = np.full(len(ids), np.nan)
            for f in sorted(set(fold)):
                tr, te = np.where(fold != f)[0], np.where(fold == f)[0]
                if kind == "svm":
                    mu, sd = X[tr].mean(0), X[tr].std(0, ddof=1)
                    Ztr, Zte = (X[tr] - mu) / sd, (X[te] - mu) / sd
                    g = 1.0 / (Ztr.shape[1] * Ztr.var()) if p["gamma"] == "scale" else p["gamma"]
                    m = SVC(C=p["C"], kernel="rbf", gamma=g, tol=1e-10, shrinking=False).fit(Ztr, y[tr])
                    pred[te] = m.decision_function(Zte)
                elif kind == "gbm":
                    m = GradientBoostingClassifier(n_estimators=p["stages"], max_depth=p["depth"], learning_rate=p["learningRate"], subsample=p["subsample"], random_state=seed).fit(X[tr], y[tr])
                    pred[te] = m.predict_proba(X[te])[:, 1]
                else:
                    mf = "sqrt" if p["mtry"] == "sqrt" else int(p["mtry"])
                    m = RandomForestClassifier(n_estimators=p["trees"], max_features=mf, random_state=seed).fit(X[tr], y[tr])
                    pred[te] = m.predict_proba(X[te])[:, 1]
            return pred

        if kind in ("svm", "gbm"):
            preds = [fit_predict(s) for s in (range(5) if kind == "gbm" else [0])]
            pred = preds[0]
            out_r["invariant"] = all(np.array_equal(preds[0], q) for q in preds[1:])
            out_r["pred"] = pred.tolist()
            out_r["maxAbsDiff"] = float(np.max(np.abs(pred - app)))
            out_r["foldAuc"] = [float(roc_auc_score(y[fold == f], pred[fold == f])) for f in sorted(set(fold))]
            out_r["pooled"] = float(roc_auc_score(y, pred))
            out_r["pooledRange"] = [float(min(roc_auc_score(y, q) for q in preds)), float(max(roc_auc_score(y, q) for q in preds))]
        else:
            out_r["pooledDist"] = [float(roc_auc_score(y, fit_predict(s))) for s in range(20)]
        out_r["appPooled"] = float(roc_auc_score(y, app))
        res["repeats"].append(out_r)
    json.dump(res, open(out, "w"))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5].split(","), sys.argv[6], sys.argv[7])
