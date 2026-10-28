# LANRider contributor guidance

- When adding or changing a course, read [the course guide](docs/course-guide.ko.md). Keep the shared route, server validation, rendering, localization and tests consistent; verify the new course as well as existing ones.
- When adding or changing a vehicle, read [the vehicle guide](docs/vehicle-guide.ko.md). Keep the model, shared physics, engine audio, localization, server validation and tests consistent; verify the new vehicle as well as existing ones.
- Keep private backups and authoring materials under `_archive/` out of Git and Docker. Project artwork and music have separate terms; consult [asset terms](public/assets/licenses.md) before adding or redistributing assets.
- LAN play is the supported scope. Do not imply Internet hosting or cross-device play is verified without evidence; report the actual checks and any untested steps.

## Updating music

- Add MP3 files to `public/assets/audio/music/` and remove tracks no longer used. Keep filenames URL-safe, lowercase and unique, such as `coast-drive.mp3`.
- Update `MUSIC_TRACKS` in `shared/music.js`: each entry is `[id, title, artist, version]`, where `id` matches the filename without `.mp3`. Use the first 12 characters of `shasum -a 256 public/assets/audio/music/<id>.mp3` as `version`; update it whenever the file changes so browsers fetch the replacement.
- Verify each song's license and permission to include and redistribute the actual file, including in public GitHub forks, before publication. Record the creator, source and applicable terms in `public/assets/notices/music-Suno.md`, `public/assets/licenses.md` and `THIRD_PARTY_NOTICES.md`. Keep any required third-party notices. Never assume a supplied file or a paid download grants redistribution rights.
- Update music-related descriptions in the READMEs and development story when needed. Specific selections repeat the chosen song; Random can change songs when a track finishes. Test both behaviors and the picker after changing the playlist.
- Run `npm test`. For local playback, use `npm ci` and `npm start`, then preview each song and test both selection modes in a browser. Only claim LAN or Internet testing when performed.
