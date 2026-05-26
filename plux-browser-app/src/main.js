const PALETTE = [
  [68, 1, 84],
  [59, 82, 139],
  [33, 145, 140],
  [94, 201, 98],
  [253, 231, 37],
  [244, 109, 67],
  [165, 0, 38],
];

let results = [];
let lastUploadFiles = [];
let isAnalyzing = false;
let mapStatuses = {};
let reportOverviewImages = {};
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];
const UNKNOWN_RECOGNITION = {
  inspectionId: "",
  displayName: "Unrecognized texture",
  family: "Unrecognized",
  variant: "",
  nominalDepth: "",
  confidence: 0,
  notes: "No sample image was available for local image recognition.",
};
const SAMPLE_OUTER_TO_INNER_RADIUS = 31.7 / 15.5;
let options = {
  detrend: true,
  levelMode: "higher-land",
  clusters: 3,
  clipPercent: 1,
  edgeRadiusPx: 5,
  segmentationMode: "spatial",
  smoothRadiusPx: 12,
  boundaryEpsilonPx: 18,
  edgeSigmaPx: 7,
  edgePercentile: 96,
  ridgeOffsetPx: 20,
  minRegionPercent: 1,
  fftDenoiseStrength: 35,
  workerCount: 9,
  maxSamples: 700000,
};

const root = document.getElementById("root");
const PARAMETER_MODES = {
  clusters: ["height", "spatial", "edge-polygons"],
  clipPercent: ["height", "spatial", "edge-polygons"],
  edgeRadiusPx: ["height"],
  smoothRadiusPx: ["spatial", "edge-polygons"],
  boundaryEpsilonPx: ["spatial", "edge-polygons"],
  edgeSigmaPx: ["edge-polygons"],
  edgePercentile: ["edge-polygons"],
  ridgeOffsetPx: ["edge-polygons"],
  minRegionPercent: ["spatial", "edge-polygons"],
  fftDenoiseStrength: ["height", "spatial"],
};

function icon(name) {
  const paths = {
    upload: "M12 3v12m0-12 4 4m-4-4-4 4M4 15v4h16v-4",
    folder: "M3 6h6l2 2h10v10H3z",
    zip: "M7 3h7l4 4v14H7z M14 3v5h5",
    export: "M12 3v12m0 0 4-4m-4 4-4-4M5 21h14",
    sliders: "M4 7h8m4 0h4M4 17h4m4 0h8M12 5v4M8 15v4",
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name]}" /></svg>`;
}

function tip(text) {
  return `title="${escapeHtml(text)}"`;
}

function renderShell() {
  const tips = {
    detrend: "Remove a best-fit tilted plane before clustering. This compensates for sample tilt during interferometry measurement.",
    levelMode: "Choose which pixels define the leveling plane. Higher land only is preferred when the original machined land is the flat reference surface.",
    clusters: "Number of height groups for k-means clustering. Use 3 when land, basin, and transition/rim populations are visible.",
    clipPercent: "Clip the highest and lowest height tails before clustering so extreme spikes do not pull the cluster centers.",
    edgeRadiusPx: "For per-pixel height segmentation, shrink each plateau mask inward by this many pixels before measuring roughness. Spatial area mode measures the full detected area.",
    segmentationMode: "Choose the region segmentation strategy. Edge polygons uses Gaussian edge detection, then approximates basin borders as straight-line polygons.",
    smoothRadiusPx: "Radius of the low-pass smoothing used before region detection. Larger values reduce local roughness before connected-component analysis.",
    boundaryEpsilonPx: "Douglas-Peucker boundary simplification epsilon in pixels. Larger values use fewer polygon points, making borders straighter/simpler like a generalized coastline.",
    edgeSigmaPx: "Gaussian blur sigma in pixels for edge-polygon segmentation. Larger values suppress laser texture and keep only macro land/basin borders.",
    edgePercentile: "Gradient percentile used as ridge/edge threshold. Higher values keep fewer, stronger edge pixels.",
    ridgeOffsetPx: "Offset from basin polygon to land side in pixels. This removes the ridge fence before measuring land roughness.",
    minRegionPercent: "Minimum connected region size, as percent of the whole height map. Smaller islands are absorbed or ignored, and small enclosed holes are filled.",
    fftDenoiseStrength: "FFT low-pass strength used only for segmentation labels. Roughness statistics use the reconstructed, detrended height values, not the denoised values.",
    workerCount: "Number of browser worker threads used for batch processing. More workers can be faster, but may use more memory and make the computer less responsive.",
  };
  root.innerHTML = `
    <main class="app">
      <section class="topbar">
        <div>
          <h1>PLUX Surface Analyzer</h1>
          <p>Detrend interferometry height maps, render profiles, cluster high/low plateaus, and export statistics.</p>
        </div>
        <div class="topActions">
          <button id="rerunBtn" disabled>${icon("sliders")}Rerun Analysis</button>
          <button class="export" id="pdfBtn" disabled>${icon("export")}PDF Report</button>
          <button class="export" id="exportBtn" disabled>${icon("export")}Export CSV</button>
        </div>
      </section>
      <section class="controls">
        <div class="uploadZone">
          <span class="bigIcon">${icon("upload")}</span>
          <div>
            <strong>Load PLUX data locally</strong>
            <span>Choose local .plux files plus optional sample images, a folder, or a .zip containing multiple files.</span>
          </div>
          <div class="uploadActions">
            <button id="folderBtn">${icon("folder")}Folder</button>
            <button id="fileBtn">${icon("zip")}Files or ZIP</button>
          </div>
          <input id="folderInput" type="file" webkitdirectory directory multiple />
          <input id="fileInput" type="file" multiple accept=".plux,.zip,.jpg,.jpeg,.png,.webp" />
        </div>
        <div class="settings">
          <div class="settingsTitle">${icon("sliders")}Analysis</div>
          <label data-param="detrend" ${tip(tips.detrend)}><input id="detrend" type="checkbox" checked /> Remove plane trend before clustering</label>
          <label data-param="levelMode" ${tip(tips.levelMode)}>Leveling basis
            <select id="levelMode" ${tip(tips.levelMode)}>
              <option value="higher-land" selected>Higher land only</option>
              <option value="all">All measured points</option>
            </select>
          </label>
          <label data-param="clusters" ${tip(tips.clusters)}>Clusters <input id="clusters" type="number" min="2" max="5" value="3" ${tip(tips.clusters)} /></label>
          <label data-param="clipPercent" ${tip(tips.clipPercent)}>Clip tails % <input id="clipPercent" type="number" step="0.5" min="0" max="10" value="1" ${tip(tips.clipPercent)} /></label>
          <label data-param="edgeRadiusPx" ${tip(tips.edgeRadiusPx)}>Edge exclusion px <input id="edgeRadiusPx" type="number" min="0" max="50" value="5" ${tip(tips.edgeRadiusPx)} /></label>
          <label ${tip(tips.segmentationMode)}>Segmentation
            <select id="segmentationMode" ${tip(tips.segmentationMode)}>
              <option value="spatial" selected>CCA geometric regions</option>
              <option value="edge-polygons">Gaussian edge polygons</option>
              <option value="height">Per-pixel height</option>
            </select>
          </label>
          <label data-param="smoothRadiusPx" ${tip(tips.smoothRadiusPx)}>Area smoothing px <input id="smoothRadiusPx" type="number" min="0" max="80" value="12" ${tip(tips.smoothRadiusPx)} /></label>
          <label data-param="boundaryEpsilonPx" ${tip(tips.boundaryEpsilonPx)}>Boundary epsilon px <input id="boundaryEpsilonPx" type="number" min="0" max="200" step="1" value="18" ${tip(tips.boundaryEpsilonPx)} /></label>
          <label data-param="edgeSigmaPx" ${tip(tips.edgeSigmaPx)}>Edge sigma px <input id="edgeSigmaPx" type="number" min="0" max="30" step="0.5" value="7" ${tip(tips.edgeSigmaPx)} /></label>
          <label data-param="edgePercentile" ${tip(tips.edgePercentile)}>Edge percentile <input id="edgePercentile" type="number" min="50" max="99.9" step="0.5" value="96" ${tip(tips.edgePercentile)} /></label>
          <label data-param="ridgeOffsetPx" ${tip(tips.ridgeOffsetPx)}>Ridge offset px <input id="ridgeOffsetPx" type="number" min="0" max="80" step="1" value="20" ${tip(tips.ridgeOffsetPx)} /></label>
          <label data-param="minRegionPercent" ${tip(tips.minRegionPercent)}>Minimum region % <input id="minRegionPercent" type="number" step="0.1" min="0" max="20" value="1" ${tip(tips.minRegionPercent)} /></label>
          <label data-param="fftDenoiseStrength" ${tip(tips.fftDenoiseStrength)}>FFT denoise % <input id="fftDenoiseStrength" type="number" step="1" min="0" max="100" value="35" ${tip(tips.fftDenoiseStrength)} /></label>
          <label data-param="workerCount" ${tip(tips.workerCount)}>CPU workers <input id="workerCount" type="number" min="1" max="12" value="${options.workerCount}" ${tip(tips.workerCount)} /></label>
        </div>
      </section>
      <section class="statusLine"><span class="dot"></span><span id="status">Ready</span><strong id="summary"></strong></section>
      <section id="content" class="empty">
        <h2>No measurements loaded</h2>
        <p>The table will show each detrended height map, cluster mask, and plateau statistics after loading local files.</p>
      </section>
    </main>
  `;

  document.getElementById("folderBtn").onclick = () => document.getElementById("folderInput").click();
  document.getElementById("fileBtn").onclick = () => document.getElementById("fileInput").click();
  document.getElementById("folderInput").onchange = (event) => handleFiles(event.target.files);
  document.getElementById("fileInput").onchange = (event) => handleFiles(event.target.files);
  document.getElementById("rerunBtn").onclick = () => rerunAnalysis();
  document.getElementById("pdfBtn").onclick = () => exportPdfReport();
  document.getElementById("exportBtn").onclick = () => exportCsv(results);
  for (const id of ["detrend", "levelMode", "clusters", "clipPercent", "edgeRadiusPx", "segmentationMode", "smoothRadiusPx", "boundaryEpsilonPx", "edgeSigmaPx", "edgePercentile", "ridgeOffsetPx", "minRegionPercent", "fftDenoiseStrength", "workerCount"]) {
    document.getElementById(id).onchange = () => {
      readOptions();
      updateParameterAvailability();
    };
  }
  updateParameterAvailability();
}

function readOptions() {
  options = {
    detrend: document.getElementById("detrend").checked,
    levelMode: document.getElementById("levelMode").value,
    clusters: Number(document.getElementById("clusters").value),
    clipPercent: Number(document.getElementById("clipPercent").value),
    edgeRadiusPx: Number(document.getElementById("edgeRadiusPx").value),
    segmentationMode: document.getElementById("segmentationMode").value,
    smoothRadiusPx: Number(document.getElementById("smoothRadiusPx").value),
    boundaryEpsilonPx: Number(document.getElementById("boundaryEpsilonPx").value),
    edgeSigmaPx: Number(document.getElementById("edgeSigmaPx").value),
    edgePercentile: Number(document.getElementById("edgePercentile").value),
    ridgeOffsetPx: Number(document.getElementById("ridgeOffsetPx").value),
    minRegionPercent: Number(document.getElementById("minRegionPercent").value),
    fftDenoiseStrength: Number(document.getElementById("fftDenoiseStrength").value),
    workerCount: Math.max(1, Math.min(12, Number(document.getElementById("workerCount").value) || 1)),
    maxSamples: 700000,
  };
}

function updateParameterAvailability() {
  const mode = document.getElementById("segmentationMode")?.value || options.segmentationMode;
  const detrendOn = document.getElementById("detrend")?.checked ?? options.detrend;
  for (const label of document.querySelectorAll(".settings [data-param]")) {
    const id = label.dataset.param;
    let enabled = true;
    if (PARAMETER_MODES[id]) enabled = PARAMETER_MODES[id].includes(mode);
    if (id === "levelMode") enabled = detrendOn;
    const control = label.querySelector("input, select");
    if (control) control.disabled = !enabled;
    label.classList.toggle("parameterDisabled", !enabled);
    if (!enabled) {
      const modeText = mode === "height" ? "Per-pixel height" : mode === "spatial" ? "CCA geometric regions" : "Gaussian edge polygons";
      label.dataset.disabledReason = id === "levelMode" ? "Only used when detrending is enabled." : `Not used by ${modeText}.`;
    } else {
      delete label.dataset.disabledReason;
    }
  }
}

function setStatus(text, busy = false) {
  document.getElementById("status").textContent = text;
  const dot = document.querySelector(".statusLine > span:first-child");
  dot.className = busy ? "spinner" : "dot";
  dot.innerHTML = busy ? `<span></span>` : "";
}

function updateSummary() {
  const exportBtn = document.getElementById("exportBtn");
  const pdfBtn = document.getElementById("pdfBtn");
  const rerunBtn = document.getElementById("rerunBtn");
  exportBtn.disabled = !results.length;
  pdfBtn.disabled = !results.length;
  rerunBtn.disabled = !lastUploadFiles.length || isAnalyzing;
  const summary = document.getElementById("summary");
  if (!results.length) {
    summary.textContent = "";
    return;
  }
  const avg = results.reduce((acc, r) => acc + r.heightDifference, 0) / results.length;
  summary.textContent = `${results.length} maps, average height difference ${fmt(avg)} um`;
}

function releaseResultUrls(rows) {
  for (const row of rows) {
    const urls = new Set([
      row?.heatmap?.url,
      row?.rawHeatmap?.url,
      row?.detrendedHeatmap?.url,
      row?.interpolatedHeatmap?.url,
      row?.sampleImageUrl,
      row?.maskUrl,
    ].filter(Boolean));
    for (const url of urls) URL.revokeObjectURL(url);
  }
}

function releaseOverviewUrls(images) {
  for (const image of Object.values(images || {})) {
    if (image?.url) URL.revokeObjectURL(image.url);
  }
}

function parseXml(text) {
  return new DOMParser().parseFromString(text, "application/xml");
}

function textAt(xml, selector, fallback = "") {
  return xml.querySelector(selector)?.textContent?.trim() ?? fallback;
}

function findEocd(view) {
  for (let i = view.byteLength - 22; i >= Math.max(0, view.byteLength - 66000); i--) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  throw new Error("ZIP end record not found.");
}

async function inflateRaw(bytes) {
  if (!("DecompressionStream" in window)) {
    throw new Error("This browser does not support built-in ZIP decompression. Use current Chrome or Edge.");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return await new Response(stream).arrayBuffer();
}

async function readZipEntries(buffer) {
  const view = new DataView(buffer);
  const decoder = new TextDecoder();
  const eocd = findEocd(view);
  const total = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries = {};
  for (let i = 0; i < total; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("Invalid ZIP central directory.");
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const localOffset = view.getUint32(offset + 42, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const name = decoder.decode(new Uint8Array(buffer, offset + 46, nameLen));
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compressed = buffer.slice(dataStart, dataStart + compressedSize);
    entries[name] = {
      method,
      async arrayBuffer() {
        if (method === 0) return compressed;
        if (method === 8) return await inflateRaw(compressed);
        throw new Error(`Unsupported ZIP compression method ${method} for ${name}.`);
      },
      async text() {
        return decoder.decode(await this.arrayBuffer());
      },
    };
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function readPluxFromArrayBuffer(name, arrayBuffer) {
  const zip = await readZipEntries(arrayBuffer);
  if (!zip["index.xml"]) throw new Error(`${name}: missing index.xml`);
  const xml = parseXml(await zip["index.xml"].text());
  const width = Number(textAt(xml, "GENERAL > IMAGE_SIZE_X"));
  const height = Number(textAt(xml, "GENERAL > IMAGE_SIZE_Y"));
  const rawName = textAt(xml, "LAYER_0 > FILENAME_Z", "LAYER_0.raw");
  if (!zip[rawName]) throw new Error(`${name}: missing ${rawName}`);
  const raw = await zip[rawName].arrayBuffer();
  return {
    name,
    width,
    height,
    values: new Float32Array(raw),
    fovX: Number(textAt(xml, "GENERAL > FOV_X")),
    fovY: Number(textAt(xml, "GENERAL > FOV_Y")),
    date: textAt(xml, "GENERAL > DATE"),
    objective: textAt(xml, "ProbingSystem > Id"),
  };
}

async function expandUploads(files) {
  const items = [];
  const images = new Map();
  const overviewImages = {};
  const addOverviewImage = (name, blob) => {
    const kind = overviewImageKind(name);
    if (!kind) return false;
    const priority = /p00xx/i.test(name) ? 2 : 1;
    if (!overviewImages[kind] || priority >= overviewImages[kind].priority) {
      overviewImages[kind] = { name, blob, priority };
    }
    return true;
  };
  const addImage = (name, blob) => {
    if (addOverviewImage(name, blob)) return;
    const key = sampleKey(name);
    if (key) images.set(key, { name, blob });
  };
  for (const file of files) {
    const name = file.webkitRelativePath || file.name;
    if (file.name.toLowerCase().endsWith(".plux")) {
      items.push({ name, buffer: await file.arrayBuffer() });
    } else if (isImageName(file.name)) {
      addImage(name, file);
    } else if (file.name.toLowerCase().endsWith(".zip")) {
      const zip = await readZipEntries(await file.arrayBuffer());
      for (const [entryName, entry] of Object.entries(zip)) {
        if (entryName.toLowerCase().endsWith(".plux")) {
          items.push({ name: `${file.name}/${entryName}`, buffer: await entry.arrayBuffer() });
        } else if (isImageName(entryName)) {
          addImage(`${file.name}/${entryName}`, new Blob([await entry.arrayBuffer()], { type: imageMimeType(entryName) }));
        }
      }
    }
  }
  for (const item of items) {
    const image = images.get(sampleKey(item.name));
    if (image) item.sampleImage = image;
  }
  return { items, overviewImages };
}

function isImageName(name) {
  const lower = name.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function imageMimeType(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

function overviewImageKind(name) {
  const file = String(name).split(/[\\/]/).pop()?.toLowerCase() || "";
  if (!file.includes("inspection samples id")) return "";
  if (file.includes("raw")) return "raw";
  if (file.includes("labelled") || file.includes("labeled")) return "labelled";
  return "";
}

function makeOverviewUrls(overviewImages) {
  const out = {};
  for (const [key, image] of Object.entries(overviewImages || {})) {
    out[key] = {
      name: image.name,
      url: URL.createObjectURL(image.blob),
    };
  }
  return out;
}

function sampleKey(name) {
  const file = String(name).split(/[\\/]/).pop() || "";
  const match = file.match(/P\d{4}/i);
  return match ? match[0].toUpperCase() : "";
}

function sampleInspectionId(row) {
  return sampleKey(row?.name || row?.sourceName || row?.sampleImageName || "") || "";
}

function recognitionForRow(row) {
  const fallback = {
    ...UNKNOWN_RECOGNITION,
    inspectionId: sampleInspectionId(row),
  };
  if (!row?.recognition) return fallback;
  return {
    ...fallback,
    ...row.recognition,
    inspectionId: row.recognition.inspectionId || fallback.inspectionId,
  };
}

async function recognizeSampleImage(blob, sourceName = "") {
  if (!blob) {
    return { ...UNKNOWN_RECOGNITION, inspectionId: sampleKey(sourceName) };
  }
  try {
    const bitmap = await createImageBitmap(blob);
    const size = 320;
    const side = Math.min(bitmap.width, bitmap.height);
    const sx = Math.max(0, (bitmap.width - side) / 2);
    const sy = 0;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);
    bitmap.close?.();
    const data = ctx.getImageData(0, 0, size, size).data;
    const gray = new Float32Array(size * size);
    const blue = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const p = (y * size + x) * 4;
        const r = data[p], g = data[p + 1], b = data[p + 2];
        const brightness = 0.299 * r + 0.587 * g + 0.114 * b;
        gray[y * size + x] = brightness;
        if (b > 65 && b > r * 1.12 && b > g * 1.03) blue[y * size + x] = 1;
      }
    }

    const imageCenter = size / 2;
    let sxBlue = 0, syBlue = 0, nBlue = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = y * size + x;
        if (!blue[idx]) continue;
        const d = Math.hypot(x - imageCenter, y - imageCenter);
        if (d > size * 0.28) continue;
        sxBlue += x;
        syBlue += y;
        nBlue++;
      }
    }
    if (nBlue < size * size * 0.01) {
      return {
        ...UNKNOWN_RECOGNITION,
        inspectionId: sampleKey(sourceName),
        notes: "The central blue hole was not detected clearly in the local sample image.",
      };
    }
    const cx = sxBlue / nBlue;
    const cy = syBlue / nBlue;
    const blueDistances = [];
    const metalDistances = [];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = y * size + x;
        const d = Math.hypot(x - cx, y - cy);
        if (d > size * 0.55) continue;
        if (blue[idx] && d < size * 0.32) blueDistances.push(d);
        if (!blue[idx] && gray[idx] > 35 && d > size * 0.18) metalDistances.push(d);
      }
    }
    const innerR = Math.max(size * 0.09, percentile(blueDistances, 92));
    const physicalOuterR = innerR * SAMPLE_OUTER_TO_INNER_RADIUS;
    const imageLimitedOuterR = size * 0.47;
    const outerR = Math.min(imageLimitedOuterR, physicalOuterR);
    if (!Number.isFinite(innerR) || !Number.isFinite(outerR) || outerR <= innerR * 1.6) {
      return {
        ...UNKNOWN_RECOGNITION,
        inspectionId: sampleKey(sourceName),
        notes: "The washer annulus could not be isolated reliably in the local sample image.",
      };
    }

    const thetaBins = 360;
    const angularDark = new Float32Array(thetaBins);
    const angularCount = new Uint16Array(thetaBins);
    const relHist = new Float32Array(18);
    let edgeWeight = 0, diagonalWeight = 0, radialWeight = 0, tangentialWeight = 0;
    let ringPixels = 0;

    for (let y = 1; y < size - 1; y++) {
      for (let x = 1; x < size - 1; x++) {
        const idx = y * size + x;
        const dx = x - cx;
        const dy = y - cy;
        const rr = Math.hypot(dx, dy);
        if (rr < innerR * 1.12 || rr > outerR * 0.98 || blue[idx]) continue;
        ringPixels++;
        const theta = Math.atan2(dy, dx);
        const bin = Math.max(0, Math.min(thetaBins - 1, Math.floor(((theta + Math.PI) / (2 * Math.PI)) * thetaBins)));
        angularDark[bin] += Math.max(0, 170 - gray[idx]);
        angularCount[bin]++;

        const gx = -gray[idx - size - 1] - 2 * gray[idx - 1] - gray[idx + size - 1] + gray[idx - size + 1] + 2 * gray[idx + 1] + gray[idx + size + 1];
        const gy = -gray[idx - size - 1] - 2 * gray[idx - size] - gray[idx - size + 1] + gray[idx + size - 1] + 2 * gray[idx + size] + gray[idx + size + 1];
        const mag = Math.hypot(gx, gy);
        if (mag < 20) continue;
        let edgeAngle = Math.atan2(gy, gx);
        let rel = Math.abs(edgeAngle - theta);
        while (rel > Math.PI) rel -= Math.PI;
        rel = Math.abs(rel);
        if (rel > Math.PI / 2) rel = Math.PI - rel;
        const deg = rel * 180 / Math.PI;
        const h = Math.max(0, Math.min(relHist.length - 1, Math.floor(deg / 5)));
        relHist[h] += mag;
        edgeWeight += mag;
        if (deg < 16) radialWeight += mag;
        else if (deg > 74) tangentialWeight += mag;
        else diagonalWeight += mag;
      }
    }

    for (let i = 0; i < thetaBins; i++) {
      angularDark[i] = angularCount[i] ? angularDark[i] / angularCount[i] : 0;
    }
    if (ringPixels < size * size * 0.05) {
      return {
        ...UNKNOWN_RECOGNITION,
        inspectionId: sampleKey(sourceName),
        notes: "Too few annular texture pixels were isolated from the local sample image.",
      };
    }
    const smoothedDark = smoothCircular(angularDark, 2);
    const meanDark = angularDark.reduce((a, b) => a + b, 0) / thetaBins;
    const darkStd = Math.sqrt(angularDark.reduce((acc, v) => acc + (v - meanDark) ** 2, 0) / thetaBins);
    let peakCount = 0;
    for (let i = 0; i < thetaBins; i++) {
      const prev = smoothedDark[(i + thetaBins - 1) % thetaBins];
      const next = smoothedDark[(i + 1) % thetaBins];
      if (smoothedDark[i] > meanDark + darkStd * 0.45 && smoothedDark[i] >= prev && smoothedDark[i] >= next) peakCount++;
    }
    const total = edgeWeight || 1;
    const diagonalRatio = diagonalWeight / total;
    const radialRatio = radialWeight / total;
    const tangentialRatio = tangentialWeight / total;
    const lowAngle = relHist.slice(3, 8).reduce((a, b) => a + b, 0);
    const highAngle = relHist.slice(10, 15).reduce((a, b) => a + b, 0);
    const diagonalBalance = Math.min(lowAngle, highAngle) / Math.max(lowAngle, highAngle, 1);

    let family = "Rectangular pockets";
    let variant = "V2";
    let confidence = 0.48;
    let notes = `Detected ${peakCount} repeated angular texture peaks after isolating the central annular texture band using the 31.7/15.5 mm outer/inner diameter ratio.`;
    const manyCircumferentialRepeats = peakCount >= 18;
    if (manyCircumferentialRepeats && (radialRatio + tangentialRatio) >= diagonalRatio * 0.72) {
      family = "Rectangular pockets";
      variant = peakCount < 45 ? "V1" : peakCount < 90 ? "V2" : "V3";
      confidence = 0.72 + Math.min(0.18, peakCount / 360);
      notes += " Many repeated annular pockets suggest rectangular pockets.";
    } else if (diagonalRatio > 0.44 && diagonalBalance > 0.62) {
      family = "Chevron pockets";
      variant = peakCount < 52 ? "V1" : peakCount < 70 ? "V2" : "V3";
      confidence = 0.58 + Math.min(0.25, diagonalRatio * 0.25 + diagonalBalance * 0.12);
      notes += " Balanced diagonal edge families suggest V-shaped chevrons.";
    } else if (diagonalRatio > 0.42 && diagonalBalance <= 0.62) {
      family = "Logarithmic spiral grooves";
      variant = diagonalRatio < 0.49 ? "V1" : diagonalRatio < 0.57 ? "V2" : "V3";
      confidence = 0.55 + Math.min(0.25, diagonalRatio * 0.3 + (1 - diagonalBalance) * 0.1);
      notes += " One dominant diagonal edge family suggests spiral grooves.";
    } else if (tangentialRatio > radialRatio * 1.25 && peakCount <= 24) {
      family = "Staircase pockets";
      variant = peakCount < 7 ? "V1" : peakCount < 13 ? "V2" : "V3";
      confidence = 0.52 + Math.min(0.2, tangentialRatio * 0.24);
      notes += " Coarse banded/tangential structure suggests staircase pockets.";
    } else {
      family = "Rectangular pockets";
      variant = peakCount < 45 ? "V1" : peakCount < 90 ? "V2" : "V3";
      confidence = 0.50 + Math.min(0.22, (radialRatio + tangentialRatio) * 0.2);
      notes += " Mostly radial/tangential edges suggest rectangular pockets.";
    }
    const variantText = textureVariantDescription(family, variant);
    const inspectionId = sampleKey(sourceName);
    return {
      inspectionId,
      displayName: `${family} ${variant}${variantText ? ` - ${variantText}` : ""}`,
      family,
      variant,
      nominalDepth: "",
      confidence: Math.max(0, Math.min(0.95, confidence)),
      features: {
        peakCount,
        diagonalRatio,
        radialRatio,
        tangentialRatio,
        diagonalBalance,
      },
      notes,
    };
  } catch (error) {
    return {
      ...UNKNOWN_RECOGNITION,
      inspectionId: sampleKey(sourceName),
      notes: `Image recognition failed: ${error.message || error}`,
    };
  }
}

function smoothCircular(values, radius) {
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    let count = 0;
    for (let d = -radius; d <= radius; d++) {
      sum += values[(i + d + values.length) % values.length];
      count++;
    }
    out[i] = sum / count;
  }
  return out;
}

async function recognizeTexture(row, sampleBlob = null) {
  return sampleBlob ? await recognizeSampleImage(sampleBlob, row?.name || "") : recognitionForRow(row);
}

function textureVariantDescription(family, variant) {
  const table = {
    "Rectangular pockets": { V1: "coarse / 30 pockets", V2: "medium / 60 pockets", V3: "dense / 120 pockets" },
    "Staircase pockets": { V1: "coarse / 4 pockets", V2: "medium / 8 pockets", V3: "dense / 16 pockets" },
    "Logarithmic spiral grooves": { V1: "blunt / 50.28 deg", V2: "medium / 58.08 deg", V3: "sharp / 63.51 deg" },
    "Chevron pockets": { V1: "coarse / 60 deg", V2: "medium / 90 deg", V3: "dense / 120 deg" },
  };
  return table[family]?.[variant] || "";
}

function percentile(values, p) {
  if (!values.length) return NaN;
  const copy = Array.from(values).sort((a, b) => a - b);
  const idx = (copy.length - 1) * (p / 100);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? copy[lo] : copy[lo] * (hi - idx) + copy[hi] * (idx - lo);
}

function sampleFinite(values, maxSamples = 600000) {
  const out = [];
  const step = Math.max(1, Math.floor(values.length / maxSamples));
  for (let i = 0; i < values.length; i += step) {
    const v = values[i];
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

function finiteFraction(values) {
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    if (Number.isFinite(values[i])) count++;
  }
  return count / values.length;
}

function solve3x3(m, b) {
  const a = m.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < 3; i++) {
    let pivot = i;
    for (let r = i + 1; r < 3; r++) if (Math.abs(a[r][i]) > Math.abs(a[pivot][i])) pivot = r;
    [a[i], a[pivot]] = [a[pivot], a[i]];
    const div = a[i][i] || 1e-12;
    for (let c = i; c < 4; c++) a[i][c] /= div;
    for (let r = 0; r < 3; r++) {
      if (r === i) continue;
      const factor = a[r][i];
      for (let c = i; c < 4; c++) a[r][c] -= factor * a[i][c];
    }
  }
  return [a[0][3], a[1][3], a[2][3]];
}

function fitPlane(values, width, height, maxSamples = 350000, mask = null) {
  const step = Math.max(1, Math.floor(values.length / maxSamples));
  let n = 0, sx = 0, sy = 0, sz = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0;
  for (let i = 0; i < values.length; i += step) {
    if (mask && !mask[i]) continue;
    const z = values[i];
    if (!Number.isFinite(z)) continue;
    const x = (i % width) / Math.max(1, width - 1) - 0.5;
    const y = Math.floor(i / width) / Math.max(1, height - 1) - 0.5;
    n++; sx += x; sy += y; sz += z; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z;
  }
  return solve3x3([[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]], [sxz, syz, sz]);
}

function detrendPlane(values, width, height, mask = null) {
  const [a, b, c] = fitPlane(values, width, height, 350000, mask);
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const z = values[i];
    if (!Number.isFinite(z)) {
      out[i] = NaN;
      continue;
    }
    const x = (i % width) / Math.max(1, width - 1) - 0.5;
    const y = Math.floor(i / width) / Math.max(1, height - 1) - 0.5;
    out[i] = z - (a * x + b * y + c);
  }
  return out;
}

function levelUsingHigherLand(values, width, height) {
  const coarseAllLeveled = detrendPlane(values, width, height);
  const coarseCluster = clusterPlateaus(coarseAllLeveled, width, height);
  return detrendPlane(values, width, height, coarseCluster.highMask);
}

function kmeans1d(sample, k, iterations = 80) {
  const centers = [];
  for (let i = 0; i < k; i++) centers.push(percentile(sample, 10 + (80 * i) / Math.max(1, k - 1)));
  for (let iter = 0; iter < iterations; iter++) {
    const sums = Array(k).fill(0);
    const counts = Array(k).fill(0);
    for (const v of sample) {
      let best = 0, dist = Math.abs(v - centers[0]);
      for (let j = 1; j < k; j++) {
        const d = Math.abs(v - centers[j]);
        if (d < dist) { best = j; dist = d; }
      }
      sums[best] += v; counts[best]++;
    }
    const next = centers.map((old, i) => counts[i] ? sums[i] / counts[i] : old).sort((a, b) => a - b);
    const movement = next.reduce((acc, v, i) => acc + Math.abs(v - centers[i]), 0);
    centers.splice(0, centers.length, ...next);
    if (movement < 1e-6) break;
  }
  return centers;
}

function trimMask(values, labels, label, trimPercent) {
  const vals = [];
  for (let i = 0; i < values.length; i++) if (labels[i] === label) vals.push(values[i]);
  const lo = percentile(vals, trimPercent);
  const hi = percentile(vals, 100 - trimPercent);
  const mask = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) if (labels[i] === label && values[i] >= lo && values[i] <= hi) mask[i] = 1;
  return mask;
}

function trimExistingMask(values, mask, trimPercent) {
  if (trimPercent <= 0) return mask;
  const vals = [];
  for (let i = 0; i < values.length; i++) if (mask[i]) vals.push(values[i]);
  if (!vals.length) return mask;
  const lo = percentile(vals, trimPercent);
  const hi = percentile(vals, 100 - trimPercent);
  const trimmed = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) {
    if (mask[i] && values[i] >= lo && values[i] <= hi) trimmed[i] = 1;
  }
  return trimmed;
}

function erodeMask(mask, width, height, radius) {
  if (radius <= 0) return mask;
  let current = mask;
  for (let pass = 0; pass < radius; pass++) {
    const next = new Uint8Array(mask.length);
    for (let y = 1; y < height - 1; y++) {
      const row = y * width;
      for (let x = 1; x < width - 1; x++) {
        const i = row + x;
        if (
          current[i] &&
          current[i - 1] &&
          current[i + 1] &&
          current[i - width] &&
          current[i + width] &&
          current[i - width - 1] &&
          current[i - width + 1] &&
          current[i + width - 1] &&
          current[i + width + 1]
        ) {
          next[i] = 1;
        }
      }
    }
    current = next;
  }
  return current;
}

function gradientFilteredMask(values, mask, width, height, rejectPercent) {
  if (rejectPercent <= 0) return mask;
  const gradients = [];
  const step = Math.max(1, Math.floor(values.length / 500000));
  for (let y = 1; y < height - 1; y += step) {
    for (let x = 1; x < width - 1; x += step) {
      const i = y * width + x;
      if (!mask[i]) continue;
      const left = values[i - 1];
      const right = values[i + 1];
      const up = values[i - width];
      const down = values[i + width];
      if ([left, right, up, down].every(Number.isFinite)) {
        gradients.push(Math.hypot(right - left, down - up) * 0.5);
      }
    }
  }
  if (!gradients.length) return mask;
  const threshold = percentile(gradients, 100 - rejectPercent);
  const filtered = new Uint8Array(values.length);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (!mask[i]) continue;
      const left = values[i - 1];
      const right = values[i + 1];
      const up = values[i - width];
      const down = values[i + width];
      if (![left, right, up, down].every(Number.isFinite)) continue;
      const g = Math.hypot(right - left, down - up) * 0.5;
      if (g <= threshold) filtered[i] = 1;
    }
  }
  return filtered;
}

function countMask(mask) {
  let count = 0;
  for (let i = 0; i < mask.length; i++) count += mask[i] ? 1 : 0;
  return count;
}

function clusterPlateaus(values, width, height) {
  const sample = sampleFinite(values, options.maxSamples);
  const clipLo = percentile(sample, options.clipPercent);
  const clipHi = percentile(sample, 100 - options.clipPercent);
  const clipped = sample.map((v) => Math.min(clipHi, Math.max(clipLo, v)));
  const centers = kmeans1d(clipped, options.clusters);
  const labels = new Int8Array(values.length);
  labels.fill(-1);
  const counts = Array(options.clusters).fill(0);
  for (let i = 0; i < values.length; i++) {
    const raw = values[i];
    if (!Number.isFinite(raw)) continue;
    const v = Math.min(clipHi, Math.max(clipLo, raw));
    let best = 0, dist = Math.abs(v - centers[0]);
    for (let j = 1; j < centers.length; j++) {
      const d = Math.abs(v - centers[j]);
      if (d < dist) { best = j; dist = d; }
    }
    labels[i] = best;
    counts[best]++;
  }
  const plateau = counts.map((count, label) => ({ count, label })).sort((a, b) => b.count - a.count).slice(0, 2).map((x) => x.label).sort((a, b) => centers[a] - centers[b]);
  const lowAssigned = new Uint8Array(values.length);
  const highAssigned = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) {
    if (labels[i] === plateau[0]) lowAssigned[i] = 1;
    if (labels[i] === plateau[1]) highAssigned[i] = 1;
  }
  let lowCore = erodeMask(lowAssigned, width, height, options.edgeRadiusPx);
  let highCore = erodeMask(highAssigned, width, height, options.edgeRadiusPx);
  if (countMask(lowCore) < 100 || countMask(highCore) < 100) {
    lowCore = lowAssigned;
    highCore = highAssigned;
  }
  lowCore = gradientFilteredMask(values, lowCore, width, height, options.gradientRejectPercent);
  highCore = gradientFilteredMask(values, highCore, width, height, options.gradientRejectPercent);
  lowCore = trimExistingMask(values, lowCore, options.trimPercent);
  highCore = trimExistingMask(values, highCore, options.trimPercent);
  if (countMask(lowCore) < 100 || countMask(highCore) < 100) {
    lowCore = trimMask(values, labels, plateau[0], options.trimPercent);
    highCore = trimMask(values, labels, plateau[1], options.trimPercent);
  }
  return {
    width,
    height,
    labels,
    centers,
    counts,
    lowLabel: plateau[0],
    highLabel: plateau[1],
    lowAssigned,
    highAssigned,
    lowMask: lowCore,
    highMask: highCore,
  };
}

function statsForMask(values, mask) {
  let n = 0, sum = 0;
  const vals = [];
  for (let i = 0; i < values.length; i++) if (mask[i]) { vals.push(values[i]); sum += values[i]; n++; }
  const mean = sum / n;
  let abs = 0, sq = 0, min = Infinity, max = -Infinity;
  for (const v of vals) {
    const d = v - mean;
    abs += Math.abs(d); sq += d * d; min = Math.min(min, v); max = Math.max(max, v);
  }
  return { points: n, mean, median: percentile(vals, 50), Sa: abs / n, Sq: Math.sqrt(sq / n), Sp: max - mean, Sv: mean - min, Sz: max - min };
}

function paletteColor(t) {
  const scaled = Math.max(0, Math.min(1, t)) * (PALETTE.length - 1);
  const i = Math.min(PALETTE.length - 2, Math.floor(scaled));
  const f = scaled - i;
  return PALETTE[i].map((c, j) => Math.round(c * (1 - f) + PALETTE[i + 1][j] * f));
}

function isContourPixel(mask, idx, width, height) {
  if (!mask || !mask[idx]) return false;
  const x = idx % width;
  const y = Math.floor(idx / width);
  if (x === 0 || y === 0 || x === width - 1 || y === height - 1) return true;
  return !(
    mask[idx - 1] &&
    mask[idx + 1] &&
    mask[idx - width] &&
    mask[idx + width] &&
    mask[idx - width - 1] &&
    mask[idx - width + 1] &&
    mask[idx + width - 1] &&
    mask[idx + width + 1]
  );
}

function contourColor(cluster, idx) {
  if (!cluster) return null;
  if (isContourPixel(cluster.lowMask, idx, cluster.width, cluster.height)) return [0, 240, 255];
  if (isContourPixel(cluster.highMask, idx, cluster.width, cluster.height)) return [255, 255, 255];
  return null;
}

function renderHeatmap(values, width, height, cluster = null, maxW = 520) {
  const sample = sampleFinite(values, 500000);
  const lo = percentile(sample, 1);
  const hi = percentile(sample, 99);
  const scale = Math.min(1, maxW / width);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(height - 1, Math.floor(y / scale));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(width - 1, Math.floor(x / scale));
      const idx = sy * width + sx;
      const v = values[sy * width + sx];
      const p = (y * w + x) * 4;
      let color = Number.isFinite(v) ? paletteColor((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) : [28, 28, 28];
      color = contourColor(cluster, idx) || color;
      img.data[p] = color[0]; img.data[p + 1] = color[1]; img.data[p + 2] = color[2]; img.data[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { url: canvas.toDataURL("image/png"), low: lo, high: hi };
}

function renderClusterMask(cluster, width, height, maxW = 520) {
  const scale = Math.min(1, maxW / width);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(height - 1, Math.floor(y / scale));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(width - 1, Math.floor(x / scale));
      const idx = sy * width + sx;
      let color = [28, 28, 28];
      if (cluster.labels[idx] >= 0) color = [230, 145, 30];
      if (cluster.labels[idx] === cluster.lowLabel) color = [88, 120, 220];
      if (cluster.labels[idx] === cluster.highLabel) color = [110, 205, 90];
      if (cluster.lowMask[idx]) color = [0, 45, 220];
      if (cluster.highMask[idx]) color = [0, 170, 35];
      color = contourColor(cluster, idx) || color;
      const p = (y * w + x) * 4;
      img.data[p] = color[0]; img.data[p + 1] = color[1]; img.data[p + 2] = color[2]; img.data[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}

function analyze(measurement) {
  let values = measurement.values;
  if (options.detrend && options.levelMode === "higher-land") {
    values = levelUsingHigherLand(measurement.values, measurement.width, measurement.height);
  } else if (options.detrend) {
    values = detrendPlane(measurement.values, measurement.width, measurement.height);
  }
  const cluster = clusterPlateaus(values, measurement.width, measurement.height);
  const low = statsForMask(values, cluster.lowMask);
  const high = statsForMask(values, cluster.highMask);
  const heatmap = renderHeatmap(values, measurement.width, measurement.height, cluster);
  const maskUrl = renderClusterMask(cluster, measurement.width, measurement.height);
  const measuredFraction = finiteFraction(values);
  return {
    ...measurement,
    values: null,
    levelMode: options.detrend ? options.levelMode : "none",
    edgeRadiusPx: options.edgeRadiusPx,
    gradientRejectPercent: options.gradientRejectPercent,
    low,
    high,
    heatmap,
    maskUrl,
    clusterCenters: cluster.centers,
    measuredFraction,
    heightDifference: high.mean - low.mean,
  };
}

function runWorkerJob(worker, item, jobOptions, id) {
  return new Promise((resolve, reject) => {
    worker.onmessage = (event) => {
      const message = event.data;
      if (message.id !== id) return;
      if (message.ok) {
        const result = message.result;
        for (const key of ["rawHeatmap", "detrendedHeatmap", "interpolatedHeatmap", "heatmap"]) {
          if (result[key]?.blob) {
            result[key].url = URL.createObjectURL(result[key].blob);
            delete result[key].blob;
          }
        }
        result.maskUrl = URL.createObjectURL(result.maskBlob);
        delete result.maskBlob;
        resolve(result);
      }
      else reject(new Error(message.error || "Worker failed to analyze PLUX file."));
    };
    worker.onerror = (event) => reject(new Error(event.message || "Worker crashed."));
    worker.postMessage({ id, name: item.name, buffer: item.buffer, options: jobOptions }, [item.buffer]);
  });
}

async function analyzeSingleItem(item, jobOptions) {
  const worker = new Worker("./src/plux-worker.js");
  try {
    return await runWorkerJob(worker, item, jobOptions, `single-${Date.now()}`);
  } finally {
    worker.terminate();
  }
}

async function analyzeWithWorkers(items, jobOptions) {
  if (!("Worker" in window)) {
    throw new Error("This browser does not support Web Workers.");
  }
  const workerTotal = Math.min(jobOptions.workerCount, items.length);
  const workers = Array.from({ length: workerTotal }, () => new Worker("./src/plux-worker.js"));
  const completed = [];
  let next = 0;
  let done = 0;

  async function runLane(worker, lane) {
    while (next < items.length) {
      const index = next++;
      const item = items[index];
      setStatus(`Processing ${done + 1}-${Math.min(done + workerTotal, items.length)}/${items.length} with ${workerTotal} CPU workers...`, true);
      const result = await runWorkerJob(worker, item, jobOptions, `${lane}-${index}`);
      result.sourceName = item.name;
      if (item.sampleImage) {
        result.sampleImageName = item.sampleImage.name;
        result.sampleImageUrl = URL.createObjectURL(item.sampleImage.blob);
      }
      result.recognition = await recognizeTexture(result, item.sampleImage?.blob || null);
      completed[index] = result;
      done++;
      results = completed.filter(Boolean);
      renderResults();
    }
  }

  try {
    await Promise.all(workers.map((worker, lane) => runLane(worker, lane)));
  } finally {
    for (const worker of workers) worker.terminate();
  }
  return completed.filter(Boolean);
}

async function handleFiles(fileList) {
  lastUploadFiles = Array.from(fileList || []);
  await processFiles(lastUploadFiles);
}

async function rerunAnalysis() {
  if (!lastUploadFiles.length || isAnalyzing) return;
  await processFiles(lastUploadFiles);
}

async function rerunSingleResult(resultIndex) {
  const current = results[resultIndex];
  if (!current || isAnalyzing) return;
  readOptions();
  const denoiseInput = document.getElementById(`denoise-${resultIndex}`);
  const epsilonInput = document.getElementById(`epsilon-${resultIndex}`);
  const localOptions = {
    ...options,
    fftDenoiseStrength: Number(denoiseInput?.value ?? current.fftDenoiseStrength ?? options.fftDenoiseStrength),
    boundaryEpsilonPx: Number(epsilonInput?.value ?? current.boundaryEpsilonPx ?? options.boundaryEpsilonPx),
  };
  isAnalyzing = true;
  mapStatuses[resultIndex] = {
    busy: true,
    text: `Rerunning ${current.name.split(/[\\/]/).pop()} with FFT ${localOptions.fftDenoiseStrength}% and boundary epsilon ${localOptions.boundaryEpsilonPx}px...`,
  };
  renderResults();
  updateSummary();
  try {
    const upload = await expandUploads(lastUploadFiles);
    const items = upload.items;
    const sourceName = current.sourceName || current.name;
    const item = items.find((candidate) => candidate.name === sourceName || candidate.name === current.name);
    if (!item) throw new Error(`Could not find the local source for ${current.name}. Load the file again, then rerun.`);
    const updated = await analyzeSingleItem(item, localOptions);
    updated.sourceName = item.name;
    if (item.sampleImage) {
      updated.sampleImageName = item.sampleImage.name;
      updated.sampleImageUrl = URL.createObjectURL(item.sampleImage.blob);
    }
    updated.recognition = await recognizeTexture(updated, item.sampleImage?.blob || null);
    releaseResultUrls([results[resultIndex]]);
    results[resultIndex] = updated;
    mapStatuses[resultIndex] = {
      busy: false,
      text: `Updated with FFT ${localOptions.fftDenoiseStrength}% and boundary epsilon ${localOptions.boundaryEpsilonPx}px.`,
    };
    renderResults();
  } catch (error) {
    console.error(error);
    mapStatuses[resultIndex] = {
      busy: false,
      error: true,
      text: error.message || "Failed to rerun this map.",
    };
    renderResults();
  } finally {
    isAnalyzing = false;
    updateSummary();
  }
}

async function processFiles(files) {
  readOptions();
  if (!files.length) return;
  isAnalyzing = true;
  setStatus("Reading local files...", true);
  updateSummary();
  releaseResultUrls(results);
  releaseOverviewUrls(reportOverviewImages);
  results = [];
  reportOverviewImages = {};
  mapStatuses = {};
  renderResults();
  try {
    const upload = await expandUploads(files);
    const items = upload.items;
    reportOverviewImages = makeOverviewUrls(upload.overviewImages);
    if (!items.length) {
      setStatus("No .plux files found in the loaded files.");
      return;
    }
    results = await analyzeWithWorkers(items, options);
    renderResults();
    setStatus(`Processed ${results.length} PLUX file${results.length === 1 ? "" : "s"}.`);
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Failed to process files.");
  } finally {
    isAnalyzing = false;
    updateSummary();
  }
}

function fmt(value, digits = 3) {
  return Number.isFinite(value) ? value.toFixed(digits) : "";
}

function colorScale(heatmap) {
  const lo = fmt(heatmap.low);
  const hi = fmt(heatmap.high);
  const mid = escapeHtml(heatmap.zeroLabel || "0 um land mean");
  return `
    <div class="colorScale" aria-label="Height color scale">
      <div class="colorBar"></div>
      <div class="scaleTicks">
        <span>${lo} um</span>
        <span>${mid}</span>
        <span>${hi} um</span>
      </div>
    </div>
  `;
}

function renderResults() {
  const content = document.getElementById("content");
  if (!results.length) {
    content.className = "empty";
    content.innerHTML = `<h2>No measurements loaded</h2><p>The table will show each detrended height map, cluster mask, and plateau statistics after loading local files.</p>`;
    updateSummary();
    return;
  }
  content.className = "results";
  content.innerHTML = `${recognitionSummaryHtml()}${results.map((r, idx) => {
    const recognition = recognitionForRow(r);
    return `
    <article class="result">
      <header>
        <div>
          <h2>${escapeHtml(recognition.inspectionId || r.name.split(/[\\/]/).pop())} - ${escapeHtml(recognition.displayName)}</h2>
          <p class="recognitionLine">Recognition confidence ${(recognition.confidence * 100).toFixed(0)}% - ${escapeHtml(recognition.notes || "")}</p>
          <p>${r.width} x ${r.height} pixels - measured ${(r.measuredFraction * 100).toFixed(1)}% - interpolated ${Number(r.interpolatedPoints || 0).toLocaleString()} points - leveling ${r.levelMode} - segmentation ${r.segmentationMode} - FFT denoise ${fmt(r.fftDenoiseStrength, 0)}% - boundary epsilon ${fmt(r.boundaryEpsilonPx, 0)} px - edge sigma ${fmt(r.edgeSigmaPx, 1)} px - ridge offset ${fmt(r.ridgeOffsetPx, 0)} px - minimum region ${fmt(r.minRegionPercent, 1)}% - centers ${r.clusterCenters.map((c) => fmt(c)).join(", ")} um</p>
        </div>
        <div class="resultActions">
          <div class="runControls">
            <span class="stepValue">${fmt(r.heightDifference)} um step</span>
            <label title="FFT low-pass denoise strength used for segmentation only. Higher values remove more high-frequency content before clustering.">FFT % <input id="denoise-${idx}" type="number" min="0" max="100" step="1" value="${fmt(r.fftDenoiseStrength, 0)}" /></label>
            <label title="Douglas-Peucker boundary simplification epsilon in pixels. Larger values use fewer boundary points and make the border more geometric.">Boundary ε <input id="epsilon-${idx}" type="number" min="0" max="200" step="1" value="${fmt(r.boundaryEpsilonPx, 0)}" /></label>
            <button class="${rerunButtonClass(idx)}" data-rerun="${idx}" ${mapStatuses[idx]?.busy ? "disabled" : ""}>${mapStatuses[idx]?.busy ? "Running..." : "Rerun Map"}</button>
          </div>
          ${mapStatusMarkup(idx)}
        </div>
      </header>
      <div class="visuals ${r.sampleImageUrl ? "withSampleImage" : ""}">
        ${r.sampleImageUrl ? `
        <figure>
          <img src="${r.sampleImageUrl}" alt="Raw sample photo ${idx + 1}" />
          <figcaption>1. Raw sample image - ${escapeHtml(r.sampleImageName || "")}</figcaption>
        </figure>
        ` : ""}
        <figure>
          <img src="${(r.rawHeatmap || r.heatmap).url}" alt="Raw height map ${idx + 1}" />
          ${colorScale(r.rawHeatmap || r.heatmap)}
          <figcaption>${r.sampleImageUrl ? "2" : "1"}. Raw height map - original measured pixels, no detrend, no interpolation</figcaption>
        </figure>
        <figure>
          <img src="${(r.detrendedHeatmap || r.heatmap).url}" alt="Detrended measured height map ${idx + 1}" />
          ${colorScale(r.detrendedHeatmap || r.heatmap)}
          <figcaption>${r.sampleImageUrl ? "3" : "2"}. Detrended height map - measured pixels only, no interpolation</figcaption>
        </figure>
        <figure>
          <img src="${(r.interpolatedHeatmap || r.heatmap).url}" alt="Detrended and interpolated height map ${idx + 1}" />
          ${colorScale(r.interpolatedHeatmap || r.heatmap)}
          <figcaption>${r.sampleImageUrl ? "4" : "3"}. Detrended + interpolated height map - cyan basin outline, white land outline</figcaption>
        </figure>
        <figure>
          <img src="${r.maskUrl}" alt="Cluster mask ${idx + 1}" />
          <figcaption>
            <span>${r.sampleImageUrl ? "5" : "4"}. Measurement mask - ${r.segmentationMode}, boundary epsilon ${fmt(r.boundaryEpsilonPx, 0)} px</span>
            <span class="legend">
              <span><i class="swatch basinCore"></i>Basin region, measured</span>
              <span><i class="swatch basinAssigned"></i>Initial basin pixels cleaned out</span>
              <span><i class="swatch landCore"></i>Land region, measured</span>
              <span><i class="swatch landAssigned"></i>Initial land pixels cleaned out</span>
              <span><i class="swatch excluded"></i>Transition or other cluster</span>
              <span><i class="swatch invalid"></i>Invalid or unmeasured</span>
              <span><i class="swatch basinContour"></i>Cyan basin region outline</span>
              <span><i class="swatch landContour"></i>White land region outline</span>
            </span>
          </figcaption>
        </figure>
      </div>
      <table>
        <thead><tr><th>Region</th><th>Mean um</th><th>Sa um</th><th>Sq um</th><th>Sz um</th><th>Points</th><th>Area %</th><th>Area px</th><th>Polygons</th></tr></thead>
        <tbody>
          <tr><td>Lower basin</td><td>${fmt(r.low.mean)}</td><td>${fmt(r.low.Sa)}</td><td>${fmt(r.low.Sq)}</td><td>${fmt(r.low.Sz)}</td><td>${r.low.points.toLocaleString()}</td><td>${fmt(r.lowArea?.percent)}</td><td>${(r.lowArea?.pixels || 0).toLocaleString()}</td><td>${(r.lowArea?.components?.length || 0).toLocaleString()}</td></tr>
          <tr><td>Higher land</td><td>${fmt(r.high.mean)}</td><td>${fmt(r.high.Sa)}</td><td>${fmt(r.high.Sq)}</td><td>${fmt(r.high.Sz)}</td><td>${r.high.points.toLocaleString()}</td><td>${fmt(r.highArea?.percent)}</td><td>${(r.highArea?.pixels || 0).toLocaleString()}</td><td>${(r.highArea?.components?.length || 0).toLocaleString()}</td></tr>
        </tbody>
      </table>
    </article>
  `}).join("")}`;
  for (const button of content.querySelectorAll("[data-rerun]")) {
    button.onclick = () => rerunSingleResult(Number(button.dataset.rerun));
  }
  updateSummary();
}

function mapStatusMarkup(idx) {
  const state = mapStatuses[idx];
  const text = state?.text || "Ready";
  const cls = state?.error ? "mapStatus error" : state?.busy ? "mapStatus busy" : state?.text ? "mapStatus done" : "mapStatus idle";
  return `<div class="${cls}">${state?.busy ? '<i class="miniSpinner"></i>' : '<i class="miniDot"></i>'}${escapeHtml(text)}</div>`;
}

function rerunButtonClass(idx) {
  const state = mapStatuses[idx];
  if (state?.error) return "rerunMapButton error";
  if (state?.busy) return "rerunMapButton running";
  if (state?.text) return "rerunMapButton done";
  return "rerunMapButton ready";
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[ch]));
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function exportCsv(rows) {
  const headers = ["file", "inspection_id", "recognized_name", "recognized_family", "recognized_variant", "recognition_confidence", "recognition_notes", "date", "width", "height", "level_mode", "segmentation_mode", "smooth_radius_px", "boundary_epsilon_px", "edge_sigma_px", "edge_percentile", "ridge_offset_px", "min_region_percent", "fft_denoise_percent", "interpolated_points", "measured_fraction", "low_mean_um", "low_Sa_um", "low_Sq_um", "low_points", "low_area_percent", "low_area_pixels", "low_polygon_count", "low_polygon_areas_percent", "low_polygon_areas_pixels", "high_mean_um", "high_Sa_um", "high_Sq_um", "high_points", "high_area_percent", "high_area_pixels", "high_polygon_count", "high_polygon_areas_percent", "high_polygon_areas_pixels", "height_difference_um", "cluster_centers_um", "objective"];
  const body = rows.map((r) => {
    const rec = recognitionForRow(r);
    return [r.name, rec.inspectionId, rec.displayName, rec.family, rec.variant, rec.confidence, rec.notes, r.date, r.width, r.height, r.levelMode, r.segmentationMode, r.smoothRadiusPx, r.boundaryEpsilonPx, r.edgeSigmaPx, r.edgePercentile, r.ridgeOffsetPx, r.minRegionPercent, r.fftDenoiseStrength, r.interpolatedPoints, r.measuredFraction, r.low.mean, r.low.Sa, r.low.Sq, r.low.points, r.lowArea?.percent, r.lowArea?.pixels, r.lowArea?.components?.length || 0, (r.lowArea?.components || []).map((c) => fmt(c.areaPercent, 4)).join("; "), (r.lowArea?.components || []).map((c) => c.areaPx).join("; "), r.high.mean, r.high.Sa, r.high.Sq, r.high.points, r.highArea?.percent, r.highArea?.pixels, r.highArea?.components?.length || 0, (r.highArea?.components || []).map((c) => fmt(c.areaPercent, 4)).join("; "), (r.highArea?.components || []).map((c) => c.areaPx).join("; "), r.heightDifference, r.clusterCenters.map((c) => fmt(c, 4)).join("; "), r.objective];
  });
  const csv = [headers, ...body].map((row) => row.map(csvEscape).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "plux_plateau_statistics.csv";
  a.click();
  URL.revokeObjectURL(url);
}

function recognitionSummaryHtml() {
  return `<section class="summaryCard">
    <div class="summaryHeader">
      <div>
        <h2>Recognized Sample Names</h2>
        <p>Local image recognition is heuristic. Use the confidence and notes as a quick check before sending a final report.</p>
      </div>
    </div>
    <table class="summaryTable">
      <thead><tr><th>Inspection ID</th><th>Recognized texture</th><th>Family</th><th>Variant</th><th>Measured step um</th><th>Date/time</th><th>Confidence</th></tr></thead>
      <tbody>${results.map((r) => {
        const rec = recognitionForRow(r);
        return `<tr>
          <td>${escapeHtml(rec.inspectionId || "-")}</td>
          <td>${escapeHtml(rec.displayName)}</td>
          <td>${escapeHtml(rec.family)}</td>
          <td>${escapeHtml(rec.variant || "-")}</td>
          <td>${fmt(r.heightDifference)}</td>
          <td>${escapeHtml(r.date || "")}</td>
          <td>${(rec.confidence * 100).toFixed(0)}%</td>
        </tr>`;
      }).join("")}</tbody>
    </table>
  </section>`;
}

function exportPdfReport() {
  if (!results.length) return;
  const report = window.open("", "_blank");
  if (!report) {
    setStatus("Popup blocked. Allow popups, then export the PDF report again.");
    return;
  }
  report.document.write(buildReportHtml());
  report.document.close();
  report.focus();
  setTimeout(() => report.print(), 800);
}

function buildReportHtml() {
  const generated = new Date().toLocaleString();
  const averageStep = results.reduce((acc, r) => acc + r.heightDifference, 0) / results.length;
  const optionRows = [
    ["Segmentation", options.segmentationMode],
    ["Leveling basis", options.detrend ? options.levelMode : "none"],
    ["Clusters", options.clusters],
    ["Clip tails %", options.clipPercent],
    ["Area smoothing px", options.smoothRadiusPx],
    ["Boundary epsilon px", options.boundaryEpsilonPx],
    ["Edge sigma px", options.edgeSigmaPx],
    ["Edge percentile", options.edgePercentile],
    ["Ridge offset px", options.ridgeOffsetPx],
    ["Minimum region %", options.minRegionPercent],
    ["FFT denoise %", options.fftDenoiseStrength],
  ];
  const hasImages = results.some((r) => r.sampleImageUrl);
  const hasOverview = Boolean(reportOverviewImages.raw || reportOverviewImages.labelled);
  return `<!doctype html><html><head><meta charset="utf-8" />
    <title>PLUX Surface Analysis Report</title>
    <style>
      * { box-sizing: border-box; }
      body { font-family: Arial, sans-serif; color: #17202a; margin: 0; font-size: 11px; }
      h1 { margin: 0 0 3px; font-size: 22px; }
      h2 { margin: 0; font-size: 16px; break-after: avoid; }
      p { color: #536174; margin: 3px 0 6px; line-height: 1.35; }
      table { width: 100%; border-collapse: collapse; font-size: 10.5px; margin: 7px 0 0; }
      th, td { border-bottom: 1px solid #d8e0e8; padding: 5px 6px; text-align: right; }
      th:first-child, td:first-child { text-align: left; }
      .cover { padding: 9mm 10mm 4mm; }
      .cover.withOverview { min-height: 203mm; page-break-after: always; }
      .summaryPage { padding: 8mm 10mm; page-break-after: always; min-height: 203mm; }
      .setup { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px 12px; margin-top: 8px; max-width: none; }
      .setup div { border-bottom: 1px solid #d8e0e8; padding: 3px 0; }
      .setup b { display: block; color: #536174; font-size: 9px; text-transform: uppercase; letter-spacing: .03em; }
      .overviewPlots { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 8px 0 10px; }
      .overviewPlots figure img { height: 118mm; }
      .overviewPlots figcaption { min-height: 0; }
      .sample { break-inside: avoid; page-break-after: always; padding: 7mm 8mm 5mm; min-height: 186mm; }
      .sample:last-child { page-break-after: auto; }
      .sampleHeader { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: start; border-bottom: 2px solid #e1e8f0; padding-bottom: 5px; margin-bottom: 6px; }
      .stepValue { color: #06732f; font-weight: 700; font-size: 14px; white-space: nowrap; }
      .plots { display: grid; grid-template-columns: repeat(${hasImages ? 5 : 4}, minmax(0, 1fr)); gap: 7px; align-items: stretch; }
      figure { margin: 0; border: 1px solid #d8e0e8; border-radius: 4px; overflow: hidden; background: #f8fafc; display: flex; flex-direction: column; min-width: 0; }
      figure img { display: block; width: 100%; height: 106px; object-fit: contain; background: #eef3f8; }
      figcaption { font-size: 9.5px; padding: 5px 6px; color: #536174; border-top: 1px solid #d8e0e8; line-height: 1.25; min-height: 36px; }
      .colorScale { padding: 5px 6px 0; }
      .colorBar { height: 9px; border-radius: 2px; background: linear-gradient(90deg, #440154, #31688e, #35b779, #fde725, #f89540, #b40426); }
      .scaleTicks { display: flex; justify-content: space-between; gap: 6px; color: #536174; font-size: 8.5px; padding-top: 3px; }
      .legend { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 7px; margin-top: 5px; color: #536174; font-size: 8.5px; }
      .legend span { display: flex; align-items: center; gap: 4px; }
      .swatch { width: 8px; height: 8px; border-radius: 2px; flex: 0 0 auto; border: 1px solid rgba(0,0,0,.08); }
      .basinCore { background: #0539d9; }
      .basinAssigned { background: #5c7ed6; }
      .landCore { background: #08aa32; }
      .landAssigned { background: #69c85c; }
      .excluded { background: #f2a020; }
      .invalid { background: #111; }
      .basinContour { background: #2fd7df; }
      .landContour { background: #fff; }
      @page { size: A4 landscape; margin: 0; }
      @media print { body { margin: 0; } }
    </style></head><body>
    <section class="cover ${hasOverview ? "withOverview" : ""}">
      <h1>PLUX Surface Analysis Report</h1>
      <p>Generated ${escapeHtml(generated)}. ${results.length} PLUX files processed. Average height step ${fmt(averageStep)} um.</p>
      ${reportOverviewHtml()}
    </section>
    ${reportSummaryPageHtml(optionRows)}
    ${results.map(reportSampleHtml).join("")}
  </body></html>`;
}

function reportSummaryPageHtml(optionRows) {
  return `<section class="summaryPage">
    <h1>Sample Summary</h1>
    <p>Texture names are recognized locally from the loaded sample images. Confidence is a diagnostic value for checking the automatic labels.</p>
    <h2>Setup Parameters</h2>
    <div class="setup">${optionRows.map(([k, v]) => `<div><b>${escapeHtml(k)}</b>${escapeHtml(v)}</div>`).join("")}</div>
    <h2 style="margin-top:8px;">Recognized Sample Names and Statistics</h2>
    <table>
      <thead><tr><th>Inspection ID</th><th>Recognized texture</th><th>Variant</th><th>Date/time</th><th>Step um</th><th>Basin Sa</th><th>Basin Sq</th><th>Land Sa</th><th>Land Sq</th><th>Confidence</th></tr></thead>
      <tbody>${results.map((r) => {
        const rec = recognitionForRow(r);
        return `<tr>
          <td>${escapeHtml(rec.inspectionId || "-")}</td>
          <td>${escapeHtml(rec.displayName)}</td>
          <td>${escapeHtml(rec.variant || "-")}</td>
          <td>${escapeHtml(r.date || "")}</td>
          <td>${fmt(r.heightDifference)}</td>
          <td>${fmt(r.low.Sa)}</td>
          <td>${fmt(r.low.Sq)}</td>
          <td>${fmt(r.high.Sa)}</td>
          <td>${fmt(r.high.Sq)}</td>
          <td>${(rec.confidence * 100).toFixed(0)}%</td>
        </tr>`;
      }).join("")}</tbody>
    </table>
  </section>`;
}

function reportOverviewHtml() {
  const plots = [];
  if (reportOverviewImages.raw) {
    plots.push(reportPlotHtml(`Inspection samples ID - raw<br>${escapeHtml(reportOverviewImages.raw.name)}`, reportOverviewImages.raw.url));
  }
  if (reportOverviewImages.labelled) {
    plots.push(reportPlotHtml(`Inspection samples ID - labelled P00xx<br>${escapeHtml(reportOverviewImages.labelled.name)}`, reportOverviewImages.labelled.url));
  }
  return plots.length ? `<div class="overviewPlots">${plots.join("")}</div>` : "";
}

function reportSampleHtml(r, idx) {
  const start = r.sampleImageUrl ? 2 : 1;
  const recognition = recognitionForRow(r);
  return `<section class="sample">
    <div class="sampleHeader">
      <div>
        <h2>${idx + 1}. ${escapeHtml(recognition.inspectionId || r.name.split(/[\\/]/).pop())} - ${escapeHtml(recognition.displayName)}</h2>
        <p>Recognition confidence ${(recognition.confidence * 100).toFixed(0)}%. ${escapeHtml(recognition.notes || "")}</p>
        <p>${reportSampleMeta(r)}</p>
      </div>
      <div class="stepValue">${fmt(r.heightDifference)} um step</div>
    </div>
    <div class="plots">
      ${r.sampleImageUrl ? reportPlotHtml(escapeHtml("1. Raw sample image - " + (r.sampleImageName || "")), r.sampleImageUrl) : ""}
      ${reportPlotHtml(escapeHtml(`${start}. Raw height map - original measured pixels, no detrend, no interpolation`), (r.rawHeatmap || r.heatmap).url, r.rawHeatmap || r.heatmap)}
      ${reportPlotHtml(escapeHtml(`${start + 1}. Detrended height map - measured pixels only, no interpolation`), (r.detrendedHeatmap || r.heatmap).url, r.detrendedHeatmap || r.heatmap)}
      ${reportPlotHtml(escapeHtml(`${start + 2}. Detrended + interpolated height map - cyan basin outline, white land outline`), (r.interpolatedHeatmap || r.heatmap).url, r.interpolatedHeatmap || r.heatmap)}
      ${reportPlotHtml(`${escapeHtml(`${start + 3}. Measurement mask - ${r.segmentationMode}, boundary epsilon ${fmt(r.boundaryEpsilonPx, 0)} px`)}${reportLegendHtml()}`, r.maskUrl)}
    </div>
    <table>
      <thead><tr><th>Region</th><th>Mean um</th><th>Sa um</th><th>Sq um</th><th>Sz um</th><th>Points</th><th>Area %</th><th>Area px</th><th>Polygons</th></tr></thead>
      <tbody>
        <tr><td>Lower basin</td><td>${fmt(r.low.mean)}</td><td>${fmt(r.low.Sa)}</td><td>${fmt(r.low.Sq)}</td><td>${fmt(r.low.Sz)}</td><td>${r.low.points.toLocaleString()}</td><td>${fmt(r.lowArea?.percent)}</td><td>${(r.lowArea?.pixels || 0).toLocaleString()}</td><td>${(r.lowArea?.components?.length || 0).toLocaleString()}</td></tr>
        <tr><td>Higher land</td><td>${fmt(r.high.mean)}</td><td>${fmt(r.high.Sa)}</td><td>${fmt(r.high.Sq)}</td><td>${fmt(r.high.Sz)}</td><td>${r.high.points.toLocaleString()}</td><td>${fmt(r.highArea?.percent)}</td><td>${(r.highArea?.pixels || 0).toLocaleString()}</td><td>${(r.highArea?.components?.length || 0).toLocaleString()}</td></tr>
      </tbody>
    </table>
  </section>`;
}

function reportSampleMeta(r) {
  return `${r.width} x ${r.height} pixels - measured ${(r.measuredFraction * 100).toFixed(1)}% - interpolated ${Number(r.interpolatedPoints || 0).toLocaleString()} points - leveling ${escapeHtml(r.levelMode)} - segmentation ${escapeHtml(r.segmentationMode)} - FFT denoise ${fmt(r.fftDenoiseStrength, 0)}% - boundary epsilon ${fmt(r.boundaryEpsilonPx, 0)} px - edge sigma ${fmt(r.edgeSigmaPx, 1)} px - ridge offset ${fmt(r.ridgeOffsetPx, 0)} px - minimum region ${fmt(r.minRegionPercent, 1)}% - centers ${r.clusterCenters.map((c) => fmt(c)).join(", ")} um`;
}

function reportPlotHtml(caption, src, heatmap = null) {
  return `<figure><img src="${escapeHtml(src)}" />${heatmap ? reportColorScale(heatmap) : ""}<figcaption>${caption}</figcaption></figure>`;
}

function reportColorScale(heatmap) {
  return `<div class="colorScale"><div class="colorBar"></div><div class="scaleTicks"><span>${fmt(heatmap.low)} um</span><span>${escapeHtml(heatmap.zeroLabel || "0 um land mean")}</span><span>${fmt(heatmap.high)} um</span></div></div>`;
}

function reportLegendHtml() {
  return `<span class="legend">
    <span><i class="swatch basinCore"></i>Basin region, measured</span>
    <span><i class="swatch basinAssigned"></i>Initial basin pixels cleaned out</span>
    <span><i class="swatch landCore"></i>Land region, measured</span>
    <span><i class="swatch landAssigned"></i>Initial land pixels cleaned out</span>
    <span><i class="swatch excluded"></i>Transition or other cluster</span>
    <span><i class="swatch invalid"></i>Invalid or unmeasured</span>
    <span><i class="swatch basinContour"></i>Cyan basin region outline</span>
    <span><i class="swatch landContour"></i>White land region outline</span>
  </span>`;
}

renderShell();
