/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// メッシュ / 3D ROI（P3）で使う vtk.js モジュールのうち、型宣言(.d.ts)を同梱しないものを
// any として ambient 宣言する（`viewer/roiMesh.ts` / `viewer/mesh3d.ts` で使用）。
// ※ 型付きモジュール（STLReader/STLWriter/OBJReader/Actor/Mapper/PolyData/ImageData 等）は
//   ここに書かない（二重宣言になるため）。
declare module "@kitware/vtk.js/Filters/General/ImageMarchingCubes";
declare module "@kitware/vtk.js/Filters/General/WindowedSincPolyDataFilter";
declare module "@kitware/vtk.js/Filters/Core/PolyDataNormals";
