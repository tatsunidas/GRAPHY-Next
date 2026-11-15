"""
geomRadiomicsCheck.ts 用: 独立実装（scikit-image の marching cubes）によるメッシュ参照値。

    python3 -I geomMeshReference.py <spec.json> <out.json>

spec: [{"key": str, "file": raw uint8 (nz,ny,nx) の C 順, "shape": [nz,ny,nx], "spacing": [dz,dy,dx]}]
各マスクの 0.5 等値面（二値マスクなので頂点は辺の中点）から、メッシュ体積・表面積・最大径（頂点間最大距離）・球形度を返す。
RadiomicsJ（ImageJ 3D Viewer の MCTriangulator）とは別実装なので、同じ入力に対する「メッシュ定義の実装一致」を見る基準になる。
"""
import json
import sys

import numpy as np
from scipy.spatial import ConvexHull
from skimage import measure

spec = json.load(open(sys.argv[1]))
out = {}
for it in spec:
    v = np.fromfile(it["file"], dtype=np.uint8).reshape(it["shape"])
    v = np.pad(v, 1)
    verts, faces, _, _ = measure.marching_cubes(v.astype(np.float32), level=0.5, spacing=tuple(it["spacing"]))
    area = float(measure.mesh_surface_area(verts, faces))
    # 符号付き四面体の和（閉じたメッシュ）
    a, b, c = verts[faces[:, 0]], verts[faces[:, 1]], verts[faces[:, 2]]
    vol = float(abs(np.sum(np.einsum("ij,ij->i", a, np.cross(b, c))) / 6.0))
    hull = verts[ConvexHull(verts).vertices]
    d = np.sqrt(((hull[:, None, :] - hull[None, :, :]) ** 2).sum(-1))
    out[it["key"]] = {"volume": vol, "area": area, "dmax": float(d.max()),
                      "sphericity": float((36 * np.pi * vol ** 2) ** (1 / 3) / area)}
json.dump(out, open(sys.argv[2], "w"))
