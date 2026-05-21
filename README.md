# Height Profiles Analysis

Browser-based tools for reading Sensofar `.plux` interferometry height profiles, detrending maps, clustering higher-land/lower-basin plateau cores, rendering contours, and exporting roughness statistics.

## Run the Browser App

From this repository root:

```powershell
.\update-and-run.cmd
```

Then open:

```text
http://127.0.0.1:4173
```

The app runs locally in the browser. Upload `.plux` files, a folder containing `.plux` files, or a `.zip` containing multiple `.plux` files.

## Requirements

- Git
- Node.js with `npx`

No measurement data is stored in this repository. Large/confidential files such as `.plux`, `.raw`, `.sur`, manuals, and local working directories are ignored by Git.
