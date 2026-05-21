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
let options = {
  detrend: true,
  levelMode: "higher-land",
  clusters: 3,
  clipPercent: 1,
  trimPercent: 2.5,
  edgeRadiusPx: 5,
  gradientRejectPercent: 5,
  workerCount: Math.min(6, Math.max(2, Math.floor((navigator.hardwareConcurrency || 8) / 2))),
  maxSamples: 700000,
};

const root = document.getElementById("root");

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
    edgeRadiusPx: "Shrink each plateau mask inward by this many pixels before measuring roughness. Larger values remove more border/sidewall pixels.",
    gradientRejectPercent: "Exclude the highest-gradient pixels inside each plateau mask. This removes sidewalls, steep transitions, scratches, and fringe artifacts.",
    trimPercent: "After core extraction, remove this percent from both the high and low height tails inside each plateau before computing statistics.",
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
          <button class="export" id="exportBtn" disabled>${icon("export")}Export CSV</button>
        </div>
      </section>
      <section class="controls">
        <div class="uploadZone">
          <span class="bigIcon">${icon("upload")}</span>
          <div>
            <strong>Upload PLUX data</strong>
            <span>Choose a folder containing .plux files or a .zip containing multiple .plux files.</span>
          </div>
          <div class="uploadActions">
            <button id="folderBtn">${icon("folder")}Folder</button>
            <button id="fileBtn">${icon("zip")}Files or ZIP</button>
          </div>
          <input id="folderInput" type="file" webkitdirectory directory multiple />
          <input id="fileInput" type="file" multiple accept=".plux,.zip" />
        </div>
        <div class="settings">
          <div class="settingsTitle">${icon("sliders")}Analysis</div>
          <label ${tip(tips.detrend)}><input id="detrend" type="checkbox" checked /> Remove plane trend before clustering</label>
          <label ${tip(tips.levelMode)}>Leveling basis
            <select id="levelMode" ${tip(tips.levelMode)}>
              <option value="higher-land" selected>Higher land only</option>
              <option value="all">All measured points</option>
            </select>
          </label>
          <label ${tip(tips.clusters)}>Clusters <input id="clusters" type="number" min="2" max="5" value="3" ${tip(tips.clusters)} /></label>
          <label ${tip(tips.clipPercent)}>Clip tails % <input id="clipPercent" type="number" step="0.5" min="0" max="10" value="1" ${tip(tips.clipPercent)} /></label>
          <label ${tip(tips.edgeRadiusPx)}>Edge exclusion px <input id="edgeRadiusPx" type="number" min="0" max="50" value="5" ${tip(tips.edgeRadiusPx)} /></label>
          <label ${tip(tips.gradientRejectPercent)}>Gradient exclusion % <input id="gradientRejectPercent" type="number" step="1" min="0" max="30" value="5" ${tip(tips.gradientRejectPercent)} /></label>
          <label ${tip(tips.trimPercent)}>Trim plateau % <input id="trimPercent" type="number" step="0.5" min="0" max="10" value="2.5" ${tip(tips.trimPercent)} /></label>
          <label ${tip(tips.workerCount)}>CPU workers <input id="workerCount" type="number" min="1" max="12" value="${options.workerCount}" ${tip(tips.workerCount)} /></label>
        </div>
      </section>
      <section class="statusLine"><span class="dot"></span><span id="status">Ready</span><strong id="summary"></strong></section>
      <section id="content" class="empty">
        <h2>No measurements loaded</h2>
        <p>The table will show each detrended height map, cluster mask, and plateau statistics after upload.</p>
      </section>
    </main>
  `;

  document.getElementById("folderBtn").onclick = () => document.getElementById("folderInput").click();
  document.getElementById("fileBtn").onclick = () => document.getElementById("fileInput").click();
  document.getElementById("folderInput").onchange = (event) => handleFiles(event.target.files);
  document.getElementById("fileInput").onchange = (event) => handleFiles(event.target.files);
  document.getElementById("rerunBtn").onclick = () => rerunAnalysis();
  document.getElementById("exportBtn").onclick = () => exportCsv(results);
  for (const id of ["detrend", "levelMode", "clusters", "clipPercent", "edgeRadiusPx", "gradientRejectPercent", "trimPercent", "workerCount"]) {
    document.getElementById(id).onchange = readOptions;
  }
}

function readOptions() {
  options = {
    detrend: document.getElementById("detrend").checked,
    levelMode: document.getElementById("levelMode").value,
    clusters: Number(document.getElementById("clusters").value),
    clipPercent: Number(document.getElementById("clipPercent").value),
    edgeRadiusPx: Number(document.getElementById("edgeRadiusPx").value),
    gradientRejectPercent: Number(document.getElementById("gradientRejectPercent").value),
    trimPercent: Number(document.getElementById("trimPercent").value),
    workerCount: Math.max(1, Math.min(12, Number(document.getElementById("workerCount").value) || 1)),
    maxSamples: 700000,
  };
}

function setStatus(text, busy = false) {
  document.getElementById("status").textContent = text;
  const dot = document.querySelector(".statusLine > span:first-child");
  dot.className = busy ? "spinner" : "dot";
  dot.innerHTML = busy ? `<span></span>` : "";
}

function updateSummary() {
  const exportBtn = document.getElementById("exportBtn");
  const rerunBtn = document.getElementById("rerunBtn");
  exportBtn.disabled = !results.length;
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
    if (row?.heatmap?.url) URL.revokeObjectURL(row.heatmap.url);
    if (row?.maskUrl) URL.revokeObjectURL(row.maskUrl);
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
  for (const file of files) {
    const name = file.webkitRelativePath || file.name;
    if (file.name.toLowerCase().endsWith(".plux")) {
      items.push({ name, buffer: await file.arrayBuffer() });
    } else if (file.name.toLowerCase().endsWith(".zip")) {
      const zip = await readZipEntries(await file.arrayBuffer());
      for (const [entryName, entry] of Object.entries(zip)) {
        if (entryName.toLowerCase().endsWith(".plux")) {
          items.push({ name: `${file.name}/${entryName}`, buffer: await entry.arrayBuffer() });
        }
      }
    }
  }
  return items;
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
        result.heatmap.url = URL.createObjectURL(result.heatmap.blob);
        delete result.heatmap.blob;
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

async function processFiles(files) {
  readOptions();
  if (!files.length) return;
  isAnalyzing = true;
  setStatus("Reading uploads...", true);
  updateSummary();
  releaseResultUrls(results);
  results = [];
  renderResults();
  try {
    const items = await expandUploads(files);
    if (!items.length) {
      setStatus("No .plux files found in the upload.");
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

function renderResults() {
  const content = document.getElementById("content");
  if (!results.length) {
    content.className = "empty";
    content.innerHTML = `<h2>No measurements loaded</h2><p>The table will show each detrended height map, cluster mask, and plateau statistics after upload.</p>`;
    updateSummary();
    return;
  }
  content.className = "results";
  content.innerHTML = results.map((r, idx) => `
    <article class="result">
      <header>
        <div>
          <h2>${escapeHtml(r.name.split(/[\\/]/).pop())}</h2>
          <p>${r.width} x ${r.height} pixels - measured ${(r.measuredFraction * 100).toFixed(1)}% - leveling ${r.levelMode} - core edge ${r.edgeRadiusPx}px - centers ${r.clusterCenters.map((c) => fmt(c)).join(", ")} um</p>
        </div>
        <span>${fmt(r.heightDifference)} um step</span>
      </header>
      <div class="visuals">
        <figure><img src="${r.heatmap.url}" alt="Detrended height map ${idx + 1}" /><figcaption>Detrended height map - cyan basin-core contour, white land-core contour - 1-99% scale ${fmt(r.heatmap.low)} to ${fmt(r.heatmap.high)} um</figcaption></figure>
        <figure>
          <img src="${r.maskUrl}" alt="Cluster mask ${idx + 1}" />
          <figcaption>
            <span>Cluster mask and measurement regions</span>
            <span class="legend">
              <span><i class="swatch basinCore"></i>Basin core, measured</span>
              <span><i class="swatch basinAssigned"></i>Basin assigned, excluded</span>
              <span><i class="swatch landCore"></i>Land core, measured</span>
              <span><i class="swatch landAssigned"></i>Land assigned, excluded</span>
              <span><i class="swatch excluded"></i>Transition or other cluster</span>
              <span><i class="swatch invalid"></i>Invalid or unmeasured</span>
              <span><i class="swatch basinContour"></i>Cyan basin contour</span>
              <span><i class="swatch landContour"></i>White land contour</span>
            </span>
          </figcaption>
        </figure>
      </div>
      <table>
        <thead><tr><th>Region</th><th>Mean um</th><th>Sa um</th><th>Sq um</th><th>Sz um</th><th>Points</th></tr></thead>
        <tbody>
          <tr><td>Lower basin</td><td>${fmt(r.low.mean)}</td><td>${fmt(r.low.Sa)}</td><td>${fmt(r.low.Sq)}</td><td>${fmt(r.low.Sz)}</td><td>${r.low.points.toLocaleString()}</td></tr>
          <tr><td>Higher land</td><td>${fmt(r.high.mean)}</td><td>${fmt(r.high.Sa)}</td><td>${fmt(r.high.Sq)}</td><td>${fmt(r.high.Sz)}</td><td>${r.high.points.toLocaleString()}</td></tr>
        </tbody>
      </table>
    </article>
  `).join("");
  updateSummary();
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[ch]));
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function exportCsv(rows) {
  const headers = ["file", "date", "width", "height", "level_mode", "edge_radius_px", "gradient_reject_percent", "measured_fraction", "low_mean_um", "low_Sa_um", "low_Sq_um", "low_points", "high_mean_um", "high_Sa_um", "high_Sq_um", "high_points", "height_difference_um", "cluster_centers_um", "objective"];
  const body = rows.map((r) => [r.name, r.date, r.width, r.height, r.levelMode, r.edgeRadiusPx, r.gradientRejectPercent, r.measuredFraction, r.low.mean, r.low.Sa, r.low.Sq, r.low.points, r.high.mean, r.high.Sa, r.high.Sq, r.high.points, r.heightDifference, r.clusterCenters.map((c) => fmt(c, 4)).join("; "), r.objective]);
  const csv = [headers, ...body].map((row) => row.map(csvEscape).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "plux_plateau_statistics.csv";
  a.click();
  URL.revokeObjectURL(url);
}

renderShell();
