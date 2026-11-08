const play = document.querySelector("#play");
const pack = document.querySelector("#pack");
const volume = document.querySelector("#volume");
const reverb = document.querySelector("#reverb");
const echo = document.querySelector("#echo");
const status = document.querySelector("#status");
const ids = ["rad", "air"].flatMap((type) =>
  Array.from({ length: 11 }, (_, index) => type + String(index).padStart(2, "0")));
let session;
let context;
let gain;
let impulse;

function createEffects() {
  const input = context.createGain();
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

  input.connect(gain);
  input.connect(room).connect(reverbLevel).connect(gain);
  input.connect(delay).connect(echoLevel).connect(gain);
  delay.connect(feedback).connect(delay);

  return {
    input,
    reverbLevel,
    echoLevel,
    disconnect() {
      for (const node of [input, room, reverbLevel, delay, feedback, echoLevel]) {
        node.disconnect();
      }
    }
  };
}

async function loadPack(name, signal) {
  const entries = await Promise.all(ids.map(async (id) => {
    const response = await fetch(`/audio/${name}/${id}.mp3`, { signal });
    if (!response.ok) throw new Error("Missing audio sample");
    return [id, await context.decodeAudioData(await response.arrayBuffer())];
  }));
  return new Map(entries);
}

async function readEvents(after, signal) {
  const response = await fetch(after === null ? "/events" : `/events?after=${after}`, { signal });
  if (!response.ok) throw new Error("Feed unavailable");
  return response.json();
}

function stop() {
  if (session) {
    session.controller.abort();
    clearTimeout(session.timer);
    for (const source of session.voices) source.stop();
    session.effects?.disconnect();
    session = undefined;
  }
  play.textContent = "Listen";
  status.textContent = "Paused";
}

async function start() {
  stop();
  const active = { controller: new AbortController(), voices: new Set() };
  const { signal } = active.controller;
  session = active;
  play.textContent = "Pause";
  status.textContent = "Loading sound pack…";
  const names = pack.value === "all"
    ? Array.from(pack.options, (option) => option.value).filter((name) => name !== "all")
    : [pack.value];
  let packs;
  try {
    context ??= new AudioContext();
    if (!gain) {
      gain = context.createGain();
      gain.connect(context.destination);
    }
    gain.gain.value = Number(volume.value);
    active.effects = createEffects();
    await context.resume();
    packs = await Promise.all(names.map((name) => loadPack(name, signal)));
  } catch {
    if (signal.aborted) return;
    stop();
    status.textContent = "Could not load this sound pack. Press Listen to retry.";
    return;
  }
  let cursor = null;
  async function poll() {
    if (signal.aborted) return;
    try {
      const batch = await readEvents(cursor, signal);
      if (signal.aborted) return;
      cursor = batch.cursor;
      for (const id of batch.events.flat().slice(-16)) {
        if (active.voices.size >= 24) break;
        const source = context.createBufferSource();
        const buffers = packs[Math.floor(Math.random() * packs.length)];
        source.buffer = buffers.get(id);
        source.connect(active.effects.input);
        active.voices.add(source);
        source.onended = () => active.voices.delete(source);
        source.start();
      }
      status.textContent = "Live · waiting for readings";
    } catch {
      if (signal.aborted) return;
      cursor = null;
      status.textContent = "Feed interrupted · reconnecting";
    }
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
