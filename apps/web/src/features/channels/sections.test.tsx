/**
 * S2 sections (P5) — RegisterPanel (the EP-10 register widget: submit → success /
 * already / 422·504·502 inline notice, field error, retry, dismiss) and
 * ChannelsList (the ready / loading / empty / error switch under the "Registered"
 * divider). RegisterPanel owns its url + busy + notice locally; the page passes
 * the hook's `register` + a nav callback.
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChannelDto, RegisterChannelResponse } from '@tubevault/types';

import { ApiError } from '../../lib/api';
import { renderWithI18n, setTestLanguage } from '../../test-utils';
import { ChannelsList } from './ChannelsList';
import { RegisterPanel } from './RegisterPanel';

function channel(id: string, over: Partial<ChannelDto> = {}): ChannelDto {
  return {
    id,
    url: `https://youtube.com/@${id}`,
    title: id,
    handle: `@${id}`,
    watchLive: false,
    qualityCap: null,
    subtitleMode: null,
    unregisteredAt: null,
    lastEnumeratedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    videoCounts: { total: 1, candidates: 0, healthy: 1 },
    ...over,
  };
}

function okResponse(name = 'Retro Tech', already = false): RegisterChannelResponse {
  return {
    channel: channel('UCx', { title: name }),
    enumerateJobId: 'ejob',
    alreadyRegistered: already,
  };
}

afterEach(async () => {
  cleanup();
  await setTestLanguage('en');
});

describe('RegisterPanel', () => {
  function renderPanel(onRegister = vi.fn().mockResolvedValue(okResponse())) {
    const onNavigate = vi.fn();
    renderWithI18n(<RegisterPanel onRegister={onRegister} onNavigate={onNavigate} />);
    return { onRegister, onNavigate };
  }

  function type(url: string) {
    fireEvent.change(screen.getByRole('textbox'), { target: { value: url } });
  }

  it('submits the trimmed url and shows the success notice', async () => {
    const { onRegister } = renderPanel();
    type('  https://youtube.com/@retro  ');
    fireEvent.click(screen.getByRole('button', { name: 'Register' }));
    expect(onRegister).toHaveBeenCalledWith('https://youtube.com/@retro');
    await waitFor(() =>
      expect(screen.getByText(/Enumerating its videos in the background/)).toBeTruthy(),
    );
  });

  it('does not submit an empty url', () => {
    const { onRegister } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Register' }));
    expect(onRegister).not.toHaveBeenCalled();
  });

  it('the url field has an accessible name (not placeholder-only)', () => {
    renderPanel();
    expect(screen.getByRole('textbox', { name: 'Channel URL' })).toBeTruthy();
  });

  it('shows the already-registered notice', async () => {
    renderPanel(vi.fn().mockResolvedValue(okResponse('Talks', true)));
    type('https://youtube.com/@talks');
    fireEvent.click(screen.getByRole('button', { name: 'Register' }));
    await waitFor(() => expect(screen.getByText(/is already registered/)).toBeTruthy());
  });

  it('422 → not-a-channel: a field error on the input, no retry', async () => {
    renderPanel(vi.fn().mockRejectedValue(new ApiError(422, 'nope')));
    type('not a url');
    fireEvent.click(screen.getByRole('button', { name: 'Register' }));
    await waitFor(() => expect(screen.getByText('Not a channel URL')).toBeTruthy());
    expect(screen.getByText(/Couldn.t find a channel there/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('504 → timeout: a Retry that re-submits', async () => {
    const onRegister = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(504, 'slow'))
      .mockResolvedValueOnce(okResponse());
    renderPanel(onRegister);
    type('https://youtube.com/@slow');
    fireEvent.click(screen.getByRole('button', { name: 'Register' }));
    await waitFor(() => expect(screen.getByText(/This is taking a while/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(onRegister).toHaveBeenCalledTimes(2));
  });

  it('502 → engine failure notice', async () => {
    renderPanel(vi.fn().mockRejectedValue(new ApiError(502, 'engine')));
    type('https://youtube.com/@down');
    fireEvent.click(screen.getByRole('button', { name: 'Register' }));
    await waitFor(() => expect(screen.getByText(/archive engine had a problem/)).toBeTruthy());
  });

  it('dismiss clears the notice', async () => {
    renderPanel();
    type('https://youtube.com/@retro');
    fireEvent.click(screen.getByRole('button', { name: 'Register' }));
    await waitFor(() =>
      expect(screen.getByText(/Enumerating its videos in the background/)).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/Enumerating its videos in the background/)).toBeNull();
  });

  it('a success notice links to the queue', async () => {
    const { onNavigate } = renderPanel();
    type('https://youtube.com/@retro');
    fireEvent.click(screen.getByRole('button', { name: 'Register' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'View in queue' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'View in queue' }));
    expect(onNavigate).toHaveBeenCalledWith('queue');
  });
});

describe('ChannelsList', () => {
  function listProps(over = {}) {
    return {
      loading: false,
      error: false,
      channels: [channel('a', { title: 'Alpha' })],
      enumerating: new Set<string>(),
      onRetry: vi.fn(),
      onOpen: vi.fn(),
      onToggleWatch: vi.fn(),
      onUnregister: vi.fn(),
      onReactivate: vi.fn(),
      onPurge: vi.fn(),
      onRegisterFirst: vi.fn(),
      ...over,
    };
  }

  it('renders the rows when ready', () => {
    renderWithI18n(<ChannelsList {...listProps()} />);
    expect(screen.getByText('Alpha')).toBeTruthy();
  });

  it('shows skeletons while loading', () => {
    renderWithI18n(<ChannelsList {...listProps({ loading: true, channels: [] })} />);
    expect(screen.getByLabelText('Loading channels…')).toBeTruthy();
  });

  it('shows the empty state with an action that routes to register-first', () => {
    const props = listProps({ channels: [] });
    renderWithI18n(<ChannelsList {...props} />);
    expect(screen.getByText('No channels yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Register a channel' }));
    expect(props.onRegisterFirst).toHaveBeenCalledTimes(1);
  });

  it('shows the error state with retry', () => {
    const props = listProps({ error: true, channels: [] });
    renderWithI18n(<ChannelsList {...props} />);
    expect(screen.getByText('Couldn’t load your channels')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });
});
