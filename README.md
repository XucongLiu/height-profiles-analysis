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

## First-Time Install on Another Windows Computer

Send or download this file:

```text
install-update-and-run.cmd
```

Double-click it. It will clone this public GitHub repository into:

```text
%USERPROFILE%\height-profiles-analysis
```

Each later double-click updates the local copy with `git pull` and starts the app again.

If Git or Node.js/npx is missing, the launcher first tries to install them automatically with Windows Package Manager (`winget`). If `winget` is not available or installation is blocked by company policy, it prints the manual download links instead.

## Requirements

- Git
- Node.js with `npx`

No measurement data is stored in this repository. Large/confidential files such as `.plux`, `.raw`, `.sur`, manuals, and local working directories are ignored by Git.
