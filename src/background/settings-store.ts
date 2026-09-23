/**
 * 设置与凭证存储（仅在 service worker 中使用）。
 *
 * - 非敏感设置：storage.local `settings`，带 schemaVersion；损坏时保留备份并回到默认值。
 * - API Key / 本地识别令牌：默认写扩展 IndexedDB；主动取消「记住在本机」时才写 storage.session。
 *   storage.local 只保存非敏感位置/删除标记；所有区域均限于可信扩展上下文。
 * - 写入失败不得报告为已保存；调用方拿到 persisted=false 后提示「仅本次生效」。
 */
import type { KeyValueArea } from './deps';
import { defaultTargetLanguageFor } from '../domain/languages';
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
  /** 已成功迁移的旧设置需要落盘，避免下次启动重复应用升级默认值。 */
  needsPersistence?: boolean;
}

export async function loadSettings(
  local: KeyValueArea,
  logger: Pick<Console, 'warn'>,
  /** 浏览器界面语言，用于首次安装时挑默认目标语言；省略则使用内置默认。 */
  uiLanguage?: string,
): Promise<LoadedSettings> {
  const initial = () => defaultSettings(defaultTargetLanguageFor(uiLanguage));
  let raw: unknown;
  try {
    raw = (await local.get([SETTINGS_KEY]))[SETTINGS_KEY];
  } catch (error) {
    logger.warn('[tongting] settings read failed', error instanceof Error ? error.name : 'unknown');
    return { settings: initial(), recoveredFromCorruption: false };
  }
  if (raw === undefined) return { settings: initial(), recoveredFromCorruption: false };
  const migrated = migrateSettings(raw);
  const parsed = SettingsSchema.safeParse(migrated);
  if (parsed.success)
    return {
      settings: parsed.data,
      recoveredFromCorruption: false,
      needsPersistence: migrated !== raw,
    };
  // 保留损坏数据备份，不静默丢弃。
  try {
    await local.set({ [SETTINGS_BACKUP_KEY]: raw });
  } catch {
    // 备份失败不影响继续使用默认设置。
  }
  logger.warn('[tongting] settings invalid, using defaults; backup kept');
  return { settings: initial(), recoveredFromCorruption: true };
}

/** v2 将默认凭证策略改为持久保存；之后用户显式选择的临时模式不会被再次覆盖。 */
export function migrateSettings(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion === undefined || obj.schemaVersion === 1)
    return { ...obj, schemaVersion: SETTINGS_SCHEMA_VERSION, rememberCredentials: true };
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
  /** 旧副本未确认全部清除；UI 保留重试清理入口，不代表凭证仍可使用。 */
  cleanupPending?: boolean;
}

function secretKey(kind: SecretKind): string {
  return kind === 'apiKey' ? API_KEY : ASR_TOKEN_KEY;
}

/**
 * 凭证存储区：
 * - session：chrome.storage.session（主动选择临时保存，扩展重载/浏览器退出会清空）。
 * - secureLocal：默认「记住在本机」，扩展 origin 的 IndexedDB（内容脚本不可读）。
 * - local：chrome.storage.local，仅用于读取并迁移旧版本保存的凭证，之后删除。
 */
export interface SecretAreas {
  local: KeyValueArea;
  session: KeyValueArea;
  secureLocal: KeyValueArea;
}

let secretRevision = 0;

function reserveSecretRevision(): number {
  secretRevision = Math.max(Date.now(), secretRevision + 1);
  return secretRevision;
}

interface SecretMarker {
  revision: number;
  storage: SecretState['storage'];
  cleanupPending: boolean;
}

function secretAreas(areas: SecretAreas): KeyValueArea[] {
  return [areas.local, areas.session, areas.secureLocal];
}

async function readSecretMarkers(areas: SecretAreas, key: string): Promise<SecretMarker[]> {
  const values = (
    await Promise.all(
      secretAreas(areas).map(async (area) => {
        const data = await area.get([`${key}.state`, `${key}.revoked`]);
        return [data[`${key}.state`], data[`${key}.revoked`]];
      }),
    )
  ).flat();
  return values
    .filter((v) => v !== undefined)
    .map((raw) => {
      const marker = raw as Partial<SecretMarker> | null;
      if (!marker || !['none', 'session', 'local'].includes(marker.storage ?? ''))
        throw new Error('invalid secret marker');
      if (
        marker.revision !== undefined &&
        (!Number.isSafeInteger(marker.revision) || marker.revision < 0)
      )
        throw new Error('invalid secret revision');
      const revision = marker.revision ?? 0;
      secretRevision = Math.max(secretRevision, revision);
      return { revision, storage: marker.storage!, cleanupPending: !!marker.cleanupPending };
    });
}

/** 非敏感位置/删除标记冗余写入：任意一个区域不可写时，其他区域仍可阻止旧副本复活。 */
async function writeSecretMarker(
  areas: SecretAreas,
  key: string,
  marker: SecretMarker,
  suffix = 'state',
): Promise<boolean> {
  const results = await Promise.allSettled(
    secretAreas(areas).map((area) => area.set({ [`${key}.${suffix}`]: marker })),
  );
  return results.every((result) => result.status === 'fulfilled');
}

export async function loadSecret(areas: SecretAreas, kind: SecretKind): Promise<SecretState> {
  const key = secretKey(kind);
  try {
    const markers = await readSecretMarkers(areas, key);
    if (markers.length) {
      const revision = Math.max(...markers.map((marker) => marker.revision));
      const current = markers.filter((marker) => marker.revision === revision);
      const marker = current[0]!;
      const cleanupPending = current.some((m) => m.cleanupPending) || undefined;
      if (marker.storage === 'none') return { value: undefined, storage: 'none', cleanupPending };
      const target = marker.storage === 'session' ? areas.session : areas.secureLocal;
      const value = (await target.get([key]))[key];
      // 权威副本缺失时不退回旧位置，浏览器退出后的 session Key 也不会从残留副本恢复。
      return {
        value: typeof value === 'string' && value ? value : undefined,
        storage: typeof value === 'string' && value ? marker.storage : 'none',
        cleanupPending,
      };
    }
    // 升级旧版本时登记唯一权威位置，同时清理其他副本；不能掩盖迁移失败。
    for (const [area, storage] of [
      [areas.session, 'session'],
      [areas.secureLocal, 'local'],
      [areas.local, 'local'],
    ] as const) {
      const value = (await area.get([key]))[key];
      if (typeof value !== 'string' || !value) continue;
      const persisted = await saveSecret(areas, kind, value, storage === 'local');
      return { value, storage, cleanupPending: !persisted || undefined };
    }
  } catch {
    // 无法确认权威位置时不读取可能已撤销的残留凭证。
    return { value: undefined, storage: 'none', cleanupPending: true };
  }
  return { value: undefined, storage: 'none' };
}

/** 保存成功要求目标副本、权威标记和旧副本清理均确认成功。 */
export async function saveSecret(
  areas: SecretAreas,
  kind: SecretKind,
  value: string,
  remember: boolean,
): Promise<boolean> {
  const key = secretKey(kind);
  const revision = reserveSecretRevision();
  const target = remember ? areas.secureLocal : areas.session;
  const storage = remember ? 'local' : 'session';
  try {
    await target.set({ [key]: value });
  } catch {
    return false;
  }
  const marked = await writeSecretMarker(areas, key, { revision, storage, cleanupPending: true });
  const others = remember ? [areas.session, areas.local] : [areas.secureLocal, areas.local];
  const removed = await Promise.allSettled(others.map((area) => area.remove([key])));
  if (!marked || removed.some((result) => result.status === 'rejected')) return false;
  return writeSecretMarker(areas, key, { revision, storage, cleanupPending: false });
}

export interface SecretRevocation {
  revision: number;
  persisted: Promise<boolean>;
}

/** 单独的撤销记录不被旧保存覆盖；立即写入，不等待前面的保存落盘。 */
export function beginSecretRevocation(areas: SecretAreas, kind: SecretKind): SecretRevocation {
  const revision = reserveSecretRevision();
  return {
    revision,
    persisted: writeSecretMarker(
      areas,
      secretKey(kind),
      { revision, storage: 'none', cleanupPending: true },
      'revoked',
    ),
  };
}

export async function clearSecret(
  areas: SecretAreas,
  kind: SecretKind,
  revocation = beginSecretRevocation(areas, kind),
): Promise<boolean> {
  const key = secretKey(kind);
  const { revision } = revocation;
  // 前面的旧写入结束后再清理所有实际副本。撤销记录已提前阻止 worker 重启复活旧凭证。
  const marked = await revocation.persisted;
  const removed = await Promise.allSettled(secretAreas(areas).map((area) => area.remove([key])));
  if (!marked || removed.some((result) => result.status === 'rejected')) return false;
  const marker: SecretMarker = { revision, storage: 'none', cleanupPending: false };
  const results = await Promise.all([
    writeSecretMarker(areas, key, marker),
    writeSecretMarker(areas, key, marker, 'revoked'),
  ]);
  return results.every(Boolean);
}

export function maskSecret(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const tail = value.length > 8 ? value.slice(-4) : '';
  return `••••${tail}`;
}
