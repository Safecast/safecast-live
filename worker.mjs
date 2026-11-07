import { timingSafeEqual } from "node:crypto";

const metrics = ["cpm", "pm01_0", "pm02_5", "pm10_0"];
const maxBytes = 65536;
const encoder = new TextEncoder();
const reply = (status) => new Response(null, { status });

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/healthz" && request.method === "GET") return reply(204);
    if (path === "/events" && request.method === "GET") return events(request, env);
    if (path !== "/ingest") return reply(404);
    if (request.method !== "POST") return reply(405);
    if (!env.INGEST_TOKEN) return reply(503);

    const expected = encoder.encode("Bearer " + env.INGEST_TOKEN);
    const supplied = encoder.encode(request.headers.get("Authorization") ?? "");
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return reply(401);
    if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") return reply(415);
    if (Number(request.headers.get("Content-Length")) > maxBytes) return reply(413);
    if (!request.body) return reply(400);

    const reader = request.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let raw = "";
    let size = 0;
    let event;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          return reply(413);
        }
        raw += decoder.decode(value, { stream: true });
      }
      event = JSON.parse(raw + decoder.decode());
    } catch {
      return reply(400);
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) return reply(400);
    if (event.file !== "_air.qo") return reply(204);
    if (typeof event.event !== "string" || !event.event || !event.body || typeof event.body !== "object" || Array.isArray(event.body)) return reply(400);
    if (!metrics.some((key) => Number.isFinite(event.body[key]) && event.body[key] >= 0)) return reply(204);

    try {
      await env.DB.prepare(
        "INSERT INTO events (event_id, accepted_at, payload) VALUES (?, ?, ?) ON CONFLICT(event_id) DO NOTHING"
      ).bind(event.event, Date.now(), raw).run();
    } catch {
      console.error("Safecast event storage failed");
      return reply(503);
    }
    return reply(204);
  }
};

function sample(prefix, value, low, high) {
  const bin = Math.floor(10 * Math.max(0, Math.min(1, (value - low) / (high - low))));
  return prefix + String(bin).padStart(2, "0");
}

async function events(request, env) {
  const after = new URL(request.url).searchParams.get("after");
  const headers = { "Cache-Control": "no-store" };
  try {
    if (after === null) {
      const cursor = await env.DB.prepare("SELECT COALESCE(MAX(seq), 0) AS cursor FROM events").first("cursor");
      return Response.json({ cursor, events: [] }, { headers });
    }
    if (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after))) return reply(400);
    const { results } = await env.DB.prepare(
      "SELECT seq, payload FROM events WHERE seq > ? ORDER BY seq LIMIT 64"
    ).bind(Number(after)).all();
    const events = [];
    for (const row of results) {
      const event = JSON.parse(row.payload);
      if (event.event.startsWith("setup-test-") || event.event.startsWith("load-test-")) continue;
      const samples = [];
      for (const key of metrics) {
        const value = event.body[key];
        if (!Number.isFinite(value) || value < 0) continue;
        // Use the original common 20–50 CPM range as a starting point for Radnote.
        samples.push(key === "cpm" ? sample("rad", value, 20, 50) : sample("air", value, 0, 10));
      }
      if (samples.length) events.push(samples);
    }
    return Response.json({ cursor: results.at(-1)?.seq ?? Number(after), events }, { headers });
  } catch {
    return reply(503);
  }
}
