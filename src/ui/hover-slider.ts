// A YouTube-style compact control: a small trigger (an icon or a value caption)
// that pops a vertical {@link Slider} DOWN as a floating rail on hover /
// focus-within. Used for the volume and speed controls so the transport bar
// stays tight until the user reaches for them. The rail is absolutely positioned
// so it overlays content instead of reflowing the bar, and stays open while the
// thumb is focused (dragging focuses it) so a drag that leaves the trigger's box
// doesn't collapse it mid-gesture. Themed via the shared --a2a-* custom
// properties; include {@link HOVER_SLIDER_STYLE} in the host's stylesheet once.

import { Slider, type SliderConfig } from './slider';

export interface HoverSliderConfig extends Omit<SliderConfig, 'compact' | 'orientation'> {
  /** Inner markup for the compact trigger (icon glyph or value caption). */
  triggerHtml: string;
  triggerAriaLabel: string;
  /** Invoked when the trigger itself is activated (e.g. mute toggle). When
   *  omitted, activating the trigger pins the rail open (touch/click affordance). */
  onTrigger?: () => void;
  /** Popped-down rail height in px. Default 104. */
  railHeight?: number;
}

export class HoverSlider {
  readonly el: HTMLDivElement;
  readonly slider: Slider;
  private trigger: HTMLButtonElement;

  constructor(cfg: HoverSliderConfig) {
    this.el = document.createElement('div');
    this.el.className = 'hsl';
    this.el.style.setProperty('--hsl-h', `${cfg.railHeight ?? 104}px`);

    this.trigger = document.createElement('button');
    this.trigger.type = 'button';
    this.trigger.className = 'hsl-trigger';
    this.trigger.setAttribute('aria-label', cfg.triggerAriaLabel);
    this.trigger.innerHTML = cfg.triggerHtml;
    // On a pointer that can hover (mouse), the rail reveals on :hover and a
    // trigger click runs the primary action (e.g. mute). On a hover-less pointer
    // (touch) there is no hover to reveal the rail, so a tap must pin it open
    // instead — otherwise the slider would be unreachable. `:focus-within` keeps
    // keyboard users covered on both.
    const noHover = window.matchMedia?.('(hover: none)').matches ?? false;
    this.trigger.addEventListener('click', () => {
      if (cfg.onTrigger && !noHover) cfg.onTrigger();
      else if (noHover) this.el.classList.toggle('open');
    });

    const rail = document.createElement('div');
    rail.className = 'hsl-rail';
    this.slider = new Slider({ ...cfg, compact: true, orientation: 'vertical' });
    rail.append(this.slider.el);

    this.el.append(this.trigger, rail);
  }

  /** Reflect an externally-set value (no callbacks fired). */
  setValue(v: number): void {
    this.slider.setValue(v);
  }

  /** Replace the trigger glyph/caption (e.g. speaker level or speed readout). */
  setTrigger(html: string): void {
    this.trigger.innerHTML = html;
  }

  setTriggerLabel(label: string): void {
    this.trigger.setAttribute('aria-label', label);
  }
}

// Themed via the shared --a2a-* custom properties defined by each host.
export const HOVER_SLIDER_STYLE = `
  .hsl { position: relative; display: inline-flex; align-items: center; }
  .hsl-trigger {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 30px; height: 30px; padding: 0 6px; flex: none;
    font: inherit; font-size: 12px; font-variant-numeric: tabular-nums;
    border: none; border-radius: 8px; background: transparent; color: var(--a2a-muted); cursor: pointer;
  }
  .hsl-trigger:hover { color: var(--a2a-text); background: var(--a2a-hover); }
  .hsl-trigger:focus-visible { outline: 2px solid var(--a2a-solid); outline-offset: 1px; }
  /* Floating rail that pops straight down from the trigger, centred on it. */
  .hsl-rail {
    position: absolute; z-index: 2147483646; top: 100%; left: 50%;
    display: flex; justify-content: center;
    padding: 12px 7px; box-sizing: border-box;
    border: 1px solid var(--a2a-border); border-radius: 10px;
    background: var(--a2a-surface); box-shadow: 0 10px 30px var(--a2a-shadow);
    opacity: 0; visibility: hidden; pointer-events: none;
    transform: translateX(-50%) translateY(-4px);
    transition: opacity .15s ease, transform .15s ease, visibility .15s;
  }
  .hsl:hover .hsl-rail,
  .hsl:focus-within .hsl-rail,
  .hsl.open .hsl-rail {
    opacity: 1; visibility: visible; pointer-events: auto;
    transform: translateX(-50%) translateY(0);
  }
  .hsl-rail .sld--vertical { height: var(--hsl-h, 104px); }
`;
