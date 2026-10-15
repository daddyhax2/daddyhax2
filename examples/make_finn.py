"""Generate examples/finn.json — a Drawimate project drawing of Finn.

Shapes are polygons; each gets a zigzag "fill" stroke (thick Scribble) and a
thin boiling Scribble outline, so the whole drawing wiggles like a cartoon.
Run:  python3 examples/make_finn.py
"""
import json, math, os, random

random.seed(7)
W, H = 1280, 720
INK = '#1d1c22'
SKIN = '#ffd6b0'
strokes_bg, strokes = [], []


def stroke(pts, brush='scribble', color=INK, size=5, opacity=1, speed=1, amp=1.6, freq=1.2, layer=None):
    out = []
    for i, (x, y) in enumerate(pts):
        out.append([round(x, 2), round(y, 2), 0.5, i * 8])
    (layer if layer is not None else strokes).append(dict(
        brush=brush, color=color, size=size, opacity=opacity, speed=speed,
        amp=amp, freq=freq, seed=random.randint(1, 10**6), points=out))


def resample(pts, step=4, closed=False):
    if closed:
        pts = pts + [pts[0]]
    out = [pts[0]]
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        d = math.hypot(x1 - x0, y1 - y0)
        n = max(1, int(d / step))
        for k in range(1, n + 1):
            out.append((x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n))
    return out


def ellipse(cx, cy, rx, ry, a0=0, a1=2 * math.pi, n=48):
    return [(cx + rx * math.cos(a0 + (a1 - a0) * i / n), cy + ry * math.sin(a0 + (a1 - a0) * i / n)) for i in range(n + 1)]


def round_rect(x0, y0, x1, y1, r):
    pts = []
    for cx, cy, a in [(x1 - r, y0 + r, -math.pi / 2), (x1 - r, y1 - r, 0), (x0 + r, y1 - r, math.pi / 2), (x0 + r, y0 + r, math.pi)]:
        pts += ellipse(cx, cy, r, r, a, a + math.pi / 2, 10)
    return pts


def fill(poly, color, size=20, amp=1.0, layer=None):
    """Zigzag scanline fill inside a (roughly convex per scanline) polygon."""
    ys = [p[1] for p in poly]
    y0, y1 = min(ys), max(ys)
    r = size * 0.5
    path, flip = [], False
    y = y0 + r * 0.9
    while y <= y1 - r * 0.9 + 0.01:
        xs = []
        for (ax, ay), (bx, by) in zip(poly, poly[1:] + poly[:1]):
            if (ay <= y < by) or (by <= y < ay):
                xs.append(ax + (y - ay) * (bx - ax) / (by - ay))
        if len(xs) >= 2:
            a, b = min(xs) + r * 0.8, max(xs) - r * 0.8
            if b < a:
                a = b = (a + b) / 2
            seg = [(a, y), (b, y)]
            path += seg[::-1] if flip else seg
            flip = not flip
        y += size * 0.7
    if path:
        stroke(resample(path, 4), color=color, size=size, amp=amp, freq=0.8, layer=layer)


def outline(poly, closed=True, size=5, color=INK):
    stroke(resample(poly, 4, closed), color=color, size=size)


def shape(poly, color, size=20):
    fill(poly, color, size)
    outline(poly)


# ---------------------------------------------------------------- background
# rolling hill: column-zigzag scribble fill under the curve, Flow grass edge on top
hy = lambda x: 590 + 26 * math.sin(x / 210) + 10 * math.sin(x / 70)
for x0, x1, c in [(-20, W + 20, '#4aa83f')]:
    path, flip, size = [], False, 34
    x = x0
    while x <= x1:
        seg = [(x, hy(x) + 14), (x, H + 30)]
        path += seg[::-1] if flip else seg
        flip = not flip
        x += size * 0.7
    stroke(resample(path, 5), color=c, size=size, amp=1.0, freq=0.6, layer=strokes_bg)
stroke([(x, hy(x)) for x in range(-20, W + 21, 5)], brush='flow', color='#a8c83a', size=16, opacity=1, speed=0.5, amp=2.5, freq=0.8, layer=strokes_bg)
for gx in range(30, W, 70):  # little grass tufts
    stroke(resample([(gx - 6, hy(gx) + 30), (gx, hy(gx) + 18), (gx + 6, hy(gx) + 30)], 3), color='#2f7f2a', size=4, layer=strokes_bg)
# clouds: overlapping white puffs + a soft smoke haze
for cx, cy, w in [(220, 140, 150), (1040, 110, 180), (1140, 255, 100)]:
    for dx, dy, r in [(-w * 0.32, 8, w * 0.22), (0, -6, w * 0.3), (w * 0.32, 8, w * 0.22)]:
        fill(ellipse(cx + dx, cy + dy, r, r * 0.8, n=24), '#ffffff', size=16, layer=strokes_bg)
    stroke(resample([(cx - w / 2, cy + 18), (cx + w / 2, cy + 18)], 4), brush='smoke', color='#ffffff',
           size=22, opacity=0.6, speed=0.4, amp=8, freq=1, layer=strokes_bg)
# twinkling sparkles: crossed particle strokes
for cx, cy in [(380, 230), (900, 330), (330, 430), (960, 470), (520, 70)]:
    for (ax, ay, bx, by) in [(-22, 0, 22, 0), (0, -22, 0, 22)]:
        stroke(resample([(cx + ax, cy + ay), (cx + bx, cy + by)], 3), brush='particle', color='#ffc61a', size=7,
               opacity=0.95, speed=0.5, amp=10, freq=1.5, layer=strokes_bg)

# ------------------------------------------------------------------- Finn
cx = 640
# backpack behind the body
shape(round_rect(cx - 98, 350, cx + 98, 465, 26), '#4cae4c')
# legs (skin) + socks
for lx in (cx - 38, cx + 38):
    shape(round_rect(lx - 13, 520, lx + 13, 600, 8), SKIN, size=14)
    shape(round_rect(lx - 14, 578, lx + 14, 612, 6), '#ffffff', size=14)
# shoes
for lx in (cx - 44, cx + 44):
    shape(ellipse(lx, 620, 30, 14, n=28), INK, size=12)
# shorts
shape([(cx - 82, 470), (cx + 82, 470), (cx + 84, 528), (cx + 6, 528), (cx, 506), (cx - 6, 528), (cx - 84, 528)], '#2456b8', size=16)
# shirt
shape([(cx - 70, 330), (cx + 70, 330), (cx + 86, 480), (cx - 86, 480)], '#3fa7e8', size=22)
# arms: one waving up, one down
stroke(resample([(cx + 78, 352), (cx + 120, 320), (cx + 150, 270)], 4), color=INK, size=22)
stroke(resample([(cx + 78, 352), (cx + 120, 320), (cx + 150, 270)], 4), color=SKIN, size=14)
stroke(resample([(cx - 78, 352), (cx - 112, 400), (cx - 124, 448)], 4), color=INK, size=22)
stroke(resample([(cx - 78, 352), (cx - 112, 400), (cx - 124, 448)], 4), color=SKIN, size=14)
shape(ellipse(cx + 154, 260, 15, 15, n=20), SKIN, size=12)
shape(ellipse(cx - 126, 458, 15, 15, n=20), SKIN, size=12)
# backpack straps
for sx in (cx - 46, cx + 46):
    stroke(resample([(sx, 334), (sx + (4 if sx < cx else -4), 430)], 4), color='#2f8a34', size=12)
# hat (white) with bear ears, running down past the cheeks
ears = []
for ex in (cx - 92, cx + 92):
    shape(ellipse(ex, 104, 30, 28, n=28), '#ffffff', size=16)
hat = round_rect(cx - 130, 92, cx + 130, 350, 90)
shape(hat, '#ffffff', size=24)
# face opening
face = round_rect(cx - 92, 150, cx + 92, 312, 48)
shape(face, SKIN, size=20)
# eyes
for exx in (cx - 40, cx + 40):
    stroke([(exx, 214)], color=INK, size=16)
# big open smile
mouth = [(cx - 52, 248), (cx + 52, 248)] + ellipse(cx, 248, 52, 40, 0, math.pi, 24)[1:]
shape(mouth, '#7a1f2b', size=12)
fill(ellipse(cx, 276, 22, 9, n=16), '#e8667a', size=8)
outline(mouth)
# cheek blush
for bx in (cx - 70, cx + 70):
    stroke(resample([(bx - 10, 246), (bx + 10, 246)], 3), color='#ff9a9a', size=12, opacity=0.6)

project = {
    'app': 'drawimate', 'version': 1, 'width': W, 'height': H,
    'background': '#bfe6ff', 'loop': 4,
    'brushSettings': {},
    'activeLayer': 1,
    'layers': [
        {'name': 'Land of Ooo', 'type': 'draw', 'visible': True, 'strokes': strokes_bg},
        {'name': 'Finn', 'type': 'draw', 'visible': True, 'strokes': strokes},
    ],
}
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'finn.json')
with open(path, 'w') as f:
    json.dump(project, f, separators=(',', ':'))
print(path, len(strokes_bg) + len(strokes), 'strokes', os.path.getsize(path) // 1024, 'KB')
