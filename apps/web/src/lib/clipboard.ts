/**
 * copyText — clipboard write that works even where the async Clipboard API
 * doesn't. TubeVault is self-hosted and commonly reached over plain HTTP on a LAN
 * (web on :8091), and `navigator.clipboard` is undefined outside a secure
 * context — so a naive `clipboard.writeText` silently no-ops there. This tries
 * the modern API first, falls back to a hidden-textarea + execCommand('copy'),
 * and returns whether the copy ACTUALLY happened, so callers never claim success
 * on a no-op.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // insecure context / permission denied → fall through to the legacy path
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
