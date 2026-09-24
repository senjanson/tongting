/**
 * 会话错误 / 翻译受阻提示：不论 phase 如何，只要快照带有 error 或 translation.blockedError 就显示，
 * 并给出可执行的下一步（按钮或操作指引）。
 */
import type { SessionSnapshot } from '../../domain/session';
import { getLocale, translate, type Locale } from '../../i18n';
import { useLocale } from '../../i18n/react';
import { Button, Hint } from '../components/controls';
import { Callout } from '../components/layout';
import { errorNextStep, sessionProblem, type NextStepAction } from '../state/derive';

export function problemTitle(
  session: SessionSnapshot,
  source: 'session' | 'blocked',
  locale: Locale = getLocale(),
): string {
  if (source === 'blocked') return translate(locale, 'common.problem.blocked');
  switch (session.phase) {
    case 'paused':
    case 'pausing':
      return translate(locale, 'common.problem.cannotResume');
    case 'starting':
    case 'configuring':
      return translate(locale, 'common.problem.startBlocked');
    default:
      return translate(locale, 'common.problem.error');
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
  const locale = useLocale();
  const problem = sessionProblem(session);
  if (!session || !problem) return null;
  const next = errorNextStep(problem.error, locale);
  return (
    <Callout
      tone="danger"
      title={compact ? undefined : problemTitle(session, problem.source, locale)}
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
