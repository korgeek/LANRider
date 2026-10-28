# Asset provenance and distribution scope

The source-code MIT license does not apply to binary art, recordings, or external data. Project-specific artwork was created by the owner with Samgim. You may use that artwork and the bundled Suno music, including in your own projects, subject to their respective terms. You may fork this repository within GitHub, subject to Suno’s terms for the music. Outside GitHub forks, you may not redistribute or sell those assets separately or as part of another product, or sublicense them to others. Third-party assets remain governed by their own licenses, including CC0; these restrictions do not replace those terms.

## Project-specific assets

| Runtime files | Provenance and terms |
| --- | --- |
| `vehicles/v4/<id>/<id>_lod0.glb`, `*_lod1.glb` | Eight vehicle designs, two quality levels each. The project-specific asset terms above apply; see the [vehicle notice](notices/vehicles-project-use-LICENSE.txt). |
| `drivers/vnext/driver_lod0.glb` | Project driver model. The project-specific asset terms above apply. |
| `coast/*.glb`, `beach/*.glb`, `tropical/*.glb`, `clouds/*.glb`, `inland/*.glb`, `track-props/*.glb` | Project-specific scenery and reused project components. The project-specific asset terms above apply. |
| `asphalt.png` | Texture generated for this project. The project-specific asset terms above apply. |
| `boost-lines.svg` | Project vector effect. The project-specific asset terms above apply. |
| `audio/sfx/countdown-b-tick.wav`, `audio/sfx/countdown-b-go.wav` | Synthesized tones; no external recording or sample was used. |

## CC0 recordings

The boost, collision, drift, engine and finish-cheer recordings use CC0 1.0 Universal sources. [Selected source URLs, creators, processing and original Kenney notices](notices/audio-CC0.md) are preserved. Attribution is optional under CC0; credits document provenance and imply no endorsement. CC0 does not grant trademark, privacy or publicity rights.

## Sky data and runtime software

- `sky-stars.json`: [d3-celestial](https://github.com/ofrohn/d3-celestial), Olaf Frohn; XHIP (Anderson & Francis 2012). Extracted J2000 coordinates for 921 stars at magnitude 4.5 or brighter and eight constellation line sets. BSD-3-Clause; retain [the original notice](notices/sky-data-BSD-3-Clause.txt) and the JSON's source, author and license metadata.
- Representative timezone coordinates: [IANA tzdb zone.tab](https://github.com/eggert/tz/blob/main/zone.tab), public domain. These are representative cities, not users' precise locations.
- [SunCalc 2.1.1](https://github.com/mourner/suncalc), Volodymyr Agafonkin: BSD-2-Clause; [original notice](notices/suncalc-BSD-2-Clause.txt).
- [Three.js 0.186.1](https://github.com/mrdoob/three.js): MIT; [original notice](notices/three-MIT.txt).
- [ws 8.22.0](https://github.com/websockets/ws): MIT; [original notice](notices/ws-MIT.txt).
- Live cloud-cover data: [Open-Meteo](https://open-meteo.com/), CC BY 4.0. The game displays a provider attribution link when received weather data is shown. API service terms are separate from the data license; the free API is for noncommercial use. Commercial operation must follow the provider's current plan and terms.

Original notices are retained in the `notices/` directory linked above.

## Bundled project music and waves

`audio/music/*.mp3` contains three tracks created with Suno, credited to **musicbysantai**. `audio/ambient-waves.mp3` is Ocean Waves by [DRAGON-STUDIO](https://ko-fi.com/dragonstudio), under the Pixabay Content License; see the notice for its separate terms and standalone redistribution restriction. The Suno recordings and embedded covers have separate terms from the software MIT license. Use of that music and GitHub forks of this repository are subject to Suno’s terms; resale, redistribution outside GitHub forks, and sublicensing are not. See the [music and waves notice](notices/music-Suno.md).
