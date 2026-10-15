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

  /* --------------------------------------------------------- shared utils */
  function computeNormals(n) {
    for (let i = 0; i < n; i++) {
      const pi = i > 0 ? i - 1 : 0, ni = i < n - 1 ? i + 1 : n - 1;
      const dx = X[ni] - X[pi], dy = Y[ni] - Y[pi];
      const len = Math.hypot(dx, dy) || 1;
      NX[i] = -dy / len; NY[i] = dx / len;
    }
  }
  /* Ribbon over a..b using normals from computeNormals(), so adjacent chunks
   * share identical edge vertices and join without seams. */
  function ribbonPre(ctx, a, b, capA, capB) {
    ctx.moveTo(X[a] + NX[a] * W[a], Y[a] + NY[a] * W[a]);
    for (let i = a + 1; i <= b; i++) ctx.lineTo(X[i] + NX[i] * W[i], Y[i] + NY[i] * W[i]);
    if (capB) { const phi = Math.atan2(NY[b], NX[b]); ctx.arc(X[b], Y[b], W[b], phi, phi - Math.PI, true); }
    else ctx.lineTo(X[b] - NX[b] * W[b], Y[b] - NY[b] * W[b]);
    for (let i = b - 1; i >= a; i--) ctx.lineTo(X[i] - NX[i] * W[i], Y[i] - NY[i] * W[i]);
    if (capA) { const phi = Math.atan2(NY[a], NX[a]); ctx.arc(X[a], Y[a], W[a], phi + Math.PI, phi, true); }
    ctx.closePath();
  }

  function hexToHsl(hex) {
    const v = parseInt(hex.slice(1), 16);
    const r = (v >> 16 & 255) / 255, g = (v >> 8 & 255) / 255, b = (v & 255) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    let h = 0, s = 0;
    if (mx !== mn) {
      const d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h *= 60;
    }
    return [h, s * 100, l * 100];
  }

  // Soft round sprite per color (smoke puffs); drawImage is far cheaper than
  // building a radial gradient per puff.
  const spriteCache = new Map();
  function sprite(color) {
    let c = spriteCache.get(color);
    if (c) return c;
    c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d'), grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, color + 'cc'); grad.addColorStop(0.35, color + '88'); grad.addColorStop(0.7, color + '2a'); grad.addColorStop(1, color + '00');
    g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
    if (spriteCache.size > 64) spriteCache.clear();
    spriteCache.set(color, c);
    return c;
  }

  const frac = (v) => v - Math.floor(v);

  // 2. Flow — smooth wiggle + a colour gradient that travels along the stroke.
  const FLOW_STEPS = 16;
  BRUSHES.flow = {
    label: 'Flow',
    defaults: { color: '#2b6cff', size: 12, opacity: 0.95, speed: 0.6, amp: 4, freq: 1 },
    palette(st) {
      if (st._palKey === st.color) return st._pal;
      const [h, s, l] = hexToHsl(st.color), pal = [];
      for (let i = 0; i < FLOW_STEPS; i++) {
        const m = i / (FLOW_STEPS - 1);
        pal.push(`hsl(${(h + m * 70).toFixed(1)},${Math.min(100, s + m * 10).toFixed(1)}%,${Math.min(88, l + m * 22).toFixed(1)}%)`);
      }
      st._pal = pal; st._palKey = st.color;
      return pal;
    },
    render(ctx, st, f) {
      const wig = cyclesPerLoop(st.speed, f.L, 0.25), drift = Math.max(1, cyclesPerLoop(st.speed, f.L, 0.5));
      const n = displace(st, TAU * f.u * wig, st.amp, st.freq * 0.006, 0.8);
      if (!n) return;
      const pal = this.palette(st), s = st._s;
      const ph = TAU * f.u * (st.speed > 0 ? drift : 0), k = st.freq * 0.012;
      const ci = (i) => Math.round((0.5 + 0.5 * Math.sin(s[i] * k - ph)) * (FLOW_STEPS - 1));
      const col = (i) => pal[ci(i)];
      ctx.globalAlpha = st.opacity;
      if (n < 3) { ctx.beginPath(); ribbon(ctx, 0, n - 1, true, true); ctx.fillStyle = col(0); ctx.fill(); return; }
      computeNormals(n);
      // Split into runs of equal palette index, then one fill per colour.
      // Runs overlap by one point so antialiased edges don't leave seams.
      let runs = 0, cur = -1;
      for (let i = 0; i < n - 1 && runs < runA.length; i++) {
        const c = ci(i);
        if (c !== cur) { if (runs) runB[runs - 1] = i; runA[runs] = i; runC[runs] = c; runs++; cur = c; }
      }
      runB[runs - 1] = n - 1;
      for (let c = 0; c < FLOW_STEPS; c++) {
        let any = false;
        for (let r = 0; r < runs; r++) {
          if (runC[r] !== c) continue;
          if (!any) { ctx.beginPath(); any = true; }
          const a = runA[r], b = Math.min(n - 1, runB[r] + 1);
          ribbonPre(ctx, a, b, a === 0, b === n - 1);
        }
        if (any) { ctx.fillStyle = pal[c]; ctx.fill(); }
      }
    },
  };
  const runA = new Int32Array(4096), runB = new Int32Array(4096), runC = new Int32Array(4096);

  /* Indices of points at roughly every `spacing` px of arc length. */
  const samples = new Int32Array(8192);
  function sampleStroke(st, n, spacing) {
    const s = st._s; let m = 0, next = 0;
    for (let i = 0; i < n && m < samples.length; i++) {
      if (s[i] >= next) { samples[m++] = i; next = s[i] + spacing; }
    }
    return m;
  }

  // 3. Particle — dots burst outward from the stroke and drift back home.
  BRUSHES.particle = {
    label: 'Particle',
    defaults: { color: '#e8452c', size: 5, opacity: 0.9, speed: 0.5, amp: 14, freq: 1.5 },
    render(ctx, st, f) {
      const cyc = cyclesPerLoop(st.speed, f.L, 0.5);
      const n = displace(st, TAU * f.u * cyc, st.amp * 0.08, 0.02, 1);
      if (!n) return;
      ctx.fillStyle = st.color;
      // faint spine so the stroke still reads as a line
      for (let i = 0; i < n; i++) W[i] *= 0.3;
      ctx.globalAlpha = st.opacity * 0.4;
      ctx.beginPath(); ribbonSplit(ctx, 0, n - 1, true, true); ctx.fill();
      for (let i = 0; i < n; i++) W[i] /= 0.3;

      const m = sampleStroke(st, n, Math.max(3, st.size * 1.1));
      const per = Math.max(1, Math.round(st.freq * 1.2));
      const sd = st.seed | 0;
      ctx.globalAlpha = st.opacity;
      ctx.beginPath();
      let arcs = false;
      for (let q = 0; q < m; q++) {
        const i = samples[q];
        for (let j = 0; j < per; j++) {
          const h1 = hash3(sd, i, j), h2 = hash3(sd + 1, i, j), h3 = hash3(sd + 2, i, j);
          const ph = cyc ? f.u * cyc + h3 : h3;
          const out = 0.5 - 0.5 * Math.cos(TAU * ph);          // 0 → 1 → 0 each cycle
          const ang = h1 * TAU + 0.6 * Math.sin(TAU * ph + h2 * 9);
          const d = st.amp * 2 * (0.25 + 0.75 * h2) * out;
          const r = Math.max(0.5, W[i] * 0.75 * (1 - 0.5 * out));
          const x = X[i] + Math.cos(ang) * d, y = Y[i] + Math.sin(ang) * d;
          // Individual fillRects are much cheaper than path arcs for tiny dots.
          if (r < 2) ctx.fillRect(x - r, y - r, r * 2, r * 2);
          else { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, TAU); arcs = true; }
        }
      }
      if (arcs) ctx.fill();
    },
  };

  // 4. Smoke — grainy charcoal core with soft puffs rising and fading.
  BRUSHES.smoke = {
    label: 'Smoke',
    defaults: { color: '#3b3a45', size: 16, opacity: 0.55, speed: 0.4, amp: 10, freq: 1 },
    render(ctx, st, f) {
      const cyc = cyclesPerLoop(st.speed, f.L, 0.5);
      const slow = cyclesPerLoop(st.speed, f.L, 0.15);
      const n = displace(st, TAU * f.u * slow, st.size * 0.12, 0.03, 0.7);
      if (!n) return;
      const sd = st.seed | 0;
      ctx.fillStyle = st.color;
      // charcoal core: a thin body filled with a cached grain texture
      for (let i = 0; i < n; i++) W[i] *= 0.6;
      ctx.globalAlpha = Math.min(1, st.opacity * 1.4);
      ctx.fillStyle = grainPattern(ctx, st.color);
      ctx.beginPath(); ribbonSplit(ctx, 0, n - 1, true, true); ctx.fill();
      for (let i = 0; i < n; i++) W[i] /= 0.6;
      // rising puffs: few, large and very soft; drawn into the half-res haze
      // buffer (flushed by the renderer after a run of smoke strokes)
      const spr = sprite(st.color);
      const hz = haze.begin(ctx);
      const m = sampleStroke(st, n, Math.max(6, st.size * 0.8));
      const per = Math.max(1, Math.round(st.freq));
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (let q = 0; q < m; q++) {
        const i = samples[q];
        for (let j = 0; j < per; j++) {
          const h1 = hash3(sd, i, j), h2 = hash3(sd + 3, i, j), h3 = hash3(sd + 5, i, j);
          const life = cyc ? frac(f.u * cyc + h3) : h3;
          const a = st.opacity * 0.5 * Math.sin(Math.PI * life);
          if (a < 0.004) continue;
          const rad = (st.size * (0.8 + life * 2.2) * (0.7 + h2 * 0.6) * pressureScale(st.points[i].p) + 4) * 0.75;
          const x = X[i] + (h1 - 0.5) * st.size * 0.6 + Math.sin(TAU * (life * 0.7 + h1)) * st.amp * 0.5 * life;
          const y = Y[i] - life * st.amp * 4;
          hz.globalAlpha = a;
          hz.drawImage(spr, x - rad, y - rad, rad * 2, rad * 2);
          if (x - rad < bx0) bx0 = x - rad; if (x + rad > bx1) bx1 = x + rad;
          if (y - rad < by0) by0 = y - rad; if (y + rad > by1) by1 = y + rad;
        }
      }
      if (bx1 >= bx0) haze.mark(bx0, by0, bx1, by1);
    },
  };

  /* Half-resolution offscreen buffer for soft, blurry content. begin() hands
   * out its context (transform matched to the target); flush() composites it
   * onto the target and clears it. */
  const haze = {
    canvas: null, g: null, used: false, scale: 0.5, m: null,
    x0: 0, y0: 0, x1: 0, y1: 0, // dirty rect in artboard units
    begin(ctx) {
      if (this.used) return this.g;
      const tc = ctx.canvas, w = Math.ceil(tc.width * this.scale), h = Math.ceil(tc.height * this.scale);
      if (!this.canvas) { this.canvas = document.createElement('canvas'); this.g = this.canvas.getContext('2d'); }
      if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
      const m = this.m = ctx.getTransform(); // assumes scale + translate only
      this.g.setTransform(m.a * this.scale, 0, 0, m.d * this.scale, m.e * this.scale, m.f * this.scale);
      this.x0 = this.y0 = Infinity; this.x1 = this.y1 = -Infinity;
      this.used = true;
      return this.g;
    },
    mark(x0, y0, x1, y1) {
      if (x0 < this.x0) this.x0 = x0; if (y0 < this.y0) this.y0 = y0;
      if (x1 > this.x1) this.x1 = x1; if (y1 > this.y1) this.y1 = y1;
    },
    flush(ctx) {
      if (!this.used) return;
      this.used = false;
      if (this.x1 < this.x0) return;
      const m = this.m, k = this.scale, cw = this.canvas.width, ch = this.canvas.height;
      // dirty rect → buffer pixels (integer, clamped, 1px margin)
      const bx0 = Math.max(0, Math.floor((this.x0 * m.a + m.e) * k) - 1), by0 = Math.max(0, Math.floor((this.y0 * m.d + m.f) * k) - 1);
      const bx1 = Math.min(cw, Math.ceil((this.x1 * m.a + m.e) * k) + 1), by1 = Math.min(ch, Math.ceil((this.y1 * m.d + m.f) * k) + 1);
      if (bx1 > bx0 && by1 > by0) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(this.canvas, bx0, by0, bx1 - bx0, by1 - by0, bx0 / k, by0 / k, (bx1 - bx0) / k, (by1 - by0) / k);
        ctx.restore();
        const g = this.g;
        g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(bx0, by0, bx1 - bx0, by1 - by0); g.restore();
      }
    },
  };

  // Speckled charcoal texture per colour, used as a fill pattern.
  const grainCache = new Map();
  function grainPattern(ctx, color) {
    let pat = grainCache.get(color);
    if (pat) return pat;
    const c = document.createElement('canvas'); c.width = c.height = 96;
    const g = c.getContext('2d'), rnd = DMNoise.mulberry32(99);
    g.fillStyle = color;
    for (let i = 0; i < 2600; i++) {
      g.globalAlpha = 0.25 + rnd() * 0.75;
      const sz = 0.7 + rnd() * 1.8;
      g.fillRect(rnd() * 96, rnd() * 96, sz, sz * (0.6 + rnd()));
    }
    pat = ctx.createPattern(c, 'repeat');
    if (grainCache.size > 64) grainCache.clear();
    grainCache.set(color, pat);
    return pat;
  }

  // 5. Pulse — line width breathes in and out, as a wave travelling along it.
  BRUSHES.pulse = {
    label: 'Pulse',
    defaults: { color: '#7a3cf0', size: 12, opacity: 1, speed: 0.75, amp: 12, freq: 1 },
    render(ctx, st, f) {
      const cyc = cyclesPerLoop(st.speed, f.L, 1), wig = cyclesPerLoop(st.speed, f.L, 0.25);
      const n = displace(st, TAU * f.u * wig, 1.2, 0.01, 0.7);
      if (!n) return;
      const s = st._s, depth = st.amp / 15, ph = TAU * f.u * cyc, k = st.freq * 0.02;
      for (let i = 0; i < n; i++) W[i] *= Math.max(0.06, 1 + depth * Math.sin(ph - s[i] * k));
      ctx.globalAlpha = st.opacity;
      fillStroke(ctx, st, n);
    },
  };

  global.DMBrushes = {
    BRUSHES, haze, noise, hash3, prep, displace, ribbon, ribbonSplit, fillStroke,
    cyclesPerLoop, pressureScale, TAU,
    buf: () => ({ X, Y, W }),
  };
})(window);
