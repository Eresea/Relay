import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * The glass tier — the only place in Umbra where depth comes from light rather
 * than from value.
 *
 * Use it for a surface that floats over the OS or over the map rather than over
 * an app pane: a HUD notification, a tray popover, a map context menu, the
 * command palette. If a surface belongs to the app window it is flat and opaque;
 * if it belongs to the desktop it is glass. Nothing in between — never blur a
 * card or a sidebar.
 *
 * The solid fill is the base and the blur is additive, so the panel stays legible
 * in a webview where backdrop-filter silently does nothing.
 */
@Component({
  selector: 'umbra-glass-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '<ng-content />',
  styleUrl: './umbra-glass-panel.component.scss',
  host: {
    class: 'umbra-glass-panel u-glass',
    '[attr.data-raised]': 'raised() ? "" : null',
  },
})
export class UmbraGlassPanelComponent {
  /** A section nested inside another glass surface. */
  readonly raised = input<boolean>(false);
}
