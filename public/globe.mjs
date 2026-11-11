// 3D view: a vector-display globe in the style of late-1970s / early-1980s
// calligraphic and storage-tube terminals. Each new reading turns the globe to the
// sensor, blinks a marker there and draws a hairline out to the nearest city's name.
const art = document.querySelector(".art");
const canvas = art.querySelector("canvas.globe");
const gps = art.querySelector(".gps");
const context = canvas.getContext("2d");

const phosphor = "224,224,214";
const background = "11,11,10";
const font = '"Courier New", Courier, monospace';
const turnMs = 2400;
const holdMs = 9000;
const minShowMs = 6000;
const idleSpin = 6; // degrees per second when nothing new has arrived
const driftSpin = 0.6; // degrees per second while a reading is shown
const markLifeMs = 10 * 60 * 1000;
const typeMs = 28; // per character, for the terminal-style label reveal
// Redraws come at an uneven, low frame rate with the odd hitch and sideways slip,
// like an old display struggling to keep up. The globe's motion runs on real time,
// so a late frame jumps ahead rather than slowing down.
const frameMs = 1000 / 14;
const hitchChance = 0.04;
const slipChance = 0.03;

const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
let visible = false;
let frame;
let last = 0;
let nextDraw = 0;
let coast = [];
let cities = [];
let data;
let ready = false;
const graticule = buildGraticule();
const view = { lon: -140, lat: 20 };
let turn = null; // { from, to, start }
let current = null; // the reading being presented
const queue = [];
const marks = [];

function load() {
  data ??= Promise.all([
    fetch("/globe/coastline.json").then((response) => response.json()),
    fetch("/globe/cities.json").then((response) => response.json())
  ]).then(([lines, places]) => {
    coast = lines.map((flat) => {
      const points = [];
      for (let i = 0; i < flat.length; i += 2) points.push([flat[i], flat[i + 1]]);
      return points;
    });
    cities = places;
  }).catch(() => {}).finally(() => { ready = true; });
  return data;
}

function buildGraticule() {
  const lines = [];
  for (let lon = -180; lon < 180; lon += 30) {
    const line = [];
    for (let lat = -80; lat <= 80; lat += 4) line.push([lon, lat]);
    lines.push(line);
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const line = [];
    for (let lon = -180; lon <= 180; lon += 4) line.push([lon, lat]);
    lines.push(line);
  }
  return lines;
}

function nearestCity(lat, lon) {
  let best = null;
  let bestDistance = Infinity;
  const scale = Math.cos(lat * Math.PI / 180);
  for (const city of cities) {
    const dLat = city[2] - lat;
    let dLon = Math.abs(city[3] - lon);
    if (dLon > 180) dLon = 360 - dLon;
    const distance = dLat * dLat + (dLon * scale) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = city;
    }
  }
  if (!best) return null;
  const km = Math.round(Math.sqrt(bestDistance) * 111);
  return { name: best[0], country: best[1], km };
}

function describe(location) {
  const { values = {}, samples = [] } = location;
  const round = (value) => value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  if (Number.isFinite(values.cpm)) return `${round(values.cpm)} CPM`;
  const air = [["PM1", values.pm01_0], ["PM2.5", values.pm02_5], ["PM10", values.pm10_0]]
    .filter(([, value]) => Number.isFinite(value));
  if (air.length) return air.map(([name, value]) => `${name} ${round(value)}`).join(" ") + " UG/M3";
  const level = samples[0];
  return level ? `${level.startsWith("rad") ? "RAD" : "AIR"} LEVEL ${level.slice(-2)}/10` : "";
}

function coordinates(lat, lon) {
  return `${Math.abs(lat).toFixed(2)}${lat < 0 ? "S" : "N"} ${Math.abs(lon).toFixed(2)}${lon < 0 ? "W" : "E"}`;
}

export function showOnGlobe(locations) {
  for (const location of locations) {
    const previous = queue.at(-1) ?? current;
    if (previous && previous.lat === location.lat && previous.lon === location.lon) continue;
    queue.push({ lat: location.lat, lon: location.lon, location });
  }
  queue.splice(0, Math.max(0, queue.length - 4));
  if (visible) start();
}

export function setGlobeVisible(show) {
  visible = show;
  canvas.hidden = !show;
  if (show) {
    void load().then(() => { if (visible) start(); });
    start();
  } else {
    cancelAnimationFrame(frame);
    frame = undefined;
  }
}

function start() {
  if (frame || !visible) return;
  last = performance.now();
  frame = requestAnimationFrame(tick);
}

function next(now) {
  const item = queue.shift();
  const place = nearestCity(item.lat, item.lon);
  current = {
    ...item,
    lines: [
      place ? `${place.km > 30 ? "NEAR " : ""}${place.name}, ${place.country}`.toUpperCase() : "",
      describe(item.location),
      coordinates(item.lat, item.lon)
    ].filter(Boolean),
    arrived: null
  };
  marks.push({ lat: item.lat, lon: item.lon, at: Date.now() });
  if (marks.length > 60) marks.shift();
  if (still()) {
    view.lon = item.lon;
    view.lat = item.lat;
    current.arrived = now;
    turn = null;
  } else {
    turn = { from: { ...view }, to: { lon: item.lon, lat: Math.max(-60, Math.min(60, item.lat)) }, start: now };
  }
}

function advance(now, seconds) {
  // Each reading stays on screen for at least minShowMs before the next one takes over.
  if (ready && queue.length && (!current || (current.arrived && now - current.arrived > minShowMs))) next(now);
  if (turn) {
    const t = Math.min(1, (now - turn.start) / turnMs);
    const ease = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    const dLon = ((turn.to.lon - turn.from.lon) % 360 + 540) % 360 - 180;
    view.lon = turn.from.lon + dLon * ease;
    view.lat = turn.from.lat + (turn.to.lat - turn.from.lat) * ease;
    if (t === 1) {
      turn = null;
      current.arrived = now;
    }
  } else if (!still()) {
    const holding = current && now - current.arrived < holdMs;
    view.lon += (holding ? driftSpin : idleSpin) * seconds;
    if (!holding) view.lat += (20 - view.lat) * Math.min(1, seconds * 0.3);
  }
  view.lon = ((view.lon + 540) % 360) - 180;
}

function project(lon, lat, cx, cy, radius) {
  const rad = Math.PI / 180;
  const l = (lon - view.lon) * rad;
  const p = lat * rad;
  const p0 = view.lat * rad;
  const cosP = Math.cos(p);
  return {
    x: cx + radius * cosP * Math.sin(l),
    y: cy - radius * (Math.cos(p0) * Math.sin(p) - Math.sin(p0) * cosP * Math.cos(l)),
    front: Math.sin(p0) * Math.sin(p) + Math.cos(p0) * cosP * Math.cos(l)
  };
}

function strokeLines(lines, cx, cy, radius) {
  context.beginPath();
  for (const line of lines) {
    let drawing = false;
    for (const [lon, lat] of line) {
      const point = project(lon, lat, cx, cy, radius);
      if (point.front <= 0) {
        drawing = false;
        continue;
      }
      if (drawing) context.lineTo(point.x, point.y);
      else context.moveTo(point.x, point.y);
      drawing = true;
    }
  }
  context.stroke();
}

function draw(now, slip = 0) {
  const ratio = devicePixelRatio || 1;
  const width = Math.round(canvas.clientWidth * ratio);
  const height = Math.round(canvas.clientHeight * ratio);
  if (!width || !height) return;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const unit = height / 400;
  // The globe sits left of centre so the label has open screen to the right.
  const cx = width * 0.36 + slip * unit;
  const cy = height / 2;
  const radius = height * 0.42;
  const layout = { cx, cy, radius, unit, width, height, ratio };

  context.globalCompositeOperation = "source-over";
  context.shadowBlur = 0;
  context.fillStyle = `rgb(${background})`;
  context.fillRect(0, 0, width, height);

  context.lineCap = context.lineJoin = "round";
  context.shadowColor = `rgba(${phosphor},0.9)`;
  context.shadowBlur = 4 * unit;

  context.strokeStyle = `rgba(${phosphor},0.3)`;
  context.lineWidth = Math.max(1, 0.6 * unit);
  strokeLines(graticule, cx, cy, radius);

  context.beginPath();
  context.arc(cx, cy, radius, 0, Math.PI * 2);
  context.strokeStyle = `rgba(${phosphor},0.7)`;
  context.stroke();

  context.strokeStyle = `rgba(${phosphor},1)`;
  context.lineWidth = Math.max(1, 0.9 * unit);
  strokeLines(coast, cx, cy, radius);

  const time = Date.now();
  for (const mark of marks) {
    const age = (time - mark.at) / markLifeMs;
    if (age >= 1 || mark === marks.at(-1)) continue;
    const point = project(mark.lon, mark.lat, cx, cy, radius);
    if (point.front <= 0) continue;
    const size = 2.4 * unit;
    context.fillStyle = `rgba(${phosphor},${0.8 * (1 - age)})`;
    context.fillRect(point.x - size / 2, point.y - size / 2, size, size);
  }

  if (current) drawCurrent(now, layout);
  else drawPrompt(layout);
}

function drawPrompt({ cx, height, unit, ratio }) {
  const text = gps.textContent.trim();
  if (!text) return;
  context.font = `${Math.max(10 * ratio, Math.round(14 * unit))}px ${font}`;
  context.textAlign = "center";
  context.textBaseline = "alphabetic";
  context.fillStyle = `rgba(${phosphor},0.95)`;
  context.fillText(text, cx, height - 14 * unit);
}

function drawCurrent(now, { cx, cy, radius, unit, width, ratio }) {
  const point = project(current.lon, current.lat, cx, cy, radius);
  if (point.front <= 0) return;
  const size = 5 * unit;
  context.fillStyle = `rgba(${phosphor},1)`;
  if (still() || Math.floor(now / 380) % 2 === 0) {
    context.fillRect(point.x - size / 2, point.y - size / 2, size, size);
  }

  if (!current.arrived) return;
  const since = now - current.arrived;

  // A single ring sweeps out from the marker when the globe arrives.
  if (since < 1400 && !still()) {
    const t = since / 1400;
    context.beginPath();
    context.arc(point.x, point.y, (6 + 40 * t) * unit, 0, Math.PI * 2);
    context.strokeStyle = `rgba(${phosphor},${0.9 * (1 - t)})`;
    context.lineWidth = Math.max(1, 0.8 * unit);
    context.stroke();
  }

  // Hairline leader: up and out from the marker, across past the globe's edge,
  // ending in a rule the label sits on.
  const textX = cx + radius + 22 * unit;
  const room = width - textX - 10 * unit;
  const spacing = "letterSpacing" in context;
  if (spacing) context.letterSpacing = `${Math.round(1.5 * unit)}px`;
  let titleSize = Math.max(10 * ratio, Math.round(13 * unit));
  context.font = `${titleSize}px ${font}`;
  const titleWidth = context.measureText(current.lines[0]).width;
  if (titleWidth > room) {
    titleSize = Math.max(9 * ratio, Math.floor(titleSize * room / titleWidth));
    context.font = `${titleSize}px ${font}`;
  }
  const detailSize = Math.max(9 * ratio, Math.round(titleSize * 0.85));
  const ruleY = Math.max(titleSize + 8 * unit, Math.min(point.y - 40 * unit, cy - radius * 0.35));
  const elbow = { x: point.x + Math.max(12 * unit, (point.y - ruleY) * 0.7), y: ruleY };
  const end = { x: textX + Math.min(room, Math.max(titleWidth, room * 0.6)), y: ruleY };
  const grow = still() ? 1 : Math.min(1, since / 450);
  const first = Math.min(1, grow * 2);
  const second = Math.max(0, grow * 2 - 1);

  context.beginPath();
  context.moveTo(point.x + 4 * unit, point.y - 4 * unit);
  context.lineTo(point.x + (elbow.x - point.x) * first, point.y + (elbow.y - point.y) * first);
  if (second) context.lineTo(elbow.x + (end.x - elbow.x) * second, ruleY);
  context.strokeStyle = `rgba(${phosphor},0.8)`;
  context.lineWidth = Math.max(1, 0.6 * unit);
  context.stroke();
  if (grow < 1) {
    if (spacing) context.letterSpacing = "0px";
    return;
  }

  let reveal = still() ? Infinity : Math.floor((since - 450) / typeMs);
  context.textAlign = "left";
  context.fillStyle = `rgba(${phosphor},1)`;
  context.textBaseline = "bottom";
  context.fillText(current.lines[0].slice(0, Math.max(0, reveal)), textX, ruleY - 5 * unit, room);
  reveal -= current.lines[0].length;
  context.textBaseline = "top";
  context.font = `${detailSize}px ${font}`;
  let y = ruleY + 7 * unit;
  for (const line of current.lines.slice(1)) {
    context.fillStyle = `rgba(${phosphor},0.8)`;
    context.fillText(line.slice(0, Math.max(0, reveal)), textX, y, room);
    reveal -= line.length;
    y += detailSize * 1.35;
  }
  if (spacing) context.letterSpacing = "0px";
}

function tick(now) {
  frame = undefined;
  if (!visible) return;
  const seconds = Math.min(0.1, (now - last) / 1000);
  last = now;
  advance(now, seconds);
  if (still()) draw(now);
  else if (now >= nextDraw) {
    const hitch = Math.random() < hitchChance;
    nextDraw = now + (hitch ? 180 + Math.random() * 260 : frameMs * (0.7 + Math.random() * 0.7));
    draw(now, Math.random() < slipChance ? (Math.random() < 0.5 ? -1 : 1) * (2 + Math.random() * 4) : 0);
  }
  frame = requestAnimationFrame(tick);
}
