#!/usr/bin/env node
/**
 * A deterministic stand-in for ffprobe (test fixture — no deps).
 *
 * Ignores its argv (runFfprobe always passes the fixed
 * `-v error -print_format json -show_format -show_streams <path>` set) and
 * behaves per FAKE_FFPROBE_SCENARIO:
 *   success (default) — canned `-show_format -show_streams` JSON on stdout, exit 0
 *   fail              — an ffprobe-style error on stderr, exit 1
 *   garbage           — unparseable stdout, exit 0 (locks the unparseable branch)
 *   short             — like success but duration 5.0s: against fake-ytdlp's
 *                       reported 12.5s the integrity verdict FAILS on duration
 *                       mismatch (the P6 verify truncation-check target)
 */
const scenario = process.env.FAKE_FFPROBE_SCENARIO ?? 'success';

if (scenario === 'fail') {
  console.error('/probe/target.mp4: Invalid data found when processing input');
  process.exit(1);
}

if (scenario === 'garbage') {
  process.stdout.write('this is not json\n');
  process.exit(0);
}

const canned = {
  streams: [
    {
      codec_type: 'video',
      codec_name: 'h264',
      width: 1920,
      height: 1080,
    },
    {
      codec_type: 'audio',
      codec_name: 'aac',
    },
  ],
  format: {
    format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
    // 'short' probes a truncated tail: 5.0s vs the source-reported 12.5s is
    // far outside the max(1s, 2%) tolerance -> integrity verdict FAILS.
    duration: scenario === 'short' ? '5.000000' : '12.512000',
    bit_rate: '1500000',
    nb_streams: 2,
  },
};
process.stdout.write(JSON.stringify(canned));
process.exit(0);
