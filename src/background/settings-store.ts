/**
 * 设置与凭证存储（仅在 service worker 中使用）。
 *
 * - 非敏感设置：storage.local `settings`，带 schemaVersion；损坏时保留备份并回到默认值。
 * - API Key / 本地识别令牌：默认 storage.session；用户选择「记住在本机」时写 storage.local。
 *   两个区域都应设置为仅可信上下文访问（见 wiring.ts）。
 * - 写入失败不得报告为已保存；调用方拿到 persisted=false 后提示「仅本次生效」。
 */
import type { KeyValueArea } from './deps';
import {
  SETTINGS_SCHEMA_VERSION,
  SettingsSchema,
  defaultSettings,
  type Settings,
} from '../domain/settings';

const SETTINGS_KEY = 'settings';
const SETTINGS_BACKUP_KEY = 'settings.corruptBackup';
const API_KEY = 'secret.apiKey';
const ASR_TOKEN_KEY = 'secret.asrToken';

export interface LoadedSettings {
  settings: Settings;
  /** 读取到损坏数据并回退默认值。 */
  recoveredFromCorruption: boolean;
}

export async function loadSettings(
  local: KeyValueArea,
  logger: Pick<Console, 'warn'>,
): Promise<LoadedSettings> {
  let raw: unknown;
  try {
    raw = (await local.get([SETTINGS_KEY]))[SETTINGS_KEY];
  } catch (error) {
    logger.warn('[tongting] settings read failed', error instanceof Error ? error.name : 'unknown');
    return { settings: defaultSettings(), recoveredFromCorruption: false };
  }
  if (raw === undefined) return { settings: defaultSettings(), recoveredFromCorruption: false };
  const migrated = migrateSettings(raw);
  const parsed = SettingsSchema.safeParse(migrated);
  if (parsed.success) return { settings: parsed.data, recoveredFromCorruption: false };
  // 保留损坏数据备份，不静默丢弃。
  try {
    await local.set({ [SETTINGS_BACKUP_KEY]: raw });
  } catch {
    // 备份失败不影响继续使用默认设置。
  }
  logger.warn('[tongting] settings invalid, using defaults; backup kept');
  return { settings: defaultSettings(), recoveredFromCorruption: true };
}

/** 设置迁移入口。当前仅有 v1；未知字段由 schema 丢弃，缺失字段取默认值。 */
export function migrateSettings(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion === undefined) return { ...obj, schemaVersion: SETTINGS_SCHEMA_VERSION };
  return obj;
}

export async function saveSettings(local: KeyValueArea, settings: Settings): Promise<boolean> {
  try {
    await local.set({ [SETTINGS_KEY]: settings });
    return true;
  } catch {
    return false;
  }
}

export type SecretKind = 'apiKey' | 'asrToken';

export interface SecretState {
  value: string | undefined;
  storage: 'none' | 'session' | 'local';
}

function secretKey(kind: SecretKind): string {
  return kind === 'apiKey' ? API_KEY : ASR_TOKEN_KEY;
}

/**
 * 凭证存储区：
 * - session：chrome.storage.session（默认，仅本次浏览器会话，内容脚本不可读）。
 * - secureLocal：「记住在本机」，扩展 origin 的 IndexedDB（内容脚本不可读）。
 * - local：chrome.storage.local，仅用于读取并迁移旧版本保存的凭证，之后删除。
 */
export interface SecretAreas {
  local: KeyValueArea;
  session: KeyValueArea;
  secureLocal: KeyValueArea;
}

export async function loadSecret(areas: SecretAreas, kind: SecretKind): Promise<SecretState> {
  const key = secretKey(kind);
  try {
    const s = (await areas.session.get([key]))[key];
    if (typeof s === 'string' && s) return { value: s, storage: 'session' };
  } catch {
    // 忽略，继续尝试本机存储
  }
  try {
    const v = (await areas.secureLocal.get([key]))[key];
    if (typeof v === 'string' && v) return { value: v, storage: 'local' };
  } catch {
    // 读取失败时继续检查旧位置
  }
  try {
    const legacy = (await areas.local.get([key]))[key];
    if (typeof legacy === 'string' && legacy) {
      // 旧版本存放在 storage.local（内容脚本可读）：迁移到 IndexedDB 后删除旧副本。
      try {
        await areas.secureLocal.set({ [key]: legacy });
        await areas.local.remove([key]);
      } catch {
        // 迁移失败：本次仍可使用，下次启动再试
      }
      return { value: legacy, storage: 'local' };
    }
  } catch {
    // 读取失败视为未配置
  }
  return { value: undefined, storage: 'none' };
}

/** 保存凭证：写入目标区域并从其他区域删除，避免残留。返回是否持久化成功。 */
export async function saveSecret(
  areas: SecretAreas,
  kind: SecretKind,
  value: string,
  remember: boolean,
): Promise<boolean> {
  const key = secretKey(kind);
  const target = remember ? areas.secureLocal : areas.session;
  try {
    await target.set({ [key]: value });
  } catch {
    return false;
  }
  const others = remember ? [areas.session, areas.local] : [areas.secureLocal, areas.local];
  // 其他区域删除失败时不影响本次保存结果；读取顺序保证 session 优先。
  await Promise.allSettled(others.map((a) => a.remove([key])));
  return true;
}

export async function clearSecret(areas: SecretAreas, kind: SecretKind): Promise<boolean> {
  const key = secretKey(kind);
  const results = await Promise.allSettled([
    areas.session.remove([key]),
    areas.secureLocal.remove([key]),
    areas.local.remove([key]),
  ]);
  return results.every((r) => r.status === 'fulfilled');
}

export function maskSecret(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const tail = value.length > 8 ? value.slice(-4) : '';
  return `••••${tail}`;
}
