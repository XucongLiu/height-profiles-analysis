# Sensofar Laser-Textured Sample Workflow Notes

## What the project files show

The `.smr` files are XML Single Measurement Recipes. They define one acquisition setup: technique, objective, field of view, scan range, autofocus, illumination, stitching behavior, external analysis, and basic processing.

For inspecting many separate samples, use a Multiple Measurement Recipe (MMR) and keep the SMR as a single-field acquisition. The MMR repeats the SMR at each stage position. This matches the SensoScan manual and the existing MMR logs in `Xucongs-working-directory/MMR`.

## Recommended measurement pattern for 36 samples

1. Use the generated SMR:
   `recipes/generated/laser_textured_36_samples_10x_interferometry.smr`

2. In SensoSCAN, create an MMR and choose the generated positions file:
   `recipes/generated/laser_textured_36_samples_6x6_relative_positions.txt`

3. Put the stage at the center of the 6x6 sample holder before starting the MMR.

4. Focus the first sample before pressing Acquire. The generated positions file leaves Z blank, so SensoSCAN will use the current Z and the SMR autofocus settings at each point.

5. If the sample holder has a different pitch, regenerate the positions:

```powershell
& "C:\Users\XLIHB8\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" `
  "C:\Users\XLIHB8\OneDrive - Scania CV\interferometry-microscope\tools\generate_sensofar_workflow.py" `
  --pitch-x-mm 31.7 --pitch-y-mm 31.7
```

## Useful SMR XML fields

- `MEASUREMENT_CONFIG/TECHNIQUE`: `2` is used in the existing interferometric recipes.
- `MEASUREMENT_CONFIG/ALGORITHM`: `8` corresponds to CSI in the measured `.plux` metadata.
- `AREA_CONFIG/NUM_COLUMNS` and `NUM_ROWS`: stitched fields inside one measurement. Keep as `1` for separate samples in an MMR.
- `SCANNING_CONFIG/RANGE_RELATIVE_UP` and `RANGE_RELATIVE_DOWN`: vertical scan range around focus.
- `AUTOFOCUS_CONFIG/BEFORE_MEASUREMENT`: should be `true` for unattended multi-position runs.
- `LIGHTSOURCE_CONFIG/AUTO_LIGHT`: should be `true` unless illumination repeatability is more important than adaptation.
- `PROCESSING_CONFIG/LEVELING`: enables basic leveling in the saved result.

## PLUX format

The `.plux` files are ZIP containers. A typical file contains:

- `index.xml`: metadata, image dimensions, objective, measurement positions, measured percentage.
- `LAYER_0.raw`: height map as little-endian `float32`, shaped as `IMAGE_SIZE_Y x IMAGE_SIZE_X`.
- `LAYER_0.stack.raw`: image stack/color intensity data.
- `recipe.txt`: the acquisition recipe used for that measurement.
- `Analysis/recipe.txt`: SensoView analysis recipe, if any.

Invalid or non-measured height pixels are stored as `NaN`. The height values in `LAYER_0.raw` are in micrometers.

## Extracting statistics without MountainView

Use:

```powershell
& "C:\Users\XLIHB8\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" `
  "C:\Users\XLIHB8\OneDrive - Scania CV\interferometry-microscope\tools\plux_stats.py" `
  "C:\Users\XLIHB8\OneDrive - Scania CV\interferometry-microscope\Xucongs-working-directory\Ground Samples Measure & Test\Scan Data" `
  --out "C:\Users\XLIHB8\OneDrive - Scania CV\interferometry-microscope\Xucongs-working-directory\plux_surface_stats.csv"
```

The script exports `Sa`, `Sq`, `Sp`, `Sv`, `Sz`, `Ssk`, `Sku`, percentiles, measured fraction, FOV, pixel size, objective, and stage coordinates.
