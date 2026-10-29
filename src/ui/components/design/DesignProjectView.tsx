import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, ArrowLeft, ExternalLink, FileText, FolderOpen, RefreshCw } from "../icons";
import { useAppStore } from "../../store/useAppStore";
import { useDesignStore } from "../../store/useDesignStore";
import { rendererStateStorage } from "../../utils/renderer-state-storage";
import type { DesignDocument } from "../../../shared/design-types";

/** Messages from the host script the project server puts in every page. */
const HOST_SOURCE = "aegis-design-host";

type Props = {
  sessionId: string;
  documentId: string;
  chrome?: "pane" | "section";
  toolbarHost?: HTMLElement | null;
  canvasOverlay?: (stage: RefObject<HTMLDivElement | null>) => ReactNode;
};

const isPage = (path: string) => /\.html?$/i.test(path);
const isTopLevel = (path: string) => !path.includes("/");
const leaf = (path: string) => path.split("/").pop() ?? path;

/**
 * A design project: its pages and files on the left, the page itself,
 * live, in the middle. The agent writes the files; every change on disk
 * reloads the page, and design_show / design_ready switch to the page the
 * agent is delivering.
 */
export function DesignProjectView({ sessionId, documentId, chrome = "pane", toolbarHost, canvasOverlay }: Props) {
  const overlayStage = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [doc, setDoc] = useState<DesignDocument | null>(null);
  const [files, setFiles] = useState<{ path: string; size: number }[] | null>(null);
  const pathKey = "aegis.design.projectPage:" + documentId;
  const [path, setPath] = useState<string>(() => rendererStateStorage.getItem(pathKey) ?? "");
  const [url, setUrl] = useState("");
  const [load, setLoad] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const [errorsOpen, setErrorsOpen] = useState(false);
  const [failure, setFailure] = useState("");

  const pages = useMemo(() => (files ?? []).filter((f) => isPage(f.path) && isTopLevel(f.path)).map((f) => f.path), [files]);
  const current = path && files?.some((f) => f.path === path) ? path : pages[0] ?? "";

  const refresh = useCallback(async () => {
    try {
      const [d, list] = await Promise.all([
        window.electron.design.read({ sessionId, documentId }),
        window.electron.design.projectFiles({ sessionId, documentId }),
      ]);
      setDoc(d);
      setFiles(list);
      setFailure("");
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    }
  }, [sessionId, documentId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The page's URL on the project's local server.
  useEffect(() => {
    if (!current) {
      setUrl("");
      return;
    }
    let live = true;
    window.electron.design
      .projectPage({ sessionId, documentId, path: current })
      .then((r) => live && setUrl(r.url))
      .catch((error) => live && setFailure(error instanceof Error ? error.message : String(error)));
    return () => {
      live = false;
    };
  }, [sessionId, documentId, current]);

  const reload = useCallback(() => {
    setErrors([]);
    setLoad((n) => n + 1);
  }, []);

  // Files changing on disk: refresh the list and reload the page, once per burst.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = window.electron.design.onChanged((raw) => {
      const event = raw as { documentId?: string; scope?: string; deleted?: boolean };
      if (event.documentId !== documentId || event.deleted) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void refresh();
        if (event.scope === "files") reload();
      }, 200);
    });
    return () => {
      if (timer) clearTimeout(timer);
      off();
    };
  }, [documentId, refresh, reload]);

  // The agent showed a page: switch to it.
  useEffect(
    () =>
      window.electron.design.onShow((event) => {
        if (event.documentId !== documentId) return;
        setPath(event.path);
        rendererStateStorage.setItem(pathKey, event.path);
        void refresh();
        reload();
      }),
    [documentId, pathKey, refresh, reload],
  );

  // What the agent hears about: this project and the page on screen.
  useEffect(() => {
    void window.electron.design.focus({ sessionId, documentId, path: current || undefined });
  }, [sessionId, documentId, current]);
  useEffect(() => () => void window.electron.design.focus({ sessionId, documentId, open: false }), [sessionId, documentId]);

  // Errors the page reports, from this page's frame only.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as { source?: string; type?: string; text?: string } | null;
      if (!data || data.source !== HOST_SOURCE) return;
      if (data.type === "error" && typeof data.text === "string") {
        const text = data.text;
        setErrors((list) => (list.includes(text) ? list : [...list, text].slice(-30)));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const choose = (next: string) => {
    setPath(next);
    rendererStateStorage.setItem(pathKey, next);
    setErrors([]);
  };

  const otherFiles = (files ?? []).filter((f) => !(isPage(f.path) && isTopLevel(f.path)));
  const src = url ? `${url}${url.includes("?") ? "&" : "?"}aegis-load=${load}` : "";

  const toolbar = (
    <header className="design-toolbar">
      {(chrome === "pane" || chrome === "section") && (
        <button
          className="design-icon-button design-back-button"
          title="All designs"
          aria-label="All designs"
          onClick={() =>
            chrome === "section"
              ? useDesignStore.getState().setSection(null)
              : useAppStore.getState().setActiveRightUtilityTab("design")
          }
        >
          <ArrowLeft size={15} />
        </button>
      )}
      <span className="design-title" title={doc?.folder}>
        {doc?.title ?? "Design"}
      </span>
      {current && <span className="design-project-current">{current}</span>}
      <span className="design-spacer" />
      {errors.length > 0 && (
        <button
          className="design-project-errors-button"
          aria-expanded={errorsOpen}
          onClick={() => setErrorsOpen((open) => !open)}
          title="Errors this page reported"
        >
          <AlertTriangle size={14} />
          {errors.length === 1 ? "1 error" : `${errors.length} errors`}
        </button>
      )}
      <button className="design-icon-button" title="Reload" aria-label="Reload" disabled={!current} onClick={reload}>
        <RefreshCw size={15} />
      </button>
      <button
        className="design-icon-button"
        title="Open in browser"
        aria-label="Open in browser"
        disabled={!url}
        onClick={() => url && window.electron.openExternalUrl(url)}
      >
        <ExternalLink size={15} />
      </button>
      <button
        className="design-icon-button"
        title="Show folder"
        aria-label="Show folder"
        onClick={() => void window.electron.design.revealProject({ sessionId, documentId })}
      >
        <FolderOpen size={15} />
      </button>
    </header>
  );

  return (
    <>
      <section className="design-panel design-project" aria-label={doc ? `Design project ${doc.title}` : "Design project"} data-design-project={documentId}>
        {toolbarHost ? createPortal(<div className="design-panel design-panel--titlebar">{toolbar}</div>, toolbarHost) : toolbar}
        {failure && (
          <div className="design-error" role="alert">
            {failure}
            <button onClick={() => void refresh()}>Refresh</button>
          </div>
        )}
        <div className="design-project-body">
          <nav className="design-project-files" aria-label="Project files">
            <h3>Pages</h3>
            {pages.length ? (
              <ul>
                {pages.map((p) => (
                  <li key={p}>
                    <button className={p === current ? "is-active" : ""} aria-current={p === current ? "page" : undefined} onClick={() => choose(p)}>
                      <FileText size={14} />
                      <span>{p.replace(/\.html?$/i, "")}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="design-project-empty-note">{files === null ? "Loading…" : "No pages yet."}</p>
            )}
            {otherFiles.length > 0 && (
              <>
                <h3>Files</h3>
                <ul className="design-project-file-list">
                  {otherFiles.map((f) => (
                    <li key={f.path} title={f.path}>
                      <span>{f.path.includes("/") ? `${f.path.slice(0, f.path.lastIndexOf("/") + 1)}${leaf(f.path)}` : f.path}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </nav>
          <div className="design-project-stage">
            {src ? (
              <iframe
                key={current}
                ref={frame}
                className="design-project-frame"
                title={current}
                src={src}
                // Its own origin (the project's local server): it can keep localStorage, never reach the app.
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock"
              />
            ) : (
              <div className="design-project-placeholder">
                <h2>{files === null ? "Opening…" : "Nothing to show yet"}</h2>
                <p>The agent writes this design's files into its folder. Pages appear here as soon as they exist, and reload whenever they change.</p>
              </div>
            )}
            {errorsOpen && errors.length > 0 && (
              <div className="design-project-errors" role="region" aria-label="Page errors">
                <ul>
                  {errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </section>
      {canvasOverlay && (
        <div ref={overlayStage} className="design-canvas-overlay" style={{ right: 0 }}>
          {canvasOverlay(overlayStage)}
        </div>
      )}
    </>
  );
}
