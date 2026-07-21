/**
 * ProgressBar spec (P2) — an owner hard-gate: determinate AND indeterminate.
 * Determinate downloads show pct + bytes/speed/eta and expose aria-valuenow.
 * Indeterminate live capture has NO total → a sliding band, NO aria-valuenow,
 * and a received/elapsed readout (no pct, no eta). The two must be distinct.
 */
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderWithI18n, setTestLanguage } from '../../test-utils';
import { ProgressBar } from './ProgressBar';

afterEach(async () => {
  cleanup();
  await setTestLanguage('en');
});

describe('ProgressBar — determinate', () => {
  it('exposes progressbar role + aria-valuenow at the pct', () => {
    renderWithI18n(<ProgressBar pct={42} downloadedBytes={100} totalBytes={200} />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
  });

  it('renders a bytes / speed / eta readout', () => {
    renderWithI18n(
      <ProgressBar
        pct={30}
        downloadedBytes={342 * 1024 * 1024}
        totalBytes={1024 * 1024 * 1024}
        speedBps={4.2 * 1024 * 1024}
        etaSeconds={180}
      />,
    );
    // "342.0 MiB of 1.0 GiB · 4.2 MiB/s · ~3:00 left" (formatting via lib/format)
    expect(screen.getByText(/of/i)).toBeTruthy();
    expect(screen.getByText(/\/s/i)).toBeTruthy();
    expect(screen.getByText(/left/i)).toBeTruthy();
  });

  it('fills the bar proportionally to pct', () => {
    const { container } = renderWithI18n(<ProgressBar pct={65} />);
    const fill = container.querySelector('.tv-progress__fill') as HTMLElement;
    expect(fill.style.width).toBe('65%');
  });
});

describe('ProgressBar — indeterminate (live capture)', () => {
  it('has NO aria-valuenow and renders the sliding band', () => {
    const { container } = renderWithI18n(
      <ProgressBar
        indeterminate
        downloadedBytes={256 * 1024 * 1024}
        elapsedSeconds={332}
        speedBps={2.1 * 1024 * 1024}
      />,
    );
    const bar = screen.getByRole('progressbar');
    expect(bar.hasAttribute('aria-valuenow')).toBe(false);
    expect(container.querySelector('.tv-progress__band')).toBeTruthy();
  });

  it('renders received / elapsed / speed (no pct, no eta)', () => {
    renderWithI18n(
      <ProgressBar
        indeterminate
        downloadedBytes={256 * 1024 * 1024}
        elapsedSeconds={332}
        speedBps={2.1 * 1024 * 1024}
      />,
    );
    expect(screen.getByText(/received/i)).toBeTruthy();
    expect(screen.getByText(/elapsed/i)).toBeTruthy();
    expect(screen.queryByText(/left/i)).toBeNull();
    expect(screen.queryByText(/%/)).toBeNull();
  });
});

describe('ProgressBar — distinct paradigms', () => {
  it('a determinate bar has a fill; an indeterminate bar has a band, not a fill', () => {
    const det = renderWithI18n(<ProgressBar pct={50} />).container;
    expect(det.querySelector('.tv-progress__fill')).toBeTruthy();
    expect(det.querySelector('.tv-progress__band')).toBeNull();
    cleanup();
    const indet = renderWithI18n(<ProgressBar indeterminate />).container;
    expect(indet.querySelector('.tv-progress__band')).toBeTruthy();
    expect(indet.querySelector('.tv-progress__fill')).toBeNull();
  });
});
