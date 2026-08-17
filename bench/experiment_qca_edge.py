#!/usr/bin/env python3
# GRAPHY-Next Benchmark Phantom (GNBP-XA)
# Copyright (C) 2026 Visionary Imaging Services, Inc.
# SPDX-License-Identifier: AGPL-3.0-or-later
#
"""QCA のエッジ検出をどの方式にするかを決めるための対照実験（`fw/angio-design.md` §16.4）。

なぜオフラインでやるのか
------------------------
アプリを通した実測（`automator/src/spike/xaPhantomCheck.ts`）は「通しで正しいか」に答えるが、
**方式を比べる**には遅すぎるし、UI・校正・経路探索の誤差が混ざる。ここでは
**画素から径を出す 1 段だけ**を、真値既知のファントム画像に対して直接叩く。

比べる 4 方式
-------------
    M1 half        いまの実装（内側と外側の中間値を線形補間で横切る点）
    M2 half/0.866  M1 に円柱投影の解析的な係数 (√3/2) を掛け戻すだけ
    M3 densito     **形を仮定しない**。−ln T を横方向に積分すると μ·A（A=断面積）になる
    M4 cylfit      ぼけ込みの円柱モデル T(d)=G_σ*exp(−μ·2√(r²−d²)) を当てはめて r を直接出す

M3 の μ（造影剤の線減弱係数）は実機では未知なので、**健常部で M4 を 1 回だけ当てはめて μ を得る**
運用を想定した `M3(μ←健常部)` も測る。形の仮定が健常部だけに閉じ、病変部には及ばないのが要点。

使い方:
    python experiment_qca_edge.py                    # 既定は phantom/GNBP-XA
    python experiment_qca_edge.py --out ./phantom
"""

from __future__ import annotations

import argparse
import json
import math
import os

import numpy as np
import pydicom

STORED_MAX = 4095


# ── 共通の下ごしらえ ──────────────────────────────────────────────────


def _gaussian_kernel(sigma_px: float, radius: int | None = None) -> np.ndarray:
    if sigma_px <= 0:
        return np.array([1.0])
    r = radius if radius is not None else max(1, int(math.ceil(4 * sigma_px)))
    x = np.arange(-r, r + 1, dtype=float)
    k = np.exp(-0.5 * (x / sigma_px) ** 2)
    return k / k.sum()


def _blur1d(v: np.ndarray, sigma_px: float) -> np.ndarray:
    """端は値の複製で埋める（生成器と同じ約束。0 埋めだと縁が暗くなる）。"""
    if sigma_px <= 0:
        return v
    k = _gaussian_kernel(sigma_px)
    r = (len(k) - 1) // 2
    padded = np.concatenate([np.full(r, v[0]), v, np.full(r, v[-1])])
    return np.convolve(padded, k, mode="valid")


def _transmission(frame: np.ndarray, col: int, half_rows: int, axis_row: int) -> np.ndarray:
    """列 `col` の透過率プロファイル（軸の上下 ±half_rows）。"""
    lo, hi = axis_row - half_rows, axis_row + half_rows + 1
    return frame[lo:hi, col].astype(float) / STORED_MAX


# ── M1 / M2: 半値法 ───────────────────────────────────────────────────


def m1_half_value_px(profile: np.ndarray) -> float | None:
    """いまの実装（`frontend/src/viewer/qca.ts` の `findEdgesInProfile`）と同じ手順。

    内側＝中心付近の平均、外側＝その側の外周 5% の平均、閾値＝その中間値。
    中心から外へ歩いて最初に閾値をよぎる区間を線形補間する。
    """
    n = len(profile)
    c = n // 2
    inner = profile[c - 1 : c + 2].mean()

    def edge(direction: int) -> float | None:
        m = max(2, round(n * 0.05))
        outer = profile[-m:].mean() if direction > 0 else profile[:m].mean()
        contrast = abs(outer - inner)
        if not contrast > 1e-6:
            return None
        threshold = (inner + outer) / 2.0
        rising = outer > inner
        i = c
        while (i < n - 1) if direction > 0 else (i > 0):
            a, b = profile[i], profile[i + direction]
            crossed = (a < threshold <= b) if rising else (a > threshold >= b)
            if crossed:
                t = (threshold - a) / (b - a) if b != a else 0.0
                return i + direction * t
            i += direction
        return None

    li, ri = edge(-1), edge(1)
    if li is None or ri is None or not ri > li:
        return None
    return float(ri - li)


# ── M3: 密度計測（形を仮定しない）─────────────────────────────────────


def m3_densitometric_area_mm2(profile: np.ndarray, mm_per_px: float, mu_per_mm: float) -> float:
    """−ln T を横方向へ積分して断面積を出す。

    I = I0·exp(−μ·L(d)) なので −ln(I/I0) = μ·L(d)。これを d について積分すると
    ∫L(d)dd = A（断面積）そのもの。**円だと仮定していない**のが M1/M2/M4 との決定的な違い。
    背景は T=1（−ln T=0）なので、積分区間を広く取っても増えない。
    """
    a = -np.log(np.clip(profile, 1e-9, None))
    a = a - np.median(np.concatenate([a[:5], a[-5:]]))  # 背景の底上げを引く
    return float(np.clip(a, 0.0, None).sum() * mm_per_px / mu_per_mm)


# ── M4: ぼけ込みの円柱モデル当てはめ ──────────────────────────────────


def _cylinder_transmission(d_mm: np.ndarray, r_mm: float, mu: float, sigma_px: float) -> np.ndarray:
    inner = np.clip(r_mm**2 - d_mm**2, 0.0, None)
    return _blur1d(np.exp(-mu * 2.0 * np.sqrt(inner)), sigma_px)


def m4_cylinder_fit(
    profile: np.ndarray,
    mm_per_px: float,
    sigma_px: float,
    mu_grid: np.ndarray | None = None,
    r_grid_mm: np.ndarray | None = None,
) -> tuple[float, float]:
    """(直径 [mm], 当てはめた μ) を返す。r と μ の 2 次元グリッド探索（scipy 不要）。"""
    n = len(profile)
    d_mm = (np.arange(n) - (n - 1) / 2.0) * mm_per_px
    if r_grid_mm is None:
        r_grid_mm = np.arange(0.05, 3.0, 0.005)
    if mu_grid is None:
        mu_grid = np.arange(0.05, 0.45, 0.005)
    best = (np.inf, 0.0, 0.0)
    for mu in mu_grid:
        model = np.stack([_cylinder_transmission(d_mm, r, mu, sigma_px) for r in r_grid_mm])
        resid = ((model - profile[None, :]) ** 2).sum(axis=1)
        i = int(np.argmin(resid))
        if resid[i] < best[0]:
            best = (float(resid[i]), float(r_grid_mm[i]), float(mu))
    return best[1] * 2.0, best[2]


# ── 実験本体 ──────────────────────────────────────────────────────────


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="./phantom")
    args = ap.parse_args()

    root = os.path.join(args.out, "GNBP-XA")
    truth = json.load(open(os.path.join(root, "truth.json"), encoding="utf-8"))["qca"]
    ds = pydicom.dcmread(os.path.join(root, truth["file"]))
    pixels = ds.pixel_array  # (frames, rows, cols)

    axis_row = int(truth["vesselAxisRow"])
    mm_per_px = float(truth["mmPerPx"])
    mu_true = float(truth["muContrastPerMm"])
    columns = int(truth["columns"])
    half_rows = 24                      # ±5.4mm。背景を十分含む
    lesion_col = columns // 2           # 病変は x=0（＝画像中央）に置かれている
    ref_cols = [lesion_col - 130, lesion_col + 130]   # ±29mm。どの病変長よりも外側

    print(f"μ(真値) = {mu_true:.5f} /mm, mm/px = {mm_per_px}, 軸 = row {axis_row}")
    print()
    header = (
        f"{'frame':>5} {'条件':>22} {'部位':>4} {'真値mm':>7} "
        f"{'M1 half':>9} {'M2 /0.866':>10} {'M3 densito':>11} {'M3 μ←健常':>10} {'M4 cylfit':>10}"
    )
    print(header)
    print("-" * len(header))

    rows_out: list[dict] = []
    for t in truth["frames"]:
        frame = pixels[t["frame"] - 1]
        sigma = float(t["blurSigmaPx"])
        noise = t["photonsPerPixel"]
        cond = f"%DS {int(t['percentDiameterStenosis']):2d} σ{sigma} " + (f"I0={noise}" if noise else "clean")

        # 健常部で μ を 1 回だけ当てはめる（形の仮定をここに閉じ込める運用）。
        ref_profiles = [_transmission(frame, c, half_rows, axis_row) for c in ref_cols]
        mu_from_ref = float(np.mean([m4_cylinder_fit(p, mm_per_px, sigma)[1] for p in ref_profiles]))

        for site, col, truth_mm in (
            ("健常", ref_cols[0], float(t["referenceDiameterMm"])),
            ("病変", lesion_col, float(t["mldMm"])),
        ):
            p = _transmission(frame, col, half_rows, axis_row)
            half_px = m1_half_value_px(p)
            m1 = half_px * mm_per_px if half_px is not None else float("nan")
            m2 = m1 / (math.sqrt(3) / 2.0)
            m3 = 2.0 * math.sqrt(m3_densitometric_area_mm2(p, mm_per_px, mu_true) / math.pi)
            m3r = 2.0 * math.sqrt(m3_densitometric_area_mm2(p, mm_per_px, mu_from_ref) / math.pi)
            m4, _ = m4_cylinder_fit(p, mm_per_px, sigma)
            print(
                f"{t['frame']:>5} {cond:>22} {site:>4} {truth_mm:>7.3f} "
                f"{m1:>9.3f} {m2:>10.3f} {m3:>11.3f} {m3r:>10.3f} {m4:>10.3f}"
            )
            rows_out.append(
                {
                    "frame": t["frame"], "site": site, "truthMm": truth_mm,
                    "m1_half": m1, "m2_corrected": m2,
                    "m3_densito_mu_true": m3, "m3_densito_mu_from_ref": m3r,
                    "m4_cylfit": m4, "muFromRef": mu_from_ref,
                    "blurSigmaPx": sigma, "photonsPerPixel": noise,
                }
            )

    # ── まとめ: 係数（測定/真値）と %DS 誤差 ────────────────────────
    print()
    print("係数（測定 ÷ 真値。1.000 が理想）")
    for key, name in (
        ("m1_half", "M1 half"), ("m2_corrected", "M2 /0.866"),
        ("m3_densito_mu_true", "M3 densito(μ真)"), ("m3_densito_mu_from_ref", "M3 densito(μ←健常)"),
        ("m4_cylfit", "M4 cylfit"),
    ):
        for site in ("健常", "病変"):
            vals = [r[key] / r["truthMm"] for r in rows_out if r["site"] == site and r["truthMm"] > 0]
            clean = [
                r[key] / r["truthMm"]
                for r in rows_out
                if r["site"] == site and r["truthMm"] > 0 and r["photonsPerPixel"] is None
            ]
            print(
                f"  {name:>20} {site} : 全 {np.mean(vals):.3f} ± {np.std(vals):.3f}"
                f"   ノイズ無し {np.mean(clean):.3f} ± {np.std(clean):.3f}"
            )

    print()
    print("%DS の絶対誤差（1 − MLD/RVD。同一手法で健常部と病変部を測る）")
    for key, name in (
        ("m1_half", "M1 half"), ("m2_corrected", "M2 /0.866"),
        ("m3_densito_mu_true", "M3 densito(μ真)"), ("m3_densito_mu_from_ref", "M3 densito(μ←健常)"),
        ("m4_cylfit", "M4 cylfit"),
    ):
        errs = []
        for t in truth["frames"]:
            ref = next(r for r in rows_out if r["frame"] == t["frame"] and r["site"] == "健常")
            les = next(r for r in rows_out if r["frame"] == t["frame"] and r["site"] == "病変")
            ds_measured = (1.0 - les[key] / ref[key]) * 100.0
            errs.append(ds_measured - float(t["percentDiameterStenosis"]))
        print(f"  {name:>20} : 平均 {np.mean(errs):+.2f}  最大 |{np.max(np.abs(errs)):.2f}|")

    out_path = os.path.join(root, "..", "..", "results", "qca-edge-experiment.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(rows_out, f, ensure_ascii=False, indent=2)
    print(f"\n結果 -> {os.path.normpath(out_path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
