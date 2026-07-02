/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// vtk.js の一部モジュールは型宣言(.d.ts)を同梱していないため、any として ambient 宣言する。
// （pure VTK 3D ビュー `viewer/vtkVolumeView.ts` で使用）
declare module "@kitware/vtk.js/Widgets/Widgets3D/ImageCroppingWidget";
