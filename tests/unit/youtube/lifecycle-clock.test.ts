// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContentScriptContext } from 'wxt/utils/content-script-context';
import { CONTENT_WAKE_MESSAGE_TYPE } from '@src/messaging/wake';
import { guardInvalidation, isTrustedWake } from '@src/youtube/lifecycle';
import { createPlayerAdapter, epochNow } from '@src/youtube/player-adapter';

afterEach(() => vi.restoreAllMocks());

describe('content wake validation', () => {
  const RID = 'abcdefghijklmnopabcdefghijklmnop';
  it('accepts only exact wake messages from this extension without a tab', () => {
    const wake = { type: CONTENT_WAKE_MESSAGE_TYPE };
    expect(isTrustedWake(wake, { id: RID }, RID)).toBe(true);
    expect(isTrustedWake(wake, { id: RID, tab: { id: 3 } }, RID)).toBe(false);
    expect(isTrustedWake(wake, { id: 'other-extension' }, RID)).toBe(false);
    expect(isTrustedWake({ ...wake, extra: 1 }, { id: RID }, RID)).toBe(false);
    expect(isTrustedWake(wake, undefined, RID)).toBe(false);
    expect(isTrustedWake(wake, { id: RID }, undefined)).toBe(false);
  });
});

describe('C4: forged WXT content-script-started event', () => {
  it('does not dispose while the extension runtime is alive, but does once it is gone', () => {
    const ctx = new ContentScriptContext('youtube');
    const cleanup = vi.fn();
    let alive = true;
    guardInvalidation(
      (cb) => ctx.onInvalidated(cb),
      () => alive,
      cleanup,
    );
    document.dispatchEvent(
      new CustomEvent(
        (ContentScriptContext as unknown as { SCRIPT_STARTED_MESSAGE_TYPE: string })
          .SCRIPT_STARTED_MESSAGE_TYPE,
        {
          detail: { contentScriptName: 'youtube', messageId: 'page-forged' },
        },
      ),
    );
    expect(ctx.isInvalid).toBe(true); // WXT 自身被伪造事件置为失效
    expect(cleanup).not.toHaveBeenCalled();
    const ctx2 = new ContentScriptContext('youtube2');
    guardInvalidation(
      (cb) => ctx2.onInvalidated(cb),
      () => alive,
      cleanup,
    );
    alive = false;
    ctx2.notifyInvalidated();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

describe('epoch clock', () => {
  it('sampledAtEpochMs follows Date.now even when performance.now stalls or drifts', () => {
    let wall = 1_800_000_000_000;
    const stalled = { now: () => 5 };
    expect(epochNow({ dateNow: () => wall, performance: stalled })).toBe(wall);
    wall += 60_000; // 系统睡眠 1 分钟：performance 停走
    expect(epochNow({ dateNow: () => wall, performance: stalled })).toBe(wall);

    vi.spyOn(Date, 'now').mockReturnValue(1_900_000_000_000);
    vi.spyOn(performance, 'now').mockReturnValue(42);
    document.body.replaceChildren();
    const root = document.createElement('div');
    root.id = 'movie_player';
    root.append(Object.assign(document.createElement('video'), { className: 'html5-main-video' }));
    document.body.append(root);
    const adapter = createPlayerAdapter({
      doc: document,
      win: window,
      getPageKind: () => 'watch',
      onEvent: () => undefined,
      pollMs: 60_000,
    });
    expect(adapter.snapshot()?.sampledAtEpochMs).toBe(1_900_000_000_000);
    adapter.dispose();
  });
});
