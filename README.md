# Safecast Live

Safecast Live revives [safestream](https://github.com/Safecast/safestream), the project behind the original [Safecast Live](https://safecast.org/safecast-live/) (v1.0, 2021, now deprecated).

It turns incoming Safecast radiation and air quality readings into sound. Each reading triggers a sample from a selected sound pack, creating an evolving composition shaped by what the sensors report and when their readings arrive. Each reading's location is shown as grayscale Landsat imagery of the surrounding area.

## Current status (v2.0, November 2026)

Working and deployed on Cloudflare:

- **Live feed.** Radnote and Airnote events arrive from Blues (Notehub) at `/ingest`, are authenticated with a bearer token, and are stored in a Cloudflare D1 database.
- **Browser player.** Polls `/events`, maps each reading to a sample and plays it at the spacing it arrived, with the latest reading sounding as soon as Play is pressed.
- **Sound packs.** Buchla, Michelsonne, Ghosts I-IV, Polivox, or Everything (a random pack per reading).
- **Effects.** Volume, reverb, echo, wet/dry mix, and effects order (echo > reverb, reverb > echo, parallel).
- **Loop capture.** Capture the last 15 seconds of what played and loop it under the live feed, with its own level.
- **Visuals.** Three views, from most artistic to most literal and global:
  - **Overlay:** layered, pixelated grayscale imagery with the sensor's coordinates.
  - **Contact Sheet:** a 3x2 grid of recent locations.
  - **3D:** a vector-display globe in a late-1970s / early-1980s terminal style that turns to each new reading, blinks a marker there and draws a hairline out to the nearest city, the reading and the coordinates.

  Imagery is NASA GIBS Landsat WELD true color, representative of the general area rather than the exact sensor position. Globe coastlines and city names come from [Natural Earth](https://www.naturalearthdata.com/) (public domain), stored in `public/globe/`.

In progress / planned:

- Tuning the reading-to-sample ranges against real-world data.

## How readings map to samples

Each pack has 22 samples: `rad00`–`rad10` for radiation and `air00`–`air10` for air quality. A reading is scaled into one of 11 bins (00 = lowest, 10 = highest, values outside the range are clamped):

| Metric | Source | Range mapped to 00–10 | Samples |
| --- | --- | --- | --- |
| `cpm` (counts per minute) | Radnote | 20–50 CPM | `rad00`–`rad10` |
| `pm01_0`, `pm02_5`, `pm10_0` (µg/m³) | Airnote | 0–10 | `air00`–`air10` |

A single Airnote event can trigger up to three air samples, one per particulate size.

## Sample specs

All samples are MP3, 44.1 kHz, stored in `public/audio/<pack>/`.

| Pack | Folder | Source | Channels | Length (each) | Bit rate | Total size | License |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Buchla | `buchla` | Buchla Music Easel, original recording by Sean Bonner | Mono | 3.1–7.2 s | ~77–118 kbps VBR | 1.2 MB | Original recording on the author's own instrument, released under this project's CC BY-NC-SA 4.0 license |
| Michelsonne | `sean` | Michelsonne toy piano by [Hainbach](https://www.hainbachmusik.com/) | Stereo | 2.6–6.9 s | ~139–153 kbps VBR | 1.8 MB | Provided license free |
| Ghosts I-IV | `NIN` | [Nine Inch Nails](https://nin.com/), *Ghosts I-IV* | Mostly stereo (3 mono) | 0.7–5.3 s | ~81–174 kbps VBR | 0.7 MB | [CC BY-NC-SA 3.0 US](https://creativecommons.org/licenses/by-nc-sa/3.0/us/) |
| Polivox | `polivox` | Polivox synth by [Samples From Mars](https://samplesfrommars.com/) | Mono | 3.0–3.2 s | ~81–200 kbps VBR | 1.1 MB | Purchased for commercial use |

## Layout

| Path | Purpose |
| --- | --- |
| `worker.mjs` | Cloudflare Worker: `/ingest` (receive events), `/events` (player feed), `/healthz` |
| `migrations/` | D1 schema |
| `public/index.html` | The page |
| `public/player.mjs` | Audio engine, polling, effects, loop capture |
| `public/field-recorder.mjs` | Imagery for the Overlay and Contact Sheet views, and view switching |
| `public/globe.mjs` | The 3D globe view |
| `public/globe/` | Natural Earth coastline (1:110m) and populated places (1:10m), trimmed to compact JSON |
| `public/audio/` | Sound packs |
| `older-work/` | Design explorations from development |

## Deploying

```sh
npx wrangler d1 migrations apply safecast-live --remote
npx wrangler secret put INGEST_TOKEN
npx wrangler deploy
```

## Credits

By [Sean Bonner](https://seanbonner.com/). Data: [Safecast](https://safecast.org/data/) (CC0). Live feed: [Blues Inc.](https://blues.com/) Imagery: [Landsat](https://www.usgs.gov/landsat-missions), courtesy of USGS. Map data: [Natural Earth](https://www.naturalearthdata.com/).

Published under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/).
