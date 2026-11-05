import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export type UmbraStatus = 'running' | 'waiting' | 'blocked' | 'done' | 'idle';

export const STATUS_LABEL: Readonly<Record<UmbraStatus, string>> = {
  running: 'Running',
  waiting: 'Waiting',
  blocked: 'Blocked',
  done: 'Completed',
  idle: 'Idle',
};

/** Shows lifecycle state as a semantic status dot and an accessible word. */
@Component({
  selector: 'umbra-status-dot',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="dot" aria-hidden="true"></span>
    @if (label()) {
      <span>{{ text() }}</span>
    }
  `,
  styleUrl: './umbra-status-dot.component.scss',
  host: {
    class: 'umbra-status-dot',
    '[attr.data-state]': 'state()',
    '[attr.role]': 'label() ? null : "img"',
    '[attr.aria-label]': 'label() ? null : text()',
  },
})
export class UmbraStatusDotComponent {
  readonly state = input<UmbraStatus>('idle');
  /** Render the state as text beside the dot. */
  readonly label = input<boolean>(false);
  /** Override the default word for the state. */
  readonly labelText = input<string>('');
  readonly text = computed(() => this.labelText() || STATUS_LABEL[this.state()]);
}
