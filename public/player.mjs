const play = document.querySelector("#play");
const pack = document.querySelector("#pack");
const volume = document.querySelector("#volume");
const status = document.querySelector("#status");
const ids = ["rad", "air"].flatMap((type) =>
  Array.from({ length: 11 }, (_, index) => type + String(index).padStart(2, "0")));
let session;
let context;
let gain;

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
  let buffers;
  try {
    context ??= new AudioContext();
    if (!gain) {
      gain = context.createGain();
      gain.connect(context.destination);
    }
    gain.gain.value = Number(volume.value);
    await context.resume();
    buffers = await loadPack(pack.value, signal);
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
        source.buffer = buffers.get(id);
        source.connect(gain);
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
