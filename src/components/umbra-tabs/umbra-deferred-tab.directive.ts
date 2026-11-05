import {
  Directive,
  EmbeddedViewRef,
  input,
  OnChanges,
  OnDestroy,
  output,
  SimpleChanges,
  TemplateRef,
  ViewContainerRef,
} from '@angular/core';

export interface UmbraDeferredTabFocusEvent {
  /** True only when this activation creates the tab content for the first time. */
  readonly firstActivation: boolean;
}

/** Creates a tab's view on first activation, retains it while inactive, and emits on every activation. */
@Directive({
  selector: 'ng-template[umbraDeferredTab]',
  standalone: true,
})
export class UmbraDeferredTabDirective implements OnChanges, OnDestroy {
  readonly umbraDeferredTab = input.required<boolean>();
  readonly focused = output<UmbraDeferredTabFocusEvent>();

  private view: EmbeddedViewRef<unknown> | null = null;

  constructor(
    private readonly template: TemplateRef<unknown>,
    private readonly container: ViewContainerRef,
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (!changes['umbraDeferredTab']) return;
    if (!this.umbraDeferredTab()) {
      if (this.view) {
        const index = this.container.indexOf(this.view);
        if (index !== -1) this.container.detach(index);
      }
      return;
    }

    const firstActivation = this.view === null;
    if (this.view) this.container.insert(this.view);
    else this.view = this.container.createEmbeddedView(this.template);
    this.focused.emit({ firstActivation });
  }

  ngOnDestroy(): void {
    if (this.view && !this.view.destroyed) this.view.destroy();
    this.view = null;
  }
}
