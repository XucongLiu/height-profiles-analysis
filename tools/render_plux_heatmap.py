from __future__ import annotations

import argparse
from pathlib import Path
import tempfile
import xml.etree.ElementTree as ET
import zipfile

import numpy as np
from PIL import Image, ImageDraw, ImageFont


def read_from_folder(folder: Path) -> tuple[np.ndarray, ET.Element]:
    index_root = ET.parse(folder / "index.xml").getroot()
    nx = int(index_root.findtext("./GENERAL/IMAGE_SIZE_X", "0"))
    ny = int(index_root.findtext("./GENERAL/IMAGE_SIZE_Y", "0"))
    raw_name = index_root.findtext("./LAYER_0/FILENAME_Z", "LAYER_0.raw")
    raw = (folder / raw_name).read_bytes()
    z = np.frombuffer(raw, dtype="<f4").reshape(ny, nx)
    return z, index_root


def read_from_plux(plux: Path) -> tuple[np.ndarray, ET.Element]:
    with zipfile.ZipFile(plux) as zf:
        index_root = ET.fromstring(zf.read("index.xml"))
        nx = int(index_root.findtext("./GENERAL/IMAGE_SIZE_X", "0"))
        ny = int(index_root.findtext("./GENERAL/IMAGE_SIZE_Y", "0"))
        raw_name = index_root.findtext("./LAYER_0/FILENAME_Z", "LAYER_0.raw")
        raw = zf.read(raw_name)
    z = np.frombuffer(raw, dtype="<f4").reshape(ny, nx)
    return z, index_root


def blue_white_red(values: np.ndarray) -> np.ndarray:
    values = np.clip(values, 0.0, 1.0)
    rgb = np.empty((*values.shape, 3), dtype=np.uint8)

    lower = values < 0.5
    upper = ~lower

    t = values[lower] * 2.0
    rgb[lower, 0] = (255 * t).astype(np.uint8)
    rgb[lower, 1] = (255 * t).astype(np.uint8)
    rgb[lower, 2] = 255

    t = (values[upper] - 0.5) * 2.0
    rgb[upper, 0] = 255
    rgb[upper, 1] = (255 * (1.0 - t)).astype(np.uint8)
    rgb[upper, 2] = (255 * (1.0 - t)).astype(np.uint8)
    return rgb


def rainbow(values: np.ndarray) -> np.ndarray:
    values = np.clip(values, 0.0, 1.0)
    stops = np.array(
        [
            [68, 1, 84],
            [59, 82, 139],
            [33, 145, 140],
            [94, 201, 98],
            [253, 231, 37],
            [244, 109, 67],
            [165, 0, 38],
        ],
        dtype=np.float32,
    )
    scaled = values * (len(stops) - 1)
    idx = np.floor(scaled).astype(np.int32)
    idx = np.clip(idx, 0, len(stops) - 2)
    t = (scaled - idx)[..., None]
    rgb = stops[idx] * (1.0 - t) + stops[idx + 1] * t
    return rgb.astype(np.uint8)


def colorize(values: np.ndarray, palette: str) -> np.ndarray:
    if palette == "blue-red":
        return blue_white_red(values)
    if palette == "rainbow":
        return rainbow(values)
    raise ValueError(f"Unsupported palette: {palette}")


def make_heatmap(
    z: np.ndarray,
    out: Path,
    title: str,
    clip_percent: float,
    max_width: int,
    palette: str,
) -> None:
    finite = np.isfinite(z)
    measured = z[finite]
    if measured.size == 0:
        raise ValueError("No finite measured height values found.")

    if clip_percent > 0:
        low = float(np.percentile(measured, clip_percent))
        high = float(np.percentile(measured, 100 - clip_percent))
    else:
        low = float(np.min(measured))
        high = float(np.max(measured))

    normalized = np.where(finite, (z - low) / (high - low), 0.0)
    colors = colorize(normalized, palette)
    colors[~finite] = np.array([45, 45, 45], dtype=np.uint8)

    heatmap = Image.fromarray(colors, mode="RGB")
    if heatmap.width > max_width:
        new_height = round(heatmap.height * max_width / heatmap.width)
        heatmap = heatmap.resize((max_width, new_height), Image.Resampling.LANCZOS)

    margin = 18
    title_h = 42
    bar_h = 46
    canvas = Image.new("RGB", (heatmap.width + margin * 2, heatmap.height + title_h + bar_h + margin * 2), "white")
    draw = ImageDraw.Draw(canvas)
    font = ImageFont.load_default()

    canvas.paste(heatmap, (margin, margin + title_h))
    draw.text((margin, margin), title, fill=(0, 0, 0), font=font)

    bar_w = heatmap.width
    grad = np.linspace(0, 1, bar_w, dtype=np.float32)[None, :]
    bar = Image.fromarray(colorize(np.repeat(grad, 16, axis=0), palette), mode="RGB")
    bar_y = margin + title_h + heatmap.height + 10
    canvas.paste(bar, (margin, bar_y))
    draw.text((margin, bar_y + 20), f"low {low:.3f} um", fill=(0, 0, 0), font=font)
    high_text = f"high {high:.3f} um"
    tw = draw.textlength(high_text, font=font)
    draw.text((margin + bar_w - tw, bar_y + 20), high_text, fill=(0, 0, 0), font=font)
    draw.text(
        (margin, bar_y + 34),
        f"NaN/unmeasured pixels: dark gray | measured: {measured.size / z.size:.1%}",
        fill=(0, 0, 0),
        font=font,
    )

    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out)


def main() -> None:
    parser = argparse.ArgumentParser(description="Render a blue-to-red heat map from a Sensofar PLUX file or extracted PLUX folder.")
    parser.add_argument("input", type=Path, help=".plux file or extracted folder containing index.xml and LAYER_0.raw")
    parser.add_argument("--out", type=Path)
    parser.add_argument("--palette", choices=["blue-red", "rainbow"], default="blue-red")
    parser.add_argument("--clip-percent", type=float, default=1.0, help="Clip low/high tails for display contrast. Use 0 for full min/max.")
    parser.add_argument("--max-width", type=int, default=1400)
    args = parser.parse_args()

    if args.input.is_dir():
        z, index_root = read_from_folder(args.input)
        default_out = args.input / f"{args.input.name}_height_heatmap.png"
        title = args.input.name
    else:
        z, index_root = read_from_plux(args.input)
        default_out = args.input.with_suffix(".height_heatmap.png")
        title = args.input.name

    title = f"{title} | {z.shape[1]} x {z.shape[0]} height map"
    make_heatmap(z, args.out or default_out, title, args.clip_percent, args.max_width, args.palette)
    print(args.out or default_out)


if __name__ == "__main__":
    main()
