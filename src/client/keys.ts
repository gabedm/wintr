export interface SubmitKeyEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly isComposing: boolean;
  readonly keyCode: number;
}

/** Enter submits, except Shift+Enter and any IME composition confirmation (keyCode 229 covers older engines). */
export const isSubmitKey = (e: SubmitKeyEvent): boolean =>
  e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229;

export interface SendDismissInput {
  /** The send was actually accepted (valid input, not already working). */
  readonly sent: boolean;
  /** An IME composition is active. */
  readonly composing: boolean;
  readonly via: 'button' | 'enter';
  /** PointerEvent.pointerType of the click, when the browser reports one. */
  readonly pointerType?: string | undefined;
  /** Primary input is coarse and cannot hover (a phone or tablet without a pointer). */
  readonly coarsePrimary: boolean;
}

/**
 * Whether a successful Send should dismiss the on-screen keyboard. Only a touch
 * Send does: a touch-pointer click, or Enter on a coarse-primary, hover-less
 * device. Mouse, pen, keyboard-activated clicks and desktop Enter keep focus,
 * and nothing is dismissed while composing or when the send was not accepted.
 */
export const shouldDismissKeyboard = (i: SendDismissInput): boolean => {
  if (!i.sent || i.composing) return false;
  if (i.via === 'enter') return i.coarsePrimary;
  return i.pointerType === 'touch' || (i.pointerType === undefined && i.coarsePrimary);
};
