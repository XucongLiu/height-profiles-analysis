from __future__ import annotations

import argparse
import csv
from pathlib import Path
import xml.etree.ElementTree as ET
import zipfile

import numpy as np


def item_map(root: ET.Element) -> dict[str, str]:
    out: dict[str, str] = {}
    for item in root.findall("./INFO/*"):
        name = item.findtext("NAME")
        value = item.findtext("VALUE")
        if name:
            out[name] = value or ""
    return out


def read_height(path: Path) -> tuple[np.ndarray, ET.Element, dict[str, str]]:
    with zipfile.ZipFile(path) as zf:
        index_root = ET.fromstring(zf.read("index.xml"))
        nx = int(index_root.findtext("./GENERAL/IMAGE_SIZE_X", "0"))
        ny = int(index_root.findtext("./GENERAL/IMAGE_SIZE_Y", "0"))
        raw_name = index_root.findtext("./LAYER_0/FILENAME_Z", "LAYER_0.raw")
        raw = zf.read(raw_name)
    z = np.frombuffer(raw, dtype="<f4").reshape(ny, nx)
    return z, index_root, item_map(index_root)


def stats_for(path: Path) -> dict[str, object]:
    z, index_root, info = read_height(path)
    finite = np.isfinite(z)
    values = z[finite]
    if values.size == 0:
        raise ValueError(f"No measured height values in {path}")

    mean = float(values.mean())
    centered = values - mean
    fov_x_mm = float(index_root.findtext("./GENERAL/FOV_X", "nan"))
    fov_y_mm = float(index_root.findtext("./GENERAL/FOV_Y", "nan"))
    nx = int(index_root.findtext("./GENERAL/IMAGE_SIZE_X", "0"))
    ny = int(index_root.findtext("./GENERAL/IMAGE_SIZE_Y", "0"))

    return {
        "file": str(path),
        "date": index_root.findtext("./GENERAL/DATE", ""),
        "objective": index_root.findtext("./ProbingSystem/Id", ""),
        "technique": info.get("Technique", ""),
        "algorithm": info.get("Algorithm", ""),
        "measured_reported": info.get("Measured", ""),
        "nx": nx,
        "ny": ny,
        "fov_x_mm": fov_x_mm,
        "fov_y_mm": fov_y_mm,
        "dx_um": fov_x_mm * 1000 / nx if nx else np.nan,
        "dy_um": fov_y_mm * 1000 / ny if ny else np.nan,
        "measured_fraction": float(values.size / z.size),
        "Smean_um": mean,
        "Sa_um": float(np.mean(np.abs(centered))),
        "Sq_um": float(np.sqrt(np.mean(centered * centered))),
        "Sp_um": float(values.max() - mean),
        "Sv_um": float(mean - values.min()),
        "Sz_um": float(values.max() - values.min()),
        "Ssk": float(np.mean(centered**3) / (np.sqrt(np.mean(centered * centered)) ** 3)),
        "Sku": float(np.mean(centered**4) / (np.mean(centered * centered) ** 2)),
        "p01_um": float(np.percentile(values, 1)),
        "p50_um": float(np.percentile(values, 50)),
        "p99_um": float(np.percentile(values, 99)),
        "stage_x_um": float(index_root.findtext("./LAYER_0/POSITION_X", "nan")),
        "stage_y_um": float(index_root.findtext("./LAYER_0/POSITION_Y", "nan")),
        "stage_z_um": float(index_root.findtext("./LAYER_0/POSITION_Z", "nan")),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract basic surface statistics from Sensofar .plux files.")
    parser.add_argument("inputs", nargs="+", type=Path, help="Files or folders to scan for .plux files")
    parser.add_argument("--out", type=Path, default=Path("plux_surface_stats.csv"))
    args = parser.parse_args()

    files: list[Path] = []
    for item in args.inputs:
        if item.is_dir():
            files.extend(sorted(item.rglob("*.plux")))
        elif item.suffix.lower() == ".plux":
            files.append(item)

    rows = [stats_for(path) for path in files]
    if not rows:
        raise SystemExit("No .plux files found.")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    print(f"Wrote {len(rows)} rows to {args.out}")


if __name__ == "__main__":
    main()
