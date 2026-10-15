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
    const pad = Math.min(28, Math.max(8, stage.clientWidth * 0.04));
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
    try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* pointer already gone */ }
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
  // Removes whole strokes on the active layer that come within reach.
  let erasing = null;

  function strokeBounds(st) {
    if (st._bbN === st.points.length) return st._bb;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of st.points) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
    st._bb = [x0, y0, x1, y1]; st._bbN = st.points.length;
    return st._bb;
  }
  function segDist2(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = ax + t * dx - px, ey = ay + t * dy - py;
    return ex * ex + ey * ey;
  }
  function hitStroke(st, x, y, r) {
    const reach = r + st.size * 0.6 + st.amp * 0.5;
    const bb = strokeBounds(st);
    if (x < bb[0] - reach || x > bb[2] + reach || y < bb[1] - reach || y > bb[3] + reach) return false;
    const pts = st.points, r2 = reach * reach;
    if (pts.length === 1) return (pts[0].x - x) ** 2 + (pts[0].y - y) ** 2 <= r2;
    for (let i = 1; i < pts.length; i++) {
      if (segDist2(x, y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= r2) return true;
    }
    return false;
  }
  function eraseAt(pt) {
    const layer = activeLayer();
    const before = layer.strokes.length;
    layer.strokes = layer.strokes.filter((st) => !hitStroke(st, pt.x, pt.y, state.eraserSize));
    if (layer.strokes.length !== before) { erasing.removed += before - layer.strokes.length; dirty = true; updateStatus(); }
  }
  function eraserStart(e, pt) {
    const layer = activeLayer();
    if (!layer || layer.type !== 'draw') { toast('Select a drawing layer to erase'); return; }
    erasing = { pointerId: e.pointerId, snap: snapshot(), removed: 0, last: pt };
    eraseAt(pt);
  }
  function eraserMove(e) {
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of (evs.length ? evs : [e])) {
      const pt = toArtboard(ev), last = erasing.last;
      // sample the drag segment so fast swipes don't skip thin strokes
      const steps = Math.max(1, Math.ceil(Math.hypot(pt.x - last.x, pt.y - last.y) / (state.eraserSize * 0.5)));
      for (let k = 1; k <= steps; k++) eraseAt({ x: last.x + (pt.x - last.x) * k / steps, y: last.y + (pt.y - last.y) * k / steps });
      erasing.last = pt;
    }
  }
  function eraserEnd() {
    if (erasing.removed) { pushUndo(erasing.snap); renderLayers(); }
    erasing = null;
  }

  /* ---------------------------------------------------------------- history */
  // Strokes are immutable once finished, so a snapshot only needs to copy
  // the layer list and each layer's stroke array (not the points).
  const undoStack = [], redoStack = [];
  const HISTORY_LIMIT = 300;

  function snapshot() {
    return {
      layers: state.layers.map((l) => Object.assign({}, l, { strokes: l.strokes.slice() })),
      activeLayerId: state.activeLayerId,
    };
  }
  function restore(snap) {
    state.layers = snap.layers.map((l) => Object.assign({}, l, { strokes: l.strokes.slice() }));
    state.activeLayerId = snap.activeLayerId;
    if (!activeLayer()) state.activeLayerId = state.layers[state.layers.length - 1].id;
    dirty = true;
    renderLayers(); updateStatus();
  }
  function pushUndo(snap) {
    undoStack.push(snap);
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack.length = 0;
    syncHistoryButtons();
  }
  function beforeChange() { pushUndo(snapshot()); }
  function undo() {
    if (drawing || erasing || !undoStack.length) return;
    redoStack.push(snapshot()); restore(undoStack.pop()); syncHistoryButtons();
  }
  function redo() {
    if (drawing || erasing || !redoStack.length) return;
    undoStack.push(snapshot()); restore(redoStack.pop()); syncHistoryButtons();
  }
  function resetHistory() { undoStack.length = 0; redoStack.length = 0; syncHistoryButtons(); }
  function syncHistoryButtons() {
    $('btnUndo').disabled = !undoStack.length;
    $('btnRedo').disabled = !redoStack.length;
  }
  $('btnUndo').addEventListener('click', undo);
  $('btnRedo').addEventListener('click', redo);

  $('btnClear').addEventListener('click', () => {
    const layer = activeLayer();
    if (!layer || layer.type !== 'draw') { toast('Select a drawing layer to clear'); return; }
    if (!layer.strokes.length) return;
    beforeChange();
    layer.strokes = [];
    dirty = true; renderLayers(); updateStatus();
    toast('Layer cleared — Ctrl+Z to undo');
  });

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
  const layerList = $('layerList');

  function renderLayers() {
    layerList.textContent = '';
    // Top of the list = top of the stack.
    for (let i = state.layers.length - 1; i >= 0; i--) {
      const l = state.layers[i];
      const li = document.createElement('li');
      li.className = 'layer' + (l.visible ? '' : ' hidden-layer');
      li.dataset.id = l.id;
      const eye = document.createElement('button');
      eye.className = 'eye'; eye.title = l.visible ? 'Hide layer' : 'Show layer';
      eye.textContent = l.visible ? '◉' : '○';
      eye.addEventListener('click', (e) => {
        e.stopPropagation();
        beforeChange();
        findLayer(l.id).visible = !l.visible;
        dirty = true; renderLayers();
      });
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = (l.type === 'image' ? '🖼 ' : '') + l.name;
      name.title = 'Double-click to rename';
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = l.type === 'image' ? 'image' : l.strokes.length;
      li.append(eye, name, count);
      li.addEventListener('click', () => { state.activeLayerId = l.id; syncActiveLayer(); });
      layerList.appendChild(li);
    }
    syncActiveLayer();
  }
  function syncActiveLayer() {
    for (const li of layerList.children) li.classList.toggle('active', +li.dataset.id === state.activeLayerId);
    const idx = state.layers.findIndex((l) => l.id === state.activeLayerId);
    $('btnLayerUp').disabled = idx >= state.layers.length - 1;
    $('btnLayerDown').disabled = idx <= 0;
    $('btnLayerDel').disabled = state.layers.length <= 1;
  }
  const findLayer = (id) => state.layers.find((l) => l.id === id);
  // Delegated: the first click of a double-click re-renders the rows.
  layerList.addEventListener('dblclick', (e) => {
    const li = e.target.closest('li');
    if (li && e.target.closest('.name')) startRename(li, +li.dataset.id);
  });

  function startRename(li, id) {
    const layer = findLayer(id);
    const input = document.createElement('input');
    input.value = layer.name; input.className = 'rename';
    const nameEl = li.querySelector('.name');
    nameEl.replaceWith(input);
    input.focus(); input.select();
    let done = false;
    const finish = (commit) => {
      if (done) return; done = true;
      const v = input.value.trim();
      if (commit && v && v !== layer.name) { beforeChange(); findLayer(id).name = v.slice(0, 40); }
      renderLayers();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); e.stopPropagation(); });
    input.addEventListener('blur', () => finish(true));
  }

  let layerCounter = 1;
  function addLayer() {
    beforeChange();
    const l = makeLayer('Layer ' + (++layerCounter));
    const idx = state.layers.findIndex((x) => x.id === state.activeLayerId);
    state.layers.splice(idx + 1, 0, l);
    state.activeLayerId = l.id;
    renderLayers();
  }
  function deleteLayer() {
    if (state.layers.length <= 1) return;
    beforeChange();
    const idx = state.layers.findIndex((x) => x.id === state.activeLayerId);
    state.layers.splice(idx, 1);
    const next = state.layers[Math.min(idx, state.layers.length - 1)];
    state.activeLayerId = next.id;
    dirty = true; renderLayers(); updateStatus();
  }
  function moveLayer(dir) {
    const idx = state.layers.findIndex((x) => x.id === state.activeLayerId), to = idx + dir;
    if (to < 0 || to >= state.layers.length) return;
    beforeChange();
    const [l] = state.layers.splice(idx, 1);
    state.layers.splice(to, 0, l);
    dirty = true; renderLayers();
  }
  $('btnLayerAdd').addEventListener('click', addLayer);
  $('btnLayerDel').addEventListener('click', deleteLayer);
  $('btnLayerUp').addEventListener('click', () => moveLayer(1));
  $('btnLayerDown').addEventListener('click', () => moveLayer(-1));

  /* ---------------------------------------------------------- image import */
  function importImageFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        beforeChange();
        const l = makeLayer(file.name.replace(/\.[^.]+$/, '').slice(0, 40) || 'Image', 'image');
        l.image = img; l.imageSrc = reader.result;
        state.layers.unshift(l); // background = bottom of the stack
        dirty = true; renderLayers();
        toast('Image added as background layer');
      };
      img.onerror = () => toast('Could not read that image');
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }
  $('btnImage').addEventListener('click', () => $('fileImage').click());
  $('fileImage').addEventListener('change', (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (f) importImageFile(f);
  });

  /* ------------------------------------------------------- save / load JSON */
  const r2 = (v) => Math.round(v * 100) / 100;
  function serialize() {
    return {
      app: 'drawimate', version: 1,
      width: state.width, height: state.height,
      background: state.background, loop: state.loop,
      brushSettings: state.brushSettings,
      activeLayer: state.layers.findIndex((l) => l.id === state.activeLayerId),
      layers: state.layers.map((l) => ({
        name: l.name, type: l.type, visible: l.visible,
        imageSrc: l.type === 'image' ? l.imageSrc : undefined,
        strokes: l.strokes.map((st) => ({
          brush: st.brush, color: st.color, size: st.size, opacity: st.opacity,
          speed: st.speed, amp: st.amp, freq: st.freq, seed: st.seed,
          // [x, y, pressure, ms since stroke start]
          points: st.points.map((p) => [r2(p.x), r2(p.y), Math.round(p.p * 1000) / 1000, p.t]),
        })),
      })),
    };
  }

  const isHex = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);
  const num = (v, d, lo, hi) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };

  function deserialize(data) {
    if (!data || data.app !== 'drawimate' || !Array.isArray(data.layers)) throw new Error('Not a Drawimate project');
    const layers = [];
    for (const L of data.layers) {
      const l = makeLayer(String(L.name || 'Layer').slice(0, 40), L.type === 'image' ? 'image' : 'draw');
      l.visible = L.visible !== false;
      if (l.type === 'image') {
        if (typeof L.imageSrc !== 'string' || !L.imageSrc.startsWith('data:image/')) continue;
        l.imageSrc = L.imageSrc;
        l.image = new Image();
        l.image.onload = () => { dirty = true; };
        l.image.src = L.imageSrc;
      } else {
        for (const S of (L.strokes || [])) {
          if (!BRUSHES[S.brush] || !Array.isArray(S.points) || !S.points.length) continue;
          const d = BRUSHES[S.brush].defaults;
          l.strokes.push({
            id: nextId(), brush: S.brush,
            color: isHex(S.color) ? S.color : d.color,
            size: num(S.size, d.size, 0.5, 200), opacity: num(S.opacity, d.opacity, 0, 1),
            speed: num(S.speed, d.speed, 0, 10), amp: num(S.amp, d.amp, 0, 200), freq: num(S.freq, d.freq, 0, 20),
            seed: num(S.seed, 1, 0, 1e9) | 0,
            points: S.points.map((p) => ({ x: +p[0] || 0, y: +p[1] || 0, p: num(p[2], 0.5, 0, 1), t: +p[3] || 0 })),
          });
        }
      }
      layers.push(l);
    }
    if (!layers.length) layers.push(makeLayer('Layer 1'));
    state.layers = layers;
    const ai = num(data.activeLayer, layers.length - 1, 0, layers.length - 1) | 0;
    state.activeLayerId = layers[ai].id;
    state.width = num(data.width, 1280, 64, 4096) | 0;
    state.height = num(data.height, 720, 64, 4096) | 0;
    if (isHex(data.background)) state.background = data.background;
    state.loop = num(data.loop, 4, 2, 10) | 0;
    if (data.brushSettings) {
      for (const k in BRUSHES) {
        const src = data.brushSettings[k], dst = state.brushSettings[k];
        if (!src) continue;
        if (isHex(src.color)) dst.color = src.color;
        for (const f of ['size', 'opacity', 'speed', 'amp', 'freq']) if (Number.isFinite(+src[f])) dst[f] = +src[f];
      }
    }
    layerCounter = layers.length;
    resetHistory();
    $('ctlBg').value = state.background;
    syncLoop(); syncCanvasSize(); syncBrushPanel();
    layoutCanvas(); renderLayers(); updateStatus();
  }

  /* Save a file. Inside a claude.ai artifact the frame blocks direct
   * downloads, so use the viewer's `downloads` capability when present. */
  const hostDownloads = window.claude && window.claude.use ? window.claude.use('downloads').catch(() => null) : Promise.resolve(null);
  async function download(blob, name, doneMsg) {
    const dl = await hostDownloads;
    if (dl) {
      try { await dl.save({ filename: name, data: blob }); if (doneMsg) toast(doneMsg); }
      catch (err) { toast(err && err.code === 'declined' ? 'Save cancelled' : 'Could not save: ' + ((err && err.message) || 'unavailable')); }
      return;
    }
    if (doneMsg) toast(doneMsg);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  function saveProject() {
    download(new Blob([JSON.stringify(serialize())], { type: 'application/json' }), 'drawimate-project.json', 'Project saved');
  }
  function loadProjectFile(file) {
    file.text().then((txt) => { deserialize(JSON.parse(txt)); toast('Project loaded'); })
      .catch((err) => toast('Could not load: ' + err.message));
  }
  $('btnSave').addEventListener('click', saveProject);
  $('btnLoad').addEventListener('click', () => $('fileProject').click());
  $('fileProject').addEventListener('change', (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (f) loadProjectFile(f);
  });

  // Drag & drop: images become background layers, .json files load.
  stage.addEventListener('dragover', (e) => e.preventDefault());
  stage.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (!f) return;
    if (f.type.startsWith('image/')) importImageFile(f);
    else if (f.name.endsWith('.json') || f.type === 'application/json') loadProjectFile(f);
  });

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

  /* ----------------------------------------------------------------- export */
  // Exports render offscreen at artboard resolution, at exact loop times
  // t = i / fps for i in [0, loop·fps), so frame N would equal frame 0 —
  // the clip loops seamlessly.
  let exporting = null;

  function exportCanvas() {
    const c = document.createElement('canvas');
    c.width = state.width; c.height = state.height;
    return c;
  }
  function startExport(label) {
    if (drawing || erasing) return null;
    exporting = { cancelled: false };
    suspendLive = true;
    $('modalText').textContent = label;
    $('modalBar').style.width = '0%';
    $('modal').hidden = false;
    $('btnWebm').disabled = $('btnZip').disabled = true;
    return exporting;
  }
  function endExport() {
    exporting = null;
    suspendLive = false; dirty = true;
    $('modal').hidden = true;
    $('btnWebm').disabled = $('btnZip').disabled = false;
  }
  const setProgress = (f, text) => {
    $('modalBar').style.width = (f * 100).toFixed(1) + '%';
    if (text) $('modalText').textContent = text;
  };
  $('modalCancel').addEventListener('click', () => { if (exporting) exporting.cancelled = true; });

  function pickVideoMime() {
    const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    return types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t));
  }

  async function exportWebm() {
    const mime = pickVideoMime();
    const c = exportCanvas();
    if (!mime || !c.captureStream) { toast('This browser cannot record WebM video'); return; }
    const job = startExport('Recording…');
    if (!job) return;
    const fps = +$('ctlFps').value, L = state.loop, total = Math.round(L * fps);
    const g = c.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);

    // captureStream(0): frames are only emitted when we call requestFrame(),
    // so every frame in the file is one we rendered at an exact loop time.
    const stream = c.captureStream(0);
    const track = stream.getVideoTracks()[0];
    const rec = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: Math.min(25e6, Math.max(2.5e6, state.width * state.height * fps * 0.12)),
    });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((res) => { rec.onstop = res; });
    rec.start(250);

    // Pace frames in real time so the recorded timestamps match playback speed.
    const t0 = performance.now();
    let sent = 0;
    await new Promise((resolve) => {
      const tick = () => {
        if (job.cancelled) return resolve();
        const due = Math.min(total, Math.floor((performance.now() - t0) / 1000 * fps) + 1);
        if (due > sent) {
          const i = due - 1;                      // render the latest due frame
          renderScene(g, i / fps);
          if (track.requestFrame) track.requestFrame();
          sent = due;
          setProgress(sent / total, `Recording ${(i / fps).toFixed(1)}s / ${L}s — keep this tab visible`);
        }
        if (sent >= total && performance.now() - t0 >= L * 1000) return resolve();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    rec.stop();
    await stopped;
    track.stop();
    const cancelled = job.cancelled;
    endExport();
    if (cancelled) { toast('Export cancelled'); return; }
    download(new Blob(chunks, { type: 'video/webm' }), `drawimate-loop-${L}s.webm`, 'WebM exported');
  }

  async function exportZip() {
    const job = startExport('Rendering frames…');
    if (!job) return;
    const fps = +$('ctlFps').value, L = state.loop, total = Math.round(L * fps);
    const c = exportCanvas(), g = c.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    const zip = new DMZip.ZipWriter();
    const digits = String(total - 1).length;
    try {
      for (let i = 0; i < total; i++) {
        if (job.cancelled) break;
        renderScene(g, i / fps);
        const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
        zip.add(`frame_${String(i).padStart(Math.max(4, digits), '0')}.png`, new Uint8Array(await blob.arrayBuffer()));
        setProgress((i + 1) / total, `Rendering frame ${i + 1} / ${total}`);
      }
    } catch (err) {
      endExport(); toast('Export failed: ' + err.message); return;
    }
    const cancelled = job.cancelled;
    endExport();
    if (cancelled) { toast('Export cancelled'); return; }
    download(zip.finish(), `drawimate-frames-${L}s-${fps}fps.zip`, `${total} PNG frames exported`);
  }
  $('btnWebm').addEventListener('click', exportWebm);
  $('btnZip').addEventListener('click', exportZip);

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
    if (exporting) return;
    if ((e.target.tagName === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'color') || e.target.tagName === 'SELECT') return;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod && e.key >= '1' && e.key <= '5') { setTool(['scribble', 'flow', 'particle', 'smoke', 'pulse'][+e.key - 1]); }
    else if (!mod && (e.key === 'e' || e.key === 'E')) setTool('eraser');
    else if (!mod && e.code === 'Space') { e.preventDefault(); setPlaying(!state.playing); }
    else if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); }
    else if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveProject(); }
    else if (mod && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); $('fileProject').click(); }
    else if (!mod && (e.key === '[' || e.key === ']')) {
      const d = e.key === ']' ? 1 : -1;
      if (state.tool === 'eraser') { state.eraserSize = Math.max(4, Math.min(80, state.eraserSize + d * 2)); }
      else { const s = state.brushSettings[state.tool]; s.size = Math.max(1, Math.min(80, s.size + d)); }
      syncBrushPanel();
    }
  });

  /* ------------------------------------------------------------------- boot */
  setTool('scribble');
  setPlaying(true);
  renderLayers();
  syncHistoryButtons();
  updateStatus();
  layoutCanvas();
  requestAnimationFrame(frame);

  // Exposed for debugging and automated tests.
  window.Drawimate = { state, renderScene, exportWebm, exportZip, setTool, setPlaying, undo, redo, serialize, deserialize, addLayer, deleteLayer, moveLayer, get fps() { return fps; }, get quality() { return quality; } };
})();
