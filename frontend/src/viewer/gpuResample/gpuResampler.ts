/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */

/**
 * Fusion のリサンプルを WebGL2 で行う薄い層。数値は `fusionEngine.ts` の CPU の実装が正で、ここは別の実装。
 * 使うか使わないかは `fusionResampler.ts`（環境判定・カナリア・時間と一致の比較）が決める。
 *
 * - 前景は**保存値のまま** 3D テクスチャ（整数の保存値は無損失）。スライスごとの slope・intercept・wPos は小さな
 *   RGBA32F のテクスチャ（SUV 校正が変わったときはこれだけ作り直す）。
 * - 出力は RGBA32F の FBO（値と有効フラグ）を `readPixels` で読み戻し、有効でない画素を NaN にして `Float32Array` で返す
 *   （契約は `computeFusionSlice` と同じ）。
 * - 対象は DVF を含まない変換（`resamplePlan` の `stages` が空）。DVF は呼び出し側が CPU にする。
 */
import type { FusionVolume } from "../fusionEngine";
import { prepareFusionSlice } from "../fusionEngine";
import type { ResamplePlan } from "./resamplePlan";
import { buildFragmentShader, pixelKindOf, VERTEX_SHADER, type PixelKind, type ShaderFault } from "./gpuShader";

/** CPU に戻した理由（記録と画面の表示に使う）。 */
export type GpuFailReason =
  | "no-webgl2"
  | "no-float-rt"
  | "too-large"
  | "unsupported-pixel-type"
  | "oom"
  | "context-lost"
  | "gl-error"
  | "shader-compile";

export type UploadResult = { ok: true } | { ok: false; reason: GpuFailReason; detail?: string };

/** 選択ロジックが使う GPU の面（テストで差し替えられる）。 */
export interface GpuLike {
  /** コンテキストを失った（以後は CPU。復帰しても同じ利用中は戻さない）。 */
  readonly lost: boolean;
  /** 前景ボリュームを（既存のものを解放して）アップロードする。 */
  upload(vol: FusionVolume): UploadResult;
  /** スライスごとの slope・intercept（SUV 校正の変更など）だけ作り直す。 */
  setParams(vol: FusionVolume): void;
  /** 背景 1 スライス分の前景値。範囲外は NaN。失敗したら null。 */
  resample(plan: ResamplePlan, cols: number, rows: number): Float32Array | null;
  /** 開発（dev）ビルドの検査用: シェーダに誤りを入れる。 */
  setFault(fault: ShaderFault | null): void;
  /** 前景のテクスチャを解放する（コンテキストは残す。次の利用で作り直す）。 */
  release(): void;
  dispose(): void;
}

const FORMAT: Record<PixelKind, { internal: number; format: number; type: number }> = {
  int16: { internal: 0x8233 /* R16I */, format: 0x8d94 /* RED_INTEGER */, type: 0x1402 /* SHORT */ },
  uint16: { internal: 0x8234 /* R16UI */, format: 0x8d94, type: 0x1403 /* UNSIGNED_SHORT */ },
  uint8: { internal: 0x8232 /* R8UI */, format: 0x8d94, type: 0x1401 /* UNSIGNED_BYTE */ },
  float32: { internal: 0x822e /* R32F */, format: 0x1903 /* RED */, type: 0x1406 /* FLOAT */ },
};
const GL_OUT_OF_MEMORY = 0x0505;

export class GpuResampler implements GpuLike {
  private gl: WebGL2RenderingContext;
  private canvas: HTMLCanvasElement | OffscreenCanvas;
  private _lost = false;
  private kind: PixelKind | null = null;
  private dims: [number, number, number] = [0, 0, 0];
  private volTex: WebGLTexture | null = null;
  private paramTex: WebGLTexture | null = null;
  private outTex: WebGLTexture | null = null;
  private fbo: WebGLFramebuffer | null = null;
  private outSize: [number, number] = [0, 0];
  private programs = new Map<string, WebGLProgram>();
  private vao: WebGLVertexArrayObject | null = null;
  private fault: ShaderFault | null = null;
  readonly limits: { max3d: number; maxTexture: number };

  private constructor(canvas: HTMLCanvasElement | OffscreenCanvas, gl: WebGL2RenderingContext) {
    this.canvas = canvas;
    this.gl = gl;
    this.limits = {
      max3d: Number(gl.getParameter(gl.MAX_3D_TEXTURE_SIZE)) || 0,
      maxTexture: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 0,
    };
    canvas.addEventListener("webglcontextlost", (e: Event) => {
      e.preventDefault();
      this._lost = true;
    });
    this.vao = gl.createVertexArray();
  }

  /** コンテキストを作る。WebGL2 や浮動小数点の描画先が無ければ理由を返す。 */
  static create(): GpuResampler | { error: GpuFailReason } {
    try {
      const canvas: HTMLCanvasElement | OffscreenCanvas =
        typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1) : document.createElement("canvas");
      const gl = canvas.getContext("webgl2", {
        powerPreference: "high-performance", // 3D と同じ GPU
        antialias: false,
        depth: false,
        stencil: false,
      }) as WebGL2RenderingContext | null;
      if (!gl) return { error: "no-webgl2" };
      if (!gl.getExtension("EXT_color_buffer_float")) return { error: "no-float-rt" };
      return new GpuResampler(canvas, gl);
    } catch {
      return { error: "no-webgl2" };
    }
  }

  get lost(): boolean {
    return this._lost || this.gl.isContextLost();
  }

  setFault(fault: ShaderFault | null): void {
    if (!import.meta.env.DEV) return; // 検査用。本番ビルドでは効かない
    this.fault = fault;
  }

  upload(vol: FusionVolume): UploadResult {
    const gl = this.gl;
    if (this.lost) return { ok: false, reason: "context-lost" };
    this.releaseVolume();
    const n = vol.slices.length;
    if (n === 0) return { ok: false, reason: "gl-error", detail: "no slices" };
    const kind = pixelKindOf(vol.slices[0].pixels);
    if (!kind) return { ok: false, reason: "unsupported-pixel-type" };
    for (const s of vol.slices) {
      if (pixelKindOf(s.pixels) !== kind || s.pixels.length !== vol.cols * vol.rows) {
        return { ok: false, reason: "unsupported-pixel-type", detail: "mixed slices" };
      }
    }
    const { max3d, maxTexture } = this.limits;
    if (vol.cols > max3d || vol.rows > max3d || n > max3d || n > maxTexture) return { ok: false, reason: "too-large" };

    const f = FORMAT[kind];
    gl.getError(); // 以前のエラーを捨てる
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.texStorage3D(gl.TEXTURE_3D, 1, f.internal, vol.cols, vol.rows, n);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    for (let z = 0; z < n; z++) {
      gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, z, vol.cols, vol.rows, 1, f.format, f.type, vol.slices[z].pixels as unknown as ArrayBufferView);
    }
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    const err = gl.getError();
    if (err !== 0) {
      gl.deleteTexture(tex);
      return err === GL_OUT_OF_MEMORY ? { ok: false, reason: "oom" } : { ok: false, reason: "gl-error", detail: `0x${err.toString(16)}` };
    }
    this.volTex = tex;
    this.kind = kind;
    this.dims = [vol.cols, vol.rows, n];
    this.setParams(vol);
    const err2 = gl.getError();
    if (err2 !== 0) {
      this.releaseVolume();
      return err2 === GL_OUT_OF_MEMORY ? { ok: false, reason: "oom" } : { ok: false, reason: "gl-error", detail: `0x${err2.toString(16)}` };
    }
    return { ok: true };
  }

  setParams(vol: FusionVolume): void {
    const gl = this.gl;
    const n = vol.slices.length;
    // wPos は prepareFusionSlice と同じ式（前景の法線方向の位置。fgIpp0 基点）
    const ctx = prepareFusionSlice(vol, { iop: vol.iop, ipp: [0, 0, 0], pixelSpacingCol: 1, pixelSpacingRow: 1, cols: 1, rows: 1 }, null);
    const data = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      data[i * 4] = vol.slices[i].slope;
      data[i * 4 + 1] = vol.slices[i].intercept;
      data[i * 4 + 2] = ctx ? ctx.wPos[i] : 0;
    }
    if (!this.paramTex) this.paramTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.paramTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, n, 1, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  resample(plan: ResamplePlan, cols: number, rows: number): Float32Array | null {
    const gl = this.gl;
    if (this.lost || !this.volTex || !this.paramTex || !this.kind) return null;
    if (plan.stages.length > 0) return null; // DVF は対象外（呼び出し側が CPU にする）
    if (cols > this.limits.maxTexture || rows > this.limits.maxTexture) return null;
    const prog = this.program(this.kind);
    if (!prog) return null;

    if (!this.outTex || this.outSize[0] !== cols || this.outSize[1] !== rows) {
      if (this.outTex) gl.deleteTexture(this.outTex);
      if (this.fbo) gl.deleteFramebuffer(this.fbo);
      this.outTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.outTex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, cols, rows);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      this.fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.outTex, 0);
      this.outSize = [cols, rows];
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return null;
    gl.viewport(0, 0, cols, rows);
    gl.disable(gl.BLEND);
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, this.volTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.paramTex);
    gl.uniform1i(gl.getUniformLocation(prog, "uVol"), 0);
    gl.uniform1i(gl.getUniformLocation(prog, "uParams"), 1);
    gl.uniform3i(gl.getUniformLocation(prog, "uDims"), this.dims[0], this.dims[1], this.dims[2]);
    // plan.first は row-major（行 = u, v, w_mm、列 = bx, by, 1）。GLSL の mat3 は列優先なので転置して渡す
    const f = plan.first;
    gl.uniformMatrix3fv(gl.getUniformLocation(prog, "uA"), false, new Float32Array([f[0], f[3], f[6], f[1], f[4], f[7], f[2], f[5], f[8]]));
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const raw = new Float32Array(cols * rows * 4);
    gl.readPixels(0, 0, cols, rows, gl.RGBA, gl.FLOAT, raw); // 同期。GPU の完了まで待つ
    if (gl.getError() !== 0) return null;
    const out = new Float32Array(cols * rows);
    for (let i = 0; i < out.length; i++) out[i] = raw[i * 4 + 1] > 0.5 ? raw[i * 4] : NaN;
    return out;
  }

  private program(kind: PixelKind): WebGLProgram | null {
    const key = `${kind}:${this.fault ?? ""}`;
    const cached = this.programs.get(key);
    if (cached) return cached;
    const gl = this.gl;
    const compile = (type: number, src: string): WebGLShader | null => {
      const s = gl.createShader(type);
      if (!s) return null;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
    };
    const vs = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compile(gl.FRAGMENT_SHADER, buildFragmentShader(kind, this.fault));
    if (!vs || !fs) return null;
    const p = gl.createProgram();
    if (!p) return null;
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return null;
    this.programs.set(key, p);
    return p;
  }

  release(): void {
    this.releaseVolume();
    if (this.paramTex) this.gl.deleteTexture(this.paramTex);
    this.paramTex = null;
  }

  private releaseVolume(): void {
    const gl = this.gl;
    if (this.volTex) gl.deleteTexture(this.volTex);
    this.volTex = null;
    this.kind = null;
  }

  dispose(): void {
    const gl = this.gl;
    this.releaseVolume();
    if (this.paramTex) gl.deleteTexture(this.paramTex);
    if (this.outTex) gl.deleteTexture(this.outTex);
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    for (const p of this.programs.values()) gl.deleteProgram(p);
    this.programs.clear();
    this.paramTex = this.outTex = this.fbo = null;
    gl.getExtension("WEBGL_lose_context")?.loseContext(); // コンテキスト数の上限に近い画面のため、使い終えたら返す
    void this.canvas;
  }
}
