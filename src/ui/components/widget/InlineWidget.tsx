import { memo, useContext, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  WIDGET_FRAME_URL,
  WIDGET_MESSAGE_SOURCE,
  type CodexVisualizationTheme,
  type WidgetFrameMessage,
  type WidgetHostMessage,
  type WidgetTheme,
} from '../../../shared/widget';
import { ImageStudioSessionContext } from '../../lib/image-studio';
import { useAppStore } from '../../store/useAppStore';
import { useWidgetStateStore } from '../../store/useWidgetStateStore';
import { openUrlInBrowserSession } from '../../utils/html-preview';

/** Tall widgets scroll inside this height so one chart can't swallow the chat. */
const MAX_HEIGHT_PX = 720;
const MAX_VIEWPORT_SHARE = 0.8;
const INITIAL_HEIGHT_PX = 96;
/** Widgets this far outside the viewport give up their frame (state is kept). */
const KEEP_ALIVE_MARGIN = '1500px 0px';

/** Last measured height per widget, so a remounted frame doesn't jump. */
const knownHeights = new Map<string, number>();

/** The app's theme as CSS variables (theme tokens live on <html>'s inline style). */
export function readWidgetTheme(): WidgetTheme {
  const root = document.documentElement;
  const variables: Record<string, string> = {};
  for (let index = 0; index < root.style.length; index += 1) {
    const name = root.style.item(index);
    if (name.startsWith('--')) variables[name] = root.style.getPropertyValue(name).trim();
  }
  return { variables, dark: root.classList.contains('dark') };
}

/** The chat scrolls in its own container; the keep-alive margin must apply there. */
function scrollParentOf(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') return node;
  }
  return null;
}

/**
 * Aegis's theme as the host style variables OpenAI's visualization runtime
 * reads (`--color-background-primary` …). Its own `--accent`, `--border` and
 * friends mean something else, so Aegis's names are never passed through.
 */
export function codexVisualizationTheme(theme: WidgetTheme): CodexVisualizationTheme {
  const v = theme.variables;
  const scale = Number.parseFloat(v['--ui-font-scale'] || '1') || 1;
  const mapped: Record<string, string | undefined> = {
    // Transparent like the chat around it; cards and popovers derive from the ink.
    '--color-background-primary': 'transparent',
    '--color-background-secondary': v['--popover-bg'] || v['--bg-secondary'],
    '--color-background-info': v['--accent-light'],
    '--color-text-primary': v['--text-primary'],
    '--color-text-secondary': v['--text-secondary'],
    '--color-text-info': v['--accent'],
    '--color-text-inverse': v['--accent-foreground'],
    '--color-text-warning': v['--error'],
    '--color-border-secondary': v['--border'],
    '--color-border-primary': v['--border'],
    '--color-ring-primary': v['--border-focus'],
    '--font-text-md-size': `${Math.round(14 * scale * 100) / 100}px`,
  };
  const styleVariables: Record<string, string> = {};
  for (const [name, value] of Object.entries(mapped)) if (value) styleVariables[name] = value;
  return { dark: theme.dark, styleVariables };
}

function maxHeight(): number {
  return Math.min(MAX_HEIGHT_PX, Math.max(240, Math.round(window.innerHeight * MAX_VIEWPORT_SHARE)));
}

function isFrameMessage(data: unknown): data is WidgetFrameMessage {
  return Boolean(data) && typeof data === 'object' && (data as { source?: unknown }).source === WIDGET_MESSAGE_SOURCE;
}

/**
 * A show_widget call, drawn inline in the conversation: a sandboxed frame
 * (scripts only, opaque origin) running the agent's HTML under the widget
 * shell's CSP, themed like the app and sized to its content.
 */
export const InlineWidget = memo(function InlineWidget({
  toolUseId,
  html,
  title,
  codexPath,
  draft = false,
}: {
  /** Keys the widget's saved state and height. */
  toolUseId: string;
  html?: string;
  title?: string;
  /** A Codex `visualize` reference: the fragment file to render in OpenAI's runtime. */
  codexPath?: string;
  /**
   * The call is still being written or not yet accepted: its markup is drawn
   * as it grows, scripts held back. Turning false runs it in the same frame.
   */
  draft?: boolean;
}) {
  const sessionId = useContext(ImageStudioSessionContext);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [nearViewport, setNearViewport] = useState(false);
  // Codex frames are prepared per mount (current theme and state baked in).
  const [codexFrame, setCodexFrame] = useState<{ url: string } | { error: string } | null>(null);
  const [contentHeight, setContentHeight] = useState(() => knownHeights.get(toolUseId) ?? INITIAL_HEIGHT_PX);
  const [limit, setLimit] = useState(maxHeight);
  const [error, setError] = useState<string | null>(null);
  // The frame answers `ready` once per load; the latest markup goes to it then
  // and on every change after, as a preview until the call is accepted.
  const content = useRef({ html, draft });
  content.current = { html, draft };
  const frameReady = useRef(false);
  const frameLive = useRef(false);

  // Frames far off screen are dropped; the placeholder keeps their height.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => setNearViewport(entry.isIntersecting),
      { root: scrollParentOf(element), rootMargin: KEEP_ALIVE_MARGIN }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!codexPath || !nearViewport) {
      setCodexFrame(null);
      return;
    }
    let cancelled = false;
    const session = sessionId ? useAppStore.getState().sessions[sessionId] : null;
    const roots = [session?.cwd, session?.projectCwd, session?.worktreePath, session?.associatedWorktreePath]
      .filter((root): root is string => typeof root === 'string' && root.length > 0);
    const theme = codexVisualizationTheme(readWidgetTheme());
    void window.electron
      .prepareCodexVisualization({
        path: codexPath,
        roots,
        styleVariables: theme.styleVariables,
        dark: theme.dark,
        state: useWidgetStateStore.getState().states[toolUseId]?.value ?? null,
        title,
      })
      .then((result) => {
        if (!cancelled) setCodexFrame(result.ok ? { url: result.url } : { error: result.message });
      })
      .catch((reason) => {
        if (!cancelled) setCodexFrame({ error: reason instanceof Error ? reason.message : String(reason) });
      });
    return () => {
      cancelled = true;
    };
  }, [codexPath, nearViewport, sessionId, title, toolUseId]);

  useEffect(() => {
    const onResize = () => setLimit(maxHeight());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // The bridge: render on `ready`, then answer the widget's requests.
  const post = (message: WidgetHostMessage) => frameRef.current?.contentWindow?.postMessage(message, '*');
  const sendContent = () => {
    if (!frameReady.current || frameLive.current || codexPath) return;
    const { html: markup = '', draft: isDraft } = content.current;
    if (isDraft) {
      post({ source: WIDGET_MESSAGE_SOURCE, type: 'preview', html: markup, theme: readWidgetTheme() });
      return;
    }
    frameLive.current = true;
    post({
      source: WIDGET_MESSAGE_SOURCE,
      type: 'render',
      html: markup,
      theme: readWidgetTheme(),
      state: useWidgetStateStore.getState().states[toolUseId]?.value ?? null,
    });
  };

  useEffect(() => {
    sendContent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, draft]);

  useEffect(() => {
    if (!nearViewport) return;
    const onMessage = (event: MessageEvent) => {
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
      const message = event.data;
      if (!isFrameMessage(message)) return;
      switch (message.type) {
        case 'ready':
          setError(null);
          // Codex frames carry their fragment, theme and state already.
          frameReady.current = true;
          frameLive.current = false;
          sendContent();
          break;
        case 'size': {
          const height = Math.round(Number(message.height) || 0);
          // A frame being torn down can measure 0; keep the last real height.
          if (height <= 0) break;
          knownHeights.set(toolUseId, height);
          setContentHeight(height);
          break;
        }
        case 'state':
          useWidgetStateStore.getState().save(toolUseId, message.state);
          break;
        case 'prompt':
          if (!sessionId || typeof message.text !== 'string' || !message.text.trim()) break;
          useAppStore.getState().requestChatInjection({
            sessionId,
            text: message.text,
            mode: 'replace',
            submit: true,
            source: 'widget',
          });
          break;
        case 'open-link': {
          if (!sessionId || typeof message.url !== 'string' || !/^https?:\/\//i.test(message.url)) break;
          useAppStore.getState().openRightUtilityTab('browser');
          void openUrlInBrowserSession({ sessionId, url: message.url }).catch((reason) =>
            toast.error(`Could not open the link: ${reason instanceof Error ? reason.message : String(reason)}`)
          );
          break;
        }
        case 'copy':
          if (typeof message.text !== 'string') break;
          void (window.electron.copyWidgetText?.(message.text) ?? navigator.clipboard.writeText(message.text)).then(
            () => toast.success('Copied'),
            () => toast.error('Could not copy')
          );
          break;
        case 'error':
          setError(typeof message.message === 'string' ? message.message : 'Widget error');
          break;
      }
    };
    window.addEventListener('message', onMessage);

    // Follow theme changes (variables and light/dark live on <html>).
    let frame = 0;
    const themeObserver = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() =>
        post(
          codexPath
            ? { source: WIDGET_MESSAGE_SOURCE, type: 'codex-theme', theme: codexVisualizationTheme(readWidgetTheme()) }
            : { source: WIDGET_MESSAGE_SOURCE, type: 'theme', theme: readWidgetTheme() }
        )
      );
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
    return () => {
      window.removeEventListener('message', onMessage);
      themeObserver.disconnect();
      cancelAnimationFrame(frame);
      // The frame goes with the viewport; a new one reports ready again.
      frameReady.current = false;
      frameLive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codexPath, nearViewport, sessionId, toolUseId]);

  const height = Math.min(contentHeight, limit);
  const frameSrc = codexPath ? (codexFrame && 'url' in codexFrame ? codexFrame.url : null) : WIDGET_FRAME_URL;
  const frameError = codexFrame && 'error' in codexFrame ? codexFrame.error : null;
  return (
    <div ref={containerRef} className="my-3 min-w-0" data-chat-widget={toolUseId}>
      <div style={{ height: frameError ? undefined : height }} className="relative w-full">
        {frameError ? (
          <div className="text-[12px] text-[var(--text-muted)]" role="status">
            Couldn’t show this visualization: {frameError}
          </div>
        ) : nearViewport && frameSrc ? (
          <iframe
            ref={frameRef}
            src={frameSrc}
            // Scripts only: an opaque origin with no access to the app, no
            // forms, popups or top-level navigation.
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            title={title || 'Interactive widget'}
            className="block h-full w-full border-0 bg-transparent"
            style={{ colorScheme: 'normal' }}
          />
        ) : null}
      </div>
      {error ? (
        <div className="mt-1 text-[12px] text-[var(--text-muted)]" role="status">
          Widget error: {error}
        </div>
      ) : null}
    </div>
  );
});
