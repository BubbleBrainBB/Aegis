/**
 * The script the project server puts first in every page's <head>. It talks
 * to the Aegis window around the preview (window.parent) with postMessage:
 * - out: the page loaded, and every error it hit (script errors, rejected
 *   promises, console.error, files that failed to load), so the preview can
 *   show them and design_ready can report them;
 * - in: reload.
 * Messages carry source "aegis-design-host" (out) / "aegis-design-parent"
 * (in). The page's own code runs as written; nothing here changes it.
 */
export const DESIGN_HOST_SOURCE = "aegis-design-host";
export const DESIGN_PARENT_SOURCE = "aegis-design-parent";

export const DESIGN_HOST_SCRIPT = `(() => {
  if (window.__aegisHost) return;
  const errors = [];
  window.__aegisHost = { errors };
  const inFrame = window.parent !== window;
  const post = (message) => {
    if (!inFrame) return;
    try { window.parent.postMessage(Object.assign({ source: ${JSON.stringify(DESIGN_HOST_SOURCE)} }, message), "*"); } catch (e) {}
  };
  const text = (value) => {
    if (value instanceof Error) return value.message;
    try { return typeof value === "string" ? value : JSON.stringify(value); } catch (e) { return String(value); }
  };
  const record = (message) => {
    message = String(message).slice(0, 2000);
    if (errors.length && errors[errors.length - 1] === message) return;
    errors.push(message);
    if (errors.length > 50) errors.shift();
    post({ type: "error", text: message });
  };
  window.addEventListener("error", (event) => {
    const target = event.target;
    if (target && target !== window && (target.src || target.href)) {
      record("Failed to load " + (target.src || target.href).split("/").slice(-1)[0]);
      return;
    }
    const where = event.filename ? " (" + event.filename.split("/").slice(-1)[0] + ":" + event.lineno + ")" : "";
    record((event.message || "Script error") + where);
  }, true);
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    record("Unhandled promise rejection: " + text(reason && reason.message ? reason.message : reason));
  });
  const consoleError = console.error;
  console.error = function () {
    record(Array.prototype.map.call(arguments, text).join(" "));
    return consoleError.apply(this, arguments);
  };
  window.addEventListener("load", () => post({ type: "loaded", title: document.title, path: location.pathname }));
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (!data || data.source !== ${JSON.stringify(DESIGN_PARENT_SOURCE)}) return;
    if (data.type === "reload") location.reload();
  });
})();`;
