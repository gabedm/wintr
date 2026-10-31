// Focus hand-off after an explicit action removes the control that held focus. Pure decisions only: the page
// arms a hand-off at the gesture and takes it in the commit that removed the trigger. Restoration, remote
// progress and automatic refresh never arm one, and a control the listener chose meanwhile is never taken over.

export interface ActiveLike {
  readonly isConnected: boolean;
  readonly disabled?: boolean;
}

/** Focus is stranded when nothing holds it (the page itself), or what held it is gone or disabled. */
export const focusStranded = (active: ActiveLike | null, body: unknown): boolean => active === null || active === body || !active.isConnected || active.disabled === true;

export const browserFocusStranded = (): boolean => typeof document === 'undefined' || focusStranded(document.activeElement as ActiveLike | null, document.body);

export class FocusHandoff {
  private armed = false;

  /** At an explicit action's gesture. */
  arm(): void {
    this.armed = true;
  }

  /** The action was refused, failed or superseded. */
  cancel(): void {
    this.armed = false;
  }

  get pending(): boolean {
    return this.armed;
  }

  /** Ends the hand-off. True (once) only if it was armed and focus is stranded now. */
  take(stranded: boolean): boolean {
    const wanted = this.armed && stranded;
    this.armed = false;
    return wanted;
  }
}
