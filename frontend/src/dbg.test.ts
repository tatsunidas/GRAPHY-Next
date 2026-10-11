import { it } from "vitest";
import { isotropicGrid, resampleToGrid } from "./viewer/gridResample";
import { makeVolume } from "./viewer/regGeometry";
it("d", () => {
  const th = (20 * Math.PI) / 180;
  const src = makeVolume(new Float32Array(30 * 25 * 12), [30, 25, 12],
    [Math.cos(th), Math.sin(th), 0, -Math.sin(th), Math.cos(th), 0], [-5, 7, 3], 0.7, 0.8, [0, 0, 2.5]);
  const g = isotropicGrid(src, 1);
  const o = resampleToGrid(src, null, g);
  const [nx, ny, nz] = g.dims;
  const c: Record<string, number> = {};
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (Number.isNaN(o[k * nx * ny + j * nx + i])) {
      const key = `i${i} j${j} k${k === 0 ? 0 : k === nz - 1 ? "E" : "m"}`;
      c[key] = (c[key] || 0) + 1;
    }
  }
  console.log(g.dims, JSON.stringify(c));
});
