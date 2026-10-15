/* Drawimate — application: state, input, render loop, UI. */
(function () {
  'use strict';
  const { BRUSHES } = DMBrushes;
  const $ = (id) => document.getElementById(id);

  /* ------------------------------------------------------------------ state */
  let uid = 1;
  const nextId = () => uid++;

  function makeLayer(name, type) {
    return { id: nextId(), name, type: type || 'draw', visible: true, strokes: [], image: null, imageSrc: null };
  }

  const state = {
    width: 1280, height: 720,
    background: '#f3eee4',
    loop: 4,                 // seconds; every animation repeats exactly this often
    playing: true,
    time: 0,                 // animation clock in seconds
    tool: 'scribble',
    eraserSize: 20,
    layers: [],
    activeLayerId: 0,
    brushSettings: {},       // per-brush settings, edited in the right panel
  };
  for (const k in BRUSHES) state.brushSettings[k] = Object.assign({}, BRUSHES[k].defaults);
  state.layers.push(makeLayer('Layer 1'));
  state.activeLayerId = state.layers[0].id;

  const activeLayer = () => state.layers.find((l) => l.id === state.activeLayerId);
  const strokeCount = () => state.layers.reduce((n, l) => n + l.strokes.length, 0);

  /* ----------------------------------------------------------------- canvas */
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');
  const stage = $('stage');
  let viewScale = 1, dpr = 1;
  let quality = 1; // adaptive resolution factor (drops on slow devices)

  function layoutCanvas() {
    const pad = 28;
    const r = stage.getBoundingClientRect();
    viewScale = Math.min((r.width - pad * 2) / state.width, (r.height - pad * 2) / state.height);
    viewScale = Math.max(0.05, viewScale);
    dpr = Math.min(window.devicePixelRatio || 1, 2) * quality;
    const cssW = Math.round(state.width * viewScale), cssH = Math.round(state.height * viewScale);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    dirty = true;
  }
  new ResizeObserver(layoutCanvas).observe(stage);

  /* --------------------------------------------------------------- rendering */
  function drawImageLayer(c, layer, w, h) {
    const img = layer.image;
    if (!img || !img.complete || !img.naturalWidth) return;
    const s = Math.min(w / img.naturalWidth, h / img.naturalHeight);
    const iw = img.naturalWidth * s, ih = img.naturalHeight * s;
    c.globalAlpha = 1;
    c.drawImage(img, (w - iw) / 2, (h - ih) / 2, iw, ih);
  }

  /* Render the whole scene at time t (seconds) into context c whose transform
   * maps artboard units → pixels. Shared by the live view and exporters. */
  function renderScene(c, t) {
    const L = state.loop;
    const f = { L, u: (((t % L) + L) % L) / L, t };
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = state.background;
    c.fillRect(0, 0, state.width, state.height);
    for (const layer of state.layers) {
      if (!layer.visible) continue;
      if (layer.type === 'image') { drawImageLayer(c, layer, state.width, state.height); continue; }
      for (const st of layer.strokes) {
        const b = BRUSHES[st.brush];
        if (!b || !st.points.length) continue;
        if (st.brush !== 'smoke') DMBrushes.haze.flush(c); // keep stacking order
        b.render(c, st, f);
      }
      DMBrushes.haze.flush(c);
    }
    c.globalAlpha = 1;
  }

  let dirty = true;
  let lastFrame = performance.now();
  let fpsFrames = 0, fpsTime = 0, fps = 0;
  let suspendLive = false; // set while exporting

  function frame(now) {
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    if (state.playing) { state.time += dt; dirty = true; }
    if (dirty && !suspendLive) {
      const s = viewScale * dpr;
      ctx.setTransform(s, 0, 0, s, 0, 0);
      renderScene(ctx, state.time);
      dirty = false;
    }
    fpsFrames++; fpsTime += dt;
    if (fpsTime >= 0.5) {
      fps = fpsFrames / fpsTime; fpsFrames = 0; fpsTime = 0;
      $('statFps').textContent = Math.round(fps) + ' fps';
      adaptQuality();
    }
    requestAnimationFrame(frame);
  }

  /* Adaptive resolution: if playback can't keep up, render the live view at a
   * lower pixel density (exports are unaffected); recover when there's headroom. */
  let slowTicks = 0, fastTicks = 0;
  function adaptQuality() {
    if (!state.playing || suspendLive || document.hidden) { slowTicks = fastTicks = 0; return; }
    if (fps < 50) { fastTicks = 0; if (++slowTicks >= 2 && quality > 0.5) { quality = Math.max(0.5, quality - 0.15); slowTicks = 0; layoutCanvas(); } }
    else if (fps > 58) { slowTicks = 0; if (++fastTicks >= 10 && quality < 1) { quality = Math.min(1, quality + 0.1); fastTicks = 0; layoutCanvas(); } }
    else slowTicks = fastTicks = 0;
  }

  /* ------------------------------------------------------------------ input */
  function toArtboard(e) {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / viewScale, y: (e.clientY - r.top) / viewScale };
  }
  function pressureOf(e) {
    // Mice (and pens/touch that report 0) get a neutral 0.5.
    if (e.pointerType === 'mouse' || !e.pressure) return 0.5;
    return e.pressure;
  }

  let drawing = null; // { stroke, pointerId, t0, last }

  function newStroke(brush) {
    const s = state.brushSettings[brush];
    return {
      id: nextId(), brush,
      color: s.color, size: s.size, opacity: s.opacity,
      speed: s.speed, amp: s.amp, freq: s.freq,
      seed: Math.floor(Math.random() * 1e6),
      points: [],
    };
  }

  function addPoint(pt, p, t, force) {
    const st = drawing.stroke, pts = st.points;
    const last = pts[pts.length - 1];
    if (last && !force) {
      const d = Math.hypot(pt.x - last.x, pt.y - last.y);
      if (d < 1.5) return; // keep data light; ~1.5 artboard px spacing
    }
    pts.push({ x: pt.x, y: pt.y, p, t });
    dirty = true;
  }

  function onPointerDown(e) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (drawing) return;
    canvas.setPointerCapture(e.pointerId);
    const pt = toArtboard(e);
    if (state.tool === 'eraser') { eraserStart(e, pt); return; }
    const layer = activeLayer();
    if (!layer || layer.type !== 'draw') { toast('Select a drawing layer first'); return; }
    if (!layer.visible) { toast('Layer is hidden'); return; }
    if (!BRUSHES[state.tool]) return;
    beforeChange();
    const stroke = newStroke(state.tool);
    layer.strokes.push(stroke);
    drawing = { stroke, pointerId: e.pointerId, t0: e.timeStamp };
    addPoint(pt, pressureOf(e), 0, true);
    updateStatus();
  }

  function onPointerMove(e) {
    moveCursor(e);
    if (erasing && e.pointerId === erasing.pointerId) { eraserMove(e); return; }
    if (!drawing || e.pointerId !== drawing.pointerId) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of (evs.length ? evs : [e])) {
      addPoint(toArtboard(ev), pressureOf(ev), Math.round(ev.timeStamp - drawing.t0));
    }
  }

  function onPointerUp(e) {
    if (erasing && e.pointerId === erasing.pointerId) { eraserEnd(); return; }
    if (!drawing || e.pointerId !== drawing.pointerId) return;
    drawing = null;
    dirty = true;
    updateStatus(); renderLayers();
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('pointerleave', () => { $('cursorRing').style.display = 'none'; });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  const ring = $('cursorRing');
  function moveCursor(e) {
    const sr = stage.getBoundingClientRect();
    const size = state.tool === 'eraser' ? state.eraserSize * 2
      : (state.brushSettings[state.tool] ? state.brushSettings[state.tool].size : 8);
    const d = Math.max(6, size * viewScale);
    ring.style.display = 'block';
    ring.style.width = ring.style.height = d + 'px';
    ring.style.left = (e.clientX - sr.left) + 'px';
    ring.style.top = (e.clientY - sr.top) + 'px';
  }

  /* ---------------------------------------------------------------- eraser */
  let erasing = null;
  function eraserStart() {}
  function eraserMove() {}
  function eraserEnd() {}

  /* ---------------------------------------------------------------- history */
  function beforeChange() {}

  /* -------------------------------------------------------------- brush UI */
  const ctl = {
    color: $('ctlColor'), size: $('ctlSize'), opacity: $('ctlOpacity'),
    speed: $('ctlSpeed'), amp: $('ctlAmp'), freq: $('ctlFreq'),
  };
  const fmt = { size: (v) => v, opacity: (v) => Math.round(v * 100) + '%', speed: (v) => (+v).toFixed(2), amp: (v) => (+v).toFixed(1), freq: (v) => (+v).toFixed(2) };

  function showOutput(input, text) {
    const out = input.parentElement.querySelector('output');
    if (out) out.textContent = text;
  }

  function syncBrushPanel() {
    const isEraser = state.tool === 'eraser';
    $('brushControls').hidden = isEraser;
    $('eraserControls').hidden = !isEraser;
    $('brushTitle').textContent = isEraser ? 'Eraser' : BRUSHES[state.tool].label;
    if (isEraser) {
      $('ctlEraser').value = state.eraserSize; showOutput($('ctlEraser'), state.eraserSize);
      return;
    }
    const s = state.brushSettings[state.tool];
    for (const k in ctl) {
      ctl[k].value = s[k];
      if (fmt[k]) showOutput(ctl[k], fmt[k](s[k]));
    }
  }

  for (const k in ctl) {
    ctl[k].addEventListener('input', () => {
      const s = state.brushSettings[state.tool];
      if (!s) return;
      s[k] = k === 'color' ? ctl[k].value : parseFloat(ctl[k].value);
      if (fmt[k]) showOutput(ctl[k], fmt[k](s[k]));
    });
  }
  $('ctlEraser').addEventListener('input', (e) => {
    state.eraserSize = +e.target.value; showOutput(e.target, state.eraserSize);
  });

  function setTool(tool) {
    if (tool !== 'eraser' && !BRUSHES[tool]) return;
    state.tool = tool;
    document.querySelectorAll('#brushTools .tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
    syncBrushPanel();
  }
  document.querySelectorAll('#brushTools .tool').forEach((b) => {
    if (b.dataset.tool !== 'eraser' && !BRUSHES[b.dataset.tool]) b.disabled = true;
    b.addEventListener('click', () => setTool(b.dataset.tool));
  });

  /* ---------------------------------------------------------------- layers */
  function renderLayers() {}

  /* ------------------------------------------------------------- transport */
  function setPlaying(p) {
    state.playing = p;
    $('btnPlay').classList.toggle('paused', !p);
    $('btnPlay').querySelector('span').textContent = p ? 'Pause' : 'Play';
    dirty = true;
  }
  $('btnPlay').addEventListener('click', () => setPlaying(!state.playing));

  /* ------------------------------------------------------------ canvas card */
  $('ctlBg').value = state.background;
  $('ctlBg').addEventListener('input', (e) => { state.background = e.target.value; dirty = true; });
  function syncLoop() { $('ctlLoop').value = state.loop; showOutput($('ctlLoop'), state.loop + 's'); }
  $('ctlLoop').addEventListener('input', (e) => { state.loop = +e.target.value; syncLoop(); dirty = true; });
  syncLoop();
  function syncCanvasSize() { $('ctlCanvasSize').value = state.width + 'x' + state.height; }
  $('ctlCanvasSize').addEventListener('change', (e) => {
    const [w, h] = e.target.value.split('x').map(Number);
    state.width = w; state.height = h; layoutCanvas();
  });
  syncCanvasSize();

  /* ---------------------------------------------------------------- misc UI */
  let toastTimer = 0;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg; el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
  }
  function updateStatus() {
    const n = strokeCount();
    $('statStrokes').textContent = n + (n === 1 ? ' stroke' : ' strokes');
  }

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'color') return;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod && e.key >= '1' && e.key <= '5') { setTool(['scribble', 'flow', 'particle', 'smoke', 'pulse'][+e.key - 1]); }
    else if (!mod && (e.key === 'e' || e.key === 'E')) setTool('eraser');
    else if (!mod && e.code === 'Space') { e.preventDefault(); setPlaying(!state.playing); }
  });

  /* ------------------------------------------------------------------- boot */
  setTool('scribble');
  setPlaying(true);
  renderLayers();
  updateStatus();
  layoutCanvas();
  requestAnimationFrame(frame);

  // Exposed for debugging and automated tests.
  window.Drawimate = { state, renderScene, setTool, setPlaying, get fps() { return fps; }, get quality() { return quality; } };
})();
