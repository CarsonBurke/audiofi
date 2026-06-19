// A small, dependency-free listbox <select> replacement styled after shadcn/ui
// (which wraps Radix) and Base UI: a bordered trigger with a chevron and a
// floating, keyboard-navigable option list with a check on the active value.
// Native <select> can't be themed to this standard and its popup escapes the
// widget's shadow root, so we build the control by hand. All markup lives inside
// the host shadow root, so {@link SELECT_STYLE} must be included in that root's
// stylesheet once. Self-contained: no focus trap library, no portal.

import { ICONS } from '../panel/icons';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectConfig {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
}

export class Select {
  /** Root element to insert into the DOM. */
  readonly el: HTMLDivElement;

  private trigger: HTMLButtonElement;
  private valueEl: HTMLSpanElement;
  private listbox: HTMLDivElement;
  private optionEls: HTMLDivElement[] = [];
  private open = false;
  private active = -1;
  private typeahead = '';
  private typeaheadAt = 0;
  private readonly onDocPointerDown: (e: PointerEvent) => void;

  constructor(private cfg: SelectConfig) {
    this.el = document.createElement('div');
    this.el.className = 'sel';

    this.trigger = document.createElement('button');
    this.trigger.type = 'button';
    this.trigger.className = 'sel-trigger';
    this.trigger.setAttribute('role', 'combobox');
    this.trigger.setAttribute('aria-haspopup', 'listbox');
    this.trigger.setAttribute('aria-expanded', 'false');
    this.trigger.setAttribute('aria-label', cfg.ariaLabel);
    this.valueEl = document.createElement('span');
    this.valueEl.className = 'sel-value';
    const chevron = document.createElement('span');
    chevron.className = 'sel-chevron';
    chevron.innerHTML = ICONS.chevronDown;
    this.trigger.append(this.valueEl, chevron);

    this.listbox = document.createElement('div');
    this.listbox.className = 'sel-listbox';
    this.listbox.setAttribute('role', 'listbox');
    this.listbox.setAttribute('aria-label', cfg.ariaLabel);
    this.listbox.hidden = true;

    this.optionEls = cfg.options.map((opt, i) => {
      const o = document.createElement('div');
      o.className = 'sel-opt';
      o.setAttribute('role', 'option');
      o.dataset.value = opt.value;
      o.id = `sel-opt-${i}`;
      const check = document.createElement('span');
      check.className = 'sel-check';
      check.innerHTML = ICONS.check;
      const text = document.createElement('span');
      text.textContent = opt.label;
      o.append(check, text);
      o.addEventListener('click', () => this.commit(i));
      o.addEventListener('pointermove', () => this.setActive(i));
      this.listbox.append(o);
      return o;
    });

    this.el.append(this.trigger, this.listbox);

    this.trigger.addEventListener('click', () => this.toggle());
    this.trigger.addEventListener('keydown', (e) => this.onTriggerKey(e));
    this.listbox.addEventListener('keydown', (e) => this.onListKey(e));
    this.onDocPointerDown = (e) => {
      if (this.open && !e.composedPath().includes(this.el)) this.close(false);
    };

    this.setValue(cfg.value);
  }

  /** Reflect an externally-set value (no onChange fired). */
  setValue(value: string): void {
    const i = this.cfg.options.findIndex((o) => o.value === value);
    const idx = i >= 0 ? i : 0;
    this.valueEl.textContent = this.cfg.options[idx]?.label ?? '';
    this.optionEls.forEach((o, k) => o.setAttribute('aria-selected', String(k === idx)));
  }

  /** Detach the document listener; call when the host is torn down. */
  destroy(): void {
    document.removeEventListener('pointerdown', this.onDocPointerDown, true);
  }

  private toggle(): void {
    this.open ? this.close(true) : this.show();
  }

  private show(): void {
    if (this.open) return;
    this.open = true;
    this.listbox.hidden = false;
    this.trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', this.onDocPointerDown, true);
    const selected = this.optionEls.findIndex((o) => o.getAttribute('aria-selected') === 'true');
    this.setActive(selected < 0 ? 0 : selected);
    this.listbox.tabIndex = -1;
    this.listbox.focus({ preventScroll: true });
  }

  private close(focusTrigger: boolean): void {
    if (!this.open) return;
    this.open = false;
    this.listbox.hidden = true;
    this.trigger.setAttribute('aria-expanded', 'false');
    this.setActive(-1);
    document.removeEventListener('pointerdown', this.onDocPointerDown, true);
    if (focusTrigger) this.trigger.focus({ preventScroll: true });
  }

  private setActive(i: number): void {
    this.active = i;
    this.optionEls.forEach((o, k) => o.classList.toggle('active', k === i));
    if (i >= 0) {
      this.listbox.setAttribute('aria-activedescendant', this.optionEls[i].id);
      this.optionEls[i].scrollIntoView({ block: 'nearest' });
    } else {
      this.listbox.removeAttribute('aria-activedescendant');
    }
  }

  private commit(i: number): void {
    const opt = this.cfg.options[i];
    if (!opt) return;
    this.setValue(opt.value);
    this.close(true);
    this.cfg.onChange(opt.value);
  }

  private move(delta: number): void {
    const n = this.optionEls.length;
    const from = this.active < 0 ? (delta > 0 ? -1 : 0) : this.active;
    this.setActive((from + delta + n) % n);
  }

  private onTriggerKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.show();
    }
  }

  private onListKey(e: KeyboardEvent): void {
    // Keep navigation keys (notably Space/Enter) from reaching host shortcuts
    // such as the side panel's space-to-play handler while the list is open.
    e.stopPropagation();
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); this.move(1); break;
      case 'ArrowUp': e.preventDefault(); this.move(-1); break;
      case 'Home': e.preventDefault(); this.setActive(0); break;
      case 'End': e.preventDefault(); this.setActive(this.optionEls.length - 1); break;
      case 'Enter':
      case ' ': e.preventDefault(); if (this.active >= 0) this.commit(this.active); break;
      case 'Escape': e.preventDefault(); this.close(true); break;
      case 'Tab': this.close(false); break;
      default: this.onTypeahead(e.key); break;
    }
  }

  // Jump to the next option whose label starts with the typed prefix.
  private onTypeahead(key: string): void {
    if (key.length !== 1) return;
    const now = Date.now();
    this.typeahead = now - this.typeaheadAt > 700 ? key : this.typeahead + key;
    this.typeaheadAt = now;
    const q = this.typeahead.toLowerCase();
    const start = this.active < 0 ? 0 : this.active;
    for (let k = 0; k < this.optionEls.length; k++) {
      const i = (start + k) % this.optionEls.length;
      if (this.cfg.options[i].label.toLowerCase().startsWith(q)) {
        this.setActive(i);
        return;
      }
    }
  }
}

// Themed via the shared --a2a-* custom properties (defined by each host: the
// widget shadow root and the side panel), so one stylesheet serves both the
// shadow DOM and the panel's manual dark mode. Class names are scoped under
// `.sel`; include this once in the host's stylesheet.
export const SELECT_STYLE = `
  .sel { position: relative; }
  .sel-trigger {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    width: 100%; height: 34px; padding: 0 10px;
    font: inherit; font-size: 13px; line-height: 1; text-align: left;
    border: 1px solid var(--a2a-border); border-radius: 8px;
    background: var(--a2a-surface); color: var(--a2a-text); cursor: pointer;
  }
  .sel-trigger:hover { border-color: var(--a2a-border-hover); }
  .sel-trigger:focus-visible { outline: 2px solid var(--a2a-solid); outline-offset: 1px; }
  .sel-value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sel-chevron { display: inline-flex; color: var(--a2a-muted); transition: transform .15s ease; }
  .sel-trigger[aria-expanded="true"] .sel-chevron { transform: rotate(180deg); }
  .sel-listbox {
    position: absolute; z-index: 2147483647; left: 0; right: 0; top: calc(100% + 4px);
    max-height: 220px; overflow-y: auto; padding: 4px;
    border: 1px solid var(--a2a-border); border-radius: 10px; background: var(--a2a-surface);
    box-shadow: 0 10px 30px var(--a2a-shadow); outline: none;
  }
  .sel-opt {
    display: flex; align-items: center; gap: 6px;
    padding: 7px 8px 7px 6px; border-radius: 6px;
    font-size: 13px; color: var(--a2a-text); cursor: pointer; user-select: none;
  }
  .sel-opt.active { background: var(--a2a-hover); }
  .sel-check { display: inline-flex; width: 16px; flex: none; opacity: 0; color: var(--a2a-solid); }
  .sel-opt[aria-selected="true"] .sel-check { opacity: 1; }
`;
