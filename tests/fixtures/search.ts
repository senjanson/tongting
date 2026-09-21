import type { SearchRecord } from '../../src/domain/search';

export const searchRecord: SearchRecord = {
  id: 'search-fixture-1',
  query: '新手怎么用 AI 剪辑 YouTube 视频',
  model: 'gpt-5.6-luna',
  createdAt: 1_800_000_000_000,
  items: [
    {
      label: '原文直译',
      keyword: 'How can beginners edit YouTube videos with AI?',
      annotation: '新手如何使用 AI 剪辑 YouTube 视频',
    },
    {
      label: '入门教程',
      keyword: 'YouTube AI editing tutorial',
      annotation: 'YouTube 视频 AI 剪辑教程',
    },
    {
      label: '工具选择',
      keyword: 'YouTube AI editing tools',
      annotation: '用于 YouTube 的 AI 视频剪辑工具',
    },
  ],
};

export function searchEnvelope(items: unknown = searchRecord.items) {
  return {
    status: 'completed',
    model: searchRecord.model,
    output: [
      { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ items }) }] },
    ],
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
