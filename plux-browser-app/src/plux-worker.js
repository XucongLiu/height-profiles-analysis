const PALETTE = [
  [68, 1, 84],
  [59, 82, 139],
  [33, 145, 140],
  [94, 201, 98],
  [253, 231, 37],
  [244, 109, 67],
  [165, 0, 38],
];

let options = {};

self.onmessage = async (event) => {
  const { id, name, buffer, options: jobOptions } = event.data;
  options = jobOptions;
  try {
    const measurement = await readPluxFromArrayBuffer(name, buffer);
    const result = await analyze(measurement);
    self.postMessage({ id, ok: true, result });
  } catch (error) {
    self.postMessage({ id, ok: false, error: error.message || String(error) });
  }
};

function findEocd(view) {
  for (let i = view.byteLength - 22; i >= Math.max(0, view.byteLength - 66000); i--) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  throw new Error("ZIP end record not found.");
}

async function inflateRaw(bytes) {
  if (!("DecompressionStream" in self)) {
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

function xmlText(xml, tag, fallback = "") {
  const match = xml.match(new RegExp(`<${tag}>\\s*([^<]*)\\s*</${tag}>`, "i"));
  return match ? match[1].trim() : fallback;
}

async function readPluxFromArrayBuffer(name, arrayBuffer) {
  const zip = await readZipEntries(arrayBuffer);
  if (!zip["index.xml"]) throw new Error(`${name}: missing index.xml`);
  const xml = await zip["index.xml"].text();
  const width = Number(xmlText(xml, "IMAGE_SIZE_X"));
  const height = Number(xmlText(xml, "IMAGE_SIZE_Y"));
  const rawName = xmlText(xml, "FILENAME_Z", "LAYER_0.raw");
  if (!zip[rawName]) throw new Error(`${name}: missing ${rawName}`);
  const raw = await zip[rawName].arrayBuffer();
  return {
    name,
    width,
    height,
    values: new Float32Array(raw),
    fovX: Number(xmlText(xml, "FOV_X")),
    fovY: Number(xmlText(xml, "FOV_Y")),
    date: xmlText(xml, "DATE"),
    objective: xmlText(xml, "Id"),
  };
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
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) count++;
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
  for (let i = 0; i < values.length; i++) if (mask[i] && values[i] >= lo && values[i] <= hi) trimmed[i] = 1;
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
          current[i] && current[i - 1] && current[i + 1] && current[i - width] && current[i + width] &&
          current[i - width - 1] && current[i - width + 1] && current[i + width - 1] && current[i + width + 1]
        ) next[i] = 1;
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
      const left = values[i - 1], right = values[i + 1], up = values[i - width], down = values[i + width];
      if ([left, right, up, down].every(Number.isFinite)) gradients.push(Math.hypot(right - left, down - up) * 0.5);
    }
  }
  if (!gradients.length) return mask;
  const threshold = percentile(gradients, 100 - rejectPercent);
  const filtered = new Uint8Array(values.length);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (!mask[i]) continue;
      const left = values[i - 1], right = values[i + 1], up = values[i - width], down = values[i + width];
      if (![left, right, up, down].every(Number.isFinite)) continue;
      if (Math.hypot(right - left, down - up) * 0.5 <= threshold) filtered[i] = 1;
    }
  }
  return filtered;
}

function boxBlurFinite(values, width, height, radius) {
  radius = Math.max(0, Math.floor(radius || 0));
  if (radius <= 0) return values;
  const horizontal = new Float32Array(values.length);
  const horizontalCount = new Uint16Array(values.length);
  for (let y = 0; y < height; y++) {
    let sum = 0;
    let count = 0;
    const row = y * width;
    for (let x = -radius; x <= radius && x < width; x++) {
      if (x >= 0) {
        const v = values[row + x];
        if (Number.isFinite(v)) { sum += v; count++; }
      }
    }
    for (let x = 0; x < width; x++) {
      const idx = row + x;
      if (count) {
        horizontal[idx] = sum / count;
        horizontalCount[idx] = 1;
      } else {
        horizontal[idx] = NaN;
      }
      const removeX = x - radius;
      const addX = x + radius + 1;
      if (removeX >= 0) {
        const v = values[row + removeX];
        if (Number.isFinite(v)) { sum -= v; count--; }
      }
      if (addX < width) {
        const v = values[row + addX];
        if (Number.isFinite(v)) { sum += v; count++; }
      }
    }
  }
  const out = new Float32Array(values.length);
  for (let x = 0; x < width; x++) {
    let sum = 0;
    let count = 0;
    for (let y = -radius; y <= radius && y < height; y++) {
      if (y >= 0) {
        const idx = y * width + x;
        if (horizontalCount[idx]) { sum += horizontal[idx]; count++; }
      }
    }
    for (let y = 0; y < height; y++) {
      const idx = y * width + x;
      out[idx] = count ? sum / count : NaN;
      const removeY = y - radius;
      const addY = y + radius + 1;
      if (removeY >= 0) {
        const removeIdx = removeY * width + x;
        if (horizontalCount[removeIdx]) { sum -= horizontal[removeIdx]; count--; }
      }
      if (addY < height) {
        const addIdx = addY * width + x;
        if (horizontalCount[addIdx]) { sum += horizontal[addIdx]; count++; }
      }
    }
  }
  return out;
}

function countMask(mask) {
  let count = 0;
  for (let i = 0; i < mask.length; i++) count += mask[i] ? 1 : 0;
  return count;
}

function clusterPlateaus(values, width, height) {
  const spatialMode = options.segmentationMode !== "height";
  const segmentationValues = spatialMode ? boxBlurFinite(values, width, height, options.smoothRadiusPx) : values;
  const sample = sampleFinite(segmentationValues, options.maxSamples);
  const clipLo = percentile(sample, options.clipPercent);
  const clipHi = percentile(sample, 100 - options.clipPercent);
  const clipped = sample.map((v) => Math.min(clipHi, Math.max(clipLo, v)));
  const centers = kmeans1d(clipped, options.clusters);
  const labels = new Int8Array(values.length);
  labels.fill(-1);
  const counts = Array(options.clusters).fill(0);
  for (let i = 0; i < values.length; i++) {
    const raw = segmentationValues[i];
    if (!Number.isFinite(raw) || !Number.isFinite(values[i])) continue;
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
  if (!spatialMode) {
    lowCore = gradientFilteredMask(values, lowCore, width, height, options.gradientRejectPercent);
    highCore = gradientFilteredMask(values, highCore, width, height, options.gradientRejectPercent);
    lowCore = trimExistingMask(values, lowCore, options.trimPercent);
    highCore = trimExistingMask(values, highCore, options.trimPercent);
    if (countMask(lowCore) < 100 || countMask(highCore) < 100) {
      lowCore = trimMask(values, labels, plateau[0], options.trimPercent);
      highCore = trimMask(values, labels, plateau[1], options.trimPercent);
    }
  }
  return { width, height, labels, centers, counts, lowLabel: plateau[0], highLabel: plateau[1], lowMask: lowCore, highMask: highCore, segmentationMode: spatialMode ? "spatial" : "height" };
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
    mask[idx - 1] && mask[idx + 1] && mask[idx - width] && mask[idx + width] &&
    mask[idx - width - 1] && mask[idx - width + 1] && mask[idx + width - 1] && mask[idx + width + 1]
  );
}

function contourColor(cluster, idx) {
  if (isContourPixel(cluster.lowMask, idx, cluster.width, cluster.height)) return [0, 240, 255];
  if (isContourPixel(cluster.highMask, idx, cluster.width, cluster.height)) return [255, 255, 255];
  return null;
}

async function canvasToBlob(canvas) {
  if (canvas.convertToBlob) return await canvas.convertToBlob({ type: "image/png" });
  return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

async function renderHeatmap(values, width, height, cluster, zeroLevel, maxW = 520) {
  const adjusted = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    adjusted[i] = Number.isFinite(v) ? v - zeroLevel : NaN;
  }
  const sample = sampleFinite(adjusted, 500000);
  const p1 = percentile(sample, 1);
  const p99 = percentile(sample, 99);
  const maxAbs = Math.max(Math.abs(p1), Math.abs(p99), 1e-9);
  const lo = -maxAbs;
  const hi = maxAbs;
  const scale = Math.min(1, maxW / width);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(height - 1, Math.floor(y / scale));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(width - 1, Math.floor(x / scale));
      const idx = sy * width + sx;
      const v = adjusted[idx];
      const p = (y * w + x) * 4;
      let color = Number.isFinite(v) ? paletteColor((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) : [28, 28, 28];
      color = contourColor(cluster, idx) || color;
      img.data[p] = color[0]; img.data[p + 1] = color[1]; img.data[p + 2] = color[2]; img.data[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { blob: await canvasToBlob(canvas), low: lo, high: hi, zeroLevel };
}

async function renderClusterMask(cluster, width, height, maxW = 520) {
  const scale = Math.min(1, maxW / width);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = new OffscreenCanvas(w, h);
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
  return await canvasToBlob(canvas);
}

async function analyze(measurement) {
  let values = measurement.values;
  if (options.detrend && options.levelMode === "higher-land") {
    values = levelUsingHigherLand(measurement.values, measurement.width, measurement.height);
  } else if (options.detrend) {
    values = detrendPlane(measurement.values, measurement.width, measurement.height);
  }
  const cluster = clusterPlateaus(values, measurement.width, measurement.height);
  const low = statsForMask(values, cluster.lowMask);
  const high = statsForMask(values, cluster.highMask);
  const heatmap = await renderHeatmap(values, measurement.width, measurement.height, cluster, high.mean);
  const maskBlob = await renderClusterMask(cluster, measurement.width, measurement.height);
  const measuredFraction = finiteFraction(values);
  return {
    name: measurement.name,
    width: measurement.width,
    height: measurement.height,
    fovX: measurement.fovX,
    fovY: measurement.fovY,
    date: measurement.date,
    objective: measurement.objective,
    levelMode: options.detrend ? options.levelMode : "none",
    edgeRadiusPx: options.edgeRadiusPx,
    gradientRejectPercent: options.gradientRejectPercent,
    segmentationMode: cluster.segmentationMode,
    smoothRadiusPx: options.smoothRadiusPx,
    low,
    high,
    heatmap,
    maskBlob,
    clusterCenters: cluster.centers,
    measuredFraction,
    heightDifference: high.mean - low.mean,
  };
}
