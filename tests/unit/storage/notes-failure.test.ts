import { describe, expect, it, vi } from 'vitest';
import type * as DbModule from '@src/storage/db';

// 模拟写事务失败（例如磁盘或配额错误），验证 saveNote 将错误抛给调用方。
vi.mock('@src/storage/db', async (importOriginal) => {
  const actual = await importOriginal<typeof DbModule>();
  return {
    ...actual,
    openTongtingDb: async () => ({
      transaction: () => {
        const failure = new DOMException('模拟写入失败', 'UnknownError');
        const done = Promise.reject(failure);
        return {
          store: { put: () => Promise.reject(failure) },
          done,
        };
      },
    }),
  };
});

describe('saveNote transaction failure', () => {
  it('rejects when the write transaction fails', async () => {
    const { saveNote } = await import('@src/storage/notes');
    await expect(saveNote('abcdefghijk', '内容')).rejects.toThrow('模拟写入失败');
  });
});
