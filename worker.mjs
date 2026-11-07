import { timingSafeEqual } from "node:crypto";

const metrics = ["cpm", "pm01_0", "pm02_5", "pm10_0"];
const maxBytes = 65536;
const encoder = new TextEncoder();
const reply = (status) => new Response(null, { status });

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/healthz" && request.method === "GET") return reply(204);
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
