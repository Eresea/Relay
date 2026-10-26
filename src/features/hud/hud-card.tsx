import { Button } from '@/components/ui/button';
import { hueVar, type EntityHue } from '@/core/entity-hue';
import type { NotificationAction } from '@/core/events';
import { vars } from '@/lib/utils';
import { Icon } from '@/shared/icon';

export type HudStatus = 'running' | 'waiting' | 'blocked' | 'done' | 'idle';

const STATUS_LABEL: Record<HudStatus, string> = {
  running: 'Running',
  waiting: 'Needs you',
  blocked: 'Needs attention',
  done: 'Done',
  idle: 'Ready',
};

interface HudCardProps {
  readonly title: string;
  readonly detail?: string | undefined;
  readonly icon?: string | undefined;
  readonly hue: EntityHue;
  readonly status: HudStatus;
  /** Undefined hides the track: never synthesise a percentage. */
  readonly progress?: number | undefined;
  readonly actions?: readonly NotificationAction[] | undefined;
  readonly onDismiss: () => void;
  readonly onAction: (action: NotificationAction) => void;
}

/**
 * One card in the attention stack: a long-lived object, its identity hue, how
 * far it has got and what it is doing. A card that waits on you says so and
 * puts its first action forward; every other card only reports.
 */
export function HudCard({
  title,
  detail,
  icon = 'circle',
  hue,
  status,
  progress,
  actions = [],
  onDismiss,
  onAction,
}: HudCardProps) {
  const tone = hueVar(hue);
  const needsYou = status === 'waiting' || status === 'blocked';

  return (
    <article className="hud-card u-glass u-chrome" data-status={status}>
      <span className="u-entity-tile tile" style={vars({ '--entity-hue': tone })}>
        <Icon name={icon} size={16} />
      </span>

      <div className="text">
        <p className="title">{title}</p>
        {detail && <p className="detail">{detail}</p>}
      </div>

      <div className="state">
        <span className="dot" />
        <span>{STATUS_LABEL[status]}</span>
        <Button size="icon" variant="ghost" aria-label="Dismiss" onClick={onDismiss}>
          <Icon name="x" size={14} />
        </Button>
      </div>

      {actions.length > 0 && (
        <div className="controls">
          {actions.map((action, index) => (
            <Button
              key={action.id}
              size="sm"
              variant={index === 0 && needsYou ? 'default' : 'secondary'}
              onClick={() => onAction(action)}
            >
              {action.label}
            </Button>
          ))}
        </div>
      )}

      {progress !== undefined && (
        <div
          className="u-entity-track track"
          style={vars({ '--entity-hue': tone })}
          role="progressbar"
          aria-valuenow={progress}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${title} progress`}
        >
          <div className="u-entity-track-fill" style={{ inlineSize: `${progress}%` }} />
        </div>
      )}
    </article>
  );
}
