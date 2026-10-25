import type { Session, WebContents } from 'electron';

/**
 * Sandboxed srcdoc frames (design boards, thumbnails, HTML previews) stay
 * put: their own script setting `location`, a form or a link must not take
 * the frame, and whatever it holds, to another address. Their CSP has no say
 * over navigation, and sandbox="allow-scripts" only stops the top window.
 */
export function guardSandboxFrameNavigation(contents: WebContents): void {
  contents.on('will-frame-navigate', (details) => {
    if (details.isMainFrame) return;
    const current = details.frame?.url ?? '';
    if (current.startsWith('about:srcdoc') && !/^about:(?:blank|srcdoc)\b/.test(details.url)) {
      details.preventDefault();
    }
  });
}

/**
 * The same rule at the network layer, in case a navigation slips past the
 * frame event: a request to load a frame, made from inside a srcdoc frame,
 * to anything but about:, data: or blob: is cancelled. Only frame loads:
 * other requests are each frame's own CSP's business.
 */
export function guardSandboxFrameRequests(session: Session): void {
  session.webRequest.onBeforeRequest({ urls: ['*://*/*'], types: ['subFrame'] }, (details, done) => {
    const from = details.frame?.url ?? '';
    done({ cancel: from.startsWith('about:srcdoc') });
  });
}
