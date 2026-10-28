# Development story

[Back to the English README](../README.md) · [한국어](development.ko.md)

## An MVP in 3 days

The starting point was a small wish: race with colleagues during short breaks on an isolated corporate LAN. Remembering older racing games led to a discussion with GPT, then to a playable browser racing MVP in three days.

That milestone describes the first playable MVP. It does not mean every feature here was finished in that window or that the project is production ready. The current version extends that experiment with multiplayer recovery, vehicle choices, sound, graphics settings, and a repeat-race flow.

This is a desktop keyboard game built with Three.js, Node.js, and WebSockets. One local server serves the game, models, textures, and JavaScript dependencies. There is no login or database; rooms live in one server process, and restarting it ends them.

## Driving physics and race rules

The vehicle picker always shows normal top speed and a 0–100 km/h time measured with the shared physics. Normal caps range from 175.75 to 218.5 km/h and average 190 km/h after a uniform 5% reduction; the boost cap is 280 km/h. Lower-cap vehicles reach their limits sooner while keeping distinct launch, handling, collision-recovery, charging and boost strengths. Scripted lap comparisons are balance indicators, not a guarantee of equal human competitiveness.

Ordinary cornering preserves world-space momentum. Tyres dissipate lateral slip within a shared acceleration/braking/cornering force budget, so large high-speed steering gently slows the car and widens its turning radius; small steering has little cost. A finite-response drivetrain governor approaches the selected speed cap and allows natural overspeed decay after boost. This point-mass approximation omits axle load transfer and yaw inertia; grip coefficients fit the game's arcade speed/track scale, rather than measured real-kart tyres. Run `node tools/qa/cornering-balance.mjs current` for per-vehicle steering probes and three-course comparisons, saved under `.cache/`.

Finish records lock at the line, while cars keep rolling and slow down as though the accelerator was released. Finishers no longer interfere with remaining racers' collisions. Coasting continues behind the results without changing records or the next starting grid.

Sustained wrong-way travel shows a red screen-edge warning. Vehicle contacts use rotating rectangular boxes at 90% of each body's width and length, with full driver height included; the server and local prediction share this calculation. Light visual contact is intentionally tolerated.

## How the project was built

The following summaries describe the needs and decisions behind the project. They are paraphrased, not verbatim transcripts.

### 1. One server decides the race

```text
Need: Players should agree on collisions, lap progress, and the result.
Decision: Keep the simulation and race state on one authoritative server.
Implementation: Advance physics at 60 Hz and broadcast snapshots at 20 Hz.
```

The server validates incoming commands and decides positions, collisions, checkpoints, and finishes. Client prediction improves response but cannot confirm a finish. Shared physics code reduces differences between the server simulation and the local prediction.

One process keeps deployment small and understandable for a LAN MVP. It also means rooms are temporary, there is no cross-process room coordination, and a restart disconnects the session.

### 2. WebSockets instead of peer-to-peer networking

```text
Need: Several browsers should join the same short race on a LAN.
Decision: Connect every browser to the same server using WebSockets.
Tradeoff: Keep hosting and authority simple; accept server traffic per client.
```

A single HTTP server serves the browser app and accepts WebSocket connections. This avoids a separate peer discovery, signaling, and peer authority flow. It is a deliberate fit for this small server-hosted game, rather than a claim that WebSockets outperform every peer-to-peer design.

### 3. Immediate input, then reconciliation

```text
Need: Steering should respond before a server round trip completes.
Decision: Predict the local car and number each input command.
Implementation: Apply the server state, discard acknowledged inputs,
                and replay the remaining inputs against that state.
```

The local car uses fixed 60 Hz prediction. Server acknowledgments identify which commands have already been processed, so reconciliation replays only the unacknowledged commands. Race identifiers and snapshot ordering keep old state from being applied to a new race.

### 4. Interpolation and visual smoothing

```text
Need: Remote cars and the camera should move smoothly between updates.
Decision: Buffer remote snapshots by 100 ms and separate drawing from physics.
Implementation: Interpolate remote cars; smooth displayed local corrections.
```

Remote interpolation trades a small display delay for steadier movement. While driving, cars within 8 m share the local collision prediction timeline and render correction, blending back to buffered interpolation over 8–16 m. Spectators keep buffered playback. The local fixed-step accumulator also provides interpolation between physics steps. Render offsets soften corrections without changing the authoritative simulation; camera following uses elapsed render time. F3 exposes timing and correction statistics for inspecting the result.

### 5. Engine sound follows the car

```text
Need: Vehicles should sound alive without a large audio subsystem.
Decision: Reuse two short engine-loop families, with a fixed family per vehicle.
Implementation: Shape pitch with speed and filter/gain with throttle and load.
```

PULSE, APEX, BOLT, COMET, SLIDE, and IGNIS use the sport loop; BULWARK and RALLY use the rough loop. Persistent Web Audio voices avoid restarting an engine on every update. Smoothed parameter changes reduce abrupt transitions, and nearby opponents are quieter than the local car.

Collision sounds have a cooldown. Drift clips repeat only while drifting and stop when that state ends. Countdown and finish cues follow race events. A click or key press unlocks browser audio; visibility handling silences engines and stops driving effects when the page is hidden. Sound settings preserve volume and mute choices.

The game includes three tracks created with Suno, credited to **musicbysantai**, and waves ambience by DRAGON-STUDIO. Music is separate from the software MIT license; use and GitHub forks are subject to Suno’s terms, and redistribution or sale outside GitHub forks is prohibited, whether separately or as part of another product. Original MP3 bytes, tags and embedded covers are preserved. See the [music and waves notice](../public/assets/notices/music-Suno.md). Documented CC0 engine/effect audio and synthesized countdown are retained.

The room-creation dialog previews music immediately: leave the default Random choice or use the previous/next buttons to select a song. The room shares its starting song and playback mode. A selected song repeats when it ends; Random can switch songs. Transitions use short fades and are not seamless loops. Lobby entry fades music out; racing music begins after the GO sound ends. Playback stays independent of driving inputs. The header master mute silences all channels without changing their saved levels. Default levels are ambience 30%, music 50%, effects 20%; existing saved settings take precedence.

BGM uses one streaming HTML audio element, without decoding the playlist into PCM. Only the selected playing song gets a compressed fallback copy; failures try a cached copy of the selected song; Random can also try other cached songs. CacheStorage is used where available; plain HTTP LAN pages retain a per-page memory fallback, with browser HTTP caching as an additional best effort. Music, waves, effects and engine voices share output headroom, compression and a peak guard. Saved music, ambience and effects controls remain separate.

### 6. Graphics choices for different machines


```text
Need: Keep the same race playable on machines with different graphics budgets.
Decision: Offer high, medium, and low quality with an initial graphics probe.
Implementation: Reuse scene assets, batch repeated props, and switch vehicle LOD.
```

High and medium use NORMAL vehicle models; low uses LIGHT models. Scenery settings reduce background work. Shared geometry/materials, instanced props, and reuse of static scene assets limit duplication. Quality changes affect presentation rather than vehicle physics.

The first-visit graphics probe suggests and stores a quality level. A manual choice takes priority, including a choice made while the probe is running. This is a device-specific starting point, not an FPS guarantee; visibility, resolution, and browser behavior can affect measurements.

### 7. Make the next race easy to start

```text
Need: A short break should be spent racing, including when all seats are full.
Decision: Keep vehicle selection, readiness, spectating, and rematches connected.
Implementation: Preserve the waiting queue and expose the next-race state.
```

Players can choose a car in the lobby, while waiting, and after results. Spectators can choose a driver or use automatic leader following. Invitation links reduce repeated room entry. The result countdown, waiting queue, and rematch readiness make session transitions visible instead of leaving players guessing.

### 8. AI collaboration, with human acceptance

```text
Workflow: Discuss a small requirement, implement it, play it, and inspect failures.
Human role: Decide priorities, test the feel, refine the UI, and accept changes.
AI roles: Dots for modeling, Codex for networking/server work,
          and ChatGPT for balancing discussions.
```

The human developer drove product decisions, playtests, UI direction, priorities, and acceptance. Dots supplied modeling work; Codex supported networking and server implementation; ChatGPT supported balancing. These roles describe this project's workflow, not a guarantee about generated output. Tests and playtests remained part of deciding whether a change worked.

