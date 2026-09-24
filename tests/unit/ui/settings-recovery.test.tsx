// @vitest-environment happy-dom
/**
 * 设置页：设置无法使用时的提示，以及「恢复默认设置」确认框与实际行为一致。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { AppSnapshot } from '@src/messaging/ui-protocol';
import { OptionsApp } from '@src/ui/options/OptionsApp';
import { makeSnapshot } from './fixtures';
import { createFakeWorker } from './fake-worker-port';

function renderOptions(snapshot: AppSnapshot) {
  const worker = createFakeWorker(snapshot, {
    'settings/reset': () => ({ persisted: true }),
  });
  vi.spyOn(fakeBrowser.runtime, 'connect').mockImplementation(() => worker.port as never);
  render(<OptionsApp />);
  return worker;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('settings recovery notice', () => {
  it('explains that invalid settings were backed up and replaced by defaults', async () => {
    renderOptions(makeSnapshot({ settingsRecovery: 'recovered' }));
    await screen.findByText('设置已恢复为默认值');
    expect(screen.getByText(/原设置已在本机备份/)).toBeTruthy();
    expect(screen.queryByText('暂时无法读取已保存的设置')).toBeNull();
  });

  it('explains that edits are not saved while the stored settings are unreadable', async () => {
    renderOptions(makeSnapshot({ settingsRecovery: 'unreadable', settingsPersisted: false }));
    await screen.findByText('暂时无法读取已保存的设置');
    expect(screen.getByText(/为避免覆盖原设置，修改只在本次生效/)).toBeTruthy();
    // 通用的「设置未能保存」由上面的说明代替，不重复提示。
    expect(screen.queryByText('设置未能保存')).toBeNull();
  });

  it('shows nothing extra for healthy settings', async () => {
    renderOptions(makeSnapshot());
    await screen.findByRole('button', { name: '恢复默认设置' });
    expect(screen.queryByText('设置已恢复为默认值')).toBeNull();
    expect(screen.queryByText('暂时无法读取已保存的设置')).toBeNull();
    expect(screen.queryByText('设置未能保存')).toBeNull();
  });
});

describe('reset confirmation', () => {
  it('states that credentials and the remember choice are kept', async () => {
    const worker = renderOptions(makeSnapshot());
    fireEvent.click(await screen.findByRole('button', { name: '恢复默认设置' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('「记住在本机」的选择保持不变');
    expect(dialog.textContent).toContain('访问权限会被移除');
    expect(dialog.textContent).not.toContain('暂时无法读取');
    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }));
    await waitFor(() =>
      expect(worker.commands().some((command) => command.kind === 'settings/reset')).toBe(true),
    );
  });

  it('warns that unreadable original settings will be overwritten', async () => {
    renderOptions(makeSnapshot({ settingsRecovery: 'unreadable' }));
    fireEvent.click(await screen.findByRole('button', { name: '恢复默认设置' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('暂时无法读取的原设置也会被默认值覆盖');
  });
});
