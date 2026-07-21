/**
 * Theme controller spec (P1). The controller owns the [data-theme] attribute on
 * <html>, persists an explicit preference to localStorage ('tv-theme'), and
 * resolves the 'system' sentinel against the OS preference — an explicit choice
 * ALWAYS wins. jsdom has no matchMedia, so each test installs a deterministic fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyResolvedTheme,
  getStoredThemePreference,
  initTheme,
  resolveTheme,
  setThemePreference,
} from './theme';

function fakeMatchMedia(dark: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: dark && query.includes('dark'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    })),
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  fakeMatchMedia(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('theme controller', () => {
  it('defaults to the "system" sentinel when nothing is stored', () => {
    expect(getStoredThemePreference()).toBe('system');
  });

  it('reads a stored explicit preference back', () => {
    localStorage.setItem('tv-theme', 'dark');
    expect(getStoredThemePreference()).toBe('dark');
  });

  it('ignores a garbage stored value and falls back to system', () => {
    localStorage.setItem('tv-theme', 'chartreuse');
    expect(getStoredThemePreference()).toBe('system');
  });

  it('setThemePreference("dark") persists and sets data-theme=dark', () => {
    const resolved = setThemePreference('dark');
    expect(resolved).toBe('dark');
    expect(localStorage.getItem('tv-theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('setThemePreference("light") persists and REMOVES data-theme', () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    const resolved = setThemePreference('light');
    expect(resolved).toBe('light');
    expect(localStorage.getItem('tv-theme')).toBe('light');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('an explicit "light" wins over an OS dark preference', () => {
    fakeMatchMedia(true); // OS says dark
    const resolved = setThemePreference('light');
    expect(resolved).toBe('light');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('resolveTheme("system") follows the OS preference', () => {
    fakeMatchMedia(true);
    expect(resolveTheme('system')).toBe('dark');
    fakeMatchMedia(false);
    expect(resolveTheme('system')).toBe('light');
  });

  it('initTheme applies the stored preference to <html>', () => {
    localStorage.setItem('tv-theme', 'dark');
    const resolved = initTheme();
    expect(resolved).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('applyResolvedTheme toggles the attribute both ways', () => {
    applyResolvedTheme('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    applyResolvedTheme('light');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});
