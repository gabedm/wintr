import { act, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { expect } from 'vitest';
import { MenuSheet } from '../../src/client/App.js';

/** Exercise the actual secondary disclosure, rather than assuming hidden copy is visible. */
export async function expandedMenu(props: ComponentProps<typeof MenuSheet>): Promise<string> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<MenuSheet {...props} />));
    const toggle = host.querySelector<HTMLButtonElement>('.privacy-toggle')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('#session-privacy')).toBeNull();
    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const html = host.innerHTML;
    await act(async () => toggle.click());
    expect(host.querySelector('#session-privacy')).toBeNull();
    return html;
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
}
