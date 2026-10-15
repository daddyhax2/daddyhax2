/* Drawimate — brush engine.
 * Every brush renders a stroke (pure data) for a given loop position `f.u` in
 * [0,1). All motion uses an integer number of cycles per loop so the
 * animation repeats seamlessly when u wraps from 1 back to 0. */
(function (global) {
  'use strict';

  const TAU = Math.PI * 2;
  const noise = DMNoise.createNoise3D(1337);
  const hash3 = DMNoise.hash3;

  // Scratch buffers shared by all strokes (rendering is single-threaded).
  let X = new Float32Array(2048), Y = new Float32Array(2048), W = new Float32Array(2048);
  let NX = new Float32Array(2048), NY = new Float32Array(2048);
  function ensure(n) {
    if (X.length >= n) return;
    const m = Math.ceil(n * 1.5);
    X = new Float32Array(m); Y = new Float32Array(m); W = new Float32Array(m);
    NX = new Float32Array(m); NY = new Float32Array(m);
  }

  /* Cumulative arc length per point, cached on the stroke and extended
   * incrementally while the stroke is still being drawn. */
  function prep(st) {
    const pts = st.points, n = pts.length;
    if (!st._s || st._s.length < n) {
      const s = new Float32Array(Math.max(16, n * 2));
      if (st._s) s.set(st._s.subarray(0, st._n || 0));
      st._s = s;
    }
    let from = st._n || 0;
    if (from === 0 && n) { st._s[0] = 0; from = 1; }
    for (let i = from; i < n; i++) {
      const a = pts[i - 1], b = pts[i];
      st._s[i] = st._s[i - 1] + Math.hypot(b.x - a.x, b.y - a.y);
    }
    st._n = n;
    return st._s;
  }

  // Integer cycles of motion per loop → seamless repetition.
  function cyclesPerLoop(speed, L, rate) {
    return Math.max(0, Math.round(speed * L * rate));
  }

  function pressureScale(p) { return 0.25 + 1.5 * p; } // mouse reports 0.5 → 1.0

  /* Displace stroke points with looping noise into X/Y; half-widths into W. */
  function displace(st, theta, amp, sfreq, R) {
    const pts = st.points, n = pts.length, s = prep(st);
    ensure(n);
    const c = Math.cos(theta) * R, sn = Math.sin(theta) * R;
    const sd = st.seed % 1000, hw = st.size * 0.5;
    for (let i = 0; i < n; i++) {
      const p = pts[i], k = s[i] * sfreq;
      if (amp > 0) {
        X[i] = p.x + noise(sd + k, c, sn) * amp;
        Y[i] = p.y + noise(sd + 51.7 + k, c + 13.1, sn) * amp;
      } else { X[i] = p.x; Y[i] = p.y; }
      W[i] = hw * pressureScale(p.p);
    }
    return n;
  }

  /* Append one closed ribbon polygon (points a..b of X/Y/W) to the current path.
   * Ends are round when capA/capB, otherwise flat (for seamless chunking). */
  function ribbon(ctx, a, b, capA, capB) {
    if (b <= a) {
      const w = Math.max(W[a], 0.3);
      ctx.moveTo(X[a] + w, Y[a]); ctx.arc(X[a], Y[a], w, 0, TAU);
      return;
    }
    for (let i = a; i <= b; i++) {
      const pi = i > a ? i - 1 : a, ni = i < b ? i + 1 : b;
      const dx = X[ni] - X[pi], dy = Y[ni] - Y[pi];
      const len = Math.hypot(dx, dy) || 1;
      NX[i] = -dy / len; NY[i] = dx / len;
    }
    ctx.moveTo(X[a] + NX[a] * W[a], Y[a] + NY[a] * W[a]);
    for (let i = a + 1; i <= b; i++) ctx.lineTo(X[i] + NX[i] * W[i], Y[i] + NY[i] * W[i]);
    if (capB) { const phi = Math.atan2(NY[b], NX[b]); ctx.arc(X[b], Y[b], W[b], phi, phi - Math.PI, true); }
    else ctx.lineTo(X[b] - NX[b] * W[b], Y[b] - NY[b] * W[b]);
    for (let i = b - 1; i >= a; i--) ctx.lineTo(X[i] - NX[i] * W[i], Y[i] - NY[i] * W[i]);
    if (capA) { const phi = Math.atan2(NY[a], NX[a]); ctx.arc(X[a], Y[a], W[a], phi + Math.PI, phi, true); }
    ctx.closePath();
  }

  /* Ribbon that splits at sharp turns (>~70°) so the inner edge never folds
   * back on itself; the round caps at split points fill the outer corner. */
  const SHARP = Math.cos(70 * Math.PI / 180);
  function ribbonSplit(ctx, a, b, capA, capB) {
    let start = a;
    for (let i = a + 1; i < b; i++) {
      const ax = X[i] - X[i - 1], ay = Y[i] - Y[i - 1], bx = X[i + 1] - X[i], by = Y[i + 1] - Y[i];
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      if (la > 0 && lb > 0 && (ax * bx + ay * by) / (la * lb) < SHARP) {
        ribbon(ctx, start, i, start === a ? capA : true, true);
        start = i;
      }
    }
    ribbon(ctx, start, b, start === a ? capA : true, capB);
  }

  function fillStroke(ctx, st, n) {
    ctx.beginPath();
    ribbonSplit(ctx, 0, n - 1, true, true);
    ctx.fillStyle = st.color;
    ctx.fill();
  }

  /* ---------------------------------------------------------------- brushes */
  const BRUSHES = {};

  // 1. Scribble — nervous "boiling line": the pose jumps a few times per second.
  BRUSHES.scribble = {
    label: 'Scribble',
    defaults: { color: '#1d1c22', size: 6, opacity: 1, speed: 1, amp: 3, freq: 1.2 },
    render(ctx, st, f) {
      const boils = cyclesPerLoop(st.speed, f.L, 6);           // ~6 boils / sec at speed 1
      const theta = boils ? TAU * Math.floor(f.u * boils) / boils : 0;
      // Large time-circle radius → successive boils are near-independent poses.
      const n = displace(st, theta, st.amp, st.freq * 0.02, 5);
      if (!n) return;
      ctx.globalAlpha = st.opacity;
      fillStroke(ctx, st, n);
    },
  };

  global.DMBrushes = {
    BRUSHES, noise, hash3, prep, displace, ribbon, ribbonSplit, fillStroke,
    cyclesPerLoop, pressureScale, TAU,
    buf: () => ({ X, Y, W }),
  };
})(window);
