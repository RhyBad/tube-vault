/**
 * ffprobe adapter: `parseFfprobe` is the v1 `parse_ffprobe` port (including the
 * NaN/inf rejection of `_to_float`/`_to_int`); `runFfprobe` is exercised
 * against the committed fake-ffprobe fixture (deterministic — no real ffmpeg
 * on the test host).
 */
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { EngineError } from './errors.js';
import { parseFfprobe, runFfprobe } from './ffprobe.js';

const FAKE_FFPROBE = fileURLToPath(new URL('../test/fixtures/fake-ffprobe.mjs', import.meta.url));

afterEach(() => {
  delete process.env.FAKE_FFPROBE_SCENARIO;
});

describe('parseFfprobe (v1 parse_ffprobe port)', () => {
  it('maps a video+audio probe to the core MediaProbe shape', () => {
    const probe = parseFfprobe({
      streams: [
        { codec_type: 'video', codec_name: 'vp9', width: 3840, height: 2160 },
        { codec_type: 'audio', codec_name: 'opus' },
      ],
      format: { format_name: 'webm', duration: '634.2', bit_rate: '2500000' },
    });
    expect(probe).toEqual({
      containerFormat: 'webm',
      durationSeconds: 634.2,
      hasVideo: true,
      hasAudio: true,
      videoCodec: 'vp9',
      audioCodec: 'opus',
      width: 3840,
      height: 2160,
      bitRate: 2500000,
      nbStreams: 2,
    });
  });

  it('rejects NaN/inf durations (a malformed mux must not pass integrity)', () => {
    expect(parseFfprobe({ format: { duration: 'nan' } }).durationSeconds).toBeNull();
    expect(parseFfprobe({ format: { duration: 'inf' } }).durationSeconds).toBeNull();
    expect(parseFfprobe({ format: { duration: '-inf' } }).durationSeconds).toBeNull();
  });

  it('tolerates missing/empty sections (audio-only, no format block)', () => {
    const probe = parseFfprobe({ streams: [{ codec_type: 'audio', codec_name: 'mp3' }] });
    expect(probe.hasVideo).toBe(false);
    expect(probe.hasAudio).toBe(true);
    expect(probe.videoCodec).toBeNull();
    expect(probe.width).toBeNull();
    expect(probe.durationSeconds).toBeNull();
    expect(probe.nbStreams).toBe(1);
  });

  it('falls back to format.nb_streams when the streams list is absent', () => {
    expect(parseFfprobe({ format: { nb_streams: '3' } }).nbStreams).toBe(3);
    expect(parseFfprobe({}).nbStreams).toBe(0);
  });

  it('non-integer int fields become null (v1 _to_int ValueError tolerance)', () => {
    expect(parseFfprobe({ format: { bit_rate: 'unknown' } }).bitRate).toBeNull();
    expect(parseFfprobe({ format: { bit_rate: '4.5' } }).bitRate).toBeNull();
  });
});

describe('runFfprobe (against the fake-ffprobe fixture)', () => {
  it('parses the fake probe end-to-end', async () => {
    const probe = await runFfprobe('/probe/target.mp4', FAKE_FFPROBE);
    expect(probe.durationSeconds).toBeCloseTo(12.512);
    expect(probe.hasVideo).toBe(true);
    expect(probe.hasAudio).toBe(true);
    expect(probe.width).toBe(1920);
    expect(probe.nbStreams).toBe(2);
  });

  it('nonzero exit -> EngineError carrying the ffprobe stderr', async () => {
    process.env.FAKE_FFPROBE_SCENARIO = 'fail';
    await expect(runFfprobe('/probe/target.mp4', FAKE_FFPROBE)).rejects.toThrow(EngineError);
    await expect(runFfprobe('/probe/target.mp4', FAKE_FFPROBE)).rejects.toThrow(
      /Invalid data found/,
    );
  });

  it('unparseable stdout -> EngineError', async () => {
    process.env.FAKE_FFPROBE_SCENARIO = 'garbage';
    await expect(runFfprobe('/probe/target.mp4', FAKE_FFPROBE)).rejects.toThrow(EngineError);
  });

  it('missing binary -> EngineError (ffprobe unavailable)', async () => {
    await expect(runFfprobe('/probe/target.mp4', '/nonexistent/ffprobe')).rejects.toThrow(
      EngineError,
    );
  });
});
