/**
 * Anti-corruption mapping of yt-dlp JSON (v1 `adapters/engine_mapping.py`
 * parity: `info_to_channel_info`, `_extract_handle`, `_collect_entries` /
 * `flat_playlist_to_entries`, `info_json_to_metadata` subset) + the
 * runYtdlpJson subprocess wrapper. Unit-level: inline fixture objects; the
 * child-process cases use `node -e` scripts (no yt-dlp involved).
 */
import { describe, expect, it } from 'vitest';

import { EngineError } from './errors.js';
import {
  AbortedError,
  flatPlaylistToEntries,
  infoToChannelInfo,
  infoToLiveProbe,
  infoToVideoMetadata,
  runYtdlpJson,
} from './ytdlp-mapping.js';

// ---------------------------------------------------------------------------
// infoToChannelInfo (v1 info_to_channel_info + _extract_handle)
// ---------------------------------------------------------------------------

describe('infoToChannelInfo', () => {
  it('maps a channel-root info dict: id, channel-name title, handle, url', () => {
    expect(
      infoToChannelInfo({
        id: 'UCabc',
        channel_id: 'UCabc',
        title: 'Some Channel - Videos', // tab-suffixed playlist title
        channel: 'Some Channel',
        uploader_id: '@somechannel',
        channel_url: 'https://www.youtube.com/channel/UCabc',
      }),
    ).toEqual({
      channelId: 'UCabc',
      title: 'Some Channel', // display title prefers the channel name over the tab title
      handle: '@somechannel',
      url: 'https://www.youtube.com/channel/UCabc',
    });
  });

  it('falls back to the playlist id when channel_id is absent (a channel tab id IS the channel id)', () => {
    expect(infoToChannelInfo({ id: 'UCfallback', title: 'T' }).channelId).toBe('UCfallback');
  });

  it('title preference order: channel > uploader > title > empty string', () => {
    expect(infoToChannelInfo({ id: 'UC1', uploader: 'Up', title: 'T' }).title).toBe('Up');
    expect(infoToChannelInfo({ id: 'UC1', title: 'T' }).title).toBe('T');
    expect(infoToChannelInfo({ id: 'UC1' }).title).toBe('');
  });

  it("handle: uploader_id already a handle ('@x') wins", () => {
    expect(infoToChannelInfo({ id: 'UC1', uploader_id: '@direct' }).handle).toBe('@direct');
  });

  it("handle: extracted from the first '@…' path segment of a channel/uploader URL", () => {
    expect(
      infoToChannelInfo({
        id: 'UC1',
        uploader_id: 'UC1', // NOT a handle
        channel_url: 'https://www.youtube.com/@fromurl/videos',
      }).handle,
    ).toBe('@fromurl');
    expect(
      infoToChannelInfo({ id: 'UC1', webpage_url: 'https://www.youtube.com/@frompage' }).handle,
    ).toBe('@frompage');
  });

  it('handle: none anywhere → null', () => {
    expect(
      infoToChannelInfo({ id: 'UC1', channel_url: 'https://www.youtube.com/channel/UC1' }).handle,
    ).toBeNull();
  });

  it('url preference order: channel_url > webpage_url > uploader_url > null', () => {
    expect(
      infoToChannelInfo({ id: 'UC1', webpage_url: 'https://w', uploader_url: 'https://u' }).url,
    ).toBe('https://w');
    expect(infoToChannelInfo({ id: 'UC1', uploader_url: 'https://u' }).url).toBe('https://u');
    expect(infoToChannelInfo({ id: 'UC1' }).url).toBeNull();
  });

  it('missing channel id → EngineError (v1 message)', () => {
    expect(() => infoToChannelInfo({ title: 'no id at all' })).toThrow(EngineError);
    expect(() => infoToChannelInfo({ title: 'no id at all' })).toThrow(
      'yt-dlp channel info has no channel id',
    );
  });

  it('malformed top-level JSON (not an object) → EngineError', () => {
    expect(() => infoToChannelInfo(null)).toThrow(EngineError);
    expect(() => infoToChannelInfo([1, 2])).toThrow(EngineError);
    expect(() => infoToChannelInfo('just a string')).toThrow(EngineError);
  });
});

// ---------------------------------------------------------------------------
// flatPlaylistToEntries (v1 flat_playlist_to_entries / _collect_entries)
// ---------------------------------------------------------------------------

describe('flatPlaylistToEntries', () => {
  it('recurses into NESTED tab playlists and dedupes across tabs', () => {
    const info = {
      id: 'UCnested',
      entries: [
        {
          id: 'UCnested-videos',
          title: 'C - Videos',
          entries: [
            { id: 'vid1', title: 'One', duration: 61, live_status: 'not_live' },
            { id: 'vid2', title: 'Two', duration: 122 },
          ],
        },
        {
          id: 'UCnested-streams',
          title: 'C - Live',
          entries: [
            { id: 'vid2', title: 'Two (dup across tabs)' }, // deduped
            { id: 'vid3', title: 'Stream', live_status: 'was_live' },
          ],
        },
      ],
    };
    const entries = flatPlaylistToEntries(info);
    expect(entries.map((e) => e.videoId)).toEqual(['vid1', 'vid2', 'vid3']);
    expect(entries[0]).toEqual({
      videoId: 'vid1',
      title: 'One',
      url: null,
      durationSeconds: 61,
      uploadDate: null,
      liveStatus: 'not_live',
    });
    expect(entries[2]?.liveStatus).toBe('was_live');
  });

  it('skips id-less and non-dict entries', () => {
    const entries = flatPlaylistToEntries({
      entries: [null, 42, 'nope', { title: 'no id' }, { id: 'kept', title: 'Kept' }],
    });
    expect(entries.map((e) => e.videoId)).toEqual(['kept']);
  });

  it("placeholder upload_date '00000000' degrades to null; a real one is midnight UTC", () => {
    const entries = flatPlaylistToEntries({
      entries: [
        { id: 'a', upload_date: '00000000' },
        { id: 'b', upload_date: '20230601' },
      ],
    });
    expect(entries[0]?.uploadDate).toBeNull();
    expect(entries[1]?.uploadDate).toEqual(new Date(Date.UTC(2023, 5, 1)));
  });

  it('duration: booleans are rejected, finite numbers pass (v1 _opt_float)', () => {
    const entries = flatPlaylistToEntries({
      entries: [
        { id: 'a', duration: true },
        { id: 'b', duration: 12.5 },
        { id: 'c', duration: 'fast' },
      ],
    });
    expect(entries.map((e) => e.durationSeconds)).toEqual([null, 12.5, null]);
  });

  it('url falls back webpage_url; title falls back to empty string', () => {
    const entries = flatPlaylistToEntries({
      entries: [{ id: 'a', webpage_url: 'https://w/a' }, { id: 'b' }],
    });
    expect(entries[0]?.url).toBe('https://w/a');
    expect(entries[0]?.title).toBe('');
    expect(entries[1]?.url).toBeNull();
  });

  it('no/invalid entries → empty list; malformed top level → EngineError', () => {
    expect(flatPlaylistToEntries({})).toEqual([]);
    expect(flatPlaylistToEntries({ entries: 'nope' })).toEqual([]);
    expect(() => flatPlaylistToEntries(null)).toThrow(EngineError);
  });
});

// ---------------------------------------------------------------------------
// infoToVideoMetadata (v1 info_json_to_metadata, preservation subset)
// ---------------------------------------------------------------------------

describe('infoToVideoMetadata', () => {
  it('maps the preservation-relevant subset', () => {
    expect(
      infoToVideoMetadata({
        id: 'vidmeta1',
        title: 'A video',
        channel_id: 'UCowner',
        channel: 'Owner Channel',
        duration: 61.5,
        upload_date: '20240102',
        timestamp: 1704200000,
        webpage_url: 'https://www.youtube.com/watch?v=vidmeta1',
        availability: 'public',
        live_status: 'was_live',
        description: 'First line.\nSecond line.',
      }),
    ).toEqual({
      videoId: 'vidmeta1',
      title: 'A video',
      channelId: 'UCowner',
      channelTitle: 'Owner Channel',
      durationSeconds: 61.5,
      uploadDate: new Date(Date.UTC(2024, 0, 2)),
      timestamp: new Date(1704200000 * 1000),
      webpageUrl: 'https://www.youtube.com/watch?v=vidmeta1',
      availability: 'public',
      liveStatus: 'was_live',
      description: 'First line.\nSecond line.',
    });
  });

  it('description: a non-empty string passes; empty / absent / non-string → null', () => {
    expect(infoToVideoMetadata({ id: 'v', description: 'hello' }).description).toBe('hello');
    expect(infoToVideoMetadata({ id: 'v', description: '' }).description).toBeNull();
    expect(infoToVideoMetadata({ id: 'v' }).description).toBeNull();
    expect(infoToVideoMetadata({ id: 'v', description: 42 }).description).toBeNull();
  });

  it('channelTitle falls back channel → uploader → null', () => {
    expect(infoToVideoMetadata({ id: 'v', uploader: 'Up' }).channelTitle).toBe('Up');
    expect(infoToVideoMetadata({ id: 'v' }).channelTitle).toBeNull();
  });

  it('absent optionals are null / empty / unknown', () => {
    expect(infoToVideoMetadata({ id: 'v' })).toEqual({
      videoId: 'v',
      title: '',
      channelId: null,
      channelTitle: null,
      durationSeconds: null,
      uploadDate: null,
      timestamp: null,
      webpageUrl: null,
      availability: null,
      liveStatus: 'unknown',
      description: null,
    });
  });

  it('missing id → EngineError (v1: "yt-dlp info dict has no \'id\'")', () => {
    expect(() => infoToVideoMetadata({ title: 'idless' })).toThrow(EngineError);
    expect(() => infoToVideoMetadata({ title: 'idless' })).toThrow("yt-dlp info dict has no 'id'");
  });

  it('malformed top-level JSON → EngineError', () => {
    expect(() => infoToVideoMetadata('nope')).toThrow(EngineError);
  });
});

// ---------------------------------------------------------------------------
// infoToLiveProbe (v1 engine_mapping.py:322-343 info_to_live_probe, EXACT):
// capturable = is_live | is_upcoming; anything else (or no id) → null.
// ---------------------------------------------------------------------------

describe('infoToLiveProbe (v1 info_to_live_probe)', () => {
  const liveInfo = {
    id: 'livebcast01',
    title: 'Big broadcast',
    live_status: 'is_live',
    webpage_url: 'https://www.youtube.com/watch?v=livebcast01',
    availability: 'public',
  };

  it('is_live → a probe with id/url/title/liveStatus', () => {
    expect(infoToLiveProbe(liveInfo)).toEqual({
      videoId: 'livebcast01',
      url: 'https://www.youtube.com/watch?v=livebcast01',
      title: 'Big broadcast',
      liveStatus: 'is_live',
      scheduledStart: null,
      isMembersOnly: false,
    });
  });

  it('is_upcoming → a probe carrying scheduledStart from release_timestamp', () => {
    const probe = infoToLiveProbe({
      ...liveInfo,
      live_status: 'is_upcoming',
      release_timestamp: 1_700_000_600,
    });
    expect(probe?.liveStatus).toBe('is_upcoming');
    expect(probe?.scheduledStart).toEqual(new Date(1_700_000_600 * 1000));
  });

  it.each(['not_live', 'was_live', 'post_live', 'unknown-ish'])(
    'live_status %s → null (resolving /live to a non-broadcast is "not live")',
    (status) => {
      expect(infoToLiveProbe({ ...liveInfo, live_status: status })).toBeNull();
    },
  );

  it('missing id → null (v1: `not video_id` → None)', () => {
    expect(infoToLiveProbe({ ...liveInfo, id: undefined })).toBeNull();
    expect(infoToLiveProbe({ ...liveInfo, id: '' })).toBeNull();
  });

  it.each(['subscriber_only', 'premium_only'])(
    'availability %s → isMembersOnly (v1 _MEMBERS_AVAILABILITY)',
    (availability) => {
      expect(infoToLiveProbe({ ...liveInfo, availability })?.isMembersOnly).toBe(true);
    },
  );

  it('public/absent availability → not members-only', () => {
    expect(infoToLiveProbe(liveInfo)?.isMembersOnly).toBe(false);
    expect(infoToLiveProbe({ ...liveInfo, availability: undefined })?.isMembersOnly).toBe(false);
  });

  it('missing webpage_url → the canonical watch url; falsy title → the video id (v1 or-chains)', () => {
    const probe = infoToLiveProbe({ id: 'livebcast01', live_status: 'is_live' });
    expect(probe?.url).toBe('https://www.youtube.com/watch?v=livebcast01');
    expect(probe?.title).toBe('livebcast01');
  });

  it('non-numeric release_timestamp → null scheduledStart (v1 isinstance guard)', () => {
    expect(infoToLiveProbe({ ...liveInfo, release_timestamp: 'soon' })?.scheduledStart).toBeNull();
  });

  it('malformed top-level JSON → EngineError', () => {
    expect(() => infoToLiveProbe('nope')).toThrow(EngineError);
  });
});

// ---------------------------------------------------------------------------
// runYtdlpJson (subprocess wrapper): JSON on success, EngineError on failure,
// AbortedError on cancel — the worker distinguishes cancel from failure by type.
// ---------------------------------------------------------------------------

const node = process.execPath;

describe('runYtdlpJson', () => {
  it('exit 0 → the parsed stdout JSON', async () => {
    await expect(
      runYtdlpJson(node, ['-e', 'process.stdout.write(JSON.stringify({ok: 1, arr: [1, 2]}))']),
    ).resolves.toEqual({ ok: 1, arr: [1, 2] });
  });

  it('exit 0 with unparseable stdout → EngineError', async () => {
    const err = await runYtdlpJson(node, ['-e', 'process.stdout.write("not json at all")']).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EngineError);
  });

  it('nonzero exit → EngineError carrying the stderr tail', async () => {
    const err = await runYtdlpJson(node, [
      '-e',
      'console.error("ERROR: HTTP Error 429: Too Many Requests"); process.exit(1)',
    ]).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).stderrTail?.join('\n')).toContain('429');
  });

  it('abort → AbortedError (distinguishable from failure; caller returns quietly)', async () => {
    const controller = new AbortController();
    const promise = runYtdlpJson(node, ['-e', 'setInterval(() => {}, 1000)'], {
      signal: controller.signal,
      killGraceMs: 500,
      onSpawn: () => controller.abort(),
    });
    const err = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AbortedError);
    expect(err).not.toBeInstanceOf(EngineError);
  }, 15_000);

  it('spawn failure (missing binary) still rejects with EngineError (runner contract)', async () => {
    await expect(runYtdlpJson('/no/such/binary-xyz', ['--version'])).rejects.toThrow(EngineError);
  });
});
