// Effetti video di Gobbo: sfondo sfocato (bokeh) e pelle levigata.
// La persona viene ritagliata con MediaPipe Selfie Segmentation; il resto lo fa WebGL2.
// Il risultato è disegnato su un canvas che fa sia da anteprima sia da sorgente per la registrazione.
import { FilesetResolver, ImageSegmenter } from './vendor/mediapipe/vision_bundle.mjs';

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`;

// sfocatura gaussiana separabile (9 campioni)
const BLUR = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_step;
out vec4 o;
void main() {
  vec3 c = texture(u_tex, v_uv).rgb * 0.227027;
  c += (texture(u_tex, v_uv + u_step).rgb + texture(u_tex, v_uv - u_step).rgb) * 0.1945946;
  c += (texture(u_tex, v_uv + u_step * 2.0).rgb + texture(u_tex, v_uv - u_step * 2.0).rgb) * 0.1216216;
  c += (texture(u_tex, v_uv + u_step * 3.0).rgb + texture(u_tex, v_uv - u_step * 3.0).rgb) * 0.054054;
  c += (texture(u_tex, v_uv + u_step * 4.0).rgb + texture(u_tex, v_uv - u_step * 4.0).rgb) * 0.016216;
  o = vec4(c, 1.0);
}`;

const FINAL = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_video, u_blur, u_mask;
uniform vec2 u_texel;
uniform float u_bokeh, u_smooth;
out vec4 o;

// probabilità che il colore sia pelle (spazio YCbCr)
float skin(vec3 c) {
  float y = dot(c, vec3(0.299, 0.587, 0.114));
  float cb = (c.b - y) * 0.564 + 0.5;
  float cr = (c.r - y) * 0.713 + 0.5;
  return (1.0 - smoothstep(0.07, 0.13, abs(cr - 0.60))) * (1.0 - smoothstep(0.09, 0.15, abs(cb - 0.40)));
}

void main() {
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);
  vec3 c = texture(u_video, uv).rgb;
  float m = smoothstep(0.3, 0.75, texture(u_mask, uv).r);

  if (u_smooth > 0.0) {
    // filtro bilaterale: media dei vicini con colore simile, così i bordi (occhi, labbra) restano nitidi
    vec3 sum = c; float wsum = 1.0;
    float r = 2.0 + 5.0 * u_smooth;
    for (int ring = 1; ring <= 2; ring++) {
      for (int i = 0; i < 8; i++) {
        float a = float(i) * 0.785398 + float(ring) * 0.3927;
        vec2 off = vec2(cos(a), sin(a)) * r * float(ring) * 0.5 * u_texel;
        vec3 s = texture(u_video, uv + off).rgb;
        vec3 d = s - c;
        float w = exp(-dot(d, d) / 0.012);
        sum += s * w; wsum += w;
      }
    }
    vec3 sm = sum / wsum;
    float k = u_smooth * 0.9 * m * skin(c);
    c = mix(c, sm, k);
    c += k * 0.03; // leggero effetto luminoso
  }

  if (u_bokeh > 0.0) {
    vec3 bg = texture(u_blur, uv).rgb;
    c = mix(bg, c, m);
  }
  o = vec4(c, 1.0);
}`;

function compile(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.bindAttribLocation(p, 0, 'a_pos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
  return { p, u };
}

function texture(gl, filter = gl.LINEAR) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

export async function createEffects(video, canvas, base = '.') {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false });
  if (!gl) throw new Error('WebGL2 non disponibile');

  const fileset = await FilesetResolver.forVisionTasks(base + '/vendor/mediapipe/wasm');
  const segOpts = d => ({
    baseOptions: { modelAssetPath: base + '/models/selfie_segmenter.tflite', delegate: d },
    runningMode: 'VIDEO', outputCategoryMask: false, outputConfidenceMasks: true
  });
  let segmenter;
  try { segmenter = await ImageSegmenter.createFromOptions(fileset, segOpts('GPU')); }
  catch (e) { segmenter = await ImageSegmenter.createFromOptions(fileset, segOpts('CPU')); }

  const blurProg = compile(gl, VERT, BLUR);
  const finalProg = compile(gl, VERT, FINAL);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const videoTex = texture(gl), maskTex = texture(gl);
  const fb = [0, 1].map(() => ({ tex: texture(gl), fbo: gl.createFramebuffer() }));
  let W = 0, H = 0, bw = 0, bh = 0;
  let mask8 = null, maskW = 0, maskH = 0, maskPrev = null;

  const opts = { bokeh: 0.5, smooth: 0.5, maxSide: 1920 };
  let running = false, frames = 0, segEvery = 1, lastSegMs = 0, fpsT = performance.now(), fps = 30;
  const listeners = { fps: null };

  function resize() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return false;
    const s = Math.min(1, opts.maxSide / Math.max(vw, vh));
    const w = Math.round(vw * s), h = Math.round(vh * s);
    if (w === W && h === H) return true;
    W = canvas.width = w; H = canvas.height = h;
    bw = Math.max(1, Math.round(W / 4)); bh = Math.max(1, Math.round(H / 4));
    for (const f of fb) {
      gl.bindTexture(gl.TEXTURE_2D, f.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, bw, bh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, f.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, f.tex, 0);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return true;
  }

  function segment(now) {
    const t0 = performance.now();
    const res = segmenter.segmentForVideo(video, now);
    try {
      const m = res.confidenceMasks && res.confidenceMasks[0];
      if (!m) return;
      const f = m.getAsFloat32Array();
      if (m.width !== maskW || m.height !== maskH || !mask8) {
        maskW = m.width; maskH = m.height; mask8 = new Uint8Array(maskW * maskH); maskPrev = new Float32Array(maskW * maskH);
      }
      // media con il fotogramma precedente: bordi più stabili, meno sfarfallio
      for (let i = 0; i < f.length; i++) { const v = maskPrev[i] * 0.35 + f[i] * 0.65; maskPrev[i] = v; mask8[i] = v * 255; }
      gl.bindTexture(gl.TEXTURE_2D, maskTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, maskW, maskH, 0, gl.RED, gl.UNSIGNED_BYTE, mask8);
    } finally { res.close(); }
    lastSegMs = performance.now() - t0;
    segEvery = lastSegMs > 22 ? 2 : 1; // se il telefono fatica, ritaglia un fotogramma sì e uno no
  }

  function draw() {
    if (!resize() || video.readyState < 2) return;
    const now = performance.now();
    if (frames % segEvery === 0) segment(now);
    frames++;

    gl.bindTexture(gl.TEXTURE_2D, videoTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);

    if (opts.bokeh > 0) {
      gl.useProgram(blurProg.p);
      gl.uniform1i(blurProg.u.u_tex, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.viewport(0, 0, bw, bh);
      const r = 0.6 + 2.2 * opts.bokeh;
      let src = videoTex;
      for (let pass = 0; pass < 4; pass++) {
        const dst = fb[pass % 2];
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
        gl.bindTexture(gl.TEXTURE_2D, src);
        gl.uniform2f(blurProg.u.u_step, pass % 2 === 0 ? r / bw : 0, pass % 2 === 0 ? 0 : r / bh);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        src = dst.tex;
      }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.useProgram(finalProg.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, videoTex); gl.uniform1i(finalProg.u.u_video, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, fb[1].tex); gl.uniform1i(finalProg.u.u_blur, 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, maskTex); gl.uniform1i(finalProg.u.u_mask, 2);
    gl.uniform2f(finalProg.u.u_texel, 1 / W, 1 / H);
    gl.uniform1f(finalProg.u.u_bokeh, opts.bokeh);
    gl.uniform1f(finalProg.u.u_smooth, opts.smooth);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);

    // misura la fluidità ogni 2 secondi
    if (now - fpsT > 2000) {
      fps = Math.round(framesSince * 1000 / (now - fpsT)); framesSince = 0; fpsT = now;
      if (listeners.fps) listeners.fps(fps);
    }
    framesSince++;
  }
  let framesSince = 0;

  const hasVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  function loop() {
    if (!running) return;
    try { draw(); } catch (e) { console.error(e); }
    if (hasVFC) video.requestVideoFrameCallback(loop); else requestAnimationFrame(loop);
  }

  return {
    start() { if (running) return; running = true; fpsT = performance.now(); framesSince = 0; loop(); },
    stop() { running = false; },
    set(o) { Object.assign(opts, o); },
    get fps() { return fps; },
    onFps(fn) { listeners.fps = fn; },
    // traccia video del canvas elaborato, da unire all'audio del microfono
    stream(fpsCap = 30) { return canvas.captureStream(fpsCap); }
  };
}
