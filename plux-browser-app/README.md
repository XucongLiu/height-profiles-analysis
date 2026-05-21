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
- Render a detrended rainbow height map.
- Cluster height values into plateau populations.
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
- `CPU workers`: number of browser worker threads used for PLUX analysis. The default is conservative for an 8-core / 16-thread CPU: enough parallelism for batches, but not all logical threads.

Contour colors:

- cyan: lower-basin core used for basin statistics
- white: higher-land core used for land statistics
