const art = document.querySelector(".art");
const canvas = art.querySelector("canvas");
const gps = art.querySelector(".gps");
const sheet = art.querySelector(".sheet");
const context = canvas.getContext("2d");
const output = context.createImageData(canvas.width, canvas.height);
output.data.fill(255);
const scratch = document.createElement("canvas");
scratch.width = canvas.width;
scratch.height = canvas.height;
const sampler = scratch.getContext("2d", { willReadFrequently: true });
const frames = [];
const fadeMs = 9000;
let pending = [];
let loading = false;
let animation;

for (const button of document.querySelectorAll("[data-view]")) {
  button.onclick = () => {
    const showSheet = button.dataset.view === "sheet";
    canvas.hidden = gps.hidden = showSheet;
    sheet.hidden = !showSheet;
    for (const option of document.querySelectorAll("[data-view]")) {
      option.setAttribute("aria-pressed", String(option === button));
    }
  };
}

const zoom = 12;
const tiles = 2 ** zoom;
const tileSize = 256;
// Times each sensor's tile has been shown this session, keyed by its base tile URL.
const visits = new Map();

function tilePosition(lat, lon) {
  const radians = Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180;
  const x = Math.max(0, Math.min(tiles - 1, Math.floor((lon + 180) / 360 * tiles)));
  const y = Math.max(0, Math.min(tiles - 1, Math.floor((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * tiles)));
  return { x, y };
}

function urlFor(x, y) {
  return "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/" +
    "Landsat_WELD_CorrectedReflectance_TrueColor_Global_Annual/default/" +
    `2000-12-01/GoogleMapsCompatible_Level12/${zoom}/${y}/${x}.jpeg`;
}

// The sensor's own tile. Duplicate checks always use this, whatever the framing.
function tileUrl(lat, lon) {
  const { x, y } = tilePosition(lat, lon);
  return urlFor(x, y);
}

// First appearance shows the sensor's tile as is. On each return the frame shifts at the
// same zoom: the reading's level sets the east/west shift, returns alternate north/south.
function framing(location) {
  const { x, y } = tilePosition(location.lat, location.lon);
  const seen = visits.get(urlFor(x, y)) ?? 0;
  let dx = 0;
  let dy = 0;
  if (seen) {
    const bin = Number(location.samples?.[0]?.slice(-2));
    const across = Number.isFinite(bin) ? (bin - 5) / 5 : 0;
    dx = Math.round(across * tileSize / 2);
    dy = Math.round((1 - Math.abs(across)) * tileSize / 2) * (seen % 2 ? 1 : -1);
  }
  return { x, y, dx, dy, key: `${urlFor(x, y)}#${dx},${dy}` };
}

const preloaded = new Map();

// Fetch and process a tile ahead of time without showing it.
export function preloadLocation(location) {
  const { key } = framing(location);
  if (!preloaded.has(key)) preloaded.set(key, processFrame(location).catch(() => null));
}

async function loadFrame(location) {
  const { key, dx, dy } = framing(location);
  const ready = preloaded.get(key);
  preloaded.delete(key);
  const frame = await (ready ?? processFrame(location));
  // If a shifted frame can't be built (for example a neighbouring tile is missing), fall back to the sensor's own tile.
  return frame ?? (dx || dy ? processFrame(location, false) : null);
}

async function fetchTile(x, y) {
  const response = await fetch(urlFor((x + tiles) % tiles, Math.max(0, Math.min(tiles - 1, y))),
    { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error("Tile unavailable");
  return createImageBitmap(await response.blob());
}

async function processFrame(location, shifted = true) {
  const { lat, lon } = location;
  const { x, y, dx, dy } = shifted ? framing(location) : { ...framing(location), dx: 0, dy: 0 };
  const left = x * tileSize + dx;
  const top = y * tileSize + dy;
  const placed = [];
  for (let ty = Math.floor(top / tileSize); ty * tileSize < top + tileSize; ty++) {
    for (let tx = Math.floor(left / tileSize); tx * tileSize < left + tileSize; tx++) {
      placed.push({ tx, ty });
    }
  }
  let images;
  try {
    images = await Promise.all(placed.map(({ tx, ty }) => fetchTile(tx, ty)));
  } catch {
    return null;
  }
  const scale = canvas.width / tileSize;
  try {
    sampler.clearRect(0, 0, canvas.width, canvas.height);
    placed.forEach(({ tx, ty }, i) => {
      sampler.drawImage(images[i], (tx * tileSize - left) * scale, (ty * tileSize - top) * scale,
        tileSize * scale, tileSize * scale);
    });
    const pixels = sampler.getImageData(0, 0, canvas.width, canvas.height);
    const gray = Uint8Array.from({ length: pixels.data.length / 4 }, (_, i) => {
      const p = i * 4;
      return Math.round(0.299 * pixels.data[p] + 0.587 * pixels.data[p + 1] + 0.114 * pixels.data[p + 2]);
    });
    const sorted = gray.slice().sort();
    const low = sorted[Math.floor(sorted.length * 0.02)];
    const high = sorted[Math.floor(sorted.length * 0.98)];
    if (high <= low) return null;
    gray.forEach((value, i) => {
      const tone = Math.round(Math.max(0, Math.min(1, (value - low) / (high - low))) * 11) * 255 / 11;
      gray[i] = tone;
      pixels.data.fill(tone, i * 4, i * 4 + 3);
    });
    sampler.putImageData(pixels, 0, 0);
    return { gray, src: scratch.toDataURL(), url: urlFor(x, y), label: `${lat.toFixed(4)}, ${lon.toFixed(4)}` };
  } finally {
    for (const image of images) image.close();
  }
}

function paint(now) {
  const latest = frames.at(-1);
  const layers = matchMedia("(prefers-reduced-motion: reduce)").matches ? [] :
    frames.slice(0, -1).map(({ gray, time }) => ({ gray, opacity: 1 - (now - time) / fadeMs }))
      .filter(({ opacity }) => opacity > 0);
  latest.gray.forEach((value, i) => {
    let composite = 255;
    for (const { gray, opacity } of layers) {
      composite += (255 - Math.abs(composite - gray[i]) - composite) * opacity;
    }
    output.data.fill(255 - Math.abs(composite - value), i * 4, i * 4 + 3);
  });
  context.putImageData(output, 0, 0);
  if (layers.length) animation = requestAnimationFrame(paint);
}

export function showLocations(locations) {
  const distinct = new Map();
  for (const location of pending.concat(locations)) {
    const url = tileUrl(location.lat, location.lon);
    if (frames.some((frame) => frame.url === url)) continue;
    distinct.delete(url);
    distinct.set(url, location);
  }
  pending = [...distinct.values()].slice(-9);
  if (!loading && pending.length) void loadPending();
}

async function loadPending() {
  loading = true;
  try {
    while (pending.length) {
      const batch = pending.splice(0).filter(({ lat, lon }) =>
        !frames.some((frame) => frame.url === tileUrl(lat, lon)));
      const loaded = await Promise.all(batch.map((location) => loadFrame(location).catch(() => null)));
      const now = performance.now();
      for (const frame of loaded) {
        if (!frame) continue;
        frames.push({ ...frame, time: now });
        visits.set(frame.url, (visits.get(frame.url) ?? 0) + 1);
        if (frames.length > 9) frames.shift();
      }
      if (!loaded.some(Boolean)) continue;
      gps.textContent = frames.at(-1).label;
      gps.style.color = gps.style.color === "white" ? "black" : "white";
      sheet.replaceChildren(...frames.slice(-6).reverse().map(({ label, src }) => {
        const tile = document.createElement("li");
        const image = document.createElement("img");
        const caption = document.createElement("span");
        image.src = src;
        image.alt = "Landsat imagery near " + label;
        caption.textContent = label;
        tile.append(image, caption);
        return tile;
      }));
      cancelAnimationFrame(animation);
      paint(now);
    }
  } finally {
    loading = false;
  }
}
