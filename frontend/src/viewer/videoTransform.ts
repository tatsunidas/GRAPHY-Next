/**
 * 動画ビューポートの回転・反転・ズーム・パン（`VideoViewer` の表示操作）。
 *
 * <p>Cornerstone 3.33.5 の `VideoViewport` は **拡大縮小と平行移動しか持たない**（`getTransform`）。
 * しかも座標変換が 2 系統ある:
 *   - 描画・`canvasToIndex` / `indexToCanvas` → `getTransform()`
 *   - 注釈ツール・`getCamera` → `canvasToWorld` / `worldToCanvas`（`getTransform` を**通らない**）
 * 片方だけ回すと「絵は回ったが ROI は回らない」になる。そこで両方を、ここの同じ式で差し替える
 * （{@link installVideoDisplay}）。
 *
 * <p>座標の約束:
 *   - world = 動画の画素座標（x 右・y 下）。注釈は world で持つので、回転しても**動画上の位置は変わらない**。
 *   - 素の写像 B: canvas = (world + pan) · r（r = 1 world あたりの CSS px、pan は world 単位）
 *   - 向き M（2×2 の整数行列）は **canvas の中心 C のまわり**に掛ける: canvas = C + M·(B(world) − C)
 *   - M は画面上の操作を**左から**積む（「今見えている絵」を右へ 90° 回す・左右に反転する）。
 *     画像タイルのボタンと同じ感覚になる。
 */

/** 2×2 の行列 [a, b, c, d] = [[a, b], [c, d]]。要素は −1・0・1 だけ（回転 90° 刻み＋反転）。 */
export type Orient = readonly [number, number, number, number];

export const IDENTITY: Orient = [1, 0, 0, 1];

/** 画面上で時計回りに 90°（y 下向きの座標なので (x, y) → (−y, x)）。 */
const ROT90: Orient = [0, -1, 1, 0];
const FLIP_H: Orient = [-1, 0, 0, 1];
const FLIP_V: Orient = [1, 0, 0, -1];

function mul(p: Orient, q: Orient): Orient {
  // `+ 0` で −0 を 0 にそろえる（向きの比較・保存で別物にならないように）
  return [
    p[0] * q[0] + p[1] * q[2] + 0,
    p[0] * q[1] + p[1] * q[3] + 0,
    p[2] * q[0] + p[3] * q[2] + 0,
    p[2] * q[1] + p[3] * q[3] + 0,
  ];
}

export const rotate90 = (m: Orient): Orient => mul(ROT90, m);
export const flipH = (m: Orient): Orient => mul(FLIP_H, m);
export const flipV = (m: Orient): Orient => mul(FLIP_V, m);

/** 直交行列なので逆行列は転置。 */
const inv = (m: Orient): Orient => [m[0], m[2], m[1], m[3]];

const apply = (m: Orient, x: number, y: number): [number, number] => [m[0] * x + m[1] * y, m[2] * x + m[3] * y];

/** 90°・270° 回っているか（画面上の幅と高さが入れ替わる）。 */
export const isSwapped = (m: Orient): boolean => m[0] === 0;

/** 回転角（時計回り、度）と、その後の左右反転の有無。表示用（`getViewState` 等）。 */
export function describe(m: Orient): { rotation: 0 | 90 | 180 | 270; flipped: boolean } {
  const flipped = m[0] * m[3] - m[1] * m[2] < 0;
  // 反転を外して純粋な回転にする（左から FLIP_H を掛けて det を +1 に戻す）
  const r = flipped ? mul(FLIP_H, m) : m;
  const rotation = r[0] === 1 ? 0 : r[0] === -1 ? 180 : r[2] === 1 ? 90 : 270;
  return { rotation, flipped };
}

/** 動画のカメラ（Cornerstone の `videoCamera` と同じ形）。 */
export interface VideoCam {
  /** 1 world（動画の 1 画素）あたりの CSS px。 */
  parallelScale: number;
  /** world 単位の平行移動。 */
  panWorld: [number, number];
}

/** canvas の CSS px の大きさ。 */
export interface CanvasSize {
  width: number;
  height: number;
}

export function worldToCanvas(w: readonly number[], cam: VideoCam, c: CanvasSize, m: Orient): [number, number] {
  const cx = c.width / 2;
  const cy = c.height / 2;
  const bx = (w[0] + cam.panWorld[0]) * cam.parallelScale;
  const by = (w[1] + cam.panWorld[1]) * cam.parallelScale;
  const [dx, dy] = apply(m, bx - cx, by - cy);
  return [cx + dx, cy + dy];
}

export function canvasToWorld(p: readonly number[], cam: VideoCam, c: CanvasSize, m: Orient): [number, number] {
  const cx = c.width / 2;
  const cy = c.height / 2;
  const [dx, dy] = apply(inv(m), p[0] - cx, p[1] - cy);
  return [(cx + dx) / cam.parallelScale - cam.panWorld[0], (cy + dy) / cam.parallelScale - cam.panWorld[1]];
}

/**
 * 描画用の 2D アフィン [a, b, c, d, e, f]（canvas 2D の `transform()` と Cornerstone `Transform.m` の並び。
 * x' = a·x + c·y + e、y' = b·x + d·y + f）。world → **デバイス px**（dpr を掛ける）。
 */
export function drawMatrix(cam: VideoCam, c: CanvasSize, m: Orient, dpr: number): [number, number, number, number, number, number] {
  const r = cam.parallelScale;
  const cx = c.width / 2;
  const cy = c.height / 2;
  // canvas = C + M·((w + pan)·r − C) = r·M·w + (C + M·(pan·r − C))
  const [tx, ty] = apply(m, cam.panWorld[0] * r - cx, cam.panWorld[1] * r - cy);
  return [dpr * r * m[0], dpr * r * m[2], dpr * r * m[1], dpr * r * m[3], dpr * (cx + tx), dpr * (cy + ty)];
}

/**
 * 全体が収まるカメラ（Fit）。回転で幅と高さが入れ替わるのを見込み、動画の中心を canvas の中心に置く。
 * （中心どうしが重なるので、回転・反転をどう掛けても中心は動かない。）
 */
export function fitCamera(videoW: number, videoH: number, c: CanvasSize, m: Orient): VideoCam {
  const [w, h] = isSwapped(m) ? [videoH, videoW] : [videoW, videoH];
  const r = Math.min(c.width / Math.max(1, w), c.height / Math.max(1, h)) || 1;
  return { parallelScale: r, panWorld: [c.width / 2 / r - videoW / 2, c.height / 2 / r - videoH / 2] };
}

/** canvas の中心に見えている world 点。 */
export function centerWorld(cam: VideoCam, c: CanvasSize): [number, number] {
  // 向き M は中心を動かさないので、M を問わず同じ
  return [c.width / 2 / cam.parallelScale - cam.panWorld[0], c.height / 2 / cam.parallelScale - cam.panWorld[1]];
}

/** 倍率 r で、world 点 `focal` を canvas の中心に置くカメラ。 */
export function cameraCenteredOn(focal: readonly number[], r: number, c: CanvasSize): VideoCam {
  return { parallelScale: r, panWorld: [c.width / 2 / r - focal[0], c.height / 2 / r - focal[1]] };
}

/** `installVideoDisplay` が差し替える `VideoViewport` の中身（内部フィールドを含む）。 */
export interface OrientableVideoViewport {
  videoWidth: number;
  videoHeight: number;
  videoCamera: VideoCam;
  canvas: HTMLCanvasElement;
  element: HTMLElement;
  isPlaying?: boolean;
  renderFrame(): void;
  getTransform(): { m: number[]; getMatrix(): number[] };
  canvasToWorld(p: number[], dest?: number[]): number[];
  worldToCanvas(w: number[]): number[];
  refreshRenderValues(): void;
  setCamera(camera: { parallelScale?: number; focalPoint?: number[] }): void;
  getCamera(): { parallelScale: number; focalPoint: number[] } & Record<string, unknown>;
  voiRange?: VideoVoi;
  setVOI(voi: VideoVoi | undefined): void;
}

/** 表示の状態（`VideoViewer` が持ち、差し替えた関数が毎回読む）。 */
export interface VideoDisplayState {
  orient(): Orient;
  inverted(): boolean;
}

/**
 * 🔴 **Cornerstone の内部に手を入れる。** 3.33.5 の `VideoViewport` に対し、インスタンス上で次を差し替える:
 *   - `getTransform`（描画・`canvasToIndex`）/ `canvasToWorld` / `worldToCanvas`（注釈ツール）→ 向き M を含む同じ式
 *   - `refreshRenderValues`（`resetCamera` と `resize` が呼ぶ Fit）→ 回転で縦横が入れ替わるのを見込む
 *   - `setVOI` → WW/WL と階調反転（{@link videoColorFilter}）
 *   - `setCamera` → パン（PanTool）・ズーム（ZoomTool）を**中心の world 点を保って**行う。素の実装は画面上のずれを
 *     回転前の pan に足すので、回っていると逆向きに動く
 * Cornerstone を上げたら `videoDisplayOpsCheck`（画素で向きを判定するスパイク）で確かめること。
 */
export function installVideoDisplay(vp: OrientableVideoViewport, state: VideoDisplayState): void {
  const getOrient = state.orient;
  const size = (): CanvasSize => ({ width: vp.canvas.offsetWidth, height: vp.canvas.offsetHeight });
  // getTransform は Transform インスタンスを返す約束なので、素の実装が返したものに行列を書き込む
  const baseGetTransform = vp.getTransform.bind(vp);
  vp.getTransform = () => {
    const t = baseGetTransform();
    const mm = drawMatrix(vp.videoCamera, size(), getOrient(), window.devicePixelRatio || 1);
    for (let i = 0; i < 6; i++) t.m[i] = mm[i];
    return t;
  };
  vp.worldToCanvas = (w) => worldToCanvas(w, vp.videoCamera, size(), getOrient());
  vp.canvasToWorld = (p, dest = [0, 0, 0]) => {
    const [x, y] = canvasToWorld(p, vp.videoCamera, size(), getOrient());
    dest.splice(0, 2, x, y);
    return dest;
  };
  vp.refreshRenderValues = () => {
    vp.videoCamera = fitCamera(vp.videoWidth, vp.videoHeight, size(), getOrient());
  };
  vp.setCamera = (camera) => {
    const c = size();
    const focal = camera.focalPoint ?? centerWorld(vp.videoCamera, c);
    // Cornerstone の parallelScale は「canvas の高さの半分が何 world か」。videoCamera の r はその逆数側
    const r = camera.parallelScale ? vp.element.clientHeight / 2 / camera.parallelScale : vp.videoCamera.parallelScale;
    if (!Number.isFinite(r) || r <= 0) return;
    vp.videoCamera = cameraCenteredOn(focal, r, c);
    if (!vp.isPlaying) vp.renderFrame();
  };
  // WW/WL（WindowLevelTool は setProperties({voiRange}) → setVOI を呼ぶ）と階調反転 → {@link videoColorFilter}
  vp.setVOI = (voi) => {
    vp.voiRange = voi && voi.upper > voi.lower ? { lower: voi.lower, upper: voi.upper } : { ...VIDEO_DEFAULT_VOI };
    vp.canvas.style.filter = videoColorFilter(vp.voiRange, state.inverted());
  };
}

/** 8bit の表示窓（WW/WL）。 */
export interface VideoVoi {
  lower: number;
  upper: number;
}

/** 動画の既定の窓（素通し）。 */
export const VIDEO_DEFAULT_VOI: VideoVoi = { lower: 0, upper: 255 };

/**
 * WW/WL と階調反転を CSS の `filter`（SVG の feColorMatrix）にする。素通しなら空文字。
 *
 * <p>🔴 Cornerstone の `VideoViewport.setColorTransform` は使わない。
 *   - 式が窓になっていない（`out = in·(upper−lower+1)/255 + lower/255`。窓を狭めても濃淡が広がらない）
 *   - `color-interpolation-filters="linearRGB"` のため、8bit 値に対して線形にならない
 *   - 階調反転を持たない
 * ここでは画像タイルと同じ意味（lower → 黒、upper → 白、その間は線形）にし、sRGB のまま計算する。
 */
export function videoColorFilter(voi: VideoVoi | null | undefined, inverted: boolean): string {
  const v = voi && voi.upper > voi.lower ? voi : VIDEO_DEFAULT_VOI;
  const identity = v.lower === VIDEO_DEFAULT_VOI.lower && v.upper === VIDEO_DEFAULT_VOI.upper;
  if (identity && !inverted) return "";
  // 入力 x ∈ [0,1]（= 画素値/255）→ (255x − lower)/(upper − lower)
  let s = 255 / (v.upper - v.lower);
  let o = -v.lower / (v.upper - v.lower);
  if (inverted) {
    s = -s;
    o = 1 - o;
  }
  const f = (n: number) => Number(n.toFixed(6));
  const values = `${f(s)} 0 0 0 ${f(o)} 0 ${f(s)} 0 0 ${f(o)} 0 0 ${f(s)} 0 ${f(o)} 0 0 0 1 0`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg"><filter id="f" color-interpolation-filters="sRGB">` +
    `<feColorMatrix type="matrix" values="${values}"/></filter></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}#f")`;
}
