import type { EnvSnippet } from '../../../core/types';
import type ClaudianPlugin from '../../../main';

export interface ProviderSelectorCallbacks {
  onProviderChange: (snippet: EnvSnippet | null) => Promise<void>;
}

export class ProviderSelector {
  private container: HTMLElement;
  private buttonEl: HTMLElement | null = null;
  private dropdownEl: HTMLElement | null = null;
  private plugin: ClaudianPlugin;
  private callbacks: ProviderSelectorCallbacks;

  constructor(
    parentEl: HTMLElement,
    plugin: ClaudianPlugin,
    callbacks: ProviderSelectorCallbacks
  ) {
    this.container = parentEl.createDiv({ cls: 'claudian-provider-selector' });
    this.plugin = plugin;
    this.callbacks = callbacks;
    this.render();
  }

  private getAvailableProviders(): { id: string; name: string }[] {
    const providers: { id: string; name: string }[] = [
      { id: '', name: 'Default' }
    ];

    for (const snippet of this.plugin.settings.envSnippets) {
      providers.push({ id: snippet.id, name: snippet.name });
    }

    return providers;
  }

  private getCurrentProviderName(): string {
    try {
      const providers = this.getAvailableProviders();
      const currentId = this.getCurrentProviderId();
      const provider = providers.find(p => p.id === currentId);
      return provider?.name || 'Default';
    } catch {
      return 'Default';
    }
  }

  private getCurrentProviderId(): string {
    try {
      const currentEnvVars = this.plugin.getActiveEnvironmentVariables();
      if (!currentEnvVars || currentEnvVars.trim() === '') {
        return '';
      }

      // Normalize env vars for comparison (remove trailing whitespace, normalize line endings)
      const normalizedCurrent = currentEnvVars.trim().replace(/\r\n/g, '\n');

      for (const snippet of this.plugin.settings.envSnippets) {
        const normalizedSnippet = snippet.envVars.trim().replace(/\r\n/g, '\n');
        if (normalizedSnippet === normalizedCurrent) {
          return snippet.id;
        }
      }
    } catch {
      // Fall through to return empty string
    }
    return '';
  }

  private render(): void {
    try {
      this.container.empty();

      this.buttonEl = this.container.createDiv({ cls: 'claudian-provider-btn' });
      this.buttonEl.setText(this.getCurrentProviderName());

      this.dropdownEl = this.container.createDiv({ cls: 'claudian-provider-dropdown' });
      this.renderOptions();

      // Toggle dropdown on button click
      this.buttonEl.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleDropdown();
      });

      // Close dropdown when clicking outside
      document.addEventListener('click', () => {
        this.closeDropdown();
      });
    } catch (error) {
      console.error('ProviderSelector render error:', error);
    }
  }

  private renderOptions(): void {
    if (!this.dropdownEl) return;
    this.dropdownEl.empty();

    try {
      const providers = this.getAvailableProviders();
      const currentId = this.getCurrentProviderId();

      for (const provider of providers) {
        const option = this.dropdownEl.createDiv({ cls: 'claudian-provider-option' });
        if (provider.id === currentId) {
          option.addClass('selected');
        }

        option.createSpan({ text: provider.name });

        option.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            const snippet = provider.id
              ? this.plugin.settings.envSnippets.find(s => s.id === provider.id)
              : null;
            await this.callbacks.onProviderChange(snippet || null);
            this.buttonEl?.setText(this.getCurrentProviderName());
            this.renderOptions();
            this.closeDropdown();
          } catch (error) {
            console.error('Provider change error:', error);
          }
        });
      }
    } catch (error) {
      console.error('renderOptions error:', error);
    }
  }

  private toggleDropdown(): void {
    if (!this.dropdownEl) return;
    const isOpen = this.dropdownEl.hasClass('open');
    if (isOpen) {
      this.closeDropdown();
    } else {
      this.openDropdown();
    }
  }

  private openDropdown(): void {
    this.dropdownEl?.addClass('open');
  }

  private closeDropdown(): void {
    this.dropdownEl?.removeClass('open');
  }

  refresh(): void {
    this.render();
  }
}
