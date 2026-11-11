#!/usr/bin/env python3
"""保存した DICOM SR（プラグインの保存）を読み、病変グループごとの計測・追跡 ID・画像参照・所見テキストを JSON で出す。

使い方: python3 -I check-structured-report.py <SR の .dcm>
出力（標準出力の JSON）: { modality, description, groups: [{ trackingId, findingText, nums: [{meaning, name, value, unit}], refs: [SOP UID] }], findings: [{label, text}] }
解釈はしない（期待値との比較は呼び出し側）。Quantity Name は NUM の修飾（HAS CONCEPT MOD の TEXT）から読む。
"""
import json
import sys

import pydicom


def meaning(item):
    seq = item.get("ConceptNameCodeSequence")
    return seq[0].CodeMeaning if seq else None


def walk(items, out_groups, out_findings, in_findings=False):
    for it in items or []:
        vt = it.get("ValueType")
        m = meaning(it)
        kids = it.get("ContentSequence") or []
        if vt == "CONTAINER":
            has_tid = any(meaning(k) == "Tracking Identifier" for k in kids)
            if has_tid:
                g = {"trackingId": None, "findingText": None, "nums": [], "refs": []}
                for k in kids:
                    km = meaning(k)
                    if km == "Tracking Identifier":
                        g["trackingId"] = k.TextValue
                    elif km == "Finding" and k.get("ValueType") == "TEXT":
                        g["findingText"] = k.TextValue
                    elif k.get("ValueType") == "IMAGE":
                        g["refs"].append(k.ReferencedSOPSequence[0].ReferencedSOPInstanceUID)
                    elif k.get("ValueType") == "NUM":
                        g["nums"].append(num(k))
                    for kk in k.get("ContentSequence") or []:
                        if kk.get("ValueType") == "IMAGE":
                            g["refs"].append(kk.ReferencedSOPSequence[0].ReferencedSOPInstanceUID)
                out_groups.append(g)
                continue
            walk(kids, out_groups, out_findings, in_findings or m == "Findings")
        elif vt == "TEXT" and in_findings:
            out_findings.append({"label": m, "text": it.TextValue})
        else:
            walk(kids, out_groups, out_findings, in_findings)


def num(it):
    mv = it.MeasuredValueSequence[0]
    name = None
    for k in it.get("ContentSequence") or []:
        if k.get("ValueType") == "TEXT" and meaning(k) == "Quantity Name":
            name = k.TextValue
    return {
        "meaning": meaning(it),
        "name": name,
        "value": float(mv.NumericValue),
        "unit": mv.MeasurementUnitsCodeSequence[0].CodeValue,
        "scheme": it.ConceptNameCodeSequence[0].CodingSchemeDesignator,
    }


ds = pydicom.dcmread(sys.argv[1])
groups, findings = [], []
walk(ds.get("ContentSequence"), groups, findings)
print(json.dumps({
    "modality": ds.Modality, "description": ds.get("SeriesDescription"), "seriesNumber": ds.get("SeriesNumber"),
    "completion": ds.get("CompletionFlag"), "verification": ds.get("VerificationFlag"),
    "groups": groups, "findings": findings,
}, ensure_ascii=False))
