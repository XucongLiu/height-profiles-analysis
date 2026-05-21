from __future__ import annotations

import argparse
import csv
from pathlib import Path
import xml.etree.ElementTree as ET
import zipfile

import numpy as np
from PIL import Image, ImageDraw, ImageFont


def read_plux_height(plux: Path) -> tuple[np.ndarray, ET.Element]:
    with zipfile.ZipFile(plux) as zf:
        index_root = ET.fromstring(zf.read("index.xml"))
        nx = int(index_root.findtext("./GENERAL/IMAGE_SIZE_X", "0"))
        ny = int(index_root.findtext("./GENERAL/IMAGE_SIZE_Y", "0"))
        raw_name = index_root.findtext("./LAYER_0/FILENAME_Z", "LAYER_0.raw")
        raw = zf.read(raw_name)
    z = np.frombuffer(raw, dtype="<f4").reshape(ny, nx)
    return z, index_root


def kmeans_1d(values: np.ndarray, clusters: int, iterations: int = 80) -> np.ndarray:
    centers = np.percentile(values, np.linspace(10, 90, clusters)).astype(float)
    for _ in range(iterations):
        labels = np.argmin(np.abs(values[:, None] - centers[None, :]), axis=1)
        new_centers = np.array(
            [
                values[labels == label].mean() if np.any(labels == label) else centers[label]
                for label in range(clusters)
            ]
        )
        new_centers = np.sort(new_centers)
        if float(np.sum(np.abs(new_centers - centers))) < 1e-6:
            centers = new_centers
            break
        centers = new_centers
    return centers


def remove_small_components(mask: np.ndarray, min_area: int) -> np.ndarray:
    # Component cleanup is intentionally conservative and dependency-free here.
    # The height-domain clustering already removes the main transition and rim
    # populations; preserving small islands is preferable to accidentally
    # erasing narrow valid texture features.
    return mask


def plateau_masks(
    z: np.ndarray,
    clip_percent: float,
    clusters: int,
    trim_percent: float,
    min_component_area: int,
    sample_size: int,
) -> tuple[dict[str, np.ndarray], dict[str, float]]:
    finite = np.isfinite(z)
    measured = z[finite]
    lo = float(np.percentile(measured, clip_percent))
    hi = float(np.percentile(measured, 100.0 - clip_percent))
    measured_clipped = np.clip(measured, lo, hi)

    if measured_clipped.size > sample_size:
        rng = np.random.default_rng(7)
        sample = measured_clipped[rng.choice(measured_clipped.size, size=sample_size, replace=False)]
    else:
        sample = measured_clipped

    centers = kmeans_1d(sample, clusters)

    zc = np.clip(z, lo, hi)
    label_image = np.full(z.shape, -1, dtype=np.int16)
    label_image[finite] = np.argmin(np.abs(zc[finite, None] - centers[None, :]), axis=1)

    full_labels = label_image[finite]
    counts = np.array([np.count_nonzero(full_labels == label) for label in range(clusters)])
    largest_two = np.sort(np.argsort(counts)[-2:])
    low_label, high_label = largest_two[0], largest_two[1]
    if centers[low_label] > centers[high_label]:
        low_label, high_label = high_label, low_label

    assigned_low = finite & (label_image == low_label)
    assigned_high = finite & (label_image == high_label)
    assigned_other = finite & ~(assigned_low | assigned_high)
    low_core = assigned_low.copy()
    high_core = assigned_high.copy()

    for name, core in [("low", low_core), ("high", high_core)]:
        vals = z[core]
        if vals.size:
            q_lo, q_hi = np.percentile(vals, [trim_percent, 100.0 - trim_percent])
            trimmed = core & (z >= q_lo) & (z <= q_hi)
            if name == "low":
                low_core = trimmed
            else:
                high_core = trimmed

    low_core = remove_small_components(low_core, min_component_area)
    high_core = remove_small_components(high_core, min_component_area)

    return (
        {
            "finite": finite,
            "assigned_low": assigned_low,
            "assigned_high": assigned_high,
            "assigned_other": assigned_other,
            "low_core": low_core,
            "high_core": high_core,
        },
        {
            "clip_low_um": lo,
            "clip_high_um": hi,
            "low_center_um": float(centers[low_label]),
            "high_center_um": float(centers[high_label]),
            "center_gap_um": float(centers[high_label] - centers[low_label]),
            "other_cluster_fraction": float(np.count_nonzero(assigned_other) / measured.size),
            **{f"cluster_{idx}_center_um": float(center) for idx, center in enumerate(centers)},
            **{f"cluster_{idx}_fraction": float(count / measured.size) for idx, count in enumerate(counts)},
        },
    )


def surface_stats(z: np.ndarray, mask: np.ndarray) -> dict[str, float | int]:
    vals = z[mask]
    mean = float(vals.mean())
    centered = vals - mean
    return {
        "points": int(vals.size),
        "mean_um": mean,
        "median_um": float(np.median(vals)),
        "Sa_um": float(np.mean(np.abs(centered))),
        "Sq_um": float(np.sqrt(np.mean(centered * centered))),
        "Sp_um": float(vals.max() - mean),
        "Sv_um": float(mean - vals.min()),
        "Sz_um": float(vals.max() - vals.min()),
        "p05_um": float(np.percentile(vals, 5)),
        "p95_um": float(np.percentile(vals, 95)),
    }


def save_mask_image(
    z: np.ndarray,
    masks: dict[str, np.ndarray],
    params: dict[str, float],
    out: Path,
    title: str,
    max_width: int,
) -> None:
    finite = masks["finite"]
    measured = z[finite]
    low = float(np.percentile(measured, 1))
    high = float(np.percentile(measured, 99))
    norm = np.where(finite, (np.clip(z, low, high) - low) / (high - low), 0.0)
    gray = (255 * norm).astype(np.uint8)
    rgb = np.stack([gray, gray, gray], axis=-1)
    rgb[~finite] = [25, 25, 25]
    rgb[masks["assigned_other"]] = [235, 145, 20]
    rgb[masks["assigned_low"]] = [95, 120, 210]
    rgb[masks["assigned_high"]] = [115, 205, 85]
    rgb[masks["low_core"]] = [0, 35, 220]
    rgb[masks["high_core"]] = [0, 175, 30]

    image = Image.fromarray(rgb, mode="RGB")
    if image.width > max_width:
        new_height = round(image.height * max_width / image.width)
        image = image.resize((max_width, new_height), Image.Resampling.LANCZOS)

    margin = 18
    title_h = 68
    canvas = Image.new("RGB", (image.width + 2 * margin, image.height + title_h + 2 * margin), "white")
    draw = ImageDraw.Draw(canvas)
    font = ImageFont.load_default()
    draw.text((margin, margin), title, fill=(0, 0, 0), font=font)
    draw.text(
        (margin, margin + 16),
        "core low: blue | core high: green | excluded extra height population: orange | trimmed pixels: pale blue/green | unmeasured: dark gray",
        fill=(0, 0, 0),
        font=font,
    )
    draw.text(
        (margin, margin + 32),
        f"selected centers: low {params['low_center_um']:.3f} um, high {params['high_center_um']:.3f} um; excluded fraction {params['other_cluster_fraction']:.1%}",
        fill=(0, 0, 0),
        font=font,
    )
    canvas.paste(image, (margin, margin + title_h))
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out)


def main() -> None:
    parser = argparse.ArgumentParser(description="Cluster a PLUX height map into high/low plateau regions and report surface statistics.")
    parser.add_argument("plux", type=Path)
    parser.add_argument("--out-csv", type=Path)
    parser.add_argument("--out-mask", type=Path)
    parser.add_argument("--clip-percent", type=float, default=1.0)
    parser.add_argument("--clusters", type=int, default=3)
    parser.add_argument("--trim-percent", type=float, default=2.5)
    parser.add_argument("--min-component-area", type=int, default=200)
    parser.add_argument("--sample-size", type=int, default=800000)
    parser.add_argument("--max-width", type=int, default=1600)
    args = parser.parse_args()

    z, index_root = read_plux_height(args.plux)
    masks, params = plateau_masks(
        z,
        args.clip_percent,
        args.clusters,
        args.trim_percent,
        args.min_component_area,
        args.sample_size,
    )

    low = surface_stats(z, masks["low_core"])
    high = surface_stats(z, masks["high_core"])
    rows = [
        {"region": "lower_basin_core", **low},
        {"region": "higher_land_core", **high},
        {
            "region": "height_difference_high_minus_low",
            "points": "",
            "mean_um": high["mean_um"] - low["mean_um"],
            "median_um": high["median_um"] - low["median_um"],
            "Sa_um": "",
            "Sq_um": "",
            "Sp_um": "",
            "Sv_um": "",
            "Sz_um": "",
            "p05_um": "",
            "p95_um": "",
        },
    ]

    out_csv = args.out_csv or args.plux.with_suffix(".plateau_cluster_stats.csv")
    out_csv.parent.mkdir(parents=True, exist_ok=True)
    with out_csv.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)

    out_mask = args.out_mask or args.plux.with_suffix(".plateau_cluster_mask.png")
    title = f"{args.plux.name} | {z.shape[1]} x {z.shape[0]} height map"
    save_mask_image(z, masks, params, out_mask, title, args.max_width)

    print(f"CSV: {out_csv}")
    print(f"Mask: {out_mask}")
    print(f"Mean height difference high-low: {high['mean_um'] - low['mean_um']:.6f} um")


if __name__ == "__main__":
    main()
