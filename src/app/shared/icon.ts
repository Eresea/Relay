import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * The only way a screen draws a glyph. Never inline an SVG in a component and
 * never paste path data.
 *
 * Icons are Lucide, masked to currentColor so every glyph inherits theme,
 * hover and disabled states for free. Umbra loads them from a CDN; Relay is a
 * desktop app and must work offline, so the SVGs are vendored into
 * src/assets/icons. See docs/DESIGN.md for the sync script.
 *
 * Sizes: 14 in dense rows, menus and small buttons; 16 default; 20 only inside
 * an empty-state tile.
 */
@Component({
  selector: 'rl-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
  host: {
    '[style.--icon-url]': 'url()',
    '[style.--icon-size.px]': 'size()',
    '[attr.aria-hidden]': 'true',
  },
  styles: `
    :host {
      display: inline-block;
      inline-size: var(--icon-size, 16px);
      block-size: var(--icon-size, 16px);
      flex: none;
      background-color: currentColor;
      -webkit-mask: var(--icon-url) center / contain no-repeat;
      mask: var(--icon-url) center / contain no-repeat;
    }
  `,
})
export class Icon {
  /** A Lucide glyph name, e.g. 'search', 'folder', 'circle-check'. */
  readonly name = input.required<string>();
  readonly size = input<14 | 16 | 20>(16);

  protected readonly url = computed(() => `url('assets/icons/${this.name()}.svg')`);
}
