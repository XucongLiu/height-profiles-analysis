from __future__ import annotations

import argparse
from pathlib import Path
import xml.etree.ElementTree as ET
import zipfile

import numpy as np
from PIL import Image, ImageDraw, ImageFont


def read_plux_height(plux: Path) -> np.ndarray:
    with zipfile.ZipFile(plux) as zf:
        index_root = ET.fromstring(zf.read("index.xml"))
        nx = int(index_root.findtext("./GENERAL/IMAGE_SIZE_X", "0"))
        ny = int(index_root.findtext("./GENERAL/IMAGE_SIZE_Y", "0"))
        raw_name = index_root.findtext("./LAYER_0/FILENAME_Z", "LAYER_0.raw")
        raw = zf.read(raw_name)
    return np.frombuffer(raw, dtype="<f4").reshape(ny, nx).astype(np.float32)


def fill_missing(z: np.ndarray) -> np.ndarray:
    out = z.copy()
    finite = np.isfinite(out)
    if finite.all():
        return out
    fill_value = float(np.nanmedian(out))
    out[~finite] = fill_value
    valid = finite.copy()
    for _ in range(6):
        missing = ~valid
        if not missing.any():
            break
        total = np.zeros_like(out, dtype=np.float32)
        count = np.zeros_like(out, dtype=np.float32)
        for dy, dx in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
            shifted = np.roll(out, (dy, dx), axis=(0, 1))
            shifted_valid = np.roll(valid, (dy, dx), axis=(0, 1))
            if dy < 0:
                shifted_valid[-1, :] = False
            if dy > 0:
                shifted_valid[0, :] = False
            if dx < 0:
                shifted_valid[:, -1] = False
            if dx > 0:
                shifted_valid[:, 0] = False
            total += np.where(shifted_valid, shifted, 0)
            count += shifted_valid
        can_fill = missing & (count > 0)
        out[can_fill] = total[can_fill] / count[can_fill]
        valid[can_fill] = True
    return out


def detrend_plane(z: np.ndarray, max_samples: int = 350_000) -> np.ndarray:
    finite = np.isfinite(z)
    yy, xx = np.nonzero(finite)
    vals = z[finite].astype(np.float64)
    if vals.size < 3:
        return z.copy()
    step = max(1, vals.size // max_samples)
    x = xx[::step].astype(np.float64)
    y = yy[::step].astype(np.float64)
    v = vals[::step]
    a = np.column_stack([x, y, np.ones_like(x)])
    coef, *_ = np.linalg.lstsq(a, v, rcond=None)
    grid_y, grid_x = np.indices(z.shape, dtype=np.float32)
    plane = coef[0] * grid_x + coef[1] * grid_y + coef[2]
    out = z.astype(np.float32) - plane.astype(np.float32)
    out[~finite] = np.nan
    return out


def gaussian_kernel1d(sigma: float) -> np.ndarray:
    if sigma <= 0:
        return np.array([1.0], dtype=np.float32)
    radius = max(1, int(round(sigma * 3)))
    x = np.arange(-radius, radius + 1, dtype=np.float32)
    kernel = np.exp(-(x * x) / (2 * sigma * sigma))
    kernel /= kernel.sum()
    return kernel.astype(np.float32)


def convolve_axis_reflect(image: np.ndarray, kernel: np.ndarray, axis: int) -> np.ndarray:
    radius = len(kernel) // 2
    pad = [(0, 0), (0, 0)]
    pad[axis] = (radius, radius)
    padded = np.pad(image, pad, mode="reflect")
    out = np.zeros_like(image, dtype=np.float32)
    for i, weight in enumerate(kernel):
        sl = [slice(None), slice(None)]
        sl[axis] = slice(i, i + image.shape[axis])
        out += weight * padded[tuple(sl)]
    return out


def gaussian_blur(image: np.ndarray, sigma: float) -> np.ndarray:
    kernel = gaussian_kernel1d(sigma)
    return convolve_axis_reflect(convolve_axis_reflect(image, kernel, axis=1), kernel, axis=0)


def gradient_magnitude(z: np.ndarray) -> np.ndarray:
    gx = np.zeros_like(z, dtype=np.float32)
    gy = np.zeros_like(z, dtype=np.float32)
    gx[:, 1:-1] = 0.5 * (z[:, 2:] - z[:, :-2])
    gx[:, 0] = z[:, 1] - z[:, 0]
    gx[:, -1] = z[:, -1] - z[:, -2]
    gy[1:-1, :] = 0.5 * (z[2:, :] - z[:-2, :])
    gy[0, :] = z[1, :] - z[0, :]
    gy[-1, :] = z[-1, :] - z[-2, :]
    return np.sqrt(gx * gx + gy * gy)


def fft_low_pass(image: np.ndarray, keep_fraction: float) -> np.ndarray:
    keep_fraction = float(np.clip(keep_fraction, 0.001, 1.0))
    spectrum = np.fft.rfft2(image)
    fy = np.fft.fftfreq(image.shape[0])[:, None]
    fx = np.fft.rfftfreq(image.shape[1])[None, :]
    radius = np.sqrt(fx * fx + fy * fy)
    cutoff = keep_fraction * float(radius.max())
    spectrum[radius > cutoff] = 0
    return np.fft.irfft2(spectrum, s=image.shape).astype(np.float32)


def render_edge_map(
    z: np.ndarray,
    name: str,
    out: Path,
    sigma: float,
    edge_percentile: float,
    max_width: int,
    fft_keep: float | None,
) -> Path:
    detrended = detrend_plane(z)
    finite = np.isfinite(detrended)
    filled = fill_missing(detrended)
    if fft_keep is None:
        smoothed = gaussian_blur(filled, sigma)
        method = f"gaussian sigma {sigma:g}px"
    else:
        smoothed = fft_low_pass(filled, fft_keep)
        if sigma > 0:
            smoothed = gaussian_blur(smoothed, sigma)
            method = f"FFT keep {fft_keep:.3f} + gaussian sigma {sigma:g}px"
        else:
            method = f"FFT keep {fft_keep:.3f}"
    grad = gradient_magnitude(smoothed)
    grad[~finite] = 0
    finite_grad = grad[finite]
    lo = float(np.percentile(finite_grad, 50))
    hi = float(np.percentile(finite_grad, 99.5))
    threshold = float(np.percentile(finite_grad, edge_percentile))
    normalized = np.clip((grad - lo) / max(hi - lo, 1e-12), 0, 1)

    rgb = np.repeat((normalized * 255).astype(np.uint8)[..., None], 3, axis=2)
    strong = grad >= threshold
    rgb[strong] = np.array([255, 55, 35], dtype=np.uint8)
    rgb[~finite] = np.array([35, 35, 35], dtype=np.uint8)

    image = Image.fromarray(rgb, mode="RGB")
    if image.width > max_width:
        new_height = round(image.height * max_width / image.width)
        image = image.resize((max_width, new_height), Image.Resampling.LANCZOS)

    margin = 16
    title_h = 46
    canvas = Image.new("RGB", (image.width + 2 * margin, image.height + title_h + 2 * margin), "white")
    draw = ImageDraw.Draw(canvas)
    font = ImageFont.load_default()
    canvas.paste(image, (margin, margin + title_h))
    draw.text((margin, margin), name, fill=(0, 0, 0), font=font)
    draw.text(
        (margin, margin + 18),
        f"gradient edge map | {method} | red >= p{edge_percentile:g} | ridge width target 10-20 px",
        fill=(0, 0, 0),
        font=font,
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out)
    return out


def make_contact_sheet(images: list[Path], out: Path, columns: int = 3) -> Path:
    loaded = [Image.open(path).convert("RGB") for path in images]
    thumb_w = 560
    thumbs = []
    for image in loaded:
        h = round(image.height * thumb_w / image.width)
        thumbs.append(image.resize((thumb_w, h), Image.Resampling.LANCZOS))
    rows = (len(thumbs) + columns - 1) // columns
    cell_h = max(img.height for img in thumbs)
    sheet = Image.new("RGB", (columns * thumb_w, rows * cell_h), "white")
    for i, image in enumerate(thumbs):
        x = (i % columns) * thumb_w
        y = (i // columns) * cell_h
        sheet.paste(image, (x, y))
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out)
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Render gradient edge maps for PLUX height profiles.")
    parser.add_argument("input_dir", type=Path)
    parser.add_argument("--out-dir", type=Path, default=Path("edge-detection-test"))
    parser.add_argument("--sigma", type=float, default=3.0)
    parser.add_argument("--fft-keep", type=float, default=None, help="Optional radial FFT low-pass keep fraction, e.g. 0.04 keeps only very low frequencies.")
    parser.add_argument("--edge-percentile", type=float, default=94.0)
    parser.add_argument("--max-width", type=int, default=1400)
    args = parser.parse_args()

    plux_files = sorted(args.input_dir.glob("*.plux"))
    if not plux_files:
        raise SystemExit(f"No .plux files found in {args.input_dir}")
    outputs = []
    for plux in plux_files:
        z = read_plux_height(plux)
        out = args.out_dir / f"{plux.stem}_edge_map.png"
        outputs.append(render_edge_map(z, plux.name, out, args.sigma, args.edge_percentile, args.max_width, args.fft_keep))
        print(out)
    print(make_contact_sheet(outputs, args.out_dir / "edge_maps_contact_sheet.png"))


if __name__ == "__main__":
    main()
