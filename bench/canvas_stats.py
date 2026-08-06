#!/usr/bin/env python3
# GRAPHY-Next Benchmark Phantom (GNBP-1)
# Copyright (C) 2026 Visionary Imaging Services, Inc.
# SPDX-License-Identifier: AGPL-3.0-or-later
#
"""Non-black fraction of a PNG, for detecting "the volume is on screen".

Used instead of reading the canvas from inside the page: the 3D viewport is a
VTK.js WebGL canvas without preserveDrawingBuffer, so drawImage()/getImageData()
return an empty buffer there and would report a rendered volume as black.
Forcing preserveDrawingBuffer would make the read work but perturb the very
frame rate being measured, so the pixels are taken through the compositor
instead.
"""
import sys
from PIL import Image

im = Image.open(sys.argv[1]).convert("L")
px = im.getdata()
n = len(px)
non_black = sum(1 for v in px if v > 2)
print(f"{non_black / n:.6f} {sum(px) / n:.3f}")
