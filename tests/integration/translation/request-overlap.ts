import type { RecordedRequest } from '../../helpers/mock-sub2api/server';

/** 按服务端实际事件顺序计算并发；同毫秒内先结束再开始也严格区分。 */
export function maxRequestOverlap(
  requests: readonly Pick<RecordedRequest, 'startedOrder' | 'finishedOrder'>[],
): number {
  let maximum = 0;
  for (const request of requests) {
    const active = requests.filter(
      (other) =>
        other.startedOrder <= request.startedOrder &&
        (other.finishedOrder ?? Infinity) > request.startedOrder,
    ).length;
    maximum = Math.max(maximum, active);
  }
  return maximum;
}
