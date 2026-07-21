/**
 * Display-format helpers (P9). All nullable inputs render an em dash — DTO
 * fields like sizeBytes/speedBps/etaSeconds are null whenever unknown, and the
 * tables must stay aligned rather than show "NaN undefined".
 */

const DASH = '—';
const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;

/** NaN/negative/Infinity are garbage inputs, not quantities — dash them too. */
function isDisplayable(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value) && value >= 0;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!isDisplayable(bytes)) return DASH;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${UNITS[unit]}`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (!isDisplayable(seconds)) return DASH;
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

export function formatSpeed(bytesPerSecond: number | null | undefined): string {
  if (!isDisplayable(bytesPerSecond)) return DASH;
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatEta(seconds: number | null | undefined): string {
  return formatDuration(seconds);
}

export function formatDate(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') return DASH;
  return iso.slice(0, 10);
}
