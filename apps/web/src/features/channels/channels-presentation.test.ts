/**
 * channels-presentation spec (S2 P2) — the pure, React-free view logic: the
 * newest-first sort (owner decision D3), the "N channels · M collecting" tallies,
 * and the register-outcome mapping (success/already + the 422/504/502/other error
 * surfaces → intent + which affordance shows). No i18n / no rel-time here — those
 * are locale-dependent and live in the view.
 */
import { describe, expect, it } from 'vitest';

import type { ChannelDto, RegisterChannelResponse } from '@tubevault/types';

import {
  activeCount,
  registerErrorView,
  registerSuccessView,
  sortNewestFirst,
} from './channels-presentation';

function ch(id: string, over: Partial<ChannelDto> = {}): ChannelDto {
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
    videoCounts: { total: 0, candidates: 0, healthy: 0 },
    ...over,
  };
}

describe('sortNewestFirst', () => {
  it('orders by createdAt descending (a just-registered channel lands first)', () => {
    const list = [
      ch('old', { createdAt: '2026-01-01T00:00:00.000Z' }),
      ch('new', { createdAt: '2026-07-15T00:00:00.000Z' }),
      ch('mid', { createdAt: '2026-04-01T00:00:00.000Z' }),
    ];
    expect(sortNewestFirst(list).map((c) => c.id)).toEqual(['new', 'mid', 'old']);
  });

  it('is pure — it never mutates the input array', () => {
    const list = [ch('a', { createdAt: '2026-01-01T00:00:00.000Z' }), ch('b')];
    const before = list.map((c) => c.id);
    sortNewestFirst(list);
    expect(list.map((c) => c.id)).toEqual(before);
  });
});

describe('activeCount', () => {
  it('counts only channels that are still collecting (unregisteredAt null)', () => {
    const list = [ch('a'), ch('b', { unregisteredAt: '2026-06-01T00:00:00.000Z' }), ch('c')];
    expect(activeCount(list)).toBe(2);
  });
});

describe('registerSuccessView', () => {
  it('surfaces the resolved channel title and whether it already existed', () => {
    const res = {
      channel: ch('retro', { title: 'Retro Tech' }),
      enumerateJobId: 'job1',
      alreadyRegistered: false,
    } as RegisterChannelResponse;
    expect(registerSuccessView(res)).toEqual({ already: false, name: 'Retro Tech' });

    const dup = { ...res, alreadyRegistered: true } as RegisterChannelResponse;
    expect(registerSuccessView(dup)).toEqual({ already: true, name: 'Retro Tech' });
  });
});

describe('registerErrorView', () => {
  it('422 → not-a-channel: danger, a field error, no retry', () => {
    expect(registerErrorView(422)).toEqual({
      kind: 'notFound',
      intent: 'danger',
      retry: false,
      field: true,
    });
  });

  it('504 → transient timeout: warning + retry, no field error', () => {
    expect(registerErrorView(504)).toEqual({
      kind: 'timeout',
      intent: 'warning',
      retry: true,
      field: false,
    });
  });

  it('502 → engine failure: danger + retry', () => {
    expect(registerErrorView(502)).toEqual({
      kind: 'engine',
      intent: 'danger',
      retry: true,
      field: false,
    });
  });

  it('anything else → a generic retryable danger', () => {
    expect(registerErrorView(500).kind).toBe('generic');
    expect(registerErrorView(0)).toEqual({
      kind: 'generic',
      intent: 'danger',
      retry: true,
      field: false,
    });
  });
});
