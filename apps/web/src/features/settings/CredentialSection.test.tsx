/**
 * CredentialSection spec (S9 P5) — the credential view wired to a fake hook: the
 * four states (verified / unverified / expired / disabled), the 503 setup banner,
 * the expired cross-link to Live, and the write-only import + delete wiring.
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionStatusResponse } from '@tubevault/types';

import { renderWithI18n, setTestLanguage } from '../../test-utils';
import { CredentialSection } from './CredentialSection';
import { deriveCredentialView } from './settings-presentation';
import type { UseCredentialResult } from './useCredential';

const VERIFIED: SessionStatusResponse = {
  enabled: true,
  configured: true,
  status: 'VERIFIED',
  lastVerifiedAt: '2026-07-15T00:00:00.000Z',
  failureStreak: 0,
  lastError: null,
};

function fakeCred(
  session: SessionStatusResponse,
  over: Partial<UseCredentialResult> = {},
): UseCredentialResult {
  return {
    phase: 'ready',
    view: deriveCredentialView(session),
    importing: false,
    retry: vi.fn(),
    importCookies: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

function render(
  session: SessionStatusResponse,
  over: Partial<UseCredentialResult> = {},
): {
  credential: UseCredentialResult;
  onToast: ReturnType<typeof vi.fn>;
  onGoLive: ReturnType<typeof vi.fn>;
  onRequestDelete: ReturnType<typeof vi.fn>;
} {
  const credential = fakeCred(session, over);
  const onToast = vi.fn();
  const onGoLive = vi.fn();
  const onRequestDelete = vi.fn();
  renderWithI18n(
    <CredentialSection
      index={3}
      credential={credential}
      onToast={onToast}
      onGoLive={onGoLive}
      onRequestDelete={onRequestDelete}
    />,
  );
  return { credential, onToast, onGoLive, onRequestDelete };
}

afterEach(async () => {
  cleanup();
  await setTestLanguage('en');
});

describe('CredentialSection — states', () => {
  it('VERIFIED shows the Verified pill and the delete affordance', () => {
    render(VERIFIED);
    expect(screen.getByText('Verified')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete credential' })).toBeTruthy();
    expect(screen.getByLabelText('Paste your Netscape cookie jar')).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('UNVERIFIED shows the calm "will verify" note', () => {
    render({ ...VERIFIED, status: 'UNVERIFIED', lastVerifiedAt: null });
    expect(screen.getByText(/a background worker will verify it shortly/)).toBeTruthy();
  });

  it('EXPIRED shows the warning + a Go-to-Live cross-link', () => {
    const { onGoLive } = render({
      ...VERIFIED,
      status: 'EXPIRED',
      failureStreak: 2,
      lastError: 'HTTP 403',
    });
    expect(screen.getByText(/This credential has expired/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Go to Live/ }));
    expect(onGoLive).toHaveBeenCalledTimes(1);
  });

  it('disabled (feature off) shows the 503 banner and disables import, no delete', () => {
    render({
      enabled: false,
      configured: false,
      status: null,
      lastVerifiedAt: null,
      failureStreak: 0,
      lastError: null,
    });
    expect(screen.getByText('Credential storage is disabled')).toBeTruthy();
    expect(screen.getByLabelText('Paste your Netscape cookie jar')).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.queryByRole('button', { name: 'Delete credential' })).toBeNull();
  });
});

describe('CredentialSection — import + delete', () => {
  it('imports the pasted cookie jar and toasts success', async () => {
    const { credential, onToast } = render(VERIFIED);
    fireEvent.change(screen.getByLabelText('Paste your Netscape cookie jar'), {
      target: { value: '# my cookies' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Import cookies' }));

    expect(credential.importCookies).toHaveBeenCalledWith('# my cookies');
    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith('success', 'Cookie imported', expect.any(String)),
    );
  });

  it('keeps Import disabled until something is pasted', () => {
    render(VERIFIED);
    expect(screen.getByRole('button', { name: 'Import cookies' })).toHaveProperty('disabled', true);
  });

  it('§S9-9: the paste readout echoes the 1 MiB budget as KB (not a bare char count)', () => {
    render(VERIFIED);
    fireEvent.change(screen.getByLabelText('Paste your Netscape cookie jar'), {
      target: { value: 'x'.repeat(2048) },
    });
    expect(screen.getByText('2.0 KB of 1 MiB')).toBeTruthy();
  });

  it('exposes the choose-file picker as a keyboard-operable button (disabled when off)', () => {
    render(VERIFIED);
    expect(screen.getByRole('button', { name: /Choose a file/ })).toHaveProperty('disabled', false);
    cleanup();
    render({
      enabled: false,
      configured: false,
      status: null,
      lastVerifiedAt: null,
      failureStreak: 0,
      lastError: null,
    });
    expect(screen.getByRole('button', { name: /Choose a file/ })).toHaveProperty('disabled', true);
  });

  it('routes delete to the page confirm', () => {
    const { onRequestDelete } = render(VERIFIED);
    fireEvent.click(screen.getByRole('button', { name: 'Delete credential' }));
    expect(onRequestDelete).toHaveBeenCalledTimes(1);
  });
});
