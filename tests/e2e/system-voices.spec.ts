/** 临时浏览器验证设置持久化；平台替身与真实系统语音验证分开记录。 */
import { chromium, expect, test, type Worker } from '@playwright/test';
import type { TtsVoiceInfo } from '../../src/messaging/ui-protocol';
import { EXTENSION_DIR, launchExtension } from './helpers/extension';
import { UiDriver } from './helpers/ui-driver';

type VoiceWorld = {
  chrome: {
    tts: {
      getVoices(): Promise<TtsVoiceInfo[]>;
      speak(
        text: string,
        options: { voiceName?: string; volume?: number; onEvent?(e: { type: string }): void },
      ): Promise<void>;
      stop(): void;
    };
    runtime: { reload(): void };
  };
  voiceCalls: string[];
  voiceEvents: Array<{ voiceName?: string; type: string }>;
};

const choices: TtsVoiceInfo[] = [
  { voiceName: 'Tingting', lang: 'zh-CN', remote: false },
  { voiceName: 'Eddy (Chinese (China mainland))', lang: 'zh-CN', remote: false },
  { voiceName: 'Meijia', lang: 'zh-TW', remote: false },
  { voiceName: 'Online', lang: 'zh-CN', remote: true },
  { voiceName: 'Sinji', lang: 'zh-HK', remote: false },
];

async function mockVoices(worker: Worker) {
  await worker.evaluate((voices) => {
    const w = globalThis as unknown as VoiceWorld;
    w.voiceCalls = [];
    w.chrome.tts.getVoices = async () => voices;
    w.chrome.tts.speak = async (_text, options) => {
      w.voiceCalls.push(options.voiceName ?? '');
      options.onEvent?.({ type: 'start' });
      setTimeout(() => options.onEvent?.({ type: 'end' }), 20);
    };
    w.chrome.tts.stop = () => undefined;
  }, choices);
}

test('voice browsing, audition, selection, extension reload and browser restart at 320px (platform voices mocked)', async () => {
  const ext = await launchExtension();
  let context = ext.context;
  try {
    const manager = await context.newPage();
    await manager.goto('chrome://extensions');
    await manager.getByRole('button', { name: 'Developer mode', exact: true }).click();
    await manager.close();
    await mockVoices(ext.serviceWorker);
    let ui = await UiDriver.open(context, ext.extensionId);
    await ui.ok({
      kind: 'settings/update',
      // 默认目标语言跟随浏览器界面语言；本用例浏览的是普通话声音。
      patch: {
        targetLanguage: 'zh-CN',
        outputMode: 'subtitle-voice',
        audio: { voiceName: 'Tingting' },
      },
    });
    await ui.page.setViewportSize({ width: 320, height: 1000 });
    await ui.page.getByRole('tab', { name: '设置', exact: true }).click();
    const picker = ui.page.getByLabel('配音声音', { exact: true });
    await expect(picker).toHaveValue('Tingting');
    await expect(picker.locator('option')).toHaveCount(5);
    await ui.page.getByText('浏览并试听全部 4 个声音').click();
    await ui.page.getByRole('button', { name: '试听 Eddy · 普通话', exact: true }).click();
    await expect
      .poll(() =>
        ext.serviceWorker.evaluate(() => (globalThis as unknown as VoiceWorld).voiceCalls.at(-1)),
      )
      .toBe('Eddy (Chinese (China mainland))');
    expect((await ui.snapshot())?.settings.audio.voiceName).toBe('Tingting');
    await ui.page.getByRole('button', { name: '使用 Eddy · 普通话', exact: true }).click();
    await expect(picker).toHaveValue('Eddy (Chinese (China mainland))');
    await ui.waitSnapshot(
      (s) =>
        s.settingsPersisted && s.settings.audio.voiceName === 'Eddy (Chinese (China mainland))',
    );
    const audio = ui.page.getByRole('region', { name: 'VOICE / 配音声音' });
    for (const colorScheme of ['light', 'dark'] as const) {
      await ui.page.emulateMedia({ colorScheme });
      await audio.scrollIntoViewIfNeeded();
      expect(await audio.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await ui.page.evaluate(() => document.documentElement.scrollWidth <= 320)).toBe(true);
      await audio.screenshot({ path: test.info().outputPath(`voices-${colorScheme}-320.png`) });
    }

    const previousWorker = (await ui.snapshot())!.workerInstanceId;
    const closed = ui.page.waitForEvent('close');
    await ui.page.evaluate(() =>
      setTimeout(() => (globalThis as unknown as VoiceWorld).chrome.runtime.reload(), 50),
    );
    await closed;
    const wake = await context.newPage();
    await expect(async () => {
      await wake.goto(`chrome-extension://${ext.extensionId}/sidepanel.html`);
    }).toPass({ timeout: 10_000 });
    await wake.close();
    ui = await UiDriver.open(context, ext.extensionId);
    expect((await ui.snapshot())!.workerInstanceId).not.toBe(previousWorker);
    expect((await ui.snapshot())!.settings.audio.voiceName).toBe('Eddy (Chinese (China mainland))');
    await ui.page.getByRole('tab', { name: '设置', exact: true }).click();
    await expect(ui.page.getByLabel('配音声音', { exact: true })).toHaveValue(
      'Eddy (Chinese (China mainland))',
    );
    await context.close();
    context = await chromium.launchPersistentContext(ext.userDataDir, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
    });
    ui = await UiDriver.open(context, ext.extensionId);
    expect((await ui.snapshot())!.settings.audio.voiceName).toBe('Eddy (Chinese (China mainland))');
    await ui.page.getByRole('tab', { name: '设置', exact: true }).click();
    await expect(ui.page.getByLabel('配音声音', { exact: true })).toHaveValue(
      'Eddy (Chinese (China mainland))',
    );
  } finally {
    await context.close().catch(() => undefined);
    await ext.close();
  }
});

test('real Chrome system voices: two different local Mandarin voices start successfully without an API key (volume zero)', async () => {
  const ext = await launchExtension();
  try {
    const ui = await UiDriver.open(ext.context, ext.extensionId);
    const { voices } = await ui.ok<{ voices: TtsVoiceInfo[] }>({ kind: 'tts/voices' });
    const local = voices.filter((v) => v.lang === 'zh-CN' && v.remote === false);
    test.skip(local.length < 2, '此机器未提供两个本地普通话声音。');
    await test.info().attach('actual-system-voices', {
      body: JSON.stringify(local, null, 2),
      contentType: 'application/json',
    });
    expect((await ui.snapshot())!.credential.configured).toBe(false);
    await ui.ok({
      kind: 'settings/update',
      patch: { targetLanguage: 'zh-CN', outputMode: 'subtitle-voice', audio: { dubVolume: 0 } },
    });
    await ui.page.getByRole('tab', { name: '设置', exact: true }).click();
    await ext.serviceWorker.evaluate(() => {
      const w = globalThis as unknown as VoiceWorld;
      w.voiceCalls = [];
      w.voiceEvents = [];
      const speak = w.chrome.tts.speak.bind(w.chrome.tts);
      w.chrome.tts.speak = (text, options) => {
        w.voiceCalls.push(options.voiceName ?? '');
        return speak(text, {
          ...options,
          onEvent: (event) => {
            w.voiceEvents.push({ voiceName: options.voiceName, type: event.type });
            options.onEvent?.(event);
          },
        });
      };
    });
    for (const voice of local.slice(0, 2)) {
      await ui.page.getByLabel('配音声音', { exact: true }).selectOption(voice.voiceName);
      await ui.waitSnapshot((s) => s.settings.audio.voiceName === voice.voiceName);
      await ui.page.getByRole('button', { name: '试听', exact: true }).click();
      await expect
        .poll(() =>
          ext.serviceWorker.evaluate(() => (globalThis as unknown as VoiceWorld).voiceCalls.at(-1)),
        )
        .toBe(voice.voiceName);
      await expect(ui.page.getByRole('button', { name: '试听', exact: true })).not.toHaveAttribute(
        'aria-busy',
        'true',
        { timeout: 7_000 },
      );
      await expect(ui.page.getByText(/试听失败/)).toHaveCount(0);
      expect(
        await ext.serviceWorker.evaluate(
          (name) =>
            (globalThis as unknown as VoiceWorld).voiceEvents.some(
              (e) => e.voiceName === name && e.type === 'start',
            ),
          voice.voiceName,
        ),
      ).toBe(true);
      await ui.ok({ kind: 'tts/stop-preview' });
    }
    await ui.page.setViewportSize({ width: 320, height: 1000 });
    await ui.page.getByText(/浏览并试听全部 \d+ 个声音/).click();
    const audio = ui.page.getByRole('region', { name: 'VOICE / 配音声音' });
    for (const colorScheme of ['light', 'dark'] as const) {
      await ui.page.emulateMedia({ colorScheme });
      await audio.scrollIntoViewIfNeeded();
      expect(await audio.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await audio.screenshot({
        path: test.info().outputPath(`actual-voices-${colorScheme}-320.png`),
      });
    }
  } finally {
    await ext.close();
  }
});
