from __future__ import annotations

import argparse
from datetime import datetime
from pathlib import Path
import xml.etree.ElementTree as ET


REPO_ROOT = Path(__file__).resolve().parents[1]
BASE_SMR = REPO_ROOT / "recipes" / "Leiro" / "Xucong" / "Xucong.smr"
GENERATED_DIR = REPO_ROOT / "recipes" / "generated"
DEFAULT_SMR_OUT = GENERATED_DIR / "laser_textured_36_samples_10x_interferometry.smr"
DEFAULT_POSITIONS_OUT = GENERATED_DIR / "laser_textured_36_samples_6x6_relative_positions.txt"


def set_text(root: ET.Element, path: str, value: object) -> None:
    node = root.find(path)
    if node is None:
        raise ValueError(f"Missing XML path: {path}")
    node.text = str(value)


def indent(elem: ET.Element, level: int = 0) -> None:
    pad = "\n" + level * "\t"
    if len(elem):
        if not elem.text or not elem.text.strip():
            elem.text = pad + "\t"
        for child in elem:
            indent(child, level + 1)
        if not elem.tail or not elem.tail.strip():
            elem.tail = pad
    elif level and (not elem.tail or not elem.tail.strip()):
        elem.tail = pad


def generate_smr(base: Path, out: Path, description: str, scan_range_um: float) -> None:
    tree = ET.parse(base)
    root = tree.getroot()

    sensofar_path = (
        r"C:\ProgramData\Sensofar\SensoSCAN 7.16\Recipes\generated"
        rf"\{out.name}"
    )

    set_text(root, "./RECIPE_BASE/FILENAME", sensofar_path)
    set_text(root, "./RECIPE_BASE/DESCRIPTION", description)
    set_text(root, "./RECIPE_BASE/AUTHOR", "Generated from project workflow")
    set_text(root, "./RECIPE_BASE/DATE", datetime.now().strftime("%H:%M.%S, %d/%m/%Y"))
    set_text(root, "./RECIPE_BASE/NUM_HISTORY", 0)

    for history in list(root.findall("./RECIPE_BASE/*")):
        if history.tag.startswith("HISTORY_"):
            root.find("./RECIPE_BASE").remove(history)

    # Keep each MMR point as one field of view. The repeated sample layout belongs
    # in the MMR positions file, not in stitched AREA_CONFIG rows/columns.
    set_text(root, "./AREA_CONFIG/GEOMETRY", 0)
    set_text(root, "./AREA_CONFIG/NUM_COLUMNS", 1)
    set_text(root, "./AREA_CONFIG/NUM_ROWS", 1)
    set_text(root, "./AREA_CONFIG/OVERLAPPING", 0)
    set_text(root, "./AREA_CONFIG/BASE_FOV_X", 0)
    set_text(root, "./AREA_CONFIG/BASE_FOV_Y", 0)
    set_text(root, "./AREA_CONFIG/FOVINBLACK", "0 ")

    # Conservative interferometric 10X settings for laser-textured surfaces.
    set_text(root, "./MEASUREMENT_CONFIG/TYPE", 2)
    set_text(root, "./MEASUREMENT_CONFIG/TECHNIQUE", 2)
    set_text(root, "./MEASUREMENT_CONFIG/ALGORITHM", 8)
    set_text(root, "./SCANNING_CONFIG/TYPE", 0)
    set_text(root, "./SCANNING_CONFIG/RANGE_RELATIVE_UP", scan_range_um)
    set_text(root, "./SCANNING_CONFIG/RANGE_RELATIVE_DOWN", scan_range_um)
    set_text(root, "./SCANNING_CONFIG/GAP_DUAL", 0)
    set_text(root, "./SCANNING_CONFIG/USE_PZT", "false")
    set_text(root, "./SCANNING_CONFIG/NUM_AVG_IMAGES", 1)
    set_text(root, "./SCANNING_CONFIG/NUM_AVG_SCANS", 1)
    set_text(root, "./SCANNING_CONFIG/THRESHOLD", 1)
    set_text(root, "./SCANNING_CONFIG/CONTINUOUS_CONFOCAL", "true")

    set_text(root, "./AUTOFOCUS_CONFIG/BEFORE_MEASUREMENT", "true")
    set_text(root, "./AUTOFOCUS_CONFIG/RANGE_LARGE", "true")
    set_text(root, "./AUTOFOCUS_CONFIG/RANGE_SMALL", "true")
    set_text(root, "./AUTOFOCUS_CONFIG/ONFAIL", 0)

    set_text(root, "./LIGHTSOURCE_CONFIG/AUTO_LIGHT", "true")
    set_text(root, "./LIGHTSOURCE_CONFIG/MONO_IMAGE", "true")
    set_text(root, "./LIGHTSOURCE_CONFIG/HDR", "false")

    set_text(root, "./PROCESSING_CONFIG/LEVELING", "true")
    set_text(root, "./PROCESSING_CONFIG/RESTORE", "false")

    out.parent.mkdir(parents=True, exist_ok=True)
    indent(root)
    tree.write(out, encoding="utf-8", xml_declaration=True)


def generate_positions(
    out: Path,
    rows: int,
    cols: int,
    pitch_x_mm: float,
    pitch_y_mm: float,
    snake: bool,
    z_mm: float | None,
) -> None:
    lines = [
        "[Measures Relative]",
        "# X_mm Y_mm Z_mm",
        "# Relative positions are added to the current stage position when MMR acquisition starts.",
        "# Focus the first sample before Acquire; leave Z blank unless every sample height is known.",
    ]
    x0 = -0.5 * (cols - 1) * pitch_x_mm
    y0 = -0.5 * (rows - 1) * pitch_y_mm
    for r in range(rows):
        col_range = range(cols - 1, -1, -1) if snake and r % 2 else range(cols)
        for c in col_range:
            x = x0 + c * pitch_x_mm
            y = y0 + r * pitch_y_mm
            if z_mm is None:
                lines.append(f"{x:.4f} {y:.4f}")
            else:
                lines.append(f"{x:.4f} {y:.4f} {z_mm:.4f}")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate a SensoSCAN SMR and MMR positions file for laser-textured samples."
    )
    parser.add_argument("--base-smr", type=Path, default=BASE_SMR)
    parser.add_argument("--smr-out", type=Path, default=DEFAULT_SMR_OUT)
    parser.add_argument("--positions-out", type=Path, default=DEFAULT_POSITIONS_OUT)
    parser.add_argument("--rows", type=int, default=6)
    parser.add_argument("--cols", type=int, default=6)
    parser.add_argument("--pitch-x-mm", type=float, default=31.7)
    parser.add_argument("--pitch-y-mm", type=float, default=31.7)
    parser.add_argument("--scan-range-um", type=float, default=80.0)
    parser.add_argument("--z-mm", type=float, default=None)
    parser.add_argument("--no-snake", action="store_true")
    args = parser.parse_args()

    generate_smr(
        args.base_smr,
        args.smr_out,
        "Laser textured samples: 10X interferometric topography, intended for 6x6 MMR.",
        args.scan_range_um,
    )
    generate_positions(
        args.positions_out,
        args.rows,
        args.cols,
        args.pitch_x_mm,
        args.pitch_y_mm,
        not args.no_snake,
        args.z_mm,
    )
    print(f"Wrote {args.smr_out}")
    print(f"Wrote {args.positions_out}")


if __name__ == "__main__":
    main()
