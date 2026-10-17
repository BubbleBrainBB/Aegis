import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

/**
 * True while an input method (Chinese/Japanese/Korean IME) owns the key.
 * Enter during composition commits the candidate text into the field; it
 * must not also run the field's Enter action. Chromium reports these
 * keydowns with isComposing set and the legacy keyCode 229.
 */
export function isImeComposing(event: ReactKeyboardEvent | KeyboardEvent): boolean {
  const native = 'nativeEvent' in event ? event.nativeEvent : event;
  return native.isComposing || native.keyCode === 229;
}
