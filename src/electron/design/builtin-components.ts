import type { DesignSystemPack } from "../../shared/design-system-pack";
import { expandDesignIcons } from "./icons";

/**
 * The components every built-in style's pack carries. They are styled only
 * through the pack's tokens, so each style restyles the same set:
 *
 *   --background --surface --raised --text --muted --line --accent --on-accent
 *   --success --warning --danger --font-display --font-body --font-mono
 *   --radius --radius-control --shadow
 *
 * Props given as attributes arrive as text: lists are comma-separated
 * ("Overview, Activity"), booleans "true"/"false". No prop starts with "on":
 * the sanitizer drops such attributes as event handlers.
 */

export const BUILTIN_COMPONENT_CSS = `
body{background:var(--background);color:var(--text);font-family:var(--font-body)}
.ds-button{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:1px solid transparent;border-radius:var(--radius-control);font:500 15px/1 var(--font-body);cursor:pointer;white-space:nowrap;text-decoration:none}
.ds-button--md{height:40px;padding:0 18px}
.ds-button--sm{height:32px;padding:0 12px;font-size:13px}
.ds-button--lg{height:48px;padding:0 24px;font-size:16px}
.ds-button--primary{background:var(--accent);color:var(--on-accent)}
.ds-button--secondary{background:transparent;color:var(--text);border-color:var(--line)}
.ds-button--ghost{background:transparent;color:var(--text)}
.ds-button--danger{background:var(--danger);color:#fff}
.ds-button svg{flex:none}
.ds-icon-button{display:inline-grid;place-items:center;flex:none;border:1px solid transparent;border-radius:var(--radius-control);background:transparent;color:var(--text);cursor:pointer;padding:0}
.ds-icon-button--sm{width:32px;height:32px}
.ds-icon-button--md{width:40px;height:40px}
.ds-icon-button--lg{width:48px;height:48px}
.ds-icon-button--secondary{border-color:var(--line);background:var(--surface)}
.ds-icon-button--primary{background:var(--accent);color:var(--on-accent)}
.ds-card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:20px;display:flex;flex-direction:column;gap:10px;color:var(--text)}
.ds-card__title{margin:0;font:600 17px/1.3 var(--font-display)}
.ds-card__subtitle{margin:-4px 0 0;font:14px/1.45 var(--font-body);color:var(--muted)}
.ds-tag{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 10px;border-radius:999px;font:500 12px/1 var(--font-body);background:color-mix(in oklch, var(--text) 8%, transparent);color:var(--text);white-space:nowrap}
.ds-tag--accent{background:color-mix(in oklch, var(--accent) 16%, transparent);color:var(--accent)}
.ds-tag--success{background:color-mix(in oklch, var(--success) 16%, transparent);color:var(--success)}
.ds-tag--warning{background:color-mix(in oklch, var(--warning) 18%, transparent);color:var(--warning)}
.ds-tag--danger{background:color-mix(in oklch, var(--danger) 16%, transparent);color:var(--danger)}
.ds-field{display:flex;flex-direction:column;gap:6px;font:500 13px/1.3 var(--font-body);color:var(--text)}
.ds-field__hint{font-weight:400;color:var(--muted)}
.ds-input{height:40px;padding:0 12px;border:1px solid var(--line);border-radius:var(--radius-control);background:var(--surface);color:var(--text);font:15px var(--font-body);width:100%}
textarea.ds-input{height:auto;min-height:96px;padding:10px 12px;line-height:1.5;resize:vertical;border-radius:min(var(--radius-control), 12px)}
.ds-select{position:relative;display:block}
.ds-select select{appearance:none;padding-right:36px;cursor:pointer}
.ds-select svg{position:absolute;right:12px;top:50%;transform:translateY(-50%);pointer-events:none;color:var(--muted)}
.ds-toggle{display:inline-flex;align-items:center;gap:10px;font:15px/1.3 var(--font-body);color:var(--text);cursor:pointer;user-select:none}
.ds-toggle__track{position:relative;width:40px;height:24px;border-radius:999px;background:color-mix(in oklch, var(--text) 18%, transparent);transition:background .15s;flex:none}
.ds-toggle__track::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform .15s}
.ds-toggle.is-on .ds-toggle__track{background:var(--accent)}
.ds-toggle.is-on .ds-toggle__track::after{transform:translateX(16px)}
.ds-check{display:inline-flex;align-items:center;gap:10px;font:15px/1.3 var(--font-body);color:var(--text);cursor:pointer;user-select:none}
.ds-check__box{display:grid;place-items:center;width:20px;height:20px;border:1.5px solid var(--line);border-radius:calc(var(--radius-control) / 3);background:var(--surface);color:transparent;flex:none}
.ds-check.is-on .ds-check__box{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.ds-tabs{display:flex;flex-direction:column;gap:16px}
.ds-tabs__list{display:flex;gap:24px;border-bottom:1px solid var(--line)}
.ds-tabs__tab{position:relative;padding:10px 0 12px;border:0;background:none;font:500 14px/1 var(--font-body);color:var(--muted);cursor:pointer}
.ds-tabs__tab.is-active{color:var(--text)}
.ds-tabs__tab.is-active::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:2px;background:var(--accent)}
.ds-segmented{display:inline-flex;padding:3px;gap:2px;border-radius:calc(var(--radius-control) + 3px);background:color-mix(in oklch, var(--text) 7%, transparent)}
.ds-segmented__item{height:30px;padding:0 14px;border:0;border-radius:var(--radius-control);background:transparent;font:500 13px/1 var(--font-body);color:var(--muted);cursor:pointer}
.ds-segmented__item.is-active{background:var(--surface);color:var(--text);box-shadow:0 1px 2px rgba(0,0,0,.08)}
.ds-avatar{display:inline-grid;place-items:center;flex:none;border-radius:50%;overflow:hidden;background:color-mix(in oklch, var(--accent) 20%, var(--surface));color:var(--accent);font:600 14px/1 var(--font-body);letter-spacing:.02em}
.ds-avatar--sm{width:28px;height:28px;font-size:11px}
.ds-avatar--md{width:40px;height:40px}
.ds-avatar--lg{width:56px;height:56px;font-size:19px}
.ds-avatar img{width:100%;height:100%;object-fit:cover}
.ds-stat{display:flex;flex-direction:column;gap:6px}
.ds-stat__label{font:500 13px/1.3 var(--font-body);color:var(--muted)}
.ds-stat__value{font:600 32px/1.1 var(--font-display);color:var(--text);font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.ds-stat__delta{font:500 13px/1.3 var(--font-body);font-variant-numeric:tabular-nums}
.ds-stat__delta--up{color:var(--success)}
.ds-stat__delta--down{color:var(--danger)}
.ds-stat__delta--flat{color:var(--muted)}
.ds-list-item{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--line);color:var(--text)}
.ds-list-item__body{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.ds-list-item__title{font:500 15px/1.35 var(--font-body);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ds-list-item__subtitle{font:13px/1.4 var(--font-body);color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ds-list-item__meta{font:13px/1 var(--font-body);color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
.ds-navbar{display:flex;align-items:center;gap:32px;height:64px;padding:0 32px;border-bottom:1px solid var(--line);background:var(--background);color:var(--text)}
.ds-navbar__brand{font:600 17px/1 var(--font-display);white-space:nowrap}
.ds-navbar__links{display:flex;gap:24px;flex:1}
.ds-navbar__link{font:500 14px/1 var(--font-body);color:var(--muted);text-decoration:none;cursor:pointer}
.ds-navbar__link.is-active{color:var(--text)}
.ds-navbar__actions{display:flex;align-items:center;gap:10px}
.ds-alert{display:flex;gap:12px;padding:14px 16px;border-radius:var(--radius);border:1px solid color-mix(in oklch, var(--tone) 30%, transparent);background:color-mix(in oklch, var(--tone) 9%, var(--surface));color:var(--text)}
.ds-alert>svg{color:var(--tone);flex:none;margin-top:1px}
.ds-alert__title{font:600 14px/1.4 var(--font-body)}
.ds-alert__body{font:14px/1.5 var(--font-body);color:var(--muted)}
.ds-alert--info{--tone:var(--accent)}
.ds-alert--success{--tone:var(--success)}
.ds-alert--warning{--tone:var(--warning)}
.ds-alert--danger{--tone:var(--danger)}
.ds-progress{display:flex;flex-direction:column;gap:8px;font:500 13px/1.3 var(--font-body);color:var(--text)}
.ds-progress__head{display:flex;justify-content:space-between;gap:12px}
.ds-progress__value{color:var(--muted);font-variant-numeric:tabular-nums}
.ds-progress__track{height:8px;border-radius:999px;background:color-mix(in oklch, var(--text) 9%, transparent);overflow:hidden}
.ds-progress__bar{height:100%;border-radius:inherit;background:var(--accent)}
.ds-divider{height:1px;border:0;margin:0;background:var(--line)}
`.trim();

const LIST = "const list = (v) => Array.isArray(v) ? v.map(String) : String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);";
const BOOL = "const truthy = (v) => v === true || v === 'true' || v === '';";

const SOURCES: DesignSystemPack["components"] = {
  Button: {
    summary: "An action: primary for the main one, secondary or ghost for the rest, danger to destroy. Children (an <aegis-icon>) lead the label.",
    html: '<button class="ds-button ds-button--{{ variant }} ds-button--{{ size }}"><aegis-slot></aegis-slot>{{ label }}</button>',
    props: {
      label: { type: "string", default: "" },
      variant: { type: "enum", options: ["primary", "secondary", "ghost", "danger"], default: "primary" },
      size: { type: "enum", options: ["sm", "md", "lg"], default: "md" },
    },
  },
  IconButton: {
    summary: "A square button holding one <aegis-icon> child; label is its accessible name.",
    html: '<button class="ds-icon-button ds-icon-button--{{ variant }} ds-icon-button--{{ size }}" aria-label="{{ label }}" title="{{ label }}"><aegis-slot></aegis-slot></button>',
    props: {
      label: { type: "string", default: "Action" },
      variant: { type: "enum", options: ["ghost", "secondary", "primary"], default: "ghost" },
      size: { type: "enum", options: ["sm", "md", "lg"], default: "md" },
    },
  },
  Card: {
    summary: "A surface grouping related content, with an optional title and subtitle.",
    html: '<section class="ds-card"><h3 class="ds-card__title" data-aegis-if="title">{{ title }}</h3><p class="ds-card__subtitle" data-aegis-if="subtitle">{{ subtitle }}</p><aegis-slot></aegis-slot></section>',
    props: { title: { type: "string", default: "" }, subtitle: { type: "string", default: "" } },
  },
  Tag: {
    summary: "A short status or category label.",
    html: '<span class="ds-tag ds-tag--{{ tone }}"><aegis-slot></aegis-slot>{{ label }}</span>',
    props: { label: { type: "string", default: "" }, tone: { type: "enum", options: ["neutral", "accent", "success", "warning", "danger"], default: "neutral" } },
  },
  Field: {
    summary: "A labelled text input, or a textarea with multiline=\"true\"; hint shows under the label.",
    html: '<label class="ds-field"><span>{{ label }}</span><span class="ds-field__hint" data-aegis-if="hint">{{ hint }}</span><textarea class="ds-input" data-aegis-if="multiline" placeholder="{{ placeholder }}">{{ value }}</textarea><input class="ds-input" data-aegis-else type="{{ type }}" placeholder="{{ placeholder }}" value="{{ value }}"></label>',
    logic: `${BOOL}\nclass Component extends AegisBoard { values() { return { multiline: truthy(this.props.multiline) }; } }`,
    props: {
      label: { type: "string", default: "Label" },
      placeholder: { type: "string", default: "" },
      value: { type: "string", default: "" },
      hint: { type: "string", default: "" },
      type: { type: "enum", options: ["text", "email", "password", "search", "number"], default: "text" },
      multiline: { type: "boolean", default: false },
    },
  },
  Select: {
    summary: "A labelled dropdown; options are comma-separated, value is the selected one.",
    html: '<label class="ds-field"><span>{{ label }}</span><span class="ds-select"><select class="ds-input" value="{{ value }}"><option data-aegis-for="o in choices" value="{{ o }}">{{ o }}</option></select><aegis-icon name="chevron-down" size="16"></aegis-icon></span></label>',
    logic: `${LIST}\nclass Component extends AegisBoard { values() { return { choices: list(this.props.options) }; } }`,
    props: { label: { type: "string", default: "Label" }, options: { type: "string", default: "Option one, Option two" }, value: { type: "string", default: "Option one" } },
  },
  Toggle: {
    summary: "An on/off switch with a label; it flips in Play.",
    html: '<label class="ds-toggle {{ checked ? \'is-on\' : \'\' }}" role="switch" aria-checked="{{ checked }}" data-aegis-on-click="flip()"><span class="ds-toggle__track"></span><span>{{ label }}</span></label>',
    logic: `${BOOL}\nclass Component extends AegisBoard { state = { checked: truthy(this.props.checked) }; flip() { this.setState({ checked: !this.state.checked }); } }`,
    props: { label: { type: "string", default: "Notifications" }, checked: { type: "boolean", default: true } },
  },
  Checkbox: {
    summary: "A checkbox with a label; it checks in Play.",
    html: '<label class="ds-check {{ checked ? \'is-on\' : \'\' }}" role="checkbox" aria-checked="{{ checked }}" data-aegis-on-click="flip()"><span class="ds-check__box"><aegis-icon name="check" size="14" stroke-width="2.5"></aegis-icon></span><span>{{ label }}</span></label>',
    logic: `${BOOL}\nclass Component extends AegisBoard { state = { checked: truthy(this.props.checked) }; flip() { this.setState({ checked: !this.state.checked }); } }`,
    props: { label: { type: "string", default: "Remember me" }, checked: { type: "boolean", default: false } },
  },
  Tabs: {
    summary: "Tabs over a panel; tabs are comma-separated, active is the selected index. Children are the panel; show per-tab content in the board with its own data-aegis-if on a board state when needed.",
    html: '<div class="ds-tabs"><div class="ds-tabs__list" role="tablist"><button data-aegis-for="(t, i) in tabs" role="tab" class="ds-tabs__tab {{ i === current ? \'is-active\' : \'\' }}" aria-selected="{{ i === current }}" data-aegis-on-click="select(i)">{{ t }}</button></div><aegis-slot></aegis-slot></div>',
    logic: `${LIST}\nclass Component extends AegisBoard { state = { current: Number(this.props.active) || 0 }; select(i) { this.setState({ current: i }); } values() { return { tabs: list(this.props.tabs) }; } }`,
    props: { tabs: { type: "string", default: "Overview, Activity, Settings" }, active: { type: "number", default: 0 } },
  },
  Segmented: {
    summary: "A compact choice between a few options (Day / Week / Month); it switches in Play.",
    html: '<div class="ds-segmented" role="radiogroup"><button data-aegis-for="(o, i) in choices" role="radio" class="ds-segmented__item {{ i === current ? \'is-active\' : \'\' }}" aria-checked="{{ i === current }}" data-aegis-on-click="select(i)">{{ o }}</button></div>',
    logic: `${LIST}\nclass Component extends AegisBoard { state = { current: Number(this.props.active) || 0 }; select(i) { this.setState({ current: i }); } values() { return { choices: list(this.props.options) }; } }`,
    props: { options: { type: "string", default: "Day, Week, Month" }, active: { type: "number", default: 0 } },
  },
  Avatar: {
    summary: "A person's initials (from name) in a circle, or an image with src=\"aegis-asset:…\".",
    html: '<span class="ds-avatar ds-avatar--{{ size }}" title="{{ name }}"><img data-aegis-if="src" data-aegis-bind-src="src" alt="{{ name }}"><span data-aegis-else>{{ initials }}</span></span>',
    logic: "class Component extends AegisBoard { values() { const parts = String(this.props.name || '').trim().split(/\\s+/).filter(Boolean); return { initials: ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() }; } }",
    props: { name: { type: "string", default: "Ada Lovelace" }, size: { type: "enum", options: ["sm", "md", "lg"], default: "md" }, src: { type: "image", default: "" } },
  },
  Stat: {
    summary: "A key figure: label, value and an optional change (trend up, down or flat).",
    html: '<div class="ds-stat"><span class="ds-stat__label">{{ label }}</span><span class="ds-stat__value">{{ value }}</span><span class="ds-stat__delta ds-stat__delta--{{ trend }}" data-aegis-if="delta">{{ delta }}</span></div>',
    props: {
      label: { type: "string", default: "Revenue" },
      value: { type: "string", default: "$48,210" },
      delta: { type: "string", default: "+12.4% vs last month" },
      trend: { type: "enum", options: ["up", "down", "flat"], default: "up" },
    },
  },
  ListItem: {
    summary: "A row in a list: leading children (an Avatar or icon), title, subtitle and trailing meta.",
    html: '<div class="ds-list-item"><aegis-slot></aegis-slot><div class="ds-list-item__body"><span class="ds-list-item__title">{{ title }}</span><span class="ds-list-item__subtitle" data-aegis-if="subtitle">{{ subtitle }}</span></div><span class="ds-list-item__meta" data-aegis-if="meta">{{ meta }}</span></div>',
    props: { title: { type: "string", default: "Title" }, subtitle: { type: "string", default: "" }, meta: { type: "string", default: "" } },
  },
  Navbar: {
    summary: "A top bar: brand, comma-separated links (active is the current one's index) and children as actions on the right.",
    html: '<header class="ds-navbar"><span class="ds-navbar__brand">{{ brand }}</span><nav class="ds-navbar__links"><a data-aegis-for="(l, i) in links" class="ds-navbar__link {{ i === current ? \'is-active\' : \'\' }}" data-aegis-on-click="select(i)">{{ l }}</a></nav><div class="ds-navbar__actions"><aegis-slot></aegis-slot></div></header>',
    logic: `${LIST}\nclass Component extends AegisBoard { state = { current: Number(this.props.active) || 0 }; select(i) { this.setState({ current: i }); } values() { return { links: list(this.props.links) }; } }`,
    props: { brand: { type: "string", default: "Northwind" }, links: { type: "string", default: "Product, Pricing, Docs" }, active: { type: "number", default: 0 } },
  },
  Alert: {
    summary: "An inline message: info, success, warning or danger, with a title and children as its text.",
    html: '<div class="ds-alert ds-alert--{{ tone }}" role="status"><aegis-icon data-aegis-if="tone === \'info\'" name="info-circle" size="18"></aegis-icon><aegis-icon data-aegis-if="tone === \'success\'" name="circle-check" size="18"></aegis-icon><aegis-icon data-aegis-if="tone === \'warning\' || tone === \'danger\'" name="alert-triangle" size="18"></aegis-icon><div><div class="ds-alert__title">{{ title }}</div><div class="ds-alert__body"><aegis-slot></aegis-slot></div></div></div>',
    props: { title: { type: "string", default: "Heads up" }, tone: { type: "enum", options: ["info", "success", "warning", "danger"], default: "info" } },
  },
  Progress: {
    summary: "A labelled progress bar; value from 0 to 100.",
    html: '<div class="ds-progress"><div class="ds-progress__head"><span>{{ label }}</span><span class="ds-progress__value">{{ pct }}%</span></div><div class="ds-progress__track"><div class="ds-progress__bar" data-aegis-bind-style="{ width: pct + \'%\' }"></div></div></div>',
    logic: "class Component extends AegisBoard { values() { return { pct: Math.max(0, Math.min(100, Math.round(Number(this.props.value) || 0))) }; } }",
    props: { label: { type: "string", default: "Storage" }, value: { type: "number", default: 64 } },
  },
};

let built: DesignSystemPack["components"] | null = null;
/**
 * The built-in components, their icons expanded on first use. Without the
 * icon library (a build that skipped build-design-assets) they render
 * without icons rather than failing.
 */
export function builtinComponents(): { components: DesignSystemPack["components"]; complete: boolean } {
  if (built) return { components: built, complete: true };
  let complete = true;
  const out = Object.fromEntries(
    Object.entries(SOURCES).map(([name, c]) => {
      try {
        return [name, { ...c, html: expandDesignIcons(c.html) }];
      } catch {
        complete = false;
        return [name, { ...c, html: c.html.replace(/<aegis-icon\b[^>]*>(?:<\/aegis-icon>)?/g, "") }];
      }
    }),
  );
  if (complete) built = out;
  return { components: out, complete };
}
