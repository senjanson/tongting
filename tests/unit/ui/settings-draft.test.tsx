// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useDraftValue } from '@src/ui/shared/hooks';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('does not settle a newer slider submission from an earlier ABA response', async () => {
  vi.useFakeTimers();
  const pending: Array<() => void> = [];
  const commit = vi.fn(() => new Promise<void>((resolve) => pending.push(resolve)));
  const { result } = renderHook(() => useDraftValue(10, commit, 250));
  act(() => result.current[1](20));
  await act(() => vi.advanceTimersByTimeAsync(250));
  act(() => result.current[1](30));
  act(() => result.current[1](20));
  await act(() => vi.advanceTimersByTimeAsync(250));
  expect(commit).toHaveBeenCalledTimes(2);
  await act(async () => pending[0]!());
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(result.current[0]).toBe(20);
  await act(async () => pending[1]!());
  await act(() => vi.advanceTimersByTimeAsync(800));
  expect(result.current[0]).toBe(10);
});
