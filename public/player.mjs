import { showLocations, preloadLocation } from "./field-recorder.mjs?v=globe";
const play = document.querySelector("#play");
const pack = document.querySelector('[aria-label="Sound pack"]');
const volume = document.querySelector("#volume");
const reverb = document.querySelector("#reverb");
const echo = document.querySelector("#echo");
const routing = document.querySelector('[aria-label="Effects order"]');
const mix = document.querySelector("#mix");
const level = (control) => Number(control.value) / 100;
const captureLoop = document.querySelector("#capture-loop");
const loopLevel = document.querySelector("#loop-level");
const clearLoop = document.querySelector("#clear-loop");
const loopSeconds = 15;
// Readings are replayed with the spacing they arrived at, this many seconds behind live.
const playbackDelay = 3;
const status = document.querySelector("#status");
const ids = ["rad", "air"].flatMap((type) =>
  Array.from({ length: 11 }, (_, index) => type + String(index).padStart(2, "0")));
let session;
let opening;
let context;
let gain;
let impulse;

function createEffects() {
  const input = context.createGain();
  const dry = context.createGain();
  const wet = context.createGain();
  wet.connect(gain);
  wet.gain.value = level(mix);
  const room = context.createConvolver();
  const reverbLevel = context.createGain();
  const delay = context.createDelay();
  const feedback = context.createGain();
  const echoLevel = context.createGain();

  if (!impulse) {
    const frames = context.sampleRate * 5;
    impulse = context.createBuffer(2, frames, context.sampleRate);
    for (let channel = 0; channel < impulse.numberOfChannels; channel++) {
      const samples = impulse.getChannelData(channel);
      for (let i = 0; i < frames; i++) {
        const decay = (1 - i / frames) ** 3;
        samples[i] = (Math.random() * 2 - 1) * decay;
      }
    }
  }
  room.buffer = impulse;
  delay.delayTime.value = 0.65;
  feedback.gain.value = 0.45;
  reverbLevel.gain.value = level(reverb) * 0.6;
  echoLevel.gain.value = level(echo) * 0.45;

  dry.gain.value = 1 - level(mix);
  input.connect(dry).connect(gain);
  input.connect(room).connect(reverbLevel).connect(wet);
  input.connect(delay).connect(echoLevel).connect(wet);
  delay.connect(feedback).connect(delay);

  let route;
  function setRouting() {
    if (route === "echo-reverb") echoLevel.disconnect(room);
    if (route === "reverb-echo") reverbLevel.disconnect(delay);

    route = selected(routing);
    if (route === "echo-reverb") echoLevel.connect(room);
    if (route === "reverb-echo") reverbLevel.connect(delay);
  }
  setRouting();

  return {
    input,
    dry,
    wet,
    setRouting,
    reverbLevel,
    echoLevel,
    disconnect() {
      for (const node of [input, dry, wet, room, reverbLevel, delay, feedback, echoLevel]) {
        node.disconnect();
      }
    }
  };
}

async function loadPacks(names, signal, audioContext) {
  const packs = names.map(() => new Map());
  const samples = names.flatMap((name, index) => ids.map((id) => ({ name, index, id })));
  for (let offset = 0; offset < samples.length; offset += 6) {
    if (signal.aborted) throw signal.reason;
    await Promise.all(samples.slice(offset, offset + 6).map(async ({ name, index, id }) => {
      const response = await fetch(`/audio/${name}/${id}.mp3`, { signal });
      if (!response.ok) throw new Error("Missing audio sample");
      packs[index].set(id, await audioContext.decodeAudioData(await response.arrayBuffer()));
    }));
  }
  return packs;
}

async function resumeAudio() {
  let timeout;
  try {
    await Promise.race([
      context.resume(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Audio startup timed out")), 4000);
      })
    ]);
    if (context.state !== "running") throw new Error("Audio is not running");
  } finally {
    clearTimeout(timeout);
  }
}

// Fetch the latest reading and location before Play is pressed, along with the raw
// audio for that reading in every pack, so the first sound and image are instant.
function prepareOpening() {
  opening = readEvents(null).then((batch) => {
    const location = batch.locations?.[0];
    if (location) preloadLocation(location);
    const ids = batch.events[0]?.samples ?? [];
    const names = Array.from(pack.querySelectorAll("button"), (option) => option.dataset.value).filter((name) => name !== "all");
    const audio = new Map(names.flatMap((name) => ids.map((id) => [`${name}/${id}`,
      fetch(`/audio/${name}/${id}.mp3`).then((response) => response.ok ? response.arrayBuffer() : null).catch(() => null)])));
    return { ids, location, audio };
  }).catch(() => null);
}

async function playOpening(active, names) {
  const ready = await opening;
  prepareOpening();
  if (!ready || active.controller.signal.aborted) return;
  if (ready.location) showLocations([ready.location]);
  for (const id of ready.ids) {
    const name = names[Math.floor(Math.random() * names.length)];
    const bytes = await ready.audio.get(`${name}/${id}`);
    if (!bytes || active.controller.signal.aborted) continue;
    const buffer = await context.decodeAudioData(bytes.slice(0)).catch(() => null);
    if (!buffer || active.controller.signal.aborted) continue;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(active.effects.input);
    active.voices.add(source);
    source.onended = () => active.voices.delete(source);
    const time = context.currentTime;
    source.start(time);
    active.history.push({ pack: name, id, buffer, time });
  }
}

async function readEvents(after, signal) {
  const response = await fetch(after === null ? "/events" : `/events?after=${after}`, { signal });
  if (!response.ok) throw new Error("Feed unavailable");
  return response.json();
}

function clearLayer() {
  const layer = session?.layer;
  if (!layer) return;
  clearInterval(layer.timer);
  for (const source of layer.voices) source.stop();
  layer.gain.disconnect();
  session.layer = undefined;
  clearLoop.disabled = true;
}

function recentSounds(active, now) {
  active.history = active.history.filter(({ time }) => time >= now - loopSeconds);
  captureLoop.disabled = active.history.length === 0;
}

captureLoop.onclick = () => {
  const active = session;
  if (!active) return;
  const now = context.currentTime;
  recentSounds(active, now);
  const heard = active.history.filter(({ time }) => time <= now).sort((a, b) => a.time - b.time);
  if (heard.length === 0) return;

  clearLayer();
  const score = heard.map(({ pack, id, buffer, time }) => ({
    pack, id, buffer, offset: time - (now - loopSeconds)
  }));
  const layer = { gain: context.createGain(), voices: new Set() };
  layer.gain.gain.value = level(loopLevel);
  layer.gain.connect(active.effects.input);
  active.layer = layer;
  clearLoop.disabled = false;

  const start = now + 0.1;
  let cycle = 0;
  let note = 0;
  function schedule() {
    const now = context.currentTime;
    const currentCycle = Math.max(0, Math.floor((now - start) / loopSeconds));
    if (cycle < currentCycle) {
      cycle = currentCycle;
      note = 0;
    }
    while (true) {
      const { buffer, offset } = score[note];
      const when = start + cycle * loopSeconds + offset;
      if (when > now + 0.25) return;
      if (when >= now) {
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(layer.gain);
        layer.voices.add(source);
        source.onended = () => layer.voices.delete(source);
        source.start(when);
      }
      note++;
      if (note === score.length) {
        note = 0;
        cycle++;
      }
    }
  }
  schedule();
  layer.timer = setInterval(schedule, 100);
};

clearLoop.onclick = clearLayer;
loopLevel.oninput = () => {
  session?.layer?.gain.gain.setTargetAtTime(level(loopLevel), context.currentTime, 0.03);
};

function stop() {
  if (session) {
    clearLayer();
    session.controller.abort();
    clearTimeout(session.timer);
    for (const source of session.voices) source.stop();
    session.effects?.disconnect();
    session = undefined;
    if (navigator.audioSession) navigator.audioSession.type = "auto";
  }
  captureLoop.disabled = true;
  play.textContent = "Play";
  status.textContent = "Paused";
}

async function start(withOpening = false) {
  stop();
  const active = { controller: new AbortController(), voices: new Set(), history: [] };
  const { signal } = active.controller;
  session = active;
  play.textContent = "Pause";
  const gps = document.querySelector(".gps");
  if (gps.textContent === "[ press to start ]") gps.textContent = "Waiting for location";
  status.textContent = "Loading sound pack…";
  const names = selected(pack) === "all"
    ? Array.from(pack.querySelectorAll("button"), (option) => option.dataset.value).filter((name) => name !== "all")
    : [selected(pack)];
  try {
    const AudioContextClass = window.AudioContext ?? window.webkitAudioContext;
    if (navigator.audioSession) navigator.audioSession.type = "playback";
    context ??= new AudioContextClass();
    await resumeAudio();
    if (signal.aborted) return;
  } catch {
    if (signal.aborted) return;
    stop();
    if (context) void context.close().catch(() => {});
    context = undefined;
    gain = undefined;
    impulse = undefined;
    status.textContent = "Could not start browser audio. Tap Play to retry.";
    return;
  }

  let packs;
  try {
    if (!gain) {
      gain = context.createGain();
      gain.connect(context.destination);
    }
    gain.gain.value = level(volume);
    active.effects = createEffects();
    if (withOpening) void playOpening(active, names);
    packs = await loadPacks(names, signal, context);
    if (signal.aborted) return;
  } catch {
    if (signal.aborted) return;
    stop();
    status.textContent = "Could not load this sound pack. Press Play to retry.";
    return;
  }
  let cursor = null;
  let triggered = 0;
  async function poll() {
    if (signal.aborted) return;
    if (context.state !== "running") {
      stop();
      status.textContent = "Browser audio interrupted. Tap Play to resume.";
      return;
    }
    try {
      const joining = cursor === null;
      const batch = await readEvents(cursor, signal);
      if (signal.aborted) return;
      cursor = batch.cursor;
      // Joining the feed only sets the cursor; the starting reading is the opening's job.
      if (joining) batch.events = [];
      else showLocations(batch.locations ?? []);
      const audioNow = context.currentTime;
      const readings = batch.events.slice(-16).flatMap(({ at, samples }) => {
        const time = Math.max(audioNow, audioNow + playbackDelay - (batch.now - at) / 1000);
        return samples.map((id) => ({ id, time }));
      });
      for (const { id, time } of readings) {
        if (active.voices.size >= 24) break;
        const source = context.createBufferSource();
        const index = Math.floor(Math.random() * packs.length);
        source.buffer = packs[index].get(id);
        source.connect(active.effects.input);
        active.voices.add(source);
        source.onended = () => active.voices.delete(source);
        source.start(time);
        active.history.push({ pack: names[index], id, buffer: source.buffer, time });
        triggered++;
      }
      status.textContent = triggered
        ? `Live · ${triggered} measurement${triggered === 1 ? "" : "s"} observed`
        : "Live · waiting for readings";
    } catch {
      if (signal.aborted) return;
      cursor = null;
      status.textContent = "Feed interrupted · reconnecting";
    }
    recentSounds(active, context.currentTime);
    active.timer = setTimeout(poll, 2500);
  }
  void poll();
}

play.onclick = () => session ? stop() : void start(true);
prepareOpening();

volume.oninput = () => { if (gain) gain.gain.value = level(volume); };

reverb.oninput = () => {
  session?.effects?.reverbLevel.gain.setTargetAtTime(level(reverb) * 0.6, context.currentTime, 0.03);
};
echo.oninput = () => {
  session?.effects?.echoLevel.gain.setTargetAtTime(level(echo) * 0.45, context.currentTime, 0.03);
};


function selected(group) {
  return group.querySelector('[aria-pressed="true"]').dataset.value;
}
for (const group of [pack, routing]) {
  const buttons = [...group.querySelectorAll("button")];
  for (const button of buttons) {
    button.onclick = () => {
      if (button.getAttribute("aria-pressed") === "true") return;
      buttons.forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
      if (group === pack && session) void start();
      if (group === routing) session?.effects?.setRouting();
    };
  }
}

for (const input of document.querySelectorAll(".dial input")) {
  const dial = input.closest(".dial");
  const glyphs = dial.querySelector(".glyphs");
  const output = dial.querySelector("output");
  function renderSlider() {
    const position = Math.round(Number(input.value) / 10);
    glyphs.textContent = Array.from({ length: 11 }, (_, index) =>
      index === 10 - position ? "[x]" : " | "
    ).join("\n");
    output.value = input.value.padStart(3, "0");
  }
  input.addEventListener("input", renderSlider);
  renderSlider();
}

mix.oninput = () => {
  const wet = level(mix);
  mix.setAttribute("aria-valuetext", mix.value + "% wet, " + (100 - Number(mix.value)) + "% dry");
  session?.effects?.dry.gain.setTargetAtTime(1 - wet, context.currentTime, 0.01);
  session?.effects?.wet.gain.setTargetAtTime(wet, context.currentTime, 0.01);
};
