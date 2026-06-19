// A dependency-free slider styled after shadcn/ui (Radix) Slider: a thin track
// with a filled range, a draggable thumb, and tick "notches" on the track.
// Value <-> position mapping is supplied by the caller so the scale can be
// non-linear — the speed control uses a log (exponential) scale so each octave
// (0.5→1→2→4) gets equal travel and the common 1–2× band is easy to land on.
// Supports horizontal (default) and vertical orientation; the vertical form
// powers the YouTube-style pop-down controls (see hover-slider.ts), where up =
// more. Lives entirely inside the host shadow root; include {@link SLIDER_STYLE}
// in that root's stylesheet once.

export type SliderOrientation = 'horizontal' | 'vertical';

export interface SliderNotch {
  value: number;
  /** Optional caption rendered under the tick (horizontal only). */
  label?: string;
}

export interface SliderConfig {
  min: number;
  max: number;
  value: number;
  /** Map a value to its track fraction in [0, 1]. */
  toFraction: (value: number) => number;
  /** Map a track fraction in [0, 1] back to a value. */
  toValue: (fraction: number) => number;
  notches: SliderNotch[];
  /** Render a value for the thumb tooltip / aria-valuetext. */
  format: (value: number) => string;
  /** Fired continuously while dragging or on each keystroke. */
  onInput: (value: number) => void;
  /** Fired once the value is committed (pointer release / key up). */
  onChange: (value: number) => void;
  ariaLabel: string;
  /** Keyboard/precision step in value space. */
  step: number;
  /** Drop tick labels and bottom label gutter (for tight/inline use). */
  compact?: boolean;
  /** Track direction. Vertical runs bottom→top (bottom = min). Default horizontal. */
  orientation?: SliderOrientation;
}

export class Slider {
  readonly el: HTMLDivElement;
  private track: HTMLDivElement;
  private range: HTMLDivElement;
  private thumb: HTMLButtonElement;
  private value: number;
  private dragging = false;
  private readonly vertical: boolean;

  constructor(private cfg: SliderConfig) {
    this.value = clamp(cfg.value, cfg.min, cfg.max);
    this.vertical = cfg.orientation === 'vertical';

    this.el = document.createElement('div');
    this.el.className = ['sld', cfg.compact ? 'sld--compact' : '', this.vertical ? 'sld--vertical' : '']
      .filter(Boolean)
      .join(' ');

    this.track = document.createElement('div');
    this.track.className = 'sld-track';
    this.range = document.createElement('div');
    this.range.className = 'sld-range';
    this.track.append(this.range);

    for (const n of cfg.notches) {
      const tick = document.createElement('span');
      tick.className = 'sld-tick';
      this.placeAlong(tick, cfg.toFraction(n.value));
      this.track.append(tick);
      // Captions only make sense on the horizontal axis with room to spare.
      if (n.label && !cfg.compact && !this.vertical) {
        const cap = document.createElement('span');
        cap.className = 'sld-tick-label';
        cap.style.left = `${cfg.toFraction(n.value) * 100}%`;
        cap.textContent = n.label;
        this.el.append(cap);
      }
    }

    this.thumb = document.createElement('button');
    this.thumb.type = 'button';
    this.thumb.className = 'sld-thumb';
    this.thumb.setAttribute('role', 'slider');
    this.thumb.setAttribute('aria-label', cfg.ariaLabel);
    this.thumb.setAttribute('aria-orientation', this.vertical ? 'vertical' : 'horizontal');
    this.thumb.setAttribute('aria-valuemin', String(cfg.min));
    this.thumb.setAttribute('aria-valuemax', String(cfg.max));
    this.track.append(this.thumb);

    this.el.append(this.track);

    this.el.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.el.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.el.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.thumb.addEventListener('keydown', (e) => this.onKey(e));

    this.render();
  }

  /** Set the value programmatically (no callbacks fired). */
  setValue(value: number): void {
    this.value = clamp(value, this.cfg.min, this.cfg.max);
    this.render();
  }

  // Position an element (tick or thumb) at a fraction along the active axis.
  private placeAlong(el: HTMLElement, f: number): void {
    if (this.vertical) el.style.bottom = `${f * 100}%`;
    else el.style.left = `${f * 100}%`;
  }

  private render(): void {
    const f = clamp(this.cfg.toFraction(this.value), 0, 1);
    if (this.vertical) this.range.style.height = `${f * 100}%`;
    else this.range.style.width = `${f * 100}%`;
    this.placeAlong(this.thumb, f);
    this.thumb.setAttribute('aria-valuenow', String(round(this.value, 2)));
    this.thumb.setAttribute('aria-valuetext', this.cfg.format(this.value));
  }

  private valueFromEvent(e: PointerEvent): number {
    const rect = this.track.getBoundingClientRect();
    const f = this.vertical
      ? clamp((rect.bottom - e.clientY) / rect.height, 0, 1)
      : clamp((e.clientX - rect.left) / rect.width, 0, 1);
    return this.snap(this.cfg.toValue(f));
  }

  private snap(v: number): number {
    const stepped = Math.round(v / this.cfg.step) * this.cfg.step;
    return clamp(round(stepped, 4), this.cfg.min, this.cfg.max);
  }

  private onPointerDown(e: PointerEvent): void {
    e.preventDefault();
    this.dragging = true;
    this.el.setPointerCapture(e.pointerId);
    this.thumb.focus({ preventScroll: true });
    this.update(this.valueFromEvent(e), false);
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.dragging) return;
    this.update(this.valueFromEvent(e), false);
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.el.releasePointerCapture(e.pointerId);
    this.update(this.value, true);
  }

  private onKey(e: KeyboardEvent): void {
    const { step, min, max } = this.cfg;
    let next: number | null = null;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowUp': next = this.value + step; break;
      case 'ArrowLeft':
      case 'ArrowDown': next = this.value - step; break;
      case 'PageUp': next = this.value + step * 4; break;
      case 'PageDown': next = this.value - step * 4; break;
      case 'Home': next = min; break;
      case 'End': next = max; break;
      default: return;
    }
    e.preventDefault();
    this.update(clamp(round(next, 4), min, max), true);
  }

  private update(value: number, commit: boolean): void {
    const changed = value !== this.value;
    this.value = value;
    this.render();
    if (changed) this.cfg.onInput(value);
    if (commit) this.cfg.onChange(value);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

function round(v: number, dp: number): number {
  const m = 10 ** dp;
  return Math.round(v * m) / m;
}

// Themed via the shared --a2a-* custom properties defined by each host.
export const SLIDER_STYLE = `
  .sld { position: relative; padding: 6px 0 18px; touch-action: none; }
  .sld--compact { padding: 8px 0; width: 100%; }
  .sld-track {
    position: relative; height: 4px; border-radius: 999px; background: var(--a2a-track); cursor: pointer;
  }
  .sld-range { position: absolute; left: 0; top: 0; height: 100%; border-radius: 999px; background: var(--a2a-solid); }
  .sld-tick {
    position: absolute; top: 50%; width: 2px; height: 8px; margin-left: -1px;
    transform: translateY(-50%); border-radius: 1px; background: var(--a2a-tick); pointer-events: none;
  }
  .sld-tick-label {
    position: absolute; bottom: 0; transform: translateX(-50%);
    font-size: 10px; color: var(--a2a-muted); white-space: nowrap; pointer-events: none;
  }
  .sld-thumb {
    position: absolute; top: 50%; left: 0; width: 15px; height: 15px; margin: 0; padding: 0;
    transform: translate(-50%, -50%); border-radius: 999px;
    background: var(--a2a-surface); border: 2px solid var(--a2a-solid); cursor: grab; box-shadow: 0 1px 2px rgba(0,0,0,.2);
  }
  .sld-thumb:active { cursor: grabbing; }
  .sld-thumb:focus-visible { outline: 2px solid var(--a2a-solid); outline-offset: 2px; }

  /* Vertical: runs bottom→top, full container height, thumb centred horizontally.
     The element is the pointer target, so give it a generous width (the 4px track
     stays centred) — a 4px-wide hit column is near-impossible to grab or drag. */
  .sld--vertical { padding: 0; width: 28px; height: 100%; display: flex; justify-content: center; touch-action: none; }
  .sld--vertical .sld-track { width: 4px; height: 100%; }
  .sld--vertical .sld-range { top: auto; bottom: 0; left: 0; width: 100%; height: 0; }
  .sld--vertical .sld-tick {
    top: auto; left: 50%; width: 8px; height: 2px; margin-left: 0; margin-bottom: -1px;
    transform: translateX(-50%);
  }
  .sld--vertical .sld-thumb { top: auto; left: 50%; transform: translate(-50%, 50%); }
`;
