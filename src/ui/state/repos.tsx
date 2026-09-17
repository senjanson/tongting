/**
 * 本地数据仓库注入：真实模式使用 IndexedDB，演示模式使用内存数据（不写入用户数据）。
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { FavoriteRecord, TranscriptRecord } from '../../storage/db';
import { listFavoritesByRecord, setFavorite, type FavoriteInput } from '../../storage/favorites';
import { listTranscriptsByVideo } from '../../storage/transcripts';

export interface FavoritesRepo {
  listByRecord(recordId: string): Promise<FavoriteRecord[]>;
  /** 设置为期望状态（幂等），返回最终状态。 */
  set(input: FavoriteInput, favorited: boolean): Promise<boolean>;
}

export interface TranscriptsRepo {
  listByVideo(videoId: string): Promise<TranscriptRecord[]>;
}

export interface UiRepos {
  favorites: FavoritesRepo;
  transcripts: TranscriptsRepo;
}

export const indexedDbRepos: UiRepos = {
  favorites: { listByRecord: listFavoritesByRecord, set: setFavorite },
  transcripts: { listByVideo: listTranscriptsByVideo },
};

const ReposContext = createContext<UiRepos>(indexedDbRepos);

export function ReposProvider({ repos, children }: { repos: UiRepos; children: ReactNode }) {
  return <ReposContext.Provider value={repos}>{children}</ReposContext.Provider>;
}

export function useRepos(): UiRepos {
  return useContext(ReposContext);
}
