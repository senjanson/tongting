/**
 * 会话错误 / 翻译受阻提示：不论 phase 如何，只要快照带有 error 或 translation.blockedError 就显示，
 * 并给出可执行的下一步（按钮或操作指引）。
 */
import type { SessionSnapshot } from '../../domain/session';
import { Button, Hint } from '../components/controls';
import { Callout } from '../components/layout';
import { errorNextStep, sessionProblem, type NextStepAction } from '../state/derive';

export function problemTitle(session: SessionSnapshot, source: 'session' | 'blocked'): string {
  if (source === 'blocked') return '翻译受阻';
  switch (session.phase) {
    case 'error':
      return '翻译出错';
    case 'paused':
    case 'pausing':
      return '无法继续翻译';
    case 'starting':
    case 'configuring':
      return '启动受阻';
    default:
      return '翻译出错';
  }
}

export function SessionProblemCallout({
  session,
  onNextStep,
  compact,
}: {
  session: SessionSnapshot | undefined;
  onNextStep(action: NextStepAction): void;
  compact?: boolean;
}) {
  const problem = sessionProblem(session);
  if (!session || !problem) return null;
  const next = errorNextStep(problem.error);
  return (
    <Callout
      tone="danger"
      title={compact ? undefined : problemTitle(session, problem.source)}
      live
      actions={
        next.action !== 'none' ? (
          <Button size="sm" onClick={() => onNextStep(next.action)}>
            {next.label}
          </Button>
        ) : undefined
      }
    >
      {problem.error.message}
      {next.hint && <Hint>{next.hint}</Hint>}
    </Callout>
  );
}
