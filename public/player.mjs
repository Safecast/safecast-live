const play = document.querySelector("#play");
const pack = document.querySelector("#pack");
const volume = document.querySelector("#volume");
const reverb = document.querySelector("#reverb");
const echo = document.querySelector("#echo");
const routing = document.querySelector("#routing");
const killDry = document.querySelector("#kill-dry");
const captureLoop = document.querySelector("#capture-loop");
const loopLevel = document.querySelector("#loop-level");
const clearLoop = document.querySelector("#clear-loop");
const loopSeconds = 15;
const status = document.querySelector("#status");
const ids = ["rad", "air"].flatMap((type) =>
  Array.from({ length: 11 }, (_, index) => type + String(index).padStart(2, "0")));
let session;
let context;
let gain;
let impulse;

function createEffects() {
  const input = context.createGain();
  const dry = context.createGain();
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
  reverbLevel.gain.value = Number(reverb.value) * 0.6;
  echoLevel.gain.value = Number(echo.value) * 0.45;

  dry.gain.value = killDry.checked ? 0 : 1;
  input.connect(dry).connect(gain);
  input.connect(room).connect(reverbLevel).connect(gain);
  input.connect(delay).connect(echoLevel).connect(gain);
  delay.connect(feedback).connect(delay);

  let route;
  function setRouting() {
    if (route === "echo-reverb") echoLevel.disconnect(room);
    if (route === "reverb-echo") reverbLevel.disconnect(delay);

    route = routing.value;
    if (route === "echo-reverb") echoLevel.connect(room);
    if (route === "reverb-echo") reverbLevel.connect(delay);
  }
  setRouting();

  return {
    input,
    dry,
    setRouting,
    reverbLevel,
    echoLevel,
    disconnect() {
      for (const node of [input, dry, room, reverbLevel, delay, feedback, echoLevel]) {
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
  if (active.history.length === 0) return;

  clearLayer();
  const score = active.history.map(({ pack, id, buffer, time }) => ({
    pack, id, buffer, offset: time - (now - loopSeconds)
  }));
  const layer = { gain: context.createGain(), voices: new Set() };
  layer.gain.gain.value = Number(loopLevel.value);
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
  session?.layer?.gain.gain.setTargetAtTime(Number(loopLevel.value), context.currentTime, 0.03);
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
  play.textContent = "Listen";
  status.textContent = "Paused";
}

async function start() {
  stop();
  const active = { controller: new AbortController(), voices: new Set(), history: [] };
  const { signal } = active.controller;
  session = active;
  play.textContent = "Pause";
  status.textContent = "Loading sound pack…";
  const names = pack.value === "all"
    ? Array.from(pack.options, (option) => option.value).filter((name) => name !== "all")
    : [pack.value];
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
    status.textContent = "Could not start browser audio. Tap Listen to retry.";
    return;
  }

  let packs;
  try {
    if (!gain) {
      gain = context.createGain();
      gain.connect(context.destination);
    }
    gain.gain.value = Number(volume.value);
    active.effects = createEffects();
    packs = await loadPacks(names, signal, context);
    if (signal.aborted) return;
  } catch {
    if (signal.aborted) return;
    stop();
    status.textContent = "Could not load this sound pack. Press Listen to retry.";
    return;
  }
  let cursor = null;
  let triggered = 0;
  async function poll() {
    if (signal.aborted) return;
    if (context.state !== "running") {
      stop();
      status.textContent = "Browser audio interrupted. Tap Listen to resume.";
      return;
    }
    try {
      const batch = await readEvents(cursor, signal);
      if (signal.aborted) return;
      cursor = batch.cursor;
      for (const id of batch.events.flat().slice(-16)) {
        if (active.voices.size >= 24) break;
        const source = context.createBufferSource();
        const index = Math.floor(Math.random() * packs.length);
        source.buffer = packs[index].get(id);
        source.connect(active.effects.input);
        active.voices.add(source);
        source.onended = () => active.voices.delete(source);
        const time = context.currentTime;
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

play.onclick = () => session ? stop() : void start();
pack.onchange = () => { if (session) void start(); };
volume.oninput = () => { if (gain) gain.gain.value = Number(volume.value); };

reverb.oninput = () => {
  session?.effects?.reverbLevel.gain.setTargetAtTime(Number(reverb.value) * 0.6, context.currentTime, 0.03);
};
echo.oninput = () => {
  session?.effects?.echoLevel.gain.setTargetAtTime(Number(echo.value) * 0.45, context.currentTime, 0.03);
};

routing.onchange = () => session?.effects?.setRouting();
killDry.onchange = () => {
  session?.effects?.dry.gain.setTargetAtTime(killDry.checked ? 0 : 1, context.currentTime, 0.01);
};
