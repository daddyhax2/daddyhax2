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

## Brushes

| Brush | Motion |
|---|---|
| **Scribble** | Nervous "boil": the line's shape jumps a few times per second (~6/s at speed 1) |
| **Flow** | Smooth wiggle; a color gradient travels along the stroke like liquid |
| **Particle** | Dots scatter outward from the stroke and drift back |
| **Smoke** | Grainy charcoal core with soft puffs that rise and fade |
| **Pulse** | Line width breathes as a wave running along the stroke |

Each brush has its own color, size, opacity, speed, amplitude and frequency. New strokes
use the current settings, and each stroke keeps its settings after it's drawn.

## Features

- Pointer Events with pressure (pen, mouse, touch) and coalesced events for smooth input
- Layers: add, delete, reorder, show/hide, rename (double-click)
- Undo/redo, an eraser that removes whole strokes, and clear layer (all undoable)
- Import an image as a background layer (button or drag & drop)
- Play/pause, and a loop length of 2–10 s
- Export one seamless loop as **WebM** (`canvas.captureStream` + `MediaRecorder`) or as a
  **PNG frame sequence `.zip`** (built-in ZIP writer)
- Save/load projects as **JSON** (or drop a `.json` file onto the canvas)

## Shortcuts

| Key | Action |
|---|---|
| `1`–`5` | Scribble / Flow / Particle / Smoke / Pulse |
| `E` | Eraser |
| `[` `]` | Brush / eraser size |
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
