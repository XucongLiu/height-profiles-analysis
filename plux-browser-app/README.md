# PLUX Surface Analyzer

Local browser app for Sensofar `.plux` files.

## Run

From this folder:

```powershell
npx http-server -p 4173 -a 127.0.0.1
```

Then open:

```text
http://127.0.0.1:4173
```

## What It Does

- Upload a folder of `.plux` files or a `.zip` containing `.plux` files.
- Extract `index.xml` and `LAYER_0.raw` in the browser.
- Fit and remove a best-fit plane from each height map. By default, the plane is fitted from the higher-land plateau only.
- Render a detrended rainbow height map with the higher-land mean height set to `0 um`.
- Cluster height values into plateau populations.
- Default segmentation uses a spatial low-pass area map, so isolated roughness spikes inside a continuous basin or land area do not become separate excluded dots.
- Build plateau-core masks by excluding pixels near land/basin borders, high-gradient transition pixels, and height-tail outliers.
- Draw contours around the exact basin-core and land-core regions used for statistics.
- Report mean height, `Sa`, `Sq`, `Sz`, points, and high-low step height.
- Export the summary table as CSV.

All processing runs client-side in the browser. Heavy PLUX analysis is executed in Web Workers so several files can be processed in parallel without locking the page.

## Leveling Modes

- `Higher land only`: two-pass method. The app first does a coarse all-points plane removal, clusters the result, takes the higher-land plateau mask, then fits the final plane using only those original land pixels. This is the preferred mode for laser-textured samples where the untouched machined land is the flat reference surface.
- `All measured points`: classic plane removal using all finite measured pixels.

## Plateau Core Controls

- `Edge exclusion px`: erodes each plateau mask inward by this many pixels before measuring roughness. This removes rim and boundary pixels that often inflate `Sq`.
- `Gradient exclusion %`: removes the highest-gradient pixels inside each core mask. This rejects sidewalls, scratches, and fringe/transition artifacts.
- `Trim plateau %`: removes the highest and lowest height tails that remain inside each core mask.
- `Segmentation`: `Spatial low-pass areas` classifies a smoothed map to detect continuous land/basin regions, then measures original detrended heights inside those regions. `Per-pixel height` keeps the older direct height clustering behavior.
- `Area smoothing px`: radius of the spatial low-pass filter used to detect large continuous areas. Increase it when roughness speckles are being misclassified as another region.
- `CPU workers`: number of browser worker threads used for PLUX analysis. The default is conservative for an 8-core / 16-thread CPU: enough parallelism for batches, but not all logical threads.

Contour colors:

- dark blue: lower-basin core used for basin statistics
- light blue: pixels assigned to the lower basin, but excluded from basin statistics
- dark green: higher-land core used for land statistics
- light green: pixels assigned to the higher land, but excluded from land statistics
- orange: transition, rim, sidewall, or other non-plateau height population
- dark gray/black: invalid or unmeasured pixels
- cyan outline: lower-basin core contour
- white outline: higher-land core contour
