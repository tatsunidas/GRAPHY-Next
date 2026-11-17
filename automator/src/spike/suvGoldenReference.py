"""SUV の係数（SUV = 値 × scale）の、独立の参照実装と、Java・TS 共通のテスト値の生成。

実行: python3 -I automator/src/spike/suvGoldenReference.py backend/src/test/resources/radiomics/suv-golden.json

Java（PetSuvCalibration）と TS（frontend/src/viewer/suv.ts の computeSuvScale）は、このファイルの JSON を同じ許容差（相対 1e-12）で検査する。
崩壊は exp で書く（実装側は 2 の冪）。式の出典: SUVbw・SUL・SUVbsa は suv.ts の冒頭コメント（OHIF・GRAPHY 準拠）。
"""
import json
import math
import sys

T_F18 = 6586.2


def utc(y, mo, d, h, mi, s):
    import calendar
    return calendar.timegm((y, mo, d, h, mi, s, 0, 0, 0)) * 1000


def lbm_james(w, h_m, sex):
    r = (w / (h_m * 100)) ** 2
    return 1.1 * w - 128 * r if sex == "M" else 1.07 * w - 148 * r


def lbm_janma(w, h_m, sex):
    bmi = w / (h_m * h_m)
    return 9270 * w / (6680 + 216 * bmi) if sex == "M" else 9270 * w / (8780 + 244 * bmi)


def bsa(w, h_m):
    return 0.007184 * w ** 0.425 * (h_m * 100) ** 0.725


UNIT = {"bw": "SUVbw", "sul-james": "SUVlbm", "sul-janma": "SUVlbm", "bsa": "SUVbsa"}


def reference(p, typ):
    """(scale, unit, type, warnings) か、('error', 名前)。"""
    w = []
    units = (p.get("units") or "").upper()
    if units == "GML" or p.get("alreadySuv"):
        return {"scale": 1.0, "unit": UNIT[typ], "type": typ, "warnings": ["alreadySuv"]}
    if units == "CNTS":
        f = p.get("philipsSuvScaleFactor")
        if f and f > 0:
            return {"scale": f, "unit": "SUVbw", "type": "bw", "warnings": ([] if typ == "bw" else ["philipsBwOnly"])}
        c = p.get("philipsActivityConcScaleFactor")
        if not (c and c > 0):
            return {"error": "philipsInvalid"}
        w.append("philipsActivityConc")
    dose, hl = p.get("totalDoseBq"), p.get("halfLifeSec")
    if not dose or dose <= 0:
        return {"error": "missingDose"}
    if not hl or hl <= 0:
        return {"error": "missingHalfLife"}
    dc = (p.get("decayCorrection") or "").strip().upper()
    if dc == "ADMIN":
        w.append("decayAdmin")
        decayed = dose
    else:
        if dc == "NONE":
            w.append("decayNone")
        if p.get("injectionTimeMs") is None or p.get("scanTimeMs") is None:
            return {"error": "missingTime"}
        dt = (p["scanTimeMs"] - p["injectionTimeMs"]) / 1000.0
        if dt < 0:
            dt += 86400
            w.append("midnightAdjust")
        if dt < 0:
            return {"error": "negativeDecay"}
        decayed = dose * math.exp(-math.log(2) * dt / hl)
    if not decayed > 0:
        return {"error": "negativeDecay"}
    wt, ht, sex = p.get("patientWeight"), p.get("patientHeight"), p.get("patientSex")
    if not wt or wt <= 0:
        return {"error": "missingWeight"}
    if typ == "bw":
        nb = wt * 1000
    elif typ in ("sul-james", "sul-janma"):
        if not ht or ht <= 0:
            return {"error": "missingHeight"}
        if not sex:
            return {"error": "missingSex"}
        nb = (lbm_james if typ == "sul-james" else lbm_janma)(wt, ht, sex) * 1000
    else:
        if not ht or ht <= 0:
            return {"error": "missingHeight"}
        nb = bsa(wt, ht) * 10000
    if not nb > 0:
        return {"error": "invalidNormBase"}
    scale = nb / decayed
    if units == "CNTS" and p.get("philipsActivityConcScaleFactor"):
        scale *= p["philipsActivityConcScaleFactor"]
    return {"scale": scale, "unit": UNIT[typ], "type": typ, "warnings": w}


def base(**over):
    p = {
        "patientWeight": 70.0, "patientHeight": 1.75, "patientSex": "M", "totalDoseBq": 370e6, "halfLifeSec": T_F18,
        "injectionTimeMs": utc(2026, 7, 27, 9, 0, 0), "scanTimeMs": utc(2026, 7, 27, 10, 0, 0),
        "units": "BQML", "decayCorrection": "START", "alreadySuv": False,
        "philipsSuvScaleFactor": None, "philipsActivityConcScaleFactor": None,
    }
    p.update(over)
    return p


CASES = [
    ("bw 標準（70kg・370MBq・1 時間後）", base(), "bw"),
    ("SUL James 男性", base(), "sul-james"),
    ("SUL James 女性", base(patientSex="F", patientHeight=1.62, patientWeight=58.0), "sul-james"),
    ("SUL Janmahasatian 男性", base(), "sul-janma"),
    ("SUL Janmahasatian 女性", base(patientSex="F", patientHeight=1.62, patientWeight=58.0), "sul-janma"),
    ("SUVbsa", base(), "bsa"),
    ("Units=GML は scale=1", base(units="GML"), "bw"),
    ("alreadySuv は Units によらず scale=1", base(alreadySuv=True), "sul-james"),
    ("Philips CNTS 私設 SUV 係数あり", base(units="CNTS", philipsSuvScaleFactor=0.00037), "bw"),
    ("Philips CNTS 私設 SUV 係数ありで SUL を選ぶと bw だけ（警告）", base(units="CNTS", philipsSuvScaleFactor=0.00037), "sul-james"),
    ("Philips CNTS 濃度係数のみ", base(units="CNTS", philipsActivityConcScaleFactor=2.5), "bw"),
    ("Philips CNTS 係数なし（負例）", base(units="CNTS"), "bw"),
    ("Philips CNTS 濃度係数が 0（負例）", base(units="CNTS", philipsActivityConcScaleFactor=0.0), "bw"),
    ("崩壊補正 ADMIN は投与量を崩壊させない", base(decayCorrection="ADMIN"), "bw"),
    ("崩壊補正 NONE は警告つきで標準式", base(decayCorrection="NONE"), "bw"),
    ("崩壊補正の欠損は標準式", base(decayCorrection=None), "bw"),
    ("日付またぎ（撮像時刻が投与時刻より前）", base(injectionTimeMs=utc(2026, 7, 27, 23, 30, 0), scanTimeMs=utc(2026, 7, 27, 0, 30, 0)), "bw"),
    ("1 日以上さかのぼる（負例）", base(injectionTimeMs=utc(2026, 7, 29, 9, 0, 0), scanTimeMs=utc(2026, 7, 27, 9, 0, 0)), "bw"),
    ("投与量なし（負例）", base(totalDoseBq=None), "bw"),
    ("投与量が 0 以下（負例）", base(totalDoseBq=0.0), "bw"),
    ("半減期なし（負例）", base(halfLifeSec=None), "bw"),
    ("投与時刻なし（負例）", base(injectionTimeMs=None), "bw"),
    ("撮像時刻なし（負例）", base(scanTimeMs=None), "bw"),
    ("体重なし（負例）", base(patientWeight=None), "bw"),
    ("身長なしでも bw は計算できる", base(patientHeight=None), "bw"),
    ("身長なしの SUL James（負例）", base(patientHeight=None), "sul-james"),
    ("身長なしの SUL Janmahasatian（負例）", base(patientHeight=None), "sul-janma"),
    ("身長なしの SUVbsa（負例）", base(patientHeight=None), "bsa"),
    ("性別なしの SUL James（負例）", base(patientSex=None), "sul-james"),
    ("性別なしでも SUVbsa は計算できる", base(patientSex=None), "bsa"),
    ("除脂肪体重が負になる（負例）", base(patientWeight=200.0, patientHeight=1.0), "sul-james"),
    ("F-18 以外（Ga-68、20 分後）", base(halfLifeSec=4062.6, totalDoseBq=150e6, scanTimeMs=utc(2026, 7, 27, 9, 20, 0)), "bw"),
]

out = {"description": "SUV の係数の共通のテスト値。参照: automator/src/spike/suvGoldenReference.py。許容差は相対 1e-12。", "tolerance": 1e-12, "cases": []}
for name, p, typ in CASES:
    out["cases"].append({"name": name, "type": typ, "params": p, "expected": reference(p, typ)})
with open(sys.argv[1], "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
    f.write("\n")
errs = sum("error" in c["expected"] for c in out["cases"])
print(len(out["cases"]), "cases;", errs, "error cases;", len(out["cases"]) - errs, "scale cases")
