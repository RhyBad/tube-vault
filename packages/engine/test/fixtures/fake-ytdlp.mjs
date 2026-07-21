#!/usr/bin/env node
/**
 * A deterministic stand-in for yt-dlp (committed test fixture — no deps).
 *
 * Understands just enough of the real argv surface (see ytdlp-args.ts):
 *   -o <template>        HONORED: dirname = output dir, and the BASENAME template
 *                        gets real `%(id)s`/`%(ext)s` substitution (id from the
 *                        URL arg's `v=` param or last path segment). Any OTHER
 *                        `%(field)X` pattern is an error (exit 64) — so a
 *                        template<->resolver naming regression in ytdlp-args.ts
 *                        turns the always-on contract leg red.
 *   --skip-download      the SUBTITLE pass
 *   --flat-playlist      channel enumeration -> a REALISTIC channel-root JSON on
 *                        stdout: the root nests ONE playlist per tab whose
 *                        `entries` hold the videos (real yt-dlp shape), entries
 *                        carry id/title/url/duration/live_status but NO
 *                        upload_date (real flat entries usually lack it)
 *   --dump-single-json   metadata extraction -> canned JSON on stdout carrying
 *                        BOTH upload_date and timestamp (like real yt-dlp — the
 *                        timestamp-preference path is exercised through the
 *                        pipe); a video id starting with 'live' reports
 *                        live_status was_live (content-type classification
 *                        fodder), else not_live
 * Every other flag (throttle, cookies, extractor-args, ...) is accepted and ignored.
 *
 * Scenario comes from FAKE_YTDLP_SCENARIO (default 'success'):
 *   success              writes <id>.mp4 (2KB) + <id>.info.json + <id>.webp, emits
 *                        3 TVPROG1 progress lines (downloading -> finished), exit 0;
 *                        with --skip-download writes <id>.en.vtt, exit 0
 *   botwall              YouTube's "not a bot" wall on stderr, exit 1
 *                        (download, enumerate AND metadata branches)
 *   http429              HTTP 429 on stderr, exit 1 (all branches, like botwall)
 *   sleepforever         download: writes <id>.mp4.part, emits ONE downloading
 *                        frame, then keeps the event loop alive forever (dies on
 *                        SIGTERM); enumerate: emits NOTHING and hangs — the
 *                        cancel-during-enumerate target
 *   sleepforever-stubborn  same, but traps+ignores SIGTERM (SIGKILL path)
 *   subsfail             media pass = success; --skip-download pass exits 1 w/ 429
 *                        (echoing the --cookies file contents first when one was
 *                        injected — the subtitle-seam redaction target, P8)
 *   unresumable          a pre-existing .part in the output dir -> corrupt-resume
 *                        error, exit 1; otherwise behaves like success (P7 fixture)
 *   unresumable-always   corrupt-resume error, exit 1 UNCONDITIONALLY (even on a
 *                        clean dir) — pins the one-scratch-restart-per-execution
 *                        cap: the second unresumable failure must fall through to
 *                        normal failure classification, never loop
 *   gone                 'removed by the uploader' deletion-class stderr, exit 1
 *                        (download, enumerate AND metadata branches) — the
 *                        terminal SOURCE_GONE classification target (P6)
 *   members              members-only stderr ('join this channel'), exit 1
 *                        (download, enumerate AND metadata branches) — the AUTH
 *                        classification target driving the P8 2-strike fold
 *   leakcookies          media pass only: ECHOES the --cookies file CONTENTS to
 *                        stderr (a hostile worst case: the engine leaking cookie
 *                        material into the tail that gets persisted), then the
 *                        terminal 'removed by the uploader' error, exit 1 —
 *                        the P8 redaction-at-persistence-seams target
 *   failpart             media pass only: NO .part in the output dir -> writes
 *                        <id>.mp4.part, emits one downloading frame, 429 stderr,
 *                        exit 1; a .part ALREADY present -> success. Locks the
 *                        "retry keeps staging" contract: the second execution
 *                        succeeds ONLY IF the first attempt's .part survived
 *
 * Live scenarios (P10):
 *   live-probe-live      --dump-single-json -> a live broadcast (video id
 *                        FAKE_LIVE_VIDEO_ID, default 'livebcast01'; live_status
 *                        is_live, availability public), exit 0
 *   live-probe-members   like live-probe-live but availability subscriber_only
 *                        (the members-only gating target)
 *   live-probe-upcoming  live_status is_upcoming + release_timestamp — mapped
 *                        by infoToLiveProbe (parity) but SKIPPED by the probe
 *                        consumer (v1: only IS_LIVE captures; pre-arm deferred)
 *   live-probe-none      live_status not_live -> infoToLiveProbe yields null
 *   live-probe-offline   ERROR 'The channel is not currently live', exit 1 —
 *                        REAL yt-dlp raises when /live resolves to nothing; the
 *                        probe consumer must read this as "not live", not FAILED
 *   live-capture         media pass: writes <id>.mp4 then APPENDS a chunk every
 *                        FAKE_LIVE_TICK_MS (default 150) with a TVPROG1 frame per
 *                        chunk; after FAKE_LIVE_TOTAL_TICKS chunks (unset = run
 *                        forever) exits 0 (the broadcast ended cleanly). SIGTERM
 *                        -> exit 0 too: --no-part means the recording on disk is
 *                        already the playable partial (D10)
 *   live-capture-empty   exits 1 quickly, NO file (the EMPTY finalize target)
 *   live-capture-stall   writes 2 chunks quickly then STOPS growing but stays
 *                        alive (dies by default on SIGTERM) — the byte-stall
 *                        watchdog target
 */
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const argv = process.argv.slice(2);
const scenario = process.env.FAKE_YTDLP_SCENARIO ?? 'success';

// Opt-in spawn ledger (FAKE_YTDLP_SPAWN_LOG=<file>): one JSON argv line per
// spawn, so tests can count EXACT invocations (e.g. "exactly 2 media passes"
// for the P7 scratch-restart cap) without process-table heuristics.
if (process.env.FAKE_YTDLP_SPAWN_LOG) {
  appendFileSync(process.env.FAKE_YTDLP_SPAWN_LOG, `${JSON.stringify(argv)}\n`);
}

const has = (flag) => argv.includes(flag);
const flagValue = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};

const url = argv.length > 0 ? argv[argv.length - 1] : '';
const videoIdFromUrl = (raw) => {
  try {
    const u = new URL(raw);
    const v = u.searchParams.get('v');
    if (v) {
      return v;
    }
    const segments = u.pathname.split('/').filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] : 'unknown';
  } catch {
    return 'unknown';
  }
};

// --- failure scenarios shared by the JSON branches (same stderr as download) -
const botwallStderr = () => {
  console.error(
    'ERROR: [youtube] ' +
      videoIdFromUrl(url) +
      ': Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.',
  );
  process.exit(1);
};
const http429Stderr = () => {
  console.error('ERROR: unable to download video data: HTTP Error 429: Too Many Requests');
  process.exit(1);
};
// Real-world deletion phrasing: 'removed by the uploader' is one of the SPECIFIC
// deletion clauses in core's ERROR_SIGNATURES (-> DELETED -> SOURCE_GONE, the
// only terminal ErrorKind). The 'Video unavailable' prefix alone would
// quarantine as UNKNOWN — the trailing clause is what makes this terminal.
const goneStderr = () => {
  console.error(
    'ERROR: [youtube] ' +
      videoIdFromUrl(url) +
      ': Video unavailable. This video has been removed by the uploader',
  );
  process.exit(1);
};
// 'join this channel' is one of core's MEMBERS_ONLY signatures -> AUTH (the
// P8 auth-failure observation; deliberately NOT the bot wall's 'not a bot').
const membersStderr = () => {
  console.error(
    'ERROR: [youtube] ' +
      videoIdFromUrl(url) +
      ': Join this channel to get access to members-only content like this video.',
  );
  process.exit(1);
};

// --- enumerate / metadata: canned JSON to stdout ---------------------------
const CHANNEL_ID = 'UCfakechannel000000000000';
const CHANNEL_URL = `https://www.youtube.com/channel/${CHANNEL_ID}`;

if (has('--flat-playlist')) {
  if (scenario === 'botwall') botwallStderr();
  if (scenario === 'http429') http429Stderr();
  if (scenario === 'gone') goneStderr();
  if (scenario === 'members') membersStderr();
  if (scenario === 'sleepforever' || scenario === 'sleepforever-stubborn') {
    // HANG (emit nothing): the cancel-during-enumerate target. Dies on SIGTERM
    // unless stubborn (then only the SIGKILL escalation ends it).
    if (scenario === 'sleepforever-stubborn') {
      process.on('SIGTERM', () => {
        /* stubborn: only SIGKILL can end this child */
      });
    }
    setInterval(() => {
      /* keep-alive: the KILL-test target */
    }, 1000);
    // Top-level await pins module execution here forever (the interval keeps
    // the event loop alive) — it must NOT fall through to the metadata branch.
    await new Promise(() => {});
  } else {
    // Realistic channel-root shape: ONE nested playlist per tab (real yt-dlp
    // nests Videos/Shorts/Live), video entries one level down.
    process.stdout.write(
      JSON.stringify({
        id: CHANNEL_ID,
        channel_id: CHANNEL_ID,
        title: 'Fake Channel - Videos',
        channel: 'Fake Channel',
        uploader_id: '@fakechannel',
        channel_url: CHANNEL_URL,
        entries: [
          {
            id: `${CHANNEL_ID}-videos`,
            title: 'Fake Channel - Videos',
            entries: [
              {
                id: 'fakevid0001',
                title: 'First fake video',
                url: 'https://www.youtube.com/watch?v=fakevid0001',
                duration: 61,
                live_status: 'not_live',
              },
              {
                id: 'fakevid0002',
                title: 'Second fake video',
                url: 'https://www.youtube.com/watch?v=fakevid0002',
                duration: 122,
                live_status: 'not_live',
              },
              {
                id: 'fakevid0003',
                title: 'Third fake video (finished live)',
                url: 'https://www.youtube.com/watch?v=fakevid0003',
                duration: 3600,
                live_status: 'was_live',
              },
            ],
          },
        ],
      }),
    );
    process.exit(0);
  }
}
if (has('--dump-single-json')) {
  if (scenario === 'botwall') botwallStderr();
  if (scenario === 'http429') http429Stderr();
  if (scenario === 'gone') goneStderr();
  if (scenario === 'members') membersStderr();
  // --- live probe scenarios (the /live URL resolution, P10) ------------------
  if (scenario === 'live-probe-offline') {
    // Real yt-dlp RAISES when a channel's /live URL resolves to no broadcast —
    // the probe consumer must classify this as "not live", never as a failure.
    console.error('ERROR: [youtube:tab] ' + url + ': The channel is not currently live');
    process.exit(1);
  }
  if (scenario.startsWith('live-probe-')) {
    const liveId = process.env.FAKE_LIVE_VIDEO_ID ?? 'livebcast01';
    const liveStatus = scenario === 'live-probe-upcoming' ? 'is_upcoming' : 'is_live';
    process.stdout.write(
      JSON.stringify({
        id: liveId,
        title: 'Fake live broadcast',
        live_status: scenario === 'live-probe-none' ? 'not_live' : liveStatus,
        webpage_url: `https://www.youtube.com/watch?v=${liveId}`,
        availability: scenario === 'live-probe-members' ? 'subscriber_only' : 'public',
        channel_id: CHANNEL_ID,
        channel: 'Fake Channel',
        ...(scenario === 'live-probe-upcoming' ? { release_timestamp: 1700000600 } : {}),
      }),
    );
    process.exit(0);
  }
  // --- CR-20 VOD-duration probe scenarios (post-live completeness re-check) ---
  if (scenario === 'vod-processing') {
    // A just-ended live whose VOD is still being processed: live_status
    // post_live and NO duration yet — the probe must DEFER (re-check later).
    const id = videoIdFromUrl(url);
    process.stdout.write(
      JSON.stringify({
        id,
        title: `Fake processing VOD ${id}`,
        live_status: 'post_live',
        channel_id: CHANNEL_ID,
        webpage_url: `https://www.youtube.com/watch?v=${id}`,
        availability: 'public',
        // no `duration` — YouTube hasn't published the VOD length yet
      }),
    );
    process.exit(0);
  }
  if (scenario === 'vod-members-done') {
    // A COMPLETED members-only live: was_live + a real duration + subscriber_only
    // availability — proves a members VOD is measurable (cookies make it visible).
    const id = videoIdFromUrl(url);
    process.stdout.write(
      JSON.stringify({
        id,
        title: `Fake members VOD ${id}`,
        live_status: 'was_live',
        duration: 3600,
        channel_id: CHANNEL_ID,
        webpage_url: `https://www.youtube.com/watch?v=${id}`,
        availability: 'subscriber_only',
        // A members VOD carries the same publish metadata as a public one —
        // cookies make it fully measurable, publishedAt included (CR-25).
        timestamp: 1700000000,
      }),
    );
    process.exit(0);
  }
  const id = videoIdFromUrl(url);
  // CR-20: an id marked 'pendingvod' is a just-ended live whose VOD is still
  // processing — live_status post_live + NO duration → the completeness probe
  // must DEFER (park AWAITING_VERIFY). Keyed on the id (not FAKE_YTDLP_SCENARIO)
  // so the capture (scenario 'live-capture') and this probe never collide.
  if (id.includes('pendingvod')) {
    process.stdout.write(
      JSON.stringify({
        id,
        title: `Fake pending VOD ${id}`,
        live_status: 'post_live',
        channel_id: CHANNEL_ID,
        webpage_url: `https://www.youtube.com/watch?v=${id}`,
        availability: 'public',
      }),
    );
    process.exit(0);
  }
  // CR-20 P3b(ii) re-check sweep markers (keyed on id, like 'pendingvod'):
  //   'vodfull'  → a COMPLETED live whose VOD length MATCHES a normal capture
  //                (fake-ffprobe default 12.512s) within tolerance → NORMAL.
  //   'vodshort' → a COMPLETED live whose VOD is FAR longer than the capture
  //                → the sweep measures a real shortfall → INTERRUPTED.
  if (id.includes('vodfull') || id.includes('vodshort')) {
    process.stdout.write(
      JSON.stringify({
        id,
        title: `Fake completed VOD ${id}`,
        live_status: 'was_live',
        duration: id.includes('vodshort') ? 7200 : 12.5,
        channel_id: CHANNEL_ID,
        webpage_url: `https://www.youtube.com/watch?v=${id}`,
        availability: 'public',
      }),
    );
    process.exit(0);
  }
  process.stdout.write(
    JSON.stringify({
      id,
      title: `Fake video ${id}`,
      duration: 12.5,
      channel_id: CHANNEL_ID,
      channel: 'Fake Channel',
      channel_url: CHANNEL_URL,
      // Real yt-dlp metadata always carries BOTH: consumers must prefer the
      // exact timestamp over the date-only upload_date (v1 _video_from_meta).
      upload_date: '20240131',
      timestamp: 1700000000, // fixed epoch → deterministic publishedAt
      live_status: id.startsWith('live') ? 'was_live' : 'not_live',
      webpage_url: `https://www.youtube.com/watch?v=${id}`,
      availability: 'public',
      // Real single-video metadata carries a description (CR-14); deterministic
      // per id so add-url capture + video-detail exposure can assert it exactly.
      description: `Fake description for ${id}.`,
    }),
  );
  process.exit(0);
}

// --- download passes: need the -o template to know where to write ----------
const template = flagValue('-o');
if (!template) {
  console.error('fake-ytdlp: missing -o template');
  process.exit(64);
}
const outDir = dirname(template);
const id = videoIdFromUrl(url);

// HONOR the basename template (the naming half of the template<->resolver
// contract). Only the fields this fake understands may appear; anything else
// (e.g. `%(title)s`) fails LOUDLY before anything is written, so an
// outputTemplate() regression cannot keep the fake contract leg green.
const nameTemplate = basename(template);
const unknownFields = (nameTemplate.match(/%\([^)]*\)[a-zA-Z]/g) ?? []).filter(
  (field) => field !== '%(id)s' && field !== '%(ext)s',
);
if (unknownFields.length > 0) {
  console.error(`fake-ytdlp: unsupported -o template field(s): ${unknownFields.join(', ')}`);
  process.exit(64);
}
/** `<basename template>` with `%(id)s` and `%(ext)s` substituted, like yt-dlp. */
const artifactName = (ext) => nameTemplate.replaceAll('%(id)s', id).replaceAll('%(ext)s', ext);

mkdirSync(outDir, { recursive: true });

const emit = (frame) => {
  process.stdout.write(`TVPROG1 ${JSON.stringify(frame)}\n`);
};

const writeSuccess = () => {
  const media = join(outDir, artifactName('mp4'));
  writeFileSync(media, Buffer.alloc(2048, 42)); // 2KB deterministic bytes
  writeFileSync(
    join(outDir, artifactName('info.json')),
    // Real yt-dlp --write-info-json carries the publish metadata too (CR-25);
    // deterministic epoch → the download flow backfills publishedAt from disk.
    JSON.stringify({
      id,
      duration: 12.5,
      format_id: '137+140',
      ext: 'mp4',
      upload_date: '20240131',
      timestamp: 1700000000,
    }),
  );
  writeFileSync(join(outDir, artifactName('webp')), Buffer.alloc(128, 9));
  emit({
    status: 'downloading',
    downloaded_bytes: 1024,
    total_bytes: 2048,
    speed: 1024,
    eta: 1,
    filename: media,
  });
  emit({
    status: 'downloading',
    downloaded_bytes: 2048,
    total_bytes: 2048,
    speed: 1024,
    eta: 0,
    filename: media,
  });
  emit({ status: 'finished', downloaded_bytes: 2048, total_bytes: 2048, filename: media });
  process.exit(0);
};

// --- the SUBTITLE pass ------------------------------------------------------
if (has('--skip-download')) {
  if (scenario === 'subsfail') {
    // Like leakcookies but for the SUBS pass: when cookies were injected, echo
    // the jar into the failing stderr (hostile worst case) — the P8
    // redact-at-source seam for the subtitle WARN JobEvent. Cookie-less runs
    // (every pre-P8 suite) see the plain 429 stderr, unchanged.
    const cookiesFile = flagValue('--cookies');
    if (cookiesFile) {
      try {
        console.error(readFileSync(cookiesFile, 'utf8'));
      } catch {
        /* unreadable — the leak simply doesn't happen */
      }
    }
    console.error('ERROR: Unable to download video subtitles: HTTP Error 429: Too Many Requests');
    process.exit(1);
  }
  writeFileSync(
    join(outDir, artifactName('en.vtt')),
    'WEBVTT\n\n00:00.000 --> 00:01.000\nfake caption\n',
  );
  process.exit(0);
}

// --- the MEDIA pass ---------------------------------------------------------
switch (scenario) {
  case 'botwall': {
    console.error(
      'ERROR: [youtube] ' +
        id +
        ': Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.',
    );
    process.exit(1);
    break;
  }
  case 'http429': {
    console.error('ERROR: unable to download video data: HTTP Error 429: Too Many Requests');
    process.exit(1);
    break;
  }
  case 'sleepforever':
  case 'sleepforever-stubborn': {
    if (scenario === 'sleepforever-stubborn') {
      process.on('SIGTERM', () => {
        /* stubborn: only SIGKILL can end this child */
      });
    }
    writeFileSync(join(outDir, `${artifactName('mp4')}.part`), Buffer.alloc(512, 7));
    emit({
      status: 'downloading',
      downloaded_bytes: 512,
      total_bytes: 2048,
      speed: 256,
      eta: 6,
      filename: join(outDir, artifactName('mp4')),
    });
    setInterval(() => {
      /* keep-alive: the KILL-test target */
    }, 1000);
    break;
  }
  case 'gone': {
    goneStderr();
    break;
  }
  case 'members': {
    membersStderr();
    break;
  }
  case 'leakcookies': {
    // Worst-case engine behavior: cookie material lands on stderr right where
    // the worker persists tails. The P8 redaction test asserts none of it
    // survives into Job.error / JobEvents / notifications.
    const cookiesFile = flagValue('--cookies');
    if (cookiesFile) {
      try {
        console.error(readFileSync(cookiesFile, 'utf8'));
      } catch {
        /* unreadable — the leak simply doesn't happen */
      }
    }
    goneStderr();
    break;
  }
  case 'failpart': {
    // First attempt: leave a .part behind and fail transiently (429). A later
    // attempt that still SEES that .part succeeds — so an end-to-end retry can
    // only go green when the worker kept the staging dir between executions.
    const partKept = readdirSync(outDir).some((name) => name.endsWith('.part'));
    if (partKept) {
      writeSuccess();
      break;
    }
    writeFileSync(join(outDir, `${artifactName('mp4')}.part`), Buffer.alloc(512, 7));
    emit({
      status: 'downloading',
      downloaded_bytes: 512,
      total_bytes: 2048,
      speed: 256,
      eta: 6,
      filename: join(outDir, artifactName('mp4')),
    });
    http429Stderr();
    break;
  }
  case 'unresumable': {
    const hasPart = readdirSync(outDir).some((name) => name.endsWith('.part'));
    if (hasPart) {
      console.error('ERROR: The file is corrupted / cannot resume. Remove the partial file.');
      process.exit(1);
    }
    writeSuccess();
    break;
  }
  case 'unresumable-always': {
    // Even a CLEAN dir fails: the scratch-restart cap target (one wipe+retry
    // per execution — the second failure must classify normally, never loop).
    console.error('ERROR: The file is corrupted / cannot resume. Remove the partial file.');
    process.exit(1);
    break;
  }
  case 'live-capture': {
    // A recording that GROWS: one 1KB chunk per tick + a TVPROG1 frame (live
    // has no total_bytes — yt-dlp can't know how long a broadcast runs).
    // FAKE_LIVE_TOTAL_TICKS set -> exits 0 after that many chunks (the
    // broadcast ended cleanly); unset -> records until signalled. SIGTERM ->
    // exit 0: with --no-part the media on disk IS the playable partial (D10),
    // like real yt-dlp finishing the current fragment and closing the file.
    // NOTE the exit-CODE nuance: real yt-dlp killed mid-recording usually dies
    // BY THE SIGNAL (exitCode null) or non-zero — classifyLiveEnd reads any of
    // those with retained bytes as INTERRUPTED. This fake's clean exit 0 is
    // deliberately the STRICTER shape for abort tests (an abort verdict must
    // come from the abort/verdict plumbing, never from a convenient non-zero
    // exit code) — the consumer checks captureVerdict BEFORE classifying.
    const media = join(outDir, artifactName('mp4'));
    const tickMs = Number(process.env.FAKE_LIVE_TICK_MS ?? '150');
    const totalTicks = process.env.FAKE_LIVE_TOTAL_TICKS
      ? Number(process.env.FAKE_LIVE_TOTAL_TICKS)
      : Number.POSITIVE_INFINITY;
    const chunk = Buffer.alloc(1024, 7);
    writeFileSync(media, chunk);
    let bytes = 1024;
    let ticks = 0;
    emit({ status: 'downloading', downloaded_bytes: bytes, total_bytes: null, filename: media });
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {
      appendFileSync(media, chunk);
      bytes += 1024;
      ticks += 1;
      emit({ status: 'downloading', downloaded_bytes: bytes, total_bytes: null, filename: media });
      if (ticks >= totalTicks) {
        emit({ status: 'finished', downloaded_bytes: bytes, filename: media });
        process.exit(0);
      }
    }, tickMs);
    break;
  }
  case 'live-capture-empty': {
    // The EMPTY finalize target: dies fast, nothing usable on disk.
    console.error('ERROR: [youtube] ' + id + ': live stream ended before any data was received');
    process.exit(1);
    break;
  }
  case 'live-capture-stall': {
    // The byte-stall watchdog target: writes 2 chunks quickly, then stays
    // ALIVE with frozen bytes (a hung-but-alive yt-dlp). No SIGTERM trap:
    // the watchdog's group-kill ends it (death by signal -> exitCode null).
    const media = join(outDir, artifactName('mp4'));
    writeFileSync(media, Buffer.alloc(2048, 7));
    emit({ status: 'downloading', downloaded_bytes: 2048, total_bytes: null, filename: media });
    setInterval(() => {
      /* keep-alive with NO byte growth — the stall signal */
    }, 1000);
    break;
  }
  default: {
    writeSuccess();
  }
}
