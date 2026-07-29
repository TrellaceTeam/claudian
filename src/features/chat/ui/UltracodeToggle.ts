import type { ToolbarCallbacks } from './InputToolbar';

/**
 * Per-tab ultracode toggle. Passes --settings '{"ultracode":true}' to the
 * spawned CLI; the flag is baked at spawn time, so the owning tab respawns
 * its SDK process on toggle (see onUltracodeChange in Tab.ts).
 */
export class UltracodeToggle {
  private container: HTMLElement;
  private toggleEl: HTMLElement | null = null;
  private labelEl: HTMLElement | null = null;
  private callbacks: ToolbarCallbacks;

  constructor(parentEl: HTMLElement, callbacks: ToolbarCallbacks) {
    this.callbacks = callbacks;
    this.container = parentEl.createDiv({ cls: 'claudian-ultracode-toggle' });
    this.render();
  }

  private render() {
    this.container.empty();

    this.labelEl = this.container.createSpan({ cls: 'claudian-ultracode-label' });
    this.labelEl.setText('Ultracode');
    this.toggleEl = this.container.createDiv({ cls: 'claudian-toggle-switch' });
    this.toggleEl.setAttribute('title', 'Ultracode: xhigh effort + dynamic-workflow orchestration (respawns this tab)');

    this.updateDisplay();

    this.toggleEl.addEventListener('click', () => this.toggle());
  }

  updateDisplay() {
    if (!this.toggleEl) return;

    const enabled = this.callbacks.getSettings().ultracode ?? false;
    this.toggleEl.toggleClass('active', enabled);
  }

  private async toggle() {
    const current = this.callbacks.getSettings().ultracode ?? false;
    await this.callbacks.onUltracodeChange?.(!current);
    this.updateDisplay();
  }
}
