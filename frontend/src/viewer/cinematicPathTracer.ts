/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Cinematic v2 — **プログレッシブ Monte-Carlo ボリューム・パストレーサ**（`fw/3d-viewer-design.md` §6.4 v2 / P7）。
 * 旧 GRAPHY `shaders/cinematic.frag`(355行)＋`present.frag` の **WebGL2 (GLSL ES 3.00) 忠実移植**。
 *
 * pure-vtk の描画とは独立した WebGL2 コンテキスト（オーバーレイ canvas）で動く。ボリュームを 3D テクスチャ
 * （正規化・最大 256³ にダウンサンプル）、色 LUT＋W/L を焼き込んだ 256×1 テクスチャに載せ、HG 位相関数＋
 * Cook-Torrance GGX サーフェス BRDF＋ソフトシャドウで各ピクセル 1 パス分の放射輝度を推定する。
 *
 * 蓄積は **ping-pong RGBA32F**（float ブレンド拡張に依存せず、前フレーム蓄積をサンプルして加算）。present パスで
 * ÷frameCount → 露出 → Reinhard → gamma して canvas へ。カメラ/LUT/W-L/クリップ/パラメータ変化で蓄積リセット。
 *
 * 座標は tex 空間 [0,1]³（旧 unit-cube を踏襲）。カメラレイは逆 view-projection（`measure3d.inverseViewProj`）で
 * world を復元し、`uWorldToTex`（origin/spacing/direction 由来）で tex 空間へ変換して march する（要件 11＝実空間整合）。
 *
 * ⚠️ GPU 依存（EXT_color_buffer_float 必須 / OES_texture_float_linear 任意）。standalone(Electron) 前提。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
type V3 = [number, number, number];

const MAX_DIM = 256; // 3D テクスチャの各軸上限（メモリ/性能ガード）

// ── フルスクリーン三角形 頂点シェーダ ──
const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// ── パストレース フラグメント（cinematic.frag の ES 3.00 / tex空間 移植）──
const CINEMATIC_FRAG = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler3D;

in vec2 vUv;
out vec4 FragColor;

uniform sampler3D volumeTex;   // 正規化スカラー [0,1]
uniform sampler2D uLutTex;     // 256x1 RGBA（W/L 焼き込み済み）
uniform sampler2D uPrevAccum;  // 前フレームまでの蓄積（ping-pong）

uniform mat4 uInvViewProj;     // NDC→world
uniform mat4 uWorldToTex;      // world→tex[0,1]
uniform vec3 uCameraPos;       // world

uniform float uWinCenter;      // 焼き込み済みなら 0.5
uniform float uWinWidth;       // 焼き込み済みなら 1.0

uniform vec3 uLightDir;        // tex 空間・光源方向（正規化）
uniform float uLightIntensity;
uniform float uAmbientIntensity;
uniform float uAnisotropy;
uniform float uLightAngularRadius;
uniform int uSamplesPerFrame;
uniform uint uFrameSeed;

uniform vec3 uClipMin;         // tex 空間クリップ
uniform vec3 uClipMax;

uniform float uRoughness;
uniform float uSpecular;
uniform float uMetallic;
uniform float uClearcoat;
uniform float uClearcoatRoughness;
uniform float uSurfaceGradientThreshold;

const int PRIMARY_STEPS = 128;
const int SHADOW_STEPS = 48;
const int MAX_BOUNCES = 4;
const float PI = 3.14159265359;

bool intersectBox(vec3 origin, vec3 dir, out float tNear, out float tFar) {
  vec3 invDir = 1.0 / dir;
  vec3 t1v = (uClipMin - origin) * invDir;
  vec3 t2v = (uClipMax - origin) * invDir;
  vec3 tMin = min(t1v, t2v);
  vec3 tMax = max(t1v, t2v);
  tNear = max(max(tMin.x, tMin.y), tMin.z);
  tFar = min(min(tMax.x, tMax.y), tMax.z);
  return tNear <= tFar && tFar > 0.0;
}

float sampleAlpha(vec3 texCoord, out vec3 albedo) {
  float rawVal = texture(volumeTex, texCoord).r;
  float winMin = uWinCenter - (uWinWidth * 0.5);
  float val = clamp((rawVal - winMin) / uWinWidth, 0.0, 1.0);
  vec4 src = texture(uLutTex, vec2(val, 0.5));
  albedo = src.rgb;
  return src.a;
}

float sampleAlphaOnly(vec3 texCoord) {
  float rawVal = texture(volumeTex, texCoord).r;
  float winMin = uWinCenter - (uWinWidth * 0.5);
  float val = clamp((rawVal - winMin) / uWinWidth, 0.0, 1.0);
  return texture(uLutTex, vec2(val, 0.5)).a;
}

vec3 computeGradient(vec3 pos) {
  const float eps = 0.005;
  float dx = sampleAlphaOnly(pos + vec3(eps, 0.0, 0.0)) - sampleAlphaOnly(pos - vec3(eps, 0.0, 0.0));
  float dy = sampleAlphaOnly(pos + vec3(0.0, eps, 0.0)) - sampleAlphaOnly(pos - vec3(0.0, eps, 0.0));
  float dz = sampleAlphaOnly(pos + vec3(0.0, 0.0, eps)) - sampleAlphaOnly(pos - vec3(0.0, 0.0, eps));
  return vec3(dx, dy, dz);
}

uint rngState;
uint pcgHash(uint x) {
  x = x * 747796405u + 2891336453u;
  uint word = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  return (word >> 22u) ^ word;
}
float rand() {
  rngState = pcgHash(rngState);
  return float(rngState) * (1.0 / 4294967296.0);
}
vec3 randomUnitVector() {
  float z = rand() * 2.0 - 1.0;
  float a = rand() * 2.0 * PI;
  float r = sqrt(max(0.0, 1.0 - z * z));
  return vec3(r * cos(a), r * sin(a), z);
}
float phaseHG(float cosTheta, float g) {
  float g2 = g * g;
  float denom = 1.0 + g2 - 2.0 * g * cosTheta;
  return (1.0 - g2) / (4.0 * PI * denom * sqrt(max(denom, 1e-4)));
}
vec3 sampleHG(vec3 forward, float g) {
  float cosTheta;
  if (abs(g) < 1e-3) {
    cosTheta = 1.0 - 2.0 * rand();
  } else {
    float sq = (1.0 - g * g) / (1.0 + g - 2.0 * g * rand());
    cosTheta = (1.0 + g * g - sq * sq) / (2.0 * g);
  }
  float sinTheta = sqrt(max(0.0, 1.0 - cosTheta * cosTheta));
  float phi = 2.0 * PI * rand();
  vec3 up = abs(forward.z) < 0.999 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
  vec3 tangent = normalize(cross(up, forward));
  vec3 bitangent = cross(forward, tangent);
  return tangent * (sinTheta * cos(phi)) + bitangent * (sinTheta * sin(phi)) + forward * cosTheta;
}
vec3 jitteredLightDir() {
  if (uLightAngularRadius <= 0.0) return uLightDir;
  float r = uLightAngularRadius * sqrt(rand());
  float phi = 2.0 * PI * rand();
  vec3 up = abs(uLightDir.z) < 0.999 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
  vec3 tangent = normalize(cross(up, uLightDir));
  vec3 bitangent = cross(uLightDir, tangent);
  return normalize(uLightDir + tangent * (r * cos(phi)) + bitangent * (r * sin(phi)));
}
float shadowTransmittance(vec3 origin) {
  vec3 lightDir = jitteredLightDir();
  float tNear, tFar;
  if (!intersectBox(origin, lightDir, tNear, tFar)) return 1.0;
  tNear = max(tNear, 0.0);
  float dist = tFar - tNear;
  if (dist <= 0.0001) return 1.0;
  float stepSize = dist / float(SHADOW_STEPS);
  vec3 pos = origin + lightDir * tNear;
  float opticalDepth = 0.0;
  for (int i = 0; i < SHADOW_STEPS; i++) {
    vec3 albedo;
    float alpha = sampleAlpha(pos, albedo);
    opticalDepth += -log(max(1.0 - alpha, 1e-4));
    pos += lightDir * stepSize;
  }
  return exp(-opticalDepth);
}
float D_GGX(float NoH, float roughness) {
  float a2 = roughness * roughness * roughness * roughness;
  float d = (NoH * NoH) * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d + 1e-7);
}
float G_Smith(float NoL, float NoV, float roughness) {
  float a2 = roughness * roughness * roughness * roughness;
  float k = a2 * 0.5;
  float gL = NoL / (NoL * (1.0 - k) + k + 1e-5);
  float gV = NoV / (NoV * (1.0 - k) + k + 1e-5);
  return gL * gV;
}
vec3 F_Schlick(float cosTheta, vec3 F0) {
  return F0 + (1.0 - F0) * pow(max(1.0 - cosTheta, 0.0), 5.0);
}
vec3 cookTorranceSpecular(vec3 N, vec3 V, vec3 L, float roughness, vec3 F0) {
  vec3 H = normalize(V + L);
  float NoH = max(dot(N, H), 0.0);
  float NoV = max(dot(N, V), 1e-4);
  float NoL = max(dot(N, L), 0.0);
  float VoH = max(dot(V, H), 0.0);
  float D = D_GGX(NoH, roughness);
  float G = G_Smith(NoL, NoV, roughness);
  vec3 F = F_Schlick(VoH, F0);
  return D * G * F / (4.0 * NoV * NoL + 1e-5);
}
vec3 sampleGGX(vec3 V, vec3 N, float roughness) {
  float a2 = roughness * roughness * roughness * roughness;
  float r0 = rand();
  float r1 = rand();
  float cosTheta2 = (1.0 - r0) / (r0 * (a2 - 1.0) + 1.0);
  float cosTheta = sqrt(max(cosTheta2, 0.0));
  float sinTheta = sqrt(max(1.0 - cosTheta2, 0.0));
  float phi = 2.0 * PI * r1;
  vec3 up = abs(N.z) < 0.999 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
  vec3 T = normalize(cross(up, N));
  vec3 B = cross(N, T);
  vec3 H = normalize(T * (sinTheta * cos(phi)) + B * (sinTheta * sin(phi)) + N * cosTheta);
  return reflect(-V, H);
}

vec3 tracePath(vec3 rayOrigin, vec3 rayDir) {
  vec3 radiance = vec3(0.0);
  vec3 throughput = vec3(1.0);
  for (int bounce = 0; bounce < MAX_BOUNCES; bounce++) {
    float tNear, tFar;
    if (!intersectBox(rayOrigin, rayDir, tNear, tFar)) break;
    tNear = max(tNear, 0.0);
    float dist = tFar - tNear;
    if (dist <= 0.0001) break;
    float stepSize = dist / float(PRIMARY_STEPS);
    vec3 pos = rayOrigin + rayDir * (tNear + rand() * stepSize);
    bool hit = false;
    vec3 hitAlbedo = vec3(0.0);
    for (int i = 0; i < PRIMARY_STEPS; i++) {
      vec3 albedo;
      float alpha = sampleAlpha(pos, albedo);
      if (rand() < alpha) { hit = true; hitAlbedo = albedo; break; }
      pos += rayDir * stepSize;
    }
    if (!hit) break;
    float visibility = shadowTransmittance(pos);
    vec3 gradient = computeGradient(pos);
    float gradMag = length(gradient);
    if (gradMag >= uSurfaceGradientThreshold) {
      vec3 N = normalize(-gradient);
      if (dot(N, -rayDir) < 0.0) N = -N;
      vec3 V = -rayDir;
      vec3 L = uLightDir;
      float NoL = max(dot(N, L), 0.0);
      vec3 F0 = mix(vec3(0.04 * uSpecular), hitAlbedo, uMetallic);
      vec3 Fv = F_Schlick(max(dot(N, V), 1e-4), F0);
      float kS_scalar = clamp(max(Fv.r, max(Fv.g, Fv.b)), 0.0, 1.0);
      float kD = (1.0 - kS_scalar) * (1.0 - uMetallic);
      vec3 diffuse = kD * hitAlbedo / PI;
      vec3 spec = cookTorranceSpecular(N, V, L, max(uRoughness, 0.01), F0);
      vec3 ccSpec = uClearcoat * cookTorranceSpecular(N, V, L, max(uClearcoatRoughness, 0.01), vec3(0.04));
      vec3 direct = (diffuse + spec + ccSpec) * uLightIntensity * visibility * NoL
                  + hitAlbedo * uAmbientIntensity;
      radiance += throughput * direct;
      float specProb = clamp(kS_scalar, 0.1, 0.9);
      if (rand() < specProb) {
        vec3 nextDir = sampleGGX(V, N, max(uRoughness, 0.01));
        if (dot(nextDir, N) <= 0.0) break;
        throughput *= F_Schlick(max(dot(N, nextDir), 0.0), F0) / specProb;
        rayDir = nextDir;
      } else {
        vec3 nextDir = normalize(N + randomUnitVector());
        if (dot(nextDir, N) <= 0.0) break;
        throughput *= hitAlbedo / (1.0 - specProb);
        rayDir = nextDir;
      }
    } else {
      float cosTheta = dot(rayDir, uLightDir);
      float phase = phaseHG(cosTheta, uAnisotropy);
      vec3 direct = hitAlbedo * (uLightIntensity * visibility * phase * 4.0 * PI + uAmbientIntensity);
      radiance += throughput * direct;
      if (bounce >= 1) {
        float continueProb = clamp(max(hitAlbedo.r, max(hitAlbedo.g, hitAlbedo.b)), 0.05, 0.95);
        if (rand() > continueProb) break;
        throughput /= continueProb;
      }
      throughput *= hitAlbedo;
      rayDir = sampleHG(rayDir, uAnisotropy);
    }
    rayOrigin = pos;
  }
  return radiance;
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 wF = uInvViewProj * vec4(ndc, 1.0, 1.0);
  vec3 farW = wF.xyz / wF.w;
  vec3 oTex = (uWorldToTex * vec4(uCameraPos, 1.0)).xyz;
  vec3 fTex = (uWorldToTex * vec4(farW, 1.0)).xyz;
  vec3 primaryDir = normalize(fTex - oTex);

  uvec2 px = uvec2(gl_FragCoord.xy);
  uint pixelSeed = px.x * 1973u + px.y * 9277u + uFrameSeed * 26699u;

  vec3 accumulated = vec3(0.0);
  int samples = max(1, uSamplesPerFrame);
  for (int s = 0; s < samples; s++) {
    rngState = pixelSeed ^ (uint(s) * 374761393u);
    accumulated += tracePath(oTex, primaryDir);
  }
  accumulated /= float(samples);

  vec3 prev = texture(uPrevAccum, vUv).rgb;
  FragColor = vec4(prev + accumulated, 1.0);
}`;

// ── present（present.frag 移植）──
const PRESENT_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 FragColor;
uniform sampler2D uAccumTex;
uniform float uFrameCount;
uniform float uExposure;
void main() {
  vec3 sum = texture(uAccumTex, vUv).rgb;
  vec3 color = (sum / max(uFrameCount, 1.0)) * uExposure;
  color = color / (1.0 + color);
  color = pow(max(color, 0.0), vec3(1.0 / 2.2));
  FragColor = vec4(color, 1.0);
}`;

/** パストレーサのマテリアル/ライトパラメータ。旧 `CinematicParams` に対応。 */
export interface PathTraceParams {
  lightIntensity: number;
  ambientIntensity: number;
  anisotropy: number;
  lightAngularRadius: number;
  samplesPerFrame: number;
  roughness: number;
  specular: number;
  metallic: number;
  clearcoat: number;
  clearcoatRoughness: number;
  surfaceGradientThreshold: number;
  exposure: number;
  /** world 空間の光源方向（正規化前でも可・シーンから光源へ）。 */
  lightDirWorld: V3;
}

export function defaultPathTraceParams(): PathTraceParams {
  return {
    lightIntensity: 1.5,
    ambientIntensity: 0.25,
    anisotropy: 0.3,
    lightAngularRadius: 0.08,
    samplesPerFrame: 1,
    roughness: 0.5,
    specular: 1,
    metallic: 0,
    clearcoat: 0,
    clearcoatRoughness: 0.05,
    surfaceGradientThreshold: 0.12,
    exposure: 1.5,
    lightDirWorld: [0.3, -0.5, 0.8],
  };
}

export interface CinematicEngine {
  /** vtk カメラ（renderer から取得）と表示サイズで per-pixel レイを更新。 */
  setCamera(invViewProj: number[], cameraPosWorld: V3): void;
  /** 色 LUT（W/L 焼き込み済み 256×4 RGBA 0..255）を設定。 */
  setLut(rgba: Uint8Array): void;
  /** tex 空間クリップ [min,max]（既定 [0,0,0]-[1,1,1]）。 */
  setClip(min: V3, max: V3): void;
  setParams(p: PathTraceParams): void;
  /** 蓄積をリセット（カメラ/パラメータ変化時）。 */
  reset(): void;
  /** 1 フレーム蓄積して present（収束まで毎フレーム呼ぶ）。 */
  renderFrame(): void;
  /** 現在の蓄積フレーム数。 */
  getFrameCount(): number;
  resize(width: number, height: number): void;
  dispose(): void;
}

/** WebGL2 パストレーサを canvas 上に構築。GPU 非対応（float FBO 不可等）なら null。 */
export function createCinematicPathTracer(
  canvas: HTMLCanvasElement,
  imageData: Any,
  geom: { origin: V3; spacing: V3; direction: number[]; dims: [number, number, number] },
  params: PathTraceParams,
): CinematicEngine | null {
  const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: false, antialias: false });
  if (!gl) return null;
  if (!gl.getExtension("EXT_color_buffer_float")) return null; // RGBA32F レンダー必須
  const floatLinear = !!gl.getExtension("OES_texture_float_linear");

  const compile = (type: number, src: string): WebGLShader | null => {
    const sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      // eslint-disable-next-line no-console
      console.error("[cinematic] shader error:", gl.getShaderInfoLog(sh));
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  };
  const link = (fragSrc: string): WebGLProgram | null => {
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, fragSrc);
    if (!vs || !fs) return null;
    const prog = gl.createProgram();
    if (!prog) return null;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, "aPos");
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      // eslint-disable-next-line no-console
      console.error("[cinematic] link error:", gl.getProgramInfoLog(prog));
      return null;
    }
    return prog;
  };

  const traceProg = link(CINEMATIC_FRAG);
  const presentProg = link(PRESENT_FRAG);
  if (!traceProg || !presentProg) return null;

  // フルスクリーン三角形。
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  // ── 3D ボリュームテクスチャ（正規化・ダウンサンプル）──
  const volTex = buildVolumeTexture(gl, imageData, geom.dims, floatLinear);
  if (!volTex) return null;

  // ── LUT テクスチャ（256×1 RGBA）──
  const lutTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, lutTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, grayscaleLut());
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // ── ping-pong 蓄積 RGBA32F ──
  let W = Math.max(1, canvas.width);
  let H = Math.max(1, canvas.height);
  const accum: { tex: WebGLTexture; fbo: WebGLFramebuffer }[] = [];
  const makeAccum = (w: number, h: number) => {
    for (const a of accum) {
      gl.deleteTexture(a.tex);
      gl.deleteFramebuffer(a.fbo);
    }
    accum.length = 0;
    for (let i = 0; i < 2; i++) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      accum.push({ tex, fbo });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };
  makeAccum(W, H);

  // uniform locations（trace）。
  const uT = (n: string) => gl.getUniformLocation(traceProg, n);
  const loc = {
    volumeTex: uT("volumeTex"), uLutTex: uT("uLutTex"), uPrevAccum: uT("uPrevAccum"),
    uInvViewProj: uT("uInvViewProj"), uWorldToTex: uT("uWorldToTex"), uCameraPos: uT("uCameraPos"),
    uWinCenter: uT("uWinCenter"), uWinWidth: uT("uWinWidth"),
    uLightDir: uT("uLightDir"), uLightIntensity: uT("uLightIntensity"), uAmbientIntensity: uT("uAmbientIntensity"),
    uAnisotropy: uT("uAnisotropy"), uLightAngularRadius: uT("uLightAngularRadius"),
    uSamplesPerFrame: uT("uSamplesPerFrame"), uFrameSeed: uT("uFrameSeed"),
    uClipMin: uT("uClipMin"), uClipMax: uT("uClipMax"),
    uRoughness: uT("uRoughness"), uSpecular: uT("uSpecular"), uMetallic: uT("uMetallic"),
    uClearcoat: uT("uClearcoat"), uClearcoatRoughness: uT("uClearcoatRoughness"),
    uSurfaceGradientThreshold: uT("uSurfaceGradientThreshold"),
  };
  const uP = (n: string) => gl.getUniformLocation(presentProg, n);
  const ploc = { uAccumTex: uP("uAccumTex"), uFrameCount: uP("uFrameCount"), uExposure: uP("uExposure") };

  // 状態。
  const worldToTex = buildWorldToTex(geom);
  let invViewProj: number[] = identity16();
  let cameraPos: V3 = [0, 0, 0];
  let clipMin: V3 = [0, 0, 0];
  let clipMax: V3 = [1, 1, 1];
  let p = { ...params };
  let frameCount = 0;
  let src = 0; // 現在の「前フレーム蓄積」= accum[src]、書込先 = accum[1-src]

  const lightTex = (): V3 => {
    // world 光源方向 → tex 空間（線形部）→ 正規化。
    const l = p.lightDirWorld;
    const t: V3 = [
      worldToTex[0] * l[0] + worldToTex[4] * l[1] + worldToTex[8] * l[2],
      worldToTex[1] * l[0] + worldToTex[5] * l[1] + worldToTex[9] * l[2],
      worldToTex[2] * l[0] + worldToTex[6] * l[1] + worldToTex[10] * l[2],
    ];
    const n = Math.hypot(t[0], t[1], t[2]) || 1;
    return [t[0] / n, t[1] / n, t[2] / n];
  };

  const drawFullscreen = () => {
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  };

  const engine: CinematicEngine = {
    setCamera(ivp, pos) {
      invViewProj = ivp.slice();
      cameraPos = [pos[0], pos[1], pos[2]];
    },
    setLut(rgba) {
      gl.bindTexture(gl.TEXTURE_2D, lutTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    },
    setClip(min, max) {
      clipMin = [min[0], min[1], min[2]];
      clipMax = [max[0], max[1], max[2]];
    },
    setParams(next) {
      p = { ...next };
    },
    reset() {
      frameCount = 0;
    },
    getFrameCount() {
      return frameCount;
    },
    renderFrame() {
      const dst = 1 - src;
      // ── 蓄積パス: accum[dst] = accum[src](前) + 今フレームの推定 ──
      gl.bindFramebuffer(gl.FRAMEBUFFER, accum[dst].fbo);
      gl.viewport(0, 0, W, H);
      gl.disable(gl.BLEND);
      gl.useProgram(traceProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_3D, volTex);
      gl.uniform1i(loc.volumeTex, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, lutTex);
      gl.uniform1i(loc.uLutTex, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, frameCount === 0 ? accum[dst].tex : accum[src].tex);
      // frameCount===0 の前蓄積は 0 にしたいので、クリアした dst 自身をサンプル（下でクリア）。
      gl.uniform1i(loc.uPrevAccum, 2);
      if (frameCount === 0) {
        // dst をクリアしてから、それを prev(=0) としてサンプル。
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      gl.uniformMatrix4fv(loc.uInvViewProj, false, new Float32Array(invViewProj));
      gl.uniformMatrix4fv(loc.uWorldToTex, false, new Float32Array(worldToTex));
      gl.uniform3fv(loc.uCameraPos, cameraPos);
      gl.uniform1f(loc.uWinCenter, 0.5);
      gl.uniform1f(loc.uWinWidth, 1.0);
      gl.uniform3fv(loc.uLightDir, lightTex());
      gl.uniform1f(loc.uLightIntensity, p.lightIntensity);
      gl.uniform1f(loc.uAmbientIntensity, p.ambientIntensity);
      gl.uniform1f(loc.uAnisotropy, p.anisotropy);
      gl.uniform1f(loc.uLightAngularRadius, p.lightAngularRadius);
      gl.uniform1i(loc.uSamplesPerFrame, Math.max(1, Math.round(p.samplesPerFrame)));
      gl.uniform1ui(loc.uFrameSeed, (frameCount + 1) >>> 0);
      gl.uniform3fv(loc.uClipMin, clipMin);
      gl.uniform3fv(loc.uClipMax, clipMax);
      gl.uniform1f(loc.uRoughness, p.roughness);
      gl.uniform1f(loc.uSpecular, p.specular);
      gl.uniform1f(loc.uMetallic, p.metallic);
      gl.uniform1f(loc.uClearcoat, p.clearcoat);
      gl.uniform1f(loc.uClearcoatRoughness, p.clearcoatRoughness);
      gl.uniform1f(loc.uSurfaceGradientThreshold, p.surfaceGradientThreshold);
      drawFullscreen();
      frameCount++;
      src = dst; // 次回の prev = 今書いた dst

      // ── present: canvas へ ──
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      gl.useProgram(presentProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, accum[src].tex);
      gl.uniform1i(ploc.uAccumTex, 0);
      gl.uniform1f(ploc.uFrameCount, frameCount);
      gl.uniform1f(ploc.uExposure, p.exposure);
      drawFullscreen();
    },
    resize(width, height) {
      W = Math.max(1, Math.floor(width));
      H = Math.max(1, Math.floor(height));
      canvas.width = W;
      canvas.height = H;
      makeAccum(W, H);
      src = 0;
      frameCount = 0;
    },
    dispose() {
      try {
        for (const a of accum) {
          gl.deleteTexture(a.tex);
          gl.deleteFramebuffer(a.fbo);
        }
        gl.deleteTexture(volTex);
        gl.deleteTexture(lutTex);
        gl.deleteProgram(traceProg);
        gl.deleteProgram(presentProg);
        gl.deleteBuffer(vbo);
        gl.deleteVertexArray(vao);
      } catch {
        /* ignore */
      }
      // ⚠️ リソース削除だけでは WebGL コンテキスト自体が残る（canvas が GC されるまで生存）。
      // 開閉を繰り返すとブラウザのコンテキスト上限に達し、古いコンテキストが強制ロスト＝白画面、
      // 以降 getContext() が null を返して 3D 表示が起動不能になるため、明示的にロストさせる。
      try {
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      } catch {
        /* ignore */
      }
    },
  };
  return engine;
}

// ── ヘルパ ──────────────────────────────────────────────────────

/** グレースケール 256×1 RGBA（初期 LUT）。 */
function grayscaleLut(): Uint8Array {
  const a = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    a[i * 4] = i;
    a[i * 4 + 1] = i;
    a[i * 4 + 2] = i;
    a[i * 4 + 3] = i; // alpha ランプ
  }
  return a;
}

/** imageData のスカラーを [0,1] 正規化＋最大 256³ にダウンサンプルして R32F 3D テクスチャを作る。 */
function buildVolumeTexture(
  gl: WebGL2RenderingContext,
  imageData: Any,
  dims: [number, number, number],
  floatLinear: boolean,
): WebGLTexture | null {
  try {
    const scalars = imageData.getPointData().getScalars();
    const data = scalars.getData() as ArrayLike<number>;
    const [nx, ny, nz] = dims;
    if (!data || data.length < nx * ny * nz) return null;
    let dmin = Infinity, dmax = -Infinity;
    const range = scalars.getRange?.();
    if (Array.isArray(range) && range.length >= 2 && range[1] > range[0]) {
      dmin = range[0];
      dmax = range[1];
    } else {
      for (let i = 0; i < data.length; i++) {
        const v = data[i];
        if (v < dmin) dmin = v;
        if (v > dmax) dmax = v;
      }
    }
    const span = dmax - dmin || 1;
    const tx = Math.min(nx, MAX_DIM), ty = Math.min(ny, MAX_DIM), tz = Math.min(nz, MAX_DIM);
    const out = new Float32Array(tx * ty * tz);
    const frame = nx * ny;
    for (let z = 0; z < tz; z++) {
      const sz = Math.min(nz - 1, Math.floor((z * nz) / tz));
      for (let y = 0; y < ty; y++) {
        const sy = Math.min(ny - 1, Math.floor((y * ny) / ty));
        for (let x = 0; x < tx; x++) {
          const sx = Math.min(nx - 1, Math.floor((x * nx) / tx));
          out[(z * ty + y) * tx + x] = (data[sz * frame + sy * nx + sx] - dmin) / span;
        }
      }
    }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R32F, tx, ty, tz, 0, gl.RED, gl.FLOAT, out);
    const filt = floatLinear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, filt);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, filt);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    return tex;
  } catch {
    return null;
  }
}

/** world→tex[0,1] の列優先 mat4（origin/spacing/direction/dims 由来。`labelVolume.worldToVoxel` と同じ写像）。 */
function buildWorldToTex(geom: {
  origin: V3;
  spacing: V3;
  direction: number[];
  dims: [number, number, number];
}): number[] {
  const { origin: o, spacing: s, direction: d, dims: D } = geom;
  const m = new Array<number>(16).fill(0);
  for (let b = 0; b < 3; b++) {
    const dir: V3 = [d[b], d[3 + b], d[6 + b]]; // 軸 b の world 方向
    const sd = (s[b] || 1) * (D[b] || 1);
    const ax = dir[0] / sd, ay = dir[1] / sd, az = dir[2] / sd;
    const tb = -(dir[0] * o[0] + dir[1] * o[1] + dir[2] * o[2]) / sd + 0.5 / (D[b] || 1);
    m[0 * 4 + b] = ax;
    m[1 * 4 + b] = ay;
    m[2 * 4 + b] = az;
    m[3 * 4 + b] = tb;
  }
  m[0 * 4 + 3] = 0;
  m[1 * 4 + 3] = 0;
  m[2 * 4 + 3] = 0;
  m[3 * 4 + 3] = 1;
  return m;
}

function identity16(): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}
