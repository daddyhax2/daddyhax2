# Drawimate

A browser drawing app where every stroke keeps moving: wiggly, hand-drawn
"boiling line" animation. It's plain HTML/CSS/JS with no build step and no dependencies.
**Open `index.html`** to run it. It works from `file://`.

## How it works

- Each stroke is stored as **data**, not pixels: an array of points `{x, y, pressure, t}`
  plus that stroke's brush settings and a random seed.
- Every frame (`requestAnimationFrame`), all strokes are redrawn and their points are
  moved by 3D simplex noise sampled at `(arc length, cos θ·R, sin θ·R)`.
- **Seamless loops:** θ goes once around a circle each loop, and every brush runs a
  whole number of motion cycles per loop. So `t = 0` and `t = loop` render identically,
  pixel for pixel.
- Strokes are filled as variable-width ribbon polygons, which supports pen pressure.
  Ribbons split at sharp corners, so they never fold back on themselves.

## Layout

- **Top bar:** undo, redo, play/pause; ink and paper colour swatches.
- **Canvas:** square 1320 × 1320 by default. Other sizes are in Share.
- **Wiggle bar (left):** how far the line boils, 0–100%. Default **13%**. In eraser mode
  it sets the eraser size.
- **Dock:** brush (tap again for the Brushes sheet), eraser, layers, move layer, share.
- **Brushes sheet:** animated preview cards, plus Speed (default **50%**), Thickness
  (default **40%**), Opacity and Detail. Each brush keeps its own settings.

## Brushes

| Brush | Motion |
|---|---|
| **Scribbles** | The boiling line: 3 thin strands that shift and bend away from the drawn path, hold a pose, then jump (~7 poses/s at speed 50%) |
| **Flow** | Smooth wiggle; a colour gradient travels along the stroke |
| **Particles** | Dots scatter outward from the stroke and drift back |
| **Smoke** | Grainy charcoal core with soft puffs that rise and fade |
| **Pulse** | Line width breathes as a wave running along the stroke |

### Scribbles calibration

Scribbles was tuned against PNG sequences from a reference app, drawn on a 1320 px canvas
at Speed 50% and Thickness 40%. "Band" is how far apart the strands spread across a loop.

| Wiggle | Reference band | Drawimate band |
|---|---|---|
| 5% | 5.5 px | 5.8 px |
| 10% | 9.2 px | 8.8 px |
| **13%** | **11.5 px** | **11.2 px** |
| 25% | 20.2 px | 20.3 px |
| 50% | 39.5 px | 39.0 px |
| 100% | 77.9 px | 77.9 px |

Thickness 40% gives 5.6 px strands. When only Scribbles are visible, the canvas redraws
only when a pose changes, about 7 times a second.

## Features

- Pointer Events with pressure (pen, mouse, touch) and coalesced events for smooth input
- Layers: add, delete, reorder, show/hide, rename (double-click)
- Undo/redo, an eraser that removes whole strokes, move layer, and clear layer (all undoable)
- Import an image as a background layer (Layers sheet or drag & drop)
- Play/pause, and a loop length of 2–10 s
- Export one seamless loop as **WebM** (`canvas.captureStream` + `MediaRecorder`) or as a
  **PNG frame sequence `.zip`** (built-in ZIP writer)
- Save/open projects as **JSON** (older v1 projects still open)

## Shortcuts

| Key | Action |
|---|---|
| `1`–`5` | Scribbles / Flow / Particles / Smoke / Pulse |
| `B` `E` `M` | Brush, eraser, move |
| `L` | Layers |
| `[` `]` | Thickness (or eraser size) |
| `Space` | Play / pause |
| `Ctrl+Z`, `Ctrl+Shift+Z` / `Ctrl+Y` | Undo, redo |
| `Ctrl+S`, `Ctrl+O` | Save, open project |

## Files

```
index.html       layout
css/style.css    dark UI
js/noise.js      seeded simplex noise + hash
js/brushes.js    brush engine (ribbons, the five brushes, smoke haze buffer)
js/zip.js        minimal STORE-mode ZIP writer
js/app.js        state, input, render loop, layers, history, save/load, export
```

## Performance notes

- Rendering uses no per-frame allocations for geometry: shared typed-array scratch buffers.
- Arc lengths are cached per stroke.
- Smoke puffs render into a half-resolution "haze" buffer that only redraws its dirty area.
- If playback drops below ~50 fps, the live view lowers its pixel density automatically and
  restores it when there is headroom. Exports always render at full resolution.

## Example

`examples/finn.json` is a sample project: an animated drawing of Finn on a hill, with
Scribble outlines and fills, a Flow grass edge, cloud puffs and Particle sparkles. Load it
with **Open**. `examples/make_finn.py` generates it from shapes (`python3 examples/make_finn.py`).
