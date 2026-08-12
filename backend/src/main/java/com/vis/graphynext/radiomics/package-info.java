/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * RadiomicsJ に絡む機能をまとめた場所。
 *
 * <p>計算そのものは外部ライブラリ <b>RadiomicsJ</b>（{@code io.github.tatsunidas:radiomicsj}、
 * Apache-2.0、著者は本プロジェクトと同じ）が持っている。ここにあるのは、そのライブラリと
 * GRAPHY-Next の保管庫・DICOM・UI を繋ぐ層だけで、特徴量の定義や数式は一切持たない。
 * ライブラリ側を直したいときは GRAPHY-Next ではなく RadiomicsJ リポジトリを触ること。
 *
 * <h2>何がどこにあるか</h2>
 * <ul>
 *   <li>{@link com.vis.graphynext.radiomics.TextureSeriesController} …
 *       {@code /api/series/texture}（同期）と {@code /api/series/texture/jobs}（投入＋ポーリング）</li>
 *   <li>{@link com.vis.graphynext.radiomics.TextureJobService} …
 *       計算は分単位になりうるのでジョブにして進捗と中止を持たせる。ワーカーは 1 本</li>
 *   <li>{@link com.vis.graphynext.radiomics.RadiomicsMapEngine} …
 *       保管庫のシリーズを {@code ij.ImagePlus} に積み、マスクを IOP/IPP で揃え、
 *       {@code FeatureVisualizationMap} で voxel-wise の特徴マップを計算する</li>
 *   <li>{@link com.vis.graphynext.radiomics.TextureFeatureCatalog} …
 *       {@code "<FAMILY>_<FeatureName>"} を RadiomicsJ の族クラス＋特徴 enum＋設定 Map に解決する</li>
 *   <li>{@link com.vis.graphynext.radiomics.GlamMapSupport} …
 *       GLAM 族だけが持つ前提（3D 専用・ROI 必須・maxRadius の頭打ち・プロセス広域 static）の面倒を見る</li>
 *   <li>{@link com.vis.graphynext.radiomics.TextureSeriesService} …
 *       32bit float のマップを 16bit unsigned ＋ Rescale へ落とし、派生シリーズとして保管庫へ入れる</li>
 * </ul>
 *
 * <h2>踏みやすい穴</h2>
 * <ul>
 *   <li>RadiomicsJ の設定には <b>{@code Map} で渡せるものと static でしか渡せないもの</b>があり、
 *       GLAM は後者が大半。static はプロセス広域なので、書き換えたら必ず戻す
 *       （{@link com.vis.graphynext.radiomics.GlamMapSupport#runWithSettings}）</li>
 *   <li>特徴計算が窓ごとに投げた例外は、マップ側がボクセルを 0 にして握り潰す。前提の違反は
 *       <b>全面ゼロのマップという形で静かに成功する</b>ので、計算前に弾くこと</li>
 *   <li>マップの値は kernel・stride・margin・（GLAM なら）maxRadius と境界補正で意味が変わる。
 *       後から設定を辿る術が無いので、{@code DerivationDescription} に書き残している</li>
 * </ul>
 *
 * <p>設計と実測は {@code fw/texture-radiomics-design.md}。GLAM は §11。
 */
package com.vis.graphynext.radiomics;
