/**
 * StatusBadge spec (P2) — an owner hard-gate. The badge is 2-axis (copyState +
 * sourceState) and NEVER relies on color alone: every rendered state carries an
 * icon AND a localized text label. This locks: the copy×source matrix, the
 * derived Rescued signature (HEALTHY + DELETED/PRIVATE), and AWAITING_VERIFY
 * rendered DISTINCT from VERIFYING (calm pulse vs spin + a different label).
 */
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { CopyState, JobStatus, SourceState } from '@tubevault/types';

import { renderWithI18n, setTestLanguage } from '../../test-utils';
import { StatusBadge } from './StatusBadge';

afterEach(async () => {
  cleanup();
  await setTestLanguage('en');
});

const COPY_LABEL: Record<CopyState, RegExp> = {
  CANDIDATE: /candidate/i,
  QUEUED: /queued/i,
  DOWNLOADING: /downloading/i,
  VERIFYING: /^verifying$/i,
  AWAITING_VERIFY: /verifying completeness/i,
  HEALTHY: /healthy/i,
  FAILED: /failed/i,
  PARTIAL_KEPT: /partly saved/i,
};

const SOURCE_LABEL: Record<SourceState, RegExp> = {
  AVAILABLE: /available/i,
  GEO_BLOCKED: /geo-blocked/i,
  PRIVATE: /private/i,
  MEMBERS_ONLY: /members only/i,
  AGE_GATED: /age-gated/i,
  DELETED: /deleted/i,
  TRANSIENT_ERROR: /temporary error/i,
  RATE_LIMITED: /rate-limited/i,
  UNKNOWN: /unknown/i,
};

describe('StatusBadge — copyState axis', () => {
  it.each(Object.keys(COPY_LABEL) as CopyState[])(
    'renders copyState %s with an icon + label (never color alone)',
    (state) => {
      const { container } = renderWithI18n(<StatusBadge copyState={state} />);
      const badge = container.querySelector(`[data-state="${state}"]`);
      expect(badge).toBeTruthy();
      // label text present
      expect(within(badge as HTMLElement).getByText(COPY_LABEL[state])).toBeTruthy();
      // icon present (svg)
      expect((badge as HTMLElement).querySelector('svg')).toBeTruthy();
    },
  );
});

describe('StatusBadge — sourceState axis', () => {
  it.each(Object.keys(SOURCE_LABEL) as SourceState[])(
    'renders sourceState %s with an icon + label',
    (state) => {
      const { container } = renderWithI18n(<StatusBadge sourceState={state} />);
      const badge = container.querySelector(`[data-state="${state}"]`);
      expect(badge).toBeTruthy();
      expect(within(badge as HTMLElement).getByText(SOURCE_LABEL[state])).toBeTruthy();
    },
  );
});

describe('StatusBadge — Rescued signature (derived)', () => {
  it.each(['DELETED', 'PRIVATE'] as SourceState[])(
    'derives Rescued from HEALTHY + %s and marks it the signature intent',
    (source) => {
      const { container } = renderWithI18n(
        <StatusBadge copyState="HEALTHY" sourceState={source} />,
      );
      const rescued = container.querySelector('[data-state="RESCUED"]');
      expect(rescued).toBeTruthy();
      expect(rescued?.getAttribute('data-intent')).toBe('signature');
      expect(screen.getByText(/rescued/i)).toBeTruthy();
    },
  );

  it('does NOT derive Rescued from HEALTHY + AVAILABLE', () => {
    const { container } = renderWithI18n(
      <StatusBadge copyState="HEALTHY" sourceState="AVAILABLE" />,
    );
    expect(container.querySelector('[data-state="RESCUED"]')).toBeNull();
  });

  it('does NOT derive Rescued from a non-HEALTHY copy of a DELETED source', () => {
    const { container } = renderWithI18n(<StatusBadge copyState="FAILED" sourceState="DELETED" />);
    expect(container.querySelector('[data-state="RESCUED"]')).toBeNull();
  });
});

describe('StatusBadge — AWAITING_VERIFY vs VERIFYING (distinct)', () => {
  it('renders AWAITING_VERIFY with a calm pulse and a different label than VERIFYING', () => {
    const awaiting = renderWithI18n(
      <StatusBadge copyState="AWAITING_VERIFY" />,
    ).container.querySelector('[data-state="AWAITING_VERIFY"]');
    cleanup();
    const verifying = renderWithI18n(<StatusBadge copyState="VERIFYING" />).container.querySelector(
      '[data-state="VERIFYING"]',
    );
    // Distinct animation: pulse (calm) vs spin.
    expect(awaiting?.querySelector('.tv-anim-pulse')).toBeTruthy();
    expect(awaiting?.querySelector('.tv-anim-spin')).toBeNull();
    expect(verifying?.querySelector('.tv-anim-spin')).toBeTruthy();
    // Distinct label.
    expect(awaiting?.textContent).toMatch(/verifying completeness/i);
    expect(verifying?.textContent).not.toMatch(/completeness/i);
  });
});

describe('StatusBadge — animation per copy state', () => {
  it('spins the DOWNLOADING worker and leaves terminal states unanimated', () => {
    const dl = renderWithI18n(<StatusBadge copyState="DOWNLOADING" />).container.querySelector(
      '[data-state="DOWNLOADING"]',
    );
    expect(dl?.querySelector('.tv-anim-spin')).toBeTruthy();
    expect(dl?.querySelector('.tv-anim-pulse')).toBeNull();
    cleanup();
    const healthy = renderWithI18n(<StatusBadge copyState="HEALTHY" />).container.querySelector(
      '[data-state="HEALTHY"]',
    );
    expect(healthy?.querySelector('.tv-anim-spin')).toBeNull();
    expect(healthy?.querySelector('.tv-anim-pulse')).toBeNull();
  });
});

describe('StatusBadge — jobStatus axis (queue rows)', () => {
  const JOB_LABEL: Record<JobStatus, RegExp> = {
    QUEUED: /queued/i,
    RUNNING: /downloading/i,
    PAUSED: /paused/i,
    COMPLETED: /completed/i,
    FAILED: /failed/i,
    CANCELED: /canceled/i,
  };

  it.each(Object.keys(JOB_LABEL) as JobStatus[])(
    'renders jobStatus %s with an icon + label',
    (state) => {
      const { container } = renderWithI18n(<StatusBadge jobStatus={state} />);
      const badge = container.querySelector(`[data-state="JOB_${state}"]`);
      expect(badge).toBeTruthy();
      expect(within(badge as HTMLElement).getByText(JOB_LABEL[state])).toBeTruthy();
      expect((badge as HTMLElement).querySelector('svg')).toBeTruthy();
    },
  );

  it('spins the RUNNING badge and leaves QUEUED/terminal unanimated', () => {
    const running = renderWithI18n(<StatusBadge jobStatus="RUNNING" />).container.querySelector(
      '[data-state="JOB_RUNNING"]',
    );
    expect(running?.querySelector('.tv-anim-spin')).toBeTruthy();
    cleanup();
    const queued = renderWithI18n(<StatusBadge jobStatus="QUEUED" />).container.querySelector(
      '[data-state="JOB_QUEUED"]',
    );
    expect(queued?.querySelector('.tv-anim-spin')).toBeNull();
  });
});

describe('StatusBadge — 2-axis + i18n', () => {
  it('renders both axes together with a "src" marker on the source badge', () => {
    const { container } = renderWithI18n(
      <StatusBadge copyState="DOWNLOADING" sourceState="MEMBERS_ONLY" />,
    );
    expect(container.querySelector('[data-state="DOWNLOADING"]')).toBeTruthy();
    const src = container.querySelector('[data-state="MEMBERS_ONLY"]');
    expect(src).toBeTruthy();
    expect(src?.getAttribute('data-intent')).toBe('locked');
    expect(src?.textContent).toMatch(/src/i);
  });

  it('localizes labels to Korean when the language switches', async () => {
    await setTestLanguage('ko');
    renderWithI18n(<StatusBadge copyState="HEALTHY" />);
    expect(screen.getByText('정상')).toBeTruthy();
  });
});
