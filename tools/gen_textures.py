#!/usr/bin/env python3
"""Process AI photos into game textures and bake a terrain splat albedo."""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
TEX = ROOT / "public" / "textures"
TEX.mkdir(parents=True, exist_ok=True)

WORLD_HALF = 48.0
WATER_Y = -0.16


def lerp(a, b, t):
    return a + (b - a) * t


def clamp(v, a=0.0, b=1.0):
    return np.clip(v, a, b)


def smoothstep(e0, e1, x):
    t = clamp((x - e0) / (e1 - e0 + 1e-9))
    return t * t * (3.0 - 2.0 * t)


def river_center_z(x):
    return 14.5 + np.sin(x * 0.038) * 5.0 + np.sin(x * 0.091 + 0.7) * 1.85


def river_half_width(x):
    return 6.6 + np.sin(x * 0.027 + 0.3) * 1.15


def stream_center_x(z):
    return 4.8 + np.sin(z * 0.11) * 2.35 + np.sin(z * 0.29 + 1.1) * 0.85


def stream_half_width(z):
    t = np.clip((z + 38.0) / 52.0, 0.0, 1.0)
    return 1.15 + t * 0.7


def fbm(x, z):
    a = np.zeros_like(x, dtype=np.float64)
    amp = 1.0
    f = 1.0
    s = 0.0
    for i in range(5):
        a += amp * np.sin(x * 0.031 * f + i * 1.7) * np.cos(z * 0.029 * f - i * 1.3)
        s += amp
        amp *= 0.5
        f *= 2.07
    return a / s


def terrain_height(x, z):
    h = 1.35 + fbm(x, z) * 1.85 + fbm(x * 2.3 + 20.0, z * 2.3 - 9.0) * 0.45
    nx = x / WORLD_HALF
    nz = z / WORLD_HALF
    edge = np.maximum(np.abs(nx), np.abs(nz))
    tedge = np.clip((edge - 0.78) / 0.22, 0.0, 1.0)
    h = h + tedge * tedge * 9.5

    woods = np.clip((8.0 - z) / 20.0, 0.0, 1.0)
    h = h + woods * 0.55 * (0.6 + 0.4 * fbm(x + 40.0, z + 12.0))

    rz = river_center_z(x)
    rd = np.abs(z - rz)
    rw = river_half_width(x)
    bank = 4.2
    bed = np.full_like(h, -1.72)
    bed = np.where(np.abs(x + 20.0) < 5.0, -0.55, bed)
    tr = smoothstep(rw + bank, rw * 0.72, rd)
    h = lerp(h, bed, tr)

    sx = stream_center_x(z)
    sd = np.abs(x - sx)
    sw = stream_half_width(z)
    sbank = 2.4
    sbed = np.full_like(h, -0.72)
    ts = smoothstep(sw + sbank, sw * 0.55, sd)
    south = z < (rz - 0.4)
    h = np.where(south, lerp(h, np.minimum(h, sbed), ts * 0.95), h)
    return h


def pollution_field(x, z):
    sx = stream_center_x(z)
    sd = np.abs(x - sx)
    sw = stream_half_width(z)
    rz = river_center_z(x)
    p_stream = smoothstep(sw + 2.6, sw * 0.4, sd)
    south = z < (rz + 1.0)
    # stronger near the source
    source = smoothstep(-18.0, -34.0, z)
    p = p_stream * south * (0.45 + 0.55 * source)

    # plume downstream (east) of confluence, hugging south bank then spreading
    conf_x = 5.0
    rd = z - rz
    rw = river_half_width(x)
    in_river = np.abs(rd) < rw
    down = np.clip((x - conf_x) / 38.0, 0.0, 1.0)
    spread = 0.28 + down * 0.72
    side = rd / (rw + 1e-6)
    # stream enters from south => negative side
    plume = smoothstep(spread, 0.0, np.abs(side + 0.38 * (1.0 - down)))
    p_plume = plume * in_river * (x > (conf_x - 2.0)) * (1.0 - down * 0.5)
    p = np.maximum(p, p_plume)
    return np.clip(p, 0.0, 1.0)


def forest_mask(x, z):
    rz = river_center_z(x)
    dens = np.ones_like(x, dtype=np.float64)
    dens = dens * smoothstep(-24.0, -14.0, x) * smoothstep(32.0, 20.0, x)
    dens = dens * smoothstep(-45.0, -37.0, z)
    dens = dens * smoothstep(rz - 4.5, rz - 12.0, z)
    dens = dens * (0.5 + 0.5 * (0.5 + 0.5 * fbm(x * 0.85, z * 0.85)))
    return np.clip(dens, 0.0, 1.0)


def load_rgb(name, size=1024):
    path = TEX / name
    im = Image.open(path).convert("RGB")
    im = im.resize((size, size), Image.Resampling.LANCZOS)
    return np.asarray(im, dtype=np.float32) / 255.0


def save_rgb(arr, name, quality=88):
    a = np.clip(arr * 255.0, 0, 255).astype(np.uint8)
    im = Image.fromarray(a, "RGB")
    dest = TEX / name
    if name.endswith(".png"):
        im.save(dest)
    else:
        im.save(dest, quality=quality, optimize=True)
    print("wrote", dest, dest.stat().st_size)


def save_rgba(arr, name):
    a = np.clip(arr * 255.0, 0, 255).astype(np.uint8)
    Image.fromarray(a, "RGBA").save(TEX / name)
    print("wrote", TEX / name)


def normal_from_rgb(rgb, strength=2.8):
    g = rgb.mean(axis=2)
    dx = np.roll(g, -1, 1) - np.roll(g, 1, 1)
    dy = np.roll(g, -1, 0) - np.roll(g, 1, 0)
    nx = -dx * strength
    ny = dy * strength
    nz = np.ones_like(g)
    n = np.stack([nx, ny, nz], axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True) + 1e-8
    return n * 0.5 + 0.5


def rough_from_rgb(rgb, lo=0.35, hi=0.9):
    g = rgb.mean(axis=2)
    r = lo + (1.0 - g) * (hi - lo)
    r = r + (np.random.default_rng(3).random(g.shape) - 0.5) * 0.04
    return np.clip(r, 0.15, 0.98)


def sample_wrap(tex, u, v):
    h, w = tex.shape[:2]
    x = np.mod(u * w, w)
    y = np.mod(v * h, h)
    xi = np.floor(x).astype(np.int32) % w
    yi = np.floor(y).astype(np.int32) % h
    return tex[yi, xi]


def leaf_cutout():
    im = Image.open(TEX / "ai_oak_leaf.png").convert("RGBA")
    a = np.asarray(im).astype(np.float32)
    rgb = a[:, :, :3]
    lum = rgb.mean(axis=2)
    # black studio backdrop
    alpha = np.clip((lum - 10.0) / 18.0, 0.0, 1.0)
    alpha = np.where(lum < 8.0, 0.0, alpha)
    # crop
    ys, xs = np.where(alpha > 0.15)
    if len(xs) == 0:
        save_rgba(a / 255.0, "leaf.png")
        return
    pad = 18
    x0, x1 = max(0, xs.min() - pad), min(a.shape[1], xs.max() + pad)
    y0, y1 = max(0, ys.min() - pad), min(a.shape[0], ys.max() + pad)
    crop = a[y0:y1, x0:x1]
    calpha = alpha[y0:y1, x0:x1]
    out = np.dstack([crop[:, :, :3] / 255.0, calpha])
    # square pad
    h, w = out.shape[:2]
    s = max(h, w)
    sq = np.zeros((s, s, 4), dtype=np.float32)
    sq[(s - h) // 2 : (s - h) // 2 + h, (s - w) // 2 : (s - w) // 2 + w] = out
    im2 = Image.fromarray(np.clip(sq * 255, 0, 255).astype(np.uint8), "RGBA")
    im2 = im2.resize((512, 512), Image.Resampling.LANCZOS)
    im2.save(TEX / "leaf.png")
    print("wrote leaf.png")


def grass_card():
    rng = np.random.default_rng(7)
    w, h = 256, 512
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(im)
    for i in range(9):
        base_x = 28 + i * 24 + float(rng.normal(0, 3))
        lean = float(rng.uniform(-26, 26))
        width = float(rng.uniform(5.5, 11.0))
        top_y = 10 + float(rng.uniform(0, 40))
        top_x = base_x + lean
        pts = [
            (base_x - width, h - 1),
            (base_x + width, h - 1),
            (top_x + 1.4, top_y),
            (top_x - 1.4, top_y),
        ]
        g = int(88 + rng.random() * 70)
        color = (int(32 + rng.random() * 28), g, int(18 + rng.random() * 22), 235)
        draw.polygon(pts, fill=color)
        # highlight edge
        draw.line([(base_x - width * 0.2, h - 2), (top_x, top_y)], fill=(color[0] + 30, min(255, g + 40), color[2] + 10, 180), width=1)
    im = im.filter(ImageFilter.GaussianBlur(radius=0.45))
    im.save(TEX / "grass_blade.png")
    print("wrote grass_blade.png")


def foam_tex():
    rng = np.random.default_rng(11)
    n = 512
    y, x = np.mgrid[0:n, 0:n]
    a = np.zeros((n, n), dtype=np.float32)
    for i, freq in enumerate((6, 13, 27, 54)):
        sx = rng.random() * 100
        sy = rng.random() * 100
        a += (0.5 ** i) * (
            0.5
            + 0.5
            * np.sin((x + sx) / n * freq * math.tau)
            * np.cos((y + sy) / n * freq * 0.85 * math.tau)
        )
    a = (a - a.min()) / (a.max() - a.min())
    a = np.clip((a - 0.45) * 2.2, 0, 1)
    rgb = np.dstack([np.full_like(a, 0.9), np.full_like(a, 0.93), np.full_like(a, 0.91), a])
    save_rgba(rgb, "foam.png")


def noise_tex():
    rng = np.random.default_rng(21)
    n = 256
    img = rng.random((n, n, 3)).astype(np.float32)
    save_rgb(img, "noise.png")


def worley(n=256, points=18, seed=4):
    rng = np.random.default_rng(seed)
    pts = rng.random((points, 2))
    y, x = np.mgrid[0:n, 0:n]
    uv = np.stack([x / n, y / n], axis=-1)
    dmin = np.full((n, n), 1e9)
    for p in pts:
        d = uv - p
        d = d - np.round(d)  # wrap
        dist = np.sqrt((d ** 2).sum(-1))
        dmin = np.minimum(dmin, dist)
    dmin /= dmin.max() + 1e-8
    return dmin


def extra_proc():
    # pebble-ish fallback already have AI; make a water caustic noise
    n = 512
    y, x = np.mgrid[0:n, 0:n] / n
    c = 0.5 + 0.5 * np.sin(20 * x + 4 * np.sin(6 * y)) * np.sin(18 * y + 3 * np.cos(5 * x))
    c = np.clip(c ** 2, 0, 1)
    rgb = np.dstack([c * 0.4 + 0.1, c * 0.7 + 0.15, c * 0.65 + 0.2])
    save_rgb(rgb, "caustic.jpg")


def process_ai():
    mapping = {
        "ai_grass.png": "grass",
        "ai_forest_floor.png": "forest",
        "ai_pebbles.png": "pebbles",
        "ai_toxic_mud.png": "mud",
        "ai_bark.png": "bark",
        "ai_dead_grass.png": "deadgrass",
        "ai_moss.png": "moss",
        "ai_rust.png": "rust",
        "ai_canopy.png": "canopy",
    }
    for src, dst in mapping.items():
        p = TEX / src
        if not p.exists():
            print("missing", src)
            continue
        rgb = load_rgb(src, 1024)
        save_rgb(rgb, f"{dst}.jpg")
        save_rgb(normal_from_rgb(rgb), f"{dst}_nor.jpg")
        r = rough_from_rgb(rgb)
        save_rgb(np.dstack([r, r, r]), f"{dst}_rough.jpg")


def bake_terrain(res=1024):
    grass = load_rgb("ai_grass.png")
    forest = load_rgb("ai_forest_floor.png")
    pebbles = load_rgb("ai_pebbles.png")
    mud = load_rgb("ai_toxic_mud.png")
    dead = load_rgb("ai_dead_grass.png")
    moss = load_rgb("ai_moss.png")

    xs = np.linspace(-WORLD_HALF, WORLD_HALF, res)
    zs = np.linspace(-WORLD_HALF, WORLD_HALF, res)
    x, z = np.meshgrid(xs, zs)
    h = terrain_height(x, z)
    # slope via finite differences
    hx = np.gradient(h, xs[1] - xs[0], axis=1)
    hz = np.gradient(h, zs[1] - zs[0], axis=0)
    slope = np.sqrt(hx * hx + hz * hz)
    pol = pollution_field(x, z)
    forestm = forest_mask(x, z)
    rz = river_center_z(x)
    rd = np.abs(z - rz)
    rw = river_half_width(x)
    near_water = smoothstep(rw + 5.5, rw + 0.2, rd)
    sx = stream_center_x(z)
    sd = np.abs(x - sx)
    sw = stream_half_width(z)
    near_stream = smoothstep(sw + 4.0, sw + 0.1, sd) * (z < rz + 2)

    u = (x + WORLD_HALF) / 4.8
    v = (z + WORLD_HALF) / 4.8
    g = sample_wrap(grass, u, v)
    f = sample_wrap(forest, u * 0.85, v * 0.85)
    pbb = sample_wrap(pebbles, u * 1.4, v * 1.4)
    md = sample_wrap(mud, u * 1.1, v * 1.1)
    dd = sample_wrap(dead, u, v)
    ms = sample_wrap(moss, u * 1.6, v * 1.6)

    rockw = smoothstep(0.45, 1.1, slope)
    sandw = np.clip(near_water * (1.0 - rockw) * 0.85 + near_stream * 0.5, 0, 1)
    mudw = np.clip(pol * 0.95 + near_stream * pol * 0.4, 0, 1)
    forw = np.clip(forestm * (1.0 - sandw) * (1.0 - mudw * 0.7), 0, 1)
    deadw = np.clip(pol * (1.0 - sandw) * 0.85, 0, 1)
    mossw = np.clip(forestm * (1.0 - pol) * 0.25 * (0.5 + 0.5 * fbm(x * 3, z * 3)), 0, 1)

    col = g.copy()
    col = lerp(col, f, forw[..., None])
    col = lerp(col, dd, deadw[..., None])
    col = lerp(col, ms, mossw[..., None])
    col = lerp(col, pbb, sandw[..., None])
    col = lerp(col, md, mudw[..., None])
    # rock tint on steep
    rock_tint = np.array([0.38, 0.34, 0.30])
    col = lerp(col, col * 0.5 + rock_tint, rockw[..., None] * 0.75)
    # wetness near water
    wet = np.clip(near_water * 0.45 + near_stream * 0.35, 0, 1)
    col = col * (1.0 - wet[..., None] * 0.28)
    # darken riverbed (under water)
    under = (h < WATER_Y + 0.05).astype(np.float64)
    col = lerp(col, pbb * 0.45 + md * 0.2, (under * (1.0 - pol) + under * pol)[..., None] * 0.85)

    save_rgb(col, "terrain_albedo.jpg", quality=90)

    # height-based normal in world XZ (for extra detail)
    hn = h.copy()
    hn = (hn - hn.min()) / (hn.max() - hn.min() + 1e-8)
    rgbh = np.dstack([hn, hn, hn])
    save_rgb(normal_from_rgb(rgbh, strength=8.0), "terrain_nor.jpg")
    rough = 0.82 - wet * 0.45 - under * 0.2 + rockw * 0.08 + pol * 0.05
    rough = np.clip(rough, 0.18, 0.95)
    save_rgb(np.dstack([rough, rough, rough]), "terrain_rough.jpg")
    # masks for runtime if needed
    Image.fromarray(np.clip(pol * 255, 0, 255).astype(np.uint8), "L").save(TEX / "pollution_mask.png")
    Image.fromarray(np.clip(forestm * 255, 0, 255).astype(np.uint8), "L").save(TEX / "forest_mask.png")
    print("baked terrain")


def main():
    np.random.seed(3)
    process_ai()
    leaf_cutout()
    grass_card()
    foam_tex()
    noise_tex()
    extra_proc()
    bake_terrain(1024)
    print("done")


if __name__ == "__main__":
    main()
