/**
 * 根据 offscreen 协议中的 AsrRoute 创建识别客户端。凭证只存在于该对象内存中，不记录、不回传。
 */
import type { AsrRoute } from '../../messaging/offscreen-protocol';
import { createLocalAsrProvider } from './local-client';
import { createSub2apiAsrProvider } from './sub2api-client';
import type { AsrProvider } from './types';

export function createAsrProviderFromRoute(route: AsrRoute, fetchImpl?: typeof fetch): AsrProvider {
  if (route.backend === 'local') {
    return createLocalAsrProvider({ baseUrl: route.baseUrl, token: route.token, fetchImpl });
  }
  return createSub2apiAsrProvider({
    baseUrl: route.baseUrl,
    apiKey: route.apiKey,
    model: route.model,
    fetchImpl,
  });
}
