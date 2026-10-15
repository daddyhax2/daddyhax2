/* Drawimate — application: state, input, render loop, UI. */
(function () {
  'use strict';
  const { BRUSHES, PCT_DEFAULTS, PCT_BRUSH, fromPercent } = DMBrushes;
  const BRUSH_ORDER = ['scribble', 'flow', 'particle', 'smoke', 'pulse'];
  const $ = (id) => document.getElementById(id);

  /* ------------------------------------------------------------------ state */
  let uid = 1;
  const nextId = () => uid++;

  function makeLayer(name, type) {
    return { id: nextId(), name, type: type || 'draw', visible: true, strokes: [], image: null, imageSrc: null };
  }
  function defaultPct(brush) {
    return Object.assign({}, PCT_DEFAULTS, { opacity: Math.round(PCT_BRUSH[brush].opacity * 100) });
  }

  const state = {
    width: 1320, height: 1320,
    background: '#ffffff',
    ink: '#000000',
    loop: 4,                 // seconds; every animation repeats exactly this often
    playing: true,
    time: 0,                 // animation clock in seconds
    tool: 'pencil',          // pencil | eraser | move
    brush: 'scribble',
    eraserPct: 20,
    layers: [],
    activeLayerId: 0,
    pct: {},                 // per-brush settings in percent: thickness, speed, wiggle, detail, opacity
  };
  for (const k of BRUSH_ORDER) state.pct[k] = defaultPct(k);
  state.layers.push(makeLayer('Layer 1'));
  state.activeLayerId = state.layers[0].id;

  const activeLayer = () => state.layers.find((l) => l.id === state.activeLayerId);
  const strokeCount = () => state.layers.reduce((n, l) => n + l.strokes.length, 0);
  const eraserRadius = () => 4 + state.eraserPct * 1.2;

  /* ----------------------------------------------------------------- canvas */
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');
  const stage = $('stage');
  let viewScale = 1, dpr = 1;
  let quality = 1; // adaptive resolution factor (drops on slow devices)

  function layoutCanvas() {
    const r = stage.getBoundingClientRect();
    const padX = Math.min(24, Math.max(0, r.width * 0.02)), padY = Math.min(24, Math.max(4, r.height * 0.02));
    viewScale = Math.max(0.05, Math.min((r.width - padX * 2) / state.width, (r.height - padY * 2) / state.height));
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
      const moved = moving && moving.layerId === layer.id;
      if (moved) { c.save(); c.translate(moving.dx, moving.dy); }
      if (layer.type === 'image') drawImageLayer(c, layer, state.width, state.height);
      else {
        for (const st of layer.strokes) {
          const b = BRUSHES[st.brush];
          if (!b || !st.points.length) continue;
          if (st.brush !== 'smoke') DMBrushes.haze.flush(c); // keep stacking order
          b.render(c, st, f);
        }
        DMBrushes.haze.flush(c);
      }
      if (moved) c.restore();
    }
    c.globalAlpha = 1;
  }

  /* Scribble strokes only change pose a few times per second. If every visible
   * stroke is a Scribble, this key changes only when some pose changes, so the
   * canvas can skip identical frames. Returns null when anything moves smoothly. */
  function sceneKey() {
    const L = state.loop, u = (((state.time % L) + L) % L) / L, rate = BRUSHES.scribble.boilRate;
    const poses = new Map();
    for (const layer of state.layers) {
      if (!layer.visible || layer.type !== 'draw') continue;
      for (const st of layer.strokes) {
        if (st.brush !== 'scribble') return null;
        if (!poses.has(st.speed)) poses.set(st.speed, DMBrushes.cyclesPerLoop(st.speed, L, rate));
      }
    }
    let key = '';
    for (const boils of poses.values()) key += boils + ':' + Math.floor(u * boils) + ',';
    return key;
  }
  let lastKey = null;

  let dirty = true;
  let lastFrame = performance.now();
  let fpsFrames = 0, fpsTime = 0, fps = 0;
  let suspendLive = false; // set while exporting

  function frame(now) {
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    if (state.playing) {
      state.time += dt;
      const key = sceneKey();
      if (key === null || key !== lastKey) dirty = true;
      lastKey = key;
    }
    if (dirty && !suspendLive) {
      const s = viewScale * dpr;
      ctx.setTransform(s, 0, 0, s, 0, 0);
      renderScene(ctx, state.time);
      dirty = false;
    }
    if (!$('sheetBrushes').hidden) renderPreviews();
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

  let drawing = null; // { stroke, pointerId, t0 }
  let moving = null;  // { layerId, pointerId, start, dx, dy }

  function newStroke(brush) {
    const p = state.pct[brush], m = fromPercent(brush, p);
    return {
      id: nextId(), brush,
      color: state.ink, size: m.size, opacity: p.opacity / 100,
      speed: m.speed, amp: m.amp, freq: m.freq,
      seed: Math.floor(Math.random() * 1e6),
      points: [],
    };
  }

  function addPoint(pt, p, t, force) {
    const pts = drawing.stroke.points;
    const last = pts[pts.length - 1];
    if (last && !force && Math.hypot(pt.x - last.x, pt.y - last.y) < 1.5) return; // ~1.5px spacing
    pts.push({ x: pt.x, y: pt.y, p, t });
    dirty = true;
  }

  function onPointerDown(e) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (drawing || erasing || moving) return;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* pointer already gone */ }
    const pt = toArtboard(e);
    if (state.tool === 'eraser') { eraserStart(e, pt); return; }
    const layer = activeLayer();
    if (state.tool === 'move') {
      if (!layer || layer.type !== 'draw' || !layer.strokes.length) { toast('Nothing to move on this layer'); return; }
      moving = { layerId: layer.id, pointerId: e.pointerId, start: pt, dx: 0, dy: 0 };
      return;
    }
    if (!layer || layer.type !== 'draw') { toast('Pick a drawing layer first'); return; }
    if (!layer.visible) { toast('This layer is hidden'); return; }
    beforeChange();
    const stroke = newStroke(state.brush);
    layer.strokes.push(stroke);
    drawing = { stroke, pointerId: e.pointerId, t0: e.timeStamp };
    addPoint(pt, pressureOf(e), 0, true);
    updateStatus();
  }

  function onPointerMove(e) {
    moveCursor(e);
    if (erasing && e.pointerId === erasing.pointerId) { eraserMove(e); return; }
    if (moving && e.pointerId === moving.pointerId) {
      const pt = toArtboard(e);
      moving.dx = pt.x - moving.start.x; moving.dy = pt.y - moving.start.y; dirty = true;
      return;
    }
    if (!drawing || e.pointerId !== drawing.pointerId) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of (evs.length ? evs : [e])) {
      addPoint(toArtboard(ev), pressureOf(ev), Math.round(ev.timeStamp - drawing.t0));
    }
  }

  function onPointerUp(e) {
    if (erasing && e.pointerId === erasing.pointerId) { eraserEnd(); return; }
    if (moving && e.pointerId === moving.pointerId) { moveEnd(); return; }
    if (!drawing || e.pointerId !== drawing.pointerId) return;
    drawing = null;
    dirty = true;
    updateStatus(); renderLayers();
  }

  // Strokes are immutable (history shares them), so a move makes translated copies.
  function moveEnd() {
    const { layerId, dx, dy } = moving;
    moving = null; dirty = true;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    beforeChange();
    const layer = findLayer(layerId);
    layer.strokes = layer.strokes.map((st) => Object.assign({}, st, {
      id: nextId(), _s: null, _n: 0, _bb: null, _bbN: -1,
      points: st.points.map((p) => ({ x: p.x + dx, y: p.y + dy, p: p.p, t: p.t })),
    }));
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('pointerleave', () => { ring.style.display = 'none'; });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  const ring = $('cursorRing');
  function moveCursor(e) {
    if (state.tool === 'move') { ring.style.display = 'none'; canvas.style.cursor = 'move'; return; }
    canvas.style.cursor = 'none';
    const sr = stage.getBoundingClientRect();
    const size = state.tool === 'eraser' ? eraserRadius() * 2 : fromPercent(state.brush, state.pct[state.brush]).size;
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
    layer.strokes = layer.strokes.filter((st) => !hitStroke(st, pt.x, pt.y, eraserRadius()));
    if (layer.strokes.length !== before) { erasing.removed += before - layer.strokes.length; dirty = true; updateStatus(); }
  }
  function eraserStart(e, pt) {
    const layer = activeLayer();
    if (!layer || layer.type !== 'draw') { toast('Pick a drawing layer to erase'); return; }
    erasing = { pointerId: e.pointerId, snap: snapshot(), removed: 0, last: pt };
    eraseAt(pt);
  }
  function eraserMove(e) {
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of (evs.length ? evs : [e])) {
      const pt = toArtboard(ev), last = erasing.last;
      // sample the drag segment so fast swipes don't skip thin strokes
      const steps = Math.max(1, Math.ceil(Math.hypot(pt.x - last.x, pt.y - last.y) / (eraserRadius() * 0.5)));
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
    if (drawing || erasing || moving || !undoStack.length) return;
    redoStack.push(snapshot()); restore(undoStack.pop()); syncHistoryButtons();
  }
  function redo() {
    if (drawing || erasing || moving || !redoStack.length) return;
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
    if (!layer || layer.type !== 'draw') { toast('Pick a drawing layer to clear'); return; }
    if (!layer.strokes.length) return;
    beforeChange();
    layer.strokes = [];
    dirty = true; renderLayers(); updateStatus();
    toast('Layer cleared. Undo brings it back');
  });

  /* ----------------------------------------------------------------- sheets */
  const SHEETS = ['sheetBrushes', 'sheetLayers', 'sheetShare'];
  function openSheet(id) {
    for (const s of SHEETS) $(s).hidden = s !== id;
    if (id === 'sheetLayers') renderLayers();
    if (id === 'sheetBrushes') syncBrushSheet();
    syncDock();
  }
  function closeSheets() { for (const s of SHEETS) $(s).hidden = true; syncDock(); }
  const sheetOpen = () => SHEETS.some((s) => !$(s).hidden);
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeSheets));

  /* ------------------------------------------------------------------ tools */
  function setTool(tool) {
    state.tool = tool;
    syncDock(); syncVSlider();
  }
  function setBrush(brush) {
    if (!BRUSHES[brush]) return;
    state.brush = brush;
    state.tool = 'pencil';
    syncDock(); syncVSlider(); syncBrushSheet();
  }
  function syncDock() {
    $('toolPencil').classList.toggle('active', state.tool === 'pencil');
    $('toolEraser').classList.toggle('active', state.tool === 'eraser');
    $('toolMove').classList.toggle('active', state.tool === 'move');
    $('toolLayers').classList.toggle('active', !$('sheetLayers').hidden);
    $('toolShare').classList.toggle('active', !$('sheetShare').hidden);
  }
  $('toolPencil').addEventListener('click', () => {
    if (state.tool === 'pencil') { $('sheetBrushes').hidden ? openSheet('sheetBrushes') : closeSheets(); }
    else { setTool('pencil'); toast(BRUSHES[state.brush].label + '. Tap again for brushes'); }
  });
  $('toolEraser').addEventListener('click', () => { setTool('eraser'); closeSheets(); });
  $('toolMove').addEventListener('click', () => { setTool('move'); closeSheets(); toast('Drag to move the current layer'); });
  $('toolLayers').addEventListener('click', () => ($('sheetLayers').hidden ? openSheet('sheetLayers') : closeSheets()));
  $('toolShare').addEventListener('click', () => ($('sheetShare').hidden ? openSheet('sheetShare') : closeSheets()));

  /* ------------------------------------------------- vertical wiggle slider */
  // Controls the brush's Wiggle (pencil/move) or the eraser size (eraser).
  const vs = $('vslider'), vsTrack = $('vsTrack');
  function vsValue() { return state.tool === 'eraser' ? state.eraserPct : state.pct[state.brush].wiggle; }
  function setVsValue(v) {
    v = Math.max(0, Math.min(100, Math.round(v)));
    if (state.tool === 'eraser') state.eraserPct = v;
    else state.pct[state.brush].wiggle = v;
    syncVSlider();
  }
  function syncVSlider() {
    const v = vsValue();
    $('vsVal').textContent = v + '%';
    $('vsFill').style.height = v + '%';
    $('vsHandle').style.bottom = v + '%';
    vs.setAttribute('aria-valuenow', v);
    vs.setAttribute('aria-label', state.tool === 'eraser' ? 'Eraser size' : 'Wiggle');
    vs.title = state.tool === 'eraser' ? 'Eraser size' : 'Wiggle: how far the line boils';
  }
  let vsDrag = null;
  function vsFromEvent(e) {
    const r = vsTrack.getBoundingClientRect();
    setVsValue((r.bottom - e.clientY) / r.height * 100);
  }
  vs.addEventListener('pointerdown', (e) => {
    vsDrag = e.pointerId;
    try { vs.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    vsFromEvent(e);
  });
  vs.addEventListener('pointermove', (e) => { if (vsDrag === e.pointerId) vsFromEvent(e); });
  vs.addEventListener('pointerup', () => { vsDrag = null; });
  vs.addEventListener('pointercancel', () => { vsDrag = null; });
  vs.addEventListener('keydown', (e) => {
    const step = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 }[e.key];
    if (step) { e.preventDefault(); e.stopPropagation(); setVsValue(vsValue() + step); }
  });

  /* ----------------------------------------------------------- brush sheet */
  const cardsEl = $('brushCards');
  const previews = {};
  for (const b of BRUSH_ORDER) {
    const btn = document.createElement('button');
    btn.className = 'card'; btn.dataset.brush = b;
    btn.setAttribute('aria-label', BRUSHES[b].label);
    const cv = document.createElement('canvas'); cv.width = cv.height = 320;
    const label = document.createElement('span'); label.textContent = BRUSHES[b].label;
    btn.append(cv, label);
    btn.addEventListener('click', () => setBrush(b));
    cardsEl.appendChild(btn);
    // a gentle wave drawn in "artboard" units, previewed at half scale
    const pts = [];
    for (let i = 0; i <= 120; i++) { const t = i / 120; pts.push({ x: 60 + 520 * t, y: 320 + Math.sin(t * Math.PI * 2) * 48, p: 0.5, t: i * 8 }); }
    previews[b] = { cv, g: cv.getContext('2d'), stroke: { brush: b, seed: 900 + BRUSH_ORDER.indexOf(b) * 77, points: pts } };
  }
  function renderPreviews() {
    const L = state.loop, u = (((state.time % L) + L) % L) / L;
    for (const b of BRUSH_ORDER) {
      const pv = previews[b], p = state.pct[b], m = fromPercent(b, p);
      Object.assign(pv.stroke, m, { color: state.ink, opacity: p.opacity / 100 });
      const g = pv.g;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, 320, 320);
      g.setTransform(0.5, 0, 0, 0.5, 0, 0);
      BRUSHES[b].render(g, pv.stroke, { L, u, t: state.time });
      DMBrushes.haze.flush(g);
    }
  }

  const sliders = { speed: 'Speed', thickness: 'Thickness', opacity: 'Opacity', detail: 'Detail' };
  const sliderEl = (k) => $('ctl' + sliders[k]);
  function paintRange(el) { el.style.setProperty('--p', ((el.value - el.min) / (el.max - el.min) * 100) + '%'); }
  function syncBrushSheet() {
    const p = state.pct[state.brush];
    for (const k in sliders) {
      const el = sliderEl(k);
      el.value = p[k]; paintRange(el);
      $('out' + sliders[k]).textContent = p[k] + '%';
    }
    cardsEl.querySelectorAll('.card').forEach((c) => c.classList.toggle('selected', c.dataset.brush === state.brush));
  }
  for (const k in sliders) {
    sliderEl(k).addEventListener('input', (e) => {
      state.pct[state.brush][k] = +e.target.value;
      paintRange(e.target);
      $('out' + sliders[k]).textContent = e.target.value + '%';
    });
  }
  $('btnResetBrush').addEventListener('click', () => {
    state.pct[state.brush] = defaultPct(state.brush);
    syncBrushSheet(); syncVSlider();
    toast(BRUSHES[state.brush].label + ' reset');
  });

  /* ---------------------------------------------------------------- layers */
  const layerList = $('layerList');
  const EYE_ON = '<svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24"><path d="M3 3l18 18"/><path d="M10.6 5.1A9.6 9.6 0 0112 5c6 0 10 7 10 7a17 17 0 01-3.2 3.9M6.6 6.6C3.8 8.4 2 12 2 12s4 7 10 7a9.4 9.4 0 004.6-1.2"/></svg>';

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
      eye.setAttribute('aria-label', eye.title);
      eye.innerHTML = l.visible ? EYE_ON : EYE_OFF;
      eye.addEventListener('click', (e) => {
        e.stopPropagation();
        beforeChange();
        findLayer(l.id).visible = !l.visible;
        dirty = true; renderLayers();
      });
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = (l.type === 'image' ? 'Image · ' : '') + l.name;
      name.title = 'Double-click to rename';
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = l.type === 'image' ? '' : l.strokes.length + (l.strokes.length === 1 ? ' stroke' : ' strokes');
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
    li.querySelector('.name').replaceWith(input);
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
    state.activeLayerId = state.layers[Math.min(idx, state.layers.length - 1)].id;
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
        toast('Image added as the background layer');
      };
      img.onerror = () => toast('That file could not be read as an image');
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
      app: 'drawimate', version: 2,
      width: state.width, height: state.height,
      background: state.background, ink: state.ink, loop: state.loop,
      brushPct: state.pct, eraserPct: state.eraserPct,
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
    if (!data || data.app !== 'drawimate' || !Array.isArray(data.layers)) throw new Error('this is not a Drawimate project');
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
            size: num(S.size, d.size, 0.3, 300), opacity: num(S.opacity, d.opacity, 0, 1),
            speed: num(S.speed, d.speed, 0, 10), amp: num(S.amp, d.amp, 0, 300), freq: num(S.freq, d.freq, 0, 20),
            seed: num(S.seed, 1, 0, 1e9) | 0,
            points: S.points.map((p) => ({ x: +p[0] || 0, y: +p[1] || 0, p: num(p[2], 0.5, 0, 1), t: +p[3] || 0 })),
          });
        }
      }
      layers.push(l);
    }
    if (!layers.length) layers.push(makeLayer('Layer 1'));
    state.layers = layers;
    state.activeLayerId = layers[num(data.activeLayer, layers.length - 1, 0, layers.length - 1) | 0].id;
    state.width = num(data.width, 1320, 64, 4096) | 0;
    state.height = num(data.height, 1320, 64, 4096) | 0;
    if (isHex(data.background)) state.background = data.background;
    if (isHex(data.ink)) state.ink = data.ink;
    state.loop = num(data.loop, 4, 2, 10) | 0;
    state.eraserPct = num(data.eraserPct, state.eraserPct, 0, 100) | 0;
    if (data.brushPct) {
      for (const k of BRUSH_ORDER) {
        const src = data.brushPct[k];
        if (!src) continue;
        for (const f of ['thickness', 'speed', 'wiggle', 'detail', 'opacity']) {
          if (Number.isFinite(+src[f])) state.pct[k][f] = num(src[f], state.pct[k][f], 0, 100) | 0;
        }
      }
    }
    layerCounter = layers.length;
    resetHistory();
    syncAll(); layoutCanvas(); renderLayers(); updateStatus();
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
    file.text().then((txt) => { deserialize(JSON.parse(txt)); closeSheets(); toast('Project opened'); })
      .catch((err) => toast('Could not open: ' + err.message));
  }
  $('btnSave').addEventListener('click', saveProject);
  $('btnLoad').addEventListener('click', () => $('fileProject').click());
  $('fileProject').addEventListener('change', (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (f) loadProjectFile(f);
  });

  // Drag & drop: images become background layers, .json files open.
  stage.addEventListener('dragover', (e) => e.preventDefault());
  stage.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (!f) return;
    if (f.type.startsWith('image/')) importImageFile(f);
    else if (f.name.endsWith('.json') || f.type === 'application/json') loadProjectFile(f);
  });

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
    if (drawing || erasing || moving) return null;
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
          setProgress(sent / total, `Recording ${(i / fps).toFixed(1)}s of ${L}s. Keep this tab visible`);
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
        setProgress((i + 1) / total, `Rendering frame ${i + 1} of ${total}`);
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

  /* ------------------------------------------------------------- transport */
  function setPlaying(p) {
    state.playing = p;
    $('btnPlay').classList.toggle('paused', !p);
    $('btnPlay').setAttribute('aria-label', p ? 'Pause animation' : 'Play animation');
    dirty = true;
  }
  $('btnPlay').addEventListener('click', () => setPlaying(!state.playing));

  /* ------------------------------------------------------ colours & canvas */
  function syncSwatches() {
    $('ctlInk').value = state.ink; $('ctlInk').nextElementSibling.style.setProperty('--c', state.ink);
    $('ctlBg').value = state.background; $('ctlBg').nextElementSibling.style.setProperty('--c', state.background);
  }
  $('ctlInk').addEventListener('input', (e) => { state.ink = e.target.value; syncSwatches(); });
  $('ctlBg').addEventListener('input', (e) => { state.background = e.target.value; syncSwatches(); dirty = true; });
  function syncLoop() { $('ctlLoop').value = state.loop; paintRange($('ctlLoop')); $('outLoop').textContent = state.loop + 's'; }
  $('ctlLoop').addEventListener('input', (e) => { state.loop = +e.target.value; syncLoop(); dirty = true; });
  function syncCanvasSize() {
    const v = state.width + 'x' + state.height, sel = $('ctlCanvasSize');
    if (![...sel.options].some((o) => o.value === v)) {
      const o = document.createElement('option'); o.value = v; o.textContent = state.width + ' × ' + state.height; sel.appendChild(o);
    }
    sel.value = v;
  }
  $('ctlCanvasSize').addEventListener('change', (e) => {
    const [w, h] = e.target.value.split('x').map(Number);
    state.width = w; state.height = h; layoutCanvas();
  });

  function syncAll() { syncSwatches(); syncLoop(); syncCanvasSize(); syncBrushSheet(); syncVSlider(); syncDock(); }

  /* ---------------------------------------------------------------- misc UI */
  let toastTimer = 0;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg; el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2000);
  }
  function updateStatus() {
    const n = strokeCount();
    $('statFps').dataset.strokes = n;
  }

  window.addEventListener('keydown', (e) => {
    if (exporting) return;
    if ((e.target.tagName === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'color') || e.target.tagName === 'SELECT') return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (e.key === 'Escape' && sheetOpen()) { closeSheets(); return; }
    if (!mod && e.key >= '1' && e.key <= '5') setBrush(BRUSH_ORDER[+e.key - 1]);
    else if (!mod && k === 'b') setTool('pencil');
    else if (!mod && k === 'e') setTool('eraser');
    else if (!mod && k === 'm') setTool('move');
    else if (!mod && k === 'l') ($('sheetLayers').hidden ? openSheet('sheetLayers') : closeSheets());
    else if (!mod && e.code === 'Space') { e.preventDefault(); setPlaying(!state.playing); }
    else if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && k === 'y') { e.preventDefault(); redo(); }
    else if (mod && k === 's') { e.preventDefault(); saveProject(); }
    else if (mod && k === 'o') { e.preventDefault(); $('fileProject').click(); }
    else if (!mod && (e.key === '[' || e.key === ']')) {
      const d = e.key === ']' ? 2 : -2;
      if (state.tool === 'eraser') setVsValue(state.eraserPct + d);
      else { const p = state.pct[state.brush]; p.thickness = Math.max(0, Math.min(100, p.thickness + d)); syncBrushSheet(); }
    }
  });

  /* ------------------------------------------------------------------- boot */
  syncAll();
  setPlaying(true);
  renderLayers();
  syncHistoryButtons();
  updateStatus();
  layoutCanvas();
  requestAnimationFrame(frame);

  // Exposed for debugging, automated tests and embedding.
  window.Drawimate = {
    state, renderScene, exportWebm, exportZip, setTool, setBrush, setPlaying,
    undo, redo, serialize, deserialize, addLayer, deleteLayer, moveLayer, openSheet, closeSheets,
    get fps() { return fps; }, get quality() { return quality; },
  };
})();
