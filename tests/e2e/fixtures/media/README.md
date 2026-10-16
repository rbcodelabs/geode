# Canvas synthetic media

`canvas-silence.mp3` is 731 bytes of synthetic mono silence, generated locally with
FFmpeg 8.1.1 (libmp3lame), with no input recording or metadata:

```sh
ffmpeg -hide_banner -loglevel error -f lavfi -i anullsrc=r=22050:cl=mono -t 0.12 -c:a libmp3lame -b:a 32k -map_metadata -1 -write_xing 0 -id3v2_version 0 canvas-silence.mp3
```

Tests copy it to the existing `Sound.mp3` fixture path. No FFmpeg installation is
needed to run them. It replaces an ID3-only header that was not playable audio.
Resource checks require a fresh native audio element's `loadeddata` event and
finite positive duration before retirement, and native error after URL retirement.
A probe timeout fails the test; it cannot satisfy the negative oracle. These are
bounded browser loading/decoder checks, not audible playback verification.

The separate existing `Clip.mp4` fixture remains a short invalid header used only
for picker inclusion/filter coverage. No valid video rendering or decoding is
claimed by these tests.
