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

function interpolateMissing(values, width, height) {
  const out = new Float32Array(values);
  let missing = 0;
  for (let i = 0; i < out.length; i++) if (!Number.isFinite(out[i])) missing++;
  if (!missing) return { values: out, interpolated: 0 };

  let previous = new Float32Array(out);
  let filledTotal = 0;
  for (let pass = 0; pass < 48 && missing > 0; pass++) {
    let filledThisPass = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (Number.isFinite(previous[idx])) continue;
        let sum = 0;
        let count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const xx = x + dx;
            if (xx < 0 || xx >= width) continue;
            const v = previous[yy * width + xx];
            if (Number.isFinite(v)) { sum += v; count++; }
          }
        }
        if (count) {
          out[idx] = sum / count;
          filledThisPass++;
        }
      }
    }
    if (!filledThisPass) break;
    missing -= filledThisPass;
    filledTotal += filledThisPass;
    previous = new Float32Array(out);
  }

  if (missing > 0) {
    const sample = sampleFinite(out, 500000);
    const fallback = percentile(sample, 50);
    for (let i = 0; i < out.length; i++) {
      if (!Number.isFinite(out[i])) {
        out[i] = fallback;
        filledTotal++;
      }
    }
  }
  return { values: out, interpolated: filledTotal };
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

function nextPow2(n) {
  return 1 << Math.ceil(Math.log2(Math.max(2, n)));
}

function fft1d(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (inverse ? 2 : -2) * Math.PI / len;
    const wLenR = Math.cos(angle);
    const wLenI = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let wr = 1;
      let wi = 0;
      for (let j = 0; j < len / 2; j++) {
        const uR = re[i + j];
        const uI = im[i + j];
        const vR = re[i + j + len / 2] * wr - im[i + j + len / 2] * wi;
        const vI = re[i + j + len / 2] * wi + im[i + j + len / 2] * wr;
        re[i + j] = uR + vR;
        im[i + j] = uI + vI;
        re[i + j + len / 2] = uR - vR;
        im[i + j + len / 2] = uI - vI;
        const nextWr = wr * wLenR - wi * wLenI;
        wi = wr * wLenI + wi * wLenR;
        wr = nextWr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

function fftLowPassForSegmentation(values, width, height, strength) {
  const s = Math.max(0, Math.min(100, Number(strength) || 0)) / 100;
  if (s <= 0) return values;
  const target = Math.min(512, nextPow2(Math.max(width, height)));
  const gridW = nextPow2(Math.max(64, Math.round(target)));
  const gridH = nextPow2(Math.max(64, Math.round(target * height / width)));
  const re = new Float32Array(gridW * gridH);
  const im = new Float32Array(gridW * gridH);
  let sum = 0;
  let count = 0;
  for (let gy = 0; gy < gridH; gy++) {
    const sy = Math.min(height - 1, Math.round((gy / Math.max(1, gridH - 1)) * (height - 1)));
    for (let gx = 0; gx < gridW; gx++) {
      const sx = Math.min(width - 1, Math.round((gx / Math.max(1, gridW - 1)) * (width - 1)));
      const v = values[sy * width + sx];
      if (Number.isFinite(v)) {
        re[gy * gridW + gx] = v;
        sum += v;
        count++;
      }
    }
  }
  const mean = count ? sum / count : 0;
  for (let i = 0; i < re.length; i++) re[i] = Number.isFinite(re[i]) ? re[i] - mean : 0;

  const rowRe = new Float32Array(gridW);
  const rowIm = new Float32Array(gridW);
  for (let y = 0; y < gridH; y++) {
    const row = y * gridW;
    for (let x = 0; x < gridW; x++) { rowRe[x] = re[row + x]; rowIm[x] = im[row + x]; }
    fft1d(rowRe, rowIm, false);
    for (let x = 0; x < gridW; x++) { re[row + x] = rowRe[x]; im[row + x] = rowIm[x]; }
  }

  const colRe = new Float32Array(gridH);
  const colIm = new Float32Array(gridH);
  for (let x = 0; x < gridW; x++) {
    for (let y = 0; y < gridH; y++) { const idx = y * gridW + x; colRe[y] = re[idx]; colIm[y] = im[idx]; }
    fft1d(colRe, colIm, false);
    for (let y = 0; y < gridH; y++) { const idx = y * gridW + x; re[idx] = colRe[y]; im[idx] = colIm[y]; }
  }

  const maxRadius = Math.hypot(gridW / 2, gridH / 2);
  const cutoff = maxRadius * (0.48 - 0.43 * s);
  const taper = Math.max(2, cutoff * 0.25);
  for (let y = 0; y < gridH; y++) {
    const fy = y <= gridH / 2 ? y : y - gridH;
    for (let x = 0; x < gridW; x++) {
      const fx = x <= gridW / 2 ? x : x - gridW;
      const r = Math.hypot(fx, fy);
      if (r <= cutoff) continue;
      const idx = y * gridW + x;
      if (r >= cutoff + taper) {
        re[idx] = 0;
        im[idx] = 0;
      } else {
        const keep = 0.5 + 0.5 * Math.cos(Math.PI * (r - cutoff) / taper);
        re[idx] *= keep;
        im[idx] *= keep;
      }
    }
  }

  for (let x = 0; x < gridW; x++) {
    for (let y = 0; y < gridH; y++) { const idx = y * gridW + x; colRe[y] = re[idx]; colIm[y] = im[idx]; }
    fft1d(colRe, colIm, true);
    for (let y = 0; y < gridH; y++) { const idx = y * gridW + x; re[idx] = colRe[y]; im[idx] = colIm[y]; }
  }
  for (let y = 0; y < gridH; y++) {
    const row = y * gridW;
    for (let x = 0; x < gridW; x++) { rowRe[x] = re[row + x]; rowIm[x] = im[row + x]; }
    fft1d(rowRe, rowIm, true);
    for (let x = 0; x < gridW; x++) re[row + x] = rowRe[x] + mean;
  }

  const out = new Float32Array(values.length);
  for (let y = 0; y < height; y++) {
    const gy = (y / Math.max(1, height - 1)) * (gridH - 1);
    const y0 = Math.floor(gy);
    const y1 = Math.min(gridH - 1, y0 + 1);
    const fy = gy - y0;
    for (let x = 0; x < width; x++) {
      const gx = (x / Math.max(1, width - 1)) * (gridW - 1);
      const x0 = Math.floor(gx);
      const x1 = Math.min(gridW - 1, x0 + 1);
      const fx = gx - x0;
      const v00 = re[y0 * gridW + x0];
      const v10 = re[y0 * gridW + x1];
      const v01 = re[y1 * gridW + x0];
      const v11 = re[y1 * gridW + x1];
      out[y * width + x] = (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
    }
  }
  return out;
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

function componentSummary(mask, width, height, minPixels = 1) {
  const seen = new Uint8Array(mask.length);
  const components = [];
  const queue = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    seen[start] = 1;
    queue.length = 0;
    queue.push(start);
    let head = 0;
    let area = 0;
    let minX = width, maxX = 0, minY = height, maxY = 0;
    while (head < queue.length) {
      const idx = queue[head++];
      const x = idx % width;
      const y = Math.floor(idx / width);
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const neighbors = [idx - 1, idx + 1, idx - width, idx + width];
      for (const n of neighbors) {
        if (n < 0 || n >= mask.length || seen[n] || !mask[n]) continue;
        const nx = n % width;
        const ny = Math.floor(n / width);
        if (Math.abs(nx - x) + Math.abs(ny - y) !== 1) continue;
        seen[n] = 1;
        queue.push(n);
      }
    }
    if (area >= minPixels) components.push({ areaPx: area, areaPercent: (area / mask.length) * 100, minX, maxX, minY, maxY });
  }
  components.sort((a, b) => b.areaPx - a.areaPx);
  return components;
}

function cleanSmallLabelComponents(labels, width, height, minPixels) {
  if (minPixels <= 1) return labels;
  const seen = new Uint8Array(labels.length);
  const queue = [];
  const boundaryCounts = new Map();
  for (let start = 0; start < labels.length; start++) {
    const label = labels[start];
    if (label < 0 || seen[start]) continue;
    seen[start] = 1;
    queue.length = 0;
    queue.push(start);
    boundaryCounts.clear();
    let head = 0;
    while (head < queue.length) {
      const idx = queue[head++];
      const x = idx % width;
      const neighbors = [idx - 1, idx + 1, idx - width, idx + width];
      for (const n of neighbors) {
        if (n < 0 || n >= labels.length) continue;
        const nx = n % width;
        if (Math.abs(nx - x) > 1) continue;
        const nl = labels[n];
        if (nl === label && !seen[n]) {
          seen[n] = 1;
          queue.push(n);
        } else if (nl >= 0 && nl !== label) {
          boundaryCounts.set(nl, (boundaryCounts.get(nl) || 0) + 1);
        }
      }
    }
    if (queue.length >= minPixels || !boundaryCounts.size) continue;
    let replacement = label;
    let bestCount = -1;
    for (const [candidate, count] of boundaryCounts.entries()) {
      if (count > bestCount) {
        replacement = candidate;
        bestCount = count;
      }
    }
    for (const idx of queue) labels[idx] = replacement;
  }
  return labels;
}

function majoritySmoothLabels(labels, width, height, iterations) {
  if (iterations <= 0) return labels;
  let current = labels;
  let next = new Int8Array(labels.length);
  const counts = new Int32Array(Math.max(8, options.clusters + 2));
  for (let iter = 0; iter < iterations; iter++) {
    next.set(current);
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = y * width + x;
        const label = current[idx];
        if (label < 0) continue;
        counts.fill(0);
        for (let dy = -1; dy <= 1; dy++) {
          const row = idx + dy * width;
          for (let dx = -1; dx <= 1; dx++) {
            const neighborLabel = current[row + dx];
            if (neighborLabel >= 0) counts[neighborLabel]++;
          }
        }
        let best = label;
        let bestCount = counts[label];
        for (let k = 0; k < counts.length; k++) {
          if (counts[k] > bestCount) {
            best = k;
            bestCount = counts[k];
          }
        }
        if (best !== label && bestCount >= 5) next[idx] = best;
      }
    }
    const swap = current;
    current = next;
    next = swap;
  }
  if (current !== labels) labels.set(current);
  return labels;
}

function fillSmallEnclosedHoles(mask, width, height, maxHolePixels) {
  if (maxHolePixels <= 0) return mask;
  const seen = new Uint8Array(mask.length);
  const queue = [];
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] || seen[start]) continue;
    seen[start] = 1;
    queue.length = 0;
    queue.push(start);
    let head = 0;
    let touchesBorder = false;
    while (head < queue.length) {
      const idx = queue[head++];
      const x = idx % width;
      const y = Math.floor(idx / width);
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesBorder = true;
      const neighbors = [idx - 1, idx + 1, idx - width, idx + width];
      for (const n of neighbors) {
        if (n < 0 || n >= mask.length || seen[n] || mask[n]) continue;
        const nx = n % width;
        const ny = Math.floor(n / width);
        if (Math.abs(nx - x) + Math.abs(ny - y) !== 1) continue;
        seen[n] = 1;
        queue.push(n);
      }
    }
    if (!touchesBorder && queue.length <= maxHolePixels) {
      for (const idx of queue) mask[idx] = 1;
    }
  }
  return mask;
}

function maskFromLargeComponents(source, width, height, minPixels) {
  if (minPixels <= 1) return source;
  const seen = new Uint8Array(source.length);
  const out = new Uint8Array(source.length);
  const queue = [];
  for (let start = 0; start < source.length; start++) {
    if (!source[start] || seen[start]) continue;
    seen[start] = 1;
    queue.length = 0;
    queue.push(start);
    let head = 0;
    while (head < queue.length) {
      const idx = queue[head++];
      const x = idx % width;
      const neighbors = [idx - 1, idx + 1, idx - width, idx + width];
      for (const n of neighbors) {
        if (n < 0 || n >= source.length || seen[n] || !source[n]) continue;
        const nx = n % width;
        if (Math.abs(nx - x) > 1) continue;
        seen[n] = 1;
        queue.push(n);
      }
    }
    if (queue.length >= minPixels) {
      for (const idx of queue) out[idx] = 1;
    }
  }
  return out;
}

function pointSegmentDistance(point, a, b) {
  const vx = b.y - a.y;
  const vy = b.x - a.x;
  const wx = point.y - a.y;
  const wy = point.x - a.x;
  const len2 = vx * vx + vy * vy;
  if (len2 <= 1e-12) {
    const dx = point.y - a.y;
    const dy = point.x - a.x;
    return Math.sqrt(dx * dx + dy * dy);
  }
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
  const py = a.y + t * vx;
  const px = a.x + t * vy;
  const dx = point.y - py;
  const dy = point.x - px;
  return Math.sqrt(dx * dx + dy * dy);
}

function simplifyCurve(points, tolerance) {
  if (points.length <= 2 || tolerance <= 0) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    let maxDist = -1;
    let maxIndex = -1;
    for (let i = start + 1; i < end; i++) {
      const d = pointSegmentDistance(points[i], points[start], points[end]);
      if (d > maxDist) {
        maxDist = d;
        maxIndex = i;
      }
    }
    if (maxDist > tolerance && maxIndex > start) {
      keep[maxIndex] = 1;
      stack.push([start, maxIndex], [maxIndex, end]);
    }
  }
  const simplified = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) simplified.push(points[i]);
  return simplified;
}

function interpolateCurve(points, minY, maxY) {
  const values = new Float32Array(maxY - minY + 1);
  if (!points.length) return values;
  let segment = 0;
  for (let y = minY; y <= maxY; y++) {
    while (segment < points.length - 2 && y > points[segment + 1].y) segment++;
    const a = points[segment];
    const b = points[Math.min(segment + 1, points.length - 1)];
    const t = b.y === a.y ? 0 : (y - a.y) / (b.y - a.y);
    values[y - minY] = a.x + (b.x - a.x) * Math.max(0, Math.min(1, t));
  }
  return values;
}

function vectorizeMaskByRowBoundaries(source, width, height, minPixels, tolerance) {
  if (tolerance <= 0) return source;
  const seen = new Uint8Array(source.length);
  const out = new Uint8Array(source.length);
  const queue = [];
  for (let start = 0; start < source.length; start++) {
    if (!source[start] || seen[start]) continue;
    seen[start] = 1;
    queue.length = 0;
    queue.push(start);
    let head = 0;
    let minY = height, maxY = 0, minX = width, maxX = 0;
    while (head < queue.length) {
      const idx = queue[head++];
      const x = idx % width;
      const y = Math.floor(idx / width);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const neighbors = [idx - 1, idx + 1, idx - width, idx + width];
      for (const n of neighbors) {
        if (n < 0 || n >= source.length || seen[n] || !source[n]) continue;
        const nx = n % width;
        if (Math.abs(nx - x) > 1) continue;
        seen[n] = 1;
        queue.push(n);
      }
    }
    if (queue.length < minPixels || maxY <= minY) continue;
    const span = maxY - minY + 1;
    const left = new Int32Array(span);
    const right = new Int32Array(span);
    left.fill(width);
    right.fill(-1);
    for (const idx of queue) {
      const x = idx % width;
      const y = Math.floor(idx / width) - minY;
      if (x < left[y]) left[y] = x;
      if (x > right[y]) right[y] = x;
    }
    const leftPoints = [];
    const rightPoints = [];
    for (let y = 0; y < span; y++) {
      if (right[y] < left[y]) continue;
      leftPoints.push({ y: y + minY, x: left[y] });
      rightPoints.push({ y: y + minY, x: right[y] });
    }
    if (leftPoints.length < 2 || rightPoints.length < 2) {
      for (const idx of queue) out[idx] = 1;
      continue;
    }
    const fittedLeft = interpolateCurve(simplifyCurve(leftPoints, tolerance), minY, maxY);
    const fittedRight = interpolateCurve(simplifyCurve(rightPoints, tolerance), minY, maxY);
    for (let y = minY; y <= maxY; y++) {
      const row = y * width;
      let x0 = Math.round(fittedLeft[y - minY]);
      let x1 = Math.round(fittedRight[y - minY]);
      if (x0 > x1) [x0, x1] = [x1, x0];
      x0 = Math.max(0, Math.min(width - 1, x0));
      x1 = Math.max(0, Math.min(width - 1, x1));
      for (let x = x0; x <= x1; x++) out[row + x] = 1;
    }
  }
  return out;
}

function labelsFromCleanPlateaus(labels, lowMask, highMask, lowLabel, highLabel) {
  for (let i = 0; i < labels.length; i++) {
    if (lowMask[i]) labels[i] = lowLabel;
    else if (highMask[i]) labels[i] = highLabel;
  }
}

function resolveMaskOverlaps(lowMask, highMask, segmentationValues, lowCenter, highCenter) {
  for (let i = 0; i < lowMask.length; i++) {
    if (!lowMask[i] || !highMask[i]) continue;
    const v = segmentationValues[i];
    if (!Number.isFinite(v)) {
      highMask[i] = 0;
      continue;
    }
    if (Math.abs(v - lowCenter) <= Math.abs(v - highCenter)) highMask[i] = 0;
    else lowMask[i] = 0;
  }
}

function clusterPlateaus(values, width, height, segmentationOverride = null) {
  const spatialMode = options.segmentationMode !== "height";
  const segmentationValues = segmentationOverride || (spatialMode ? boxBlurFinite(values, width, height, options.smoothRadiusPx) : values);
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
  if (spatialMode) {
    const minPixels = Math.ceil(values.length * Math.max(0, options.minRegionPercent || 0) / 100);
    const smoothIterations = Math.max(0, Math.min(32, Math.round(options.smoothRadiusPx || 0)));
    cleanSmallLabelComponents(labels, width, height, minPixels);
    majoritySmoothLabels(labels, width, height, smoothIterations);
    cleanSmallLabelComponents(labels, width, height, minPixels);
    counts.fill(0);
    for (let i = 0; i < labels.length; i++) if (labels[i] >= 0) counts[labels[i]]++;
  }
  const plateau = counts.map((count, label) => ({ count, label })).sort((a, b) => b.count - a.count).slice(0, 2).map((x) => x.label).sort((a, b) => centers[a] - centers[b]);
  const lowAssigned = new Uint8Array(values.length);
  const highAssigned = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) {
    if (labels[i] === plateau[0]) lowAssigned[i] = 1;
    if (labels[i] === plateau[1]) highAssigned[i] = 1;
  }
  let lowCore = lowAssigned;
  let highCore = highAssigned;
  if (!spatialMode) {
    lowCore = erodeMask(lowAssigned, width, height, options.edgeRadiusPx);
    highCore = erodeMask(highAssigned, width, height, options.edgeRadiusPx);
    if (countMask(lowCore) < 100 || countMask(highCore) < 100) {
      lowCore = lowAssigned;
      highCore = highAssigned;
    }
    lowCore = gradientFilteredMask(values, lowCore, width, height, options.gradientRejectPercent || 0);
    highCore = gradientFilteredMask(values, highCore, width, height, options.gradientRejectPercent || 0);
    lowCore = trimExistingMask(values, lowCore, options.trimPercent || 0);
    highCore = trimExistingMask(values, highCore, options.trimPercent || 0);
    if (countMask(lowCore) < 100 || countMask(highCore) < 100) {
      lowCore = trimMask(values, labels, plateau[0], options.trimPercent || 0);
      highCore = trimMask(values, labels, plateau[1], options.trimPercent || 0);
    }
  } else {
    const minPixels = Math.ceil(values.length * Math.max(0, options.minRegionPercent || 0) / 100);
    lowCore = maskFromLargeComponents(lowAssigned, width, height, minPixels);
    highCore = maskFromLargeComponents(highAssigned, width, height, minPixels);
    fillSmallEnclosedHoles(lowCore, width, height, minPixels);
    fillSmallEnclosedHoles(highCore, width, height, minPixels);
    const vectorTolerance = Math.max(1, Math.min(80, (options.smoothRadiusPx || 0) * 0.75));
    lowCore = vectorizeMaskByRowBoundaries(lowCore, width, height, minPixels, vectorTolerance);
    highCore = vectorizeMaskByRowBoundaries(highCore, width, height, minPixels, vectorTolerance);
    fillSmallEnclosedHoles(lowCore, width, height, minPixels);
    fillSmallEnclosedHoles(highCore, width, height, minPixels);
    resolveMaskOverlaps(lowCore, highCore, segmentationValues, centers[plateau[0]], centers[plateau[1]]);
    labelsFromCleanPlateaus(labels, lowCore, highCore, plateau[0], plateau[1]);
  }
  const minPixels = Math.ceil(values.length * Math.max(0, options.minRegionPercent || 0) / 100);
  return {
    width,
    height,
    labels,
    centers,
    counts,
    lowLabel: plateau[0],
    highLabel: plateau[1],
    lowMask: lowCore,
    highMask: highCore,
    lowComponents: componentSummary(lowCore, width, height, spatialMode ? minPixels : 1),
    highComponents: componentSummary(highCore, width, height, spatialMode ? minPixels : 1),
    segmentationMode: spatialMode ? "cca-geometry" : "height"
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
  const reconstruction = interpolateMissing(measurement.values, measurement.width, measurement.height);
  let values = reconstruction.values;
  if (options.detrend && options.levelMode === "higher-land") {
    values = levelUsingHigherLand(values, measurement.width, measurement.height);
  } else if (options.detrend) {
    values = detrendPlane(values, measurement.width, measurement.height);
  }
  const denoisedSegmentation = fftLowPassForSegmentation(values, measurement.width, measurement.height, options.fftDenoiseStrength);
  const cluster = clusterPlateaus(values, measurement.width, measurement.height, denoisedSegmentation);
  const low = statsForMask(values, cluster.lowMask);
  const high = statsForMask(values, cluster.highMask);
  const lowAreaPx = countMask(cluster.lowMask);
  const highAreaPx = countMask(cluster.highMask);
  const totalPixels = measurement.width * measurement.height;
  const fovArea = Number.isFinite(measurement.fovX) && Number.isFinite(measurement.fovY) ? measurement.fovX * measurement.fovY : NaN;
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
    segmentationMode: cluster.segmentationMode,
    smoothRadiusPx: options.smoothRadiusPx,
    minRegionPercent: options.minRegionPercent || 0,
    fftDenoiseStrength: options.fftDenoiseStrength || 0,
    interpolatedPoints: reconstruction.interpolated,
    low,
    high,
    lowArea: { pixels: lowAreaPx, percent: (lowAreaPx / totalPixels) * 100, fovUnits2: Number.isFinite(fovArea) ? fovArea * lowAreaPx / totalPixels : NaN, components: cluster.lowComponents },
    highArea: { pixels: highAreaPx, percent: (highAreaPx / totalPixels) * 100, fovUnits2: Number.isFinite(fovArea) ? fovArea * highAreaPx / totalPixels : NaN, components: cluster.highComponents },
    heatmap,
    maskBlob,
    clusterCenters: cluster.centers,
    measuredFraction,
    heightDifference: high.mean - low.mean,
  };
}
