import { describe, expect, it } from 'vitest';

import {
  parseSubtitleTracks,
  srtToVtt,
  subtitleTrackLabel,
  SUBTITLE_CONTENT_TYPE,
} from './subtitles';

const VID = 'mediavid001';

describe('parseSubtitleTracks', () => {
  it('finds <videoId>.<lang>.<ext> sidecars, only the <track>-viable vtt/srt formats', () => {
    const tracks = parseSubtitleTracks(
      [
        `${VID}.mp4`, // media — ignored
        `${VID}.webp`, // thumbnail — ignored
        `${VID}.info.json`, // sidecar — ignored
        `${VID}.en.vtt`,
        `${VID}.es.srt`,
        `${VID}.fr.ass`, // ass is NOT <track>-viable — excluded
        'unrelated.en.vtt', // different video prefix — ignored
      ],
      VID,
    );
    expect(tracks).toEqual([
      { lang: 'en', label: 'English', format: 'vtt' },
      { lang: 'es', label: 'Spanish', format: 'srt' },
    ]);
  });

  it('dedupes a lang that has BOTH vtt and srt, preferring vtt', () => {
    const tracks = parseSubtitleTracks([`${VID}.en.srt`, `${VID}.en.vtt`], VID);
    expect(tracks).toEqual([{ lang: 'en', label: 'English', format: 'vtt' }]);
  });

  it('keeps hyphenated BCP-47 tags (en-US) and sorts by lang; empty when none', () => {
    const tracks = parseSubtitleTracks([`${VID}.ko.vtt`, `${VID}.en-US.vtt`], VID);
    expect(tracks.map((t) => t.lang)).toEqual(['en-US', 'ko']);
    expect(parseSubtitleTracks([`${VID}.mp4`], VID)).toEqual([]);
  });

  it('excludes an unsafe lang so every listed track is serveable (parity with the serve validator)', () => {
    // A lang with a dot cannot pass the serve endpoint's safeId → never list it.
    expect(parseSubtitleTracks([`${VID}.en.orig.vtt`], VID)).toEqual([]);
  });
});

describe('srtToVtt', () => {
  it('prepends the WEBVTT header and turns comma-decimal timecodes into dots', () => {
    const srt = ['1', '00:00:01,000 --> 00:00:04,000', 'Hello, world', '', ''].join('\n');
    const vtt = srtToVtt(srt);
    expect(vtt.startsWith('WEBVTT\n\n')).toBe(true);
    expect(vtt).toContain('00:00:01.000 --> 00:00:04.000');
    expect(vtt).toContain('Hello, world'); // a comma in the TEXT is untouched
  });

  it('normalizes CRLF and strips a BOM; idempotent on already-VTT-ish input', () => {
    const srt = '\uFEFF1\r\n00:00:00,500 --> 00:00:02,500\r\nLine\r\n';
    const vtt = srtToVtt(srt);
    expect(vtt).not.toContain('\r');
    expect(vtt).not.toContain('\uFEFF');
    expect(vtt).toContain('00:00:00.500 --> 00:00:02.500');
  });

  it('converts ONLY cue-timing lines \u2014 a timecode-shaped substring in cue TEXT is left alone', () => {
    const srt = ['1', '00:00:01,000 --> 00:00:02,000', 'ping at 00:00:01,500 sharp', '', ''].join(
      '\n',
    );
    const vtt = srtToVtt(srt);
    expect(vtt).toContain('00:00:01.000 --> 00:00:02.000'); // the timing line is dotted
    expect(vtt).toContain('ping at 00:00:01,500 sharp'); // the cue TEXT comma survives
  });

  it('converts every cue in a multi-cue document', () => {
    const srt = [
      '1',
      '00:00:01,000 --> 00:00:02,000',
      'A',
      '',
      '2',
      '00:00:03,250 --> 00:00:04,750',
      'B',
      '',
    ].join('\n');
    const vtt = srtToVtt(srt);
    expect(vtt).toContain('00:00:01.000 --> 00:00:02.000');
    expect(vtt).toContain('00:00:03.250 --> 00:00:04.750');
  });
});

describe('subtitleTrackLabel', () => {
  it('derives a human label from the lang code, omitting the unresolvable', () => {
    expect(subtitleTrackLabel('en')).toBe('English');
    expect(subtitleTrackLabel('ko')).toBe('Korean');
    expect(subtitleTrackLabel('zz')).toBeUndefined(); // unassigned code echoes → omitted
    expect(subtitleTrackLabel('en_US')).toBeUndefined(); // malformed tag throws → omitted
  });
});

describe('SUBTITLE_CONTENT_TYPE', () => {
  it('is WebVTT (the one type the serve endpoint ever emits)', () => {
    expect(SUBTITLE_CONTENT_TYPE).toBe('text/vtt; charset=utf-8');
  });
});
