// Desktop tools exposed to agents. The gateway binds driver arguments to the observed app and window.

import { COMPUTER_USE_GATEWAY_TOOLS } from '../../../shared/computer-use';

export type ComputerUseToolId = (typeof COMPUTER_USE_GATEWAY_TOOLS)[number];

export interface ComputerUseToolDefinition {
  name: ComputerUseToolId;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>;
  /** Acts on the desktop: approval-gated, leased, refused in Plan mode. */
  mutating: boolean;
  /** How far a "until revoked" grant for it reaches (see computerUseRiskRank). */
  risk: 'low' | 'medium';
}

const APP = {
  type: 'string',
  description: 'App name, full app path, or unambiguous bundle identifier',
} as const;

const WINDOW_ID = { type: 'integer', minimum: 1, description: 'Exact window ID returned by list_windows.' };
function schema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  const toolTitle = { type: 'string', maxLength: 120, description: "Short progress label in the user's language describing this action in the chat." };
  return { type: 'object', additionalProperties: false, properties: { ...properties, toolTitle }, required };
}

export const COMPUTER_USE_TOOL_DEFINITIONS: readonly ComputerUseToolDefinition[] = [
  {
    name: 'list_apps',
    description:
      'List the apps on this Mac: the ones running now, then the installed ones, each with its bundle identifier. Use a name or bundle identifier from here as `app` in the other tools.',
    parameters: schema({}, []),
    mutating: false,
    risk: 'low',
  },
  {
    name: 'get_app_state',
    description:
      "Read a specific window_id from list_windows or, if omitted, the app's key window: its accessibility tree, where each element you can act on has an [index], and a screenshot. Opens the app in the background first when it is not running (the user is asked). Call this once per turn before acting on an app; every action returns the window's new state, so you rarely need to call it again.",
    parameters: schema({
      app: APP, window_id: WINDOW_ID,
      query: { type: 'string', minLength: 1, maxLength: 512, description: 'Filter the accessibility tree by text.' },
      max_elements: { type: 'integer', minimum: 1, maximum: 2000 },
      include_screenshot: { type: 'boolean', description: 'Set false for a text-only read.' },
    }, ['app']),
    mutating: false,
    risk: 'medium',
  },
  {
    name: 'click',
    description:
      'Click an element by its index from the accessibility tree, or at pixel coordinates in the latest screenshot. Prefer the index: it works on a window in the background and moves no pointer.',
    parameters: schema(
      {
        app: APP, window_id: WINDOW_ID,
        element_index: { type: 'string', description: 'Element index to click' },
        x: { type: 'number', description: 'X coordinate in screenshot pixel coordinates' },
        y: { type: 'number', description: 'Y coordinate in screenshot pixel coordinates' },
        click_count: {
          type: 'integer',
          description: 'Number of clicks. Defaults to 1. With element_index: 1, or 2 with the left button. With x and y: 1 to 3.',
        },
        mouse_button: {
          type: 'string',
          enum: ['left', 'right', 'middle'],
          description: 'Mouse button to click. Defaults to left.',
        },
      },
      ['app']
    ),
    mutating: true,
    risk: 'low',
  },
  {
    name: 'perform_secondary_action',
    description:
      'Invoke another accessibility action an element lists in the tree (its `actions=[…]`), for example show_menu, pick, confirm, cancel, increment or decrement.',
    parameters: schema(
      {
        app: APP, window_id: WINDOW_ID,
        element_index: { type: 'string', description: 'Element identifier' },
        action: { type: 'string', description: 'Secondary accessibility action name' },
      },
      ['app', 'element_index', 'action']
    ),
    mutating: true,
    risk: 'low',
  },
  {
    name: 'set_value',
    description:
      'Set the value of a settable accessibility element: a text field, slider, stepper, or the option of a popup button.',
    parameters: schema(
      {
        app: APP, window_id: WINDOW_ID,
        element_index: { type: 'string', description: 'Element identifier' },
        value: { type: 'string', description: 'Value to assign' },
      },
      ['app', 'element_index', 'value']
    ),
    mutating: true,
    risk: 'medium',
  },
  {
    name: 'scroll',
    description: 'Scroll an element in a direction by a number of pages.',
    parameters: schema(
      {
        app: APP, window_id: WINDOW_ID,
        element_index: { type: 'string', description: 'Element identifier' },
        direction: { type: 'string', description: 'Scroll direction: up, down, left, or right' },
        pages: { type: 'number', description: 'Number of pages to scroll. Fractional values are supported. Defaults to 1' },
      },
      ['app', 'element_index', 'direction']
    ),
    mutating: true,
    risk: 'low',
  },
  {
    name: 'drag',
    description: 'Drag from one point to another using pixel coordinates in the latest screenshot.',
    parameters: schema(
      {
        app: APP, window_id: WINDOW_ID,
        from_x: { type: 'number', description: 'Start X coordinate' },
        from_y: { type: 'number', description: 'Start Y coordinate' },
        to_x: { type: 'number', description: 'End X coordinate' },
        to_y: { type: 'number', description: 'End Y coordinate' },
      },
      ['app', 'from_x', 'from_y', 'to_x', 'to_y']
    ),
    mutating: true,
    risk: 'low',
  },
  {
    name: 'press_key',
    description:
      'Press a key or key combination, including modifier and navigation keys, in xdotool `key` syntax. Examples: "a", "Return", "Tab", "super+c", "Up", "KP_0".',
    parameters: schema(
      { app: APP, window_id: WINDOW_ID, key: { type: 'string', description: 'Key or key combination to press' } },
      ['app', 'key']
    ),
    mutating: true,
    risk: 'medium',
  },
  {
    name: 'type_text',
    description: 'Type literal text into the focused element of the app. Does not press Return: use press_key for that.',
    parameters: schema({ app: APP, window_id: WINDOW_ID, text: { type: 'string', description: 'Literal text to type' } }, ['app', 'text']),
    mutating: true,
    risk: 'medium',
  },
  {
    name: 'list_windows', description: 'List the open windows of one app with titles and IDs. Select one with get_app_state.',
    parameters: schema({ app: APP }, ['app']), mutating: false, risk: 'low',
  },
  {
    name: 'verify_state', description: 'Check a control in the last observed window. Check the returned verdict before reporting success.',
    parameters: schema({
      app: APP, window_id: WINDOW_ID, label: { type: 'string' }, role: { type: 'string' },
      value_equals: { type: 'string' }, selected: { type: 'boolean' }, enabled: { type: 'boolean' },
    }, ['app']), mutating: false, risk: 'low',
  },
  {
    name: 'zoom', description: 'Inspect part of the last observed window. Coordinates refer to the full window screenshot, including for subsequent actions.',
    parameters: schema({ app: APP, window_id: WINDOW_ID, x1: { type: 'integer' }, y1: { type: 'integer' }, x2: { type: 'integer' }, y2: { type: 'integer' } },
      ['app', 'x1', 'y1', 'x2', 'y2']), mutating: false, risk: 'low',
  },
  {
    name: 'invoke_menu', description: 'Send the native menu command by its full path in the observed window. macOS can refuse a background document. Check fresh window state for the command’s effect.',
    parameters: schema({ app: APP, window_id: WINDOW_ID, path: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string', minLength: 1, maxLength: 200 } } },
      ['app', 'path']), mutating: true, risk: 'medium',
  },
];

export function computerUseToolDefinition(name: string): ComputerUseToolDefinition | null {
  return COMPUTER_USE_TOOL_DEFINITIONS.find((tool) => tool.name === name) ?? null;
}

const MODIFIERS: Record<string, string> = {
  super: 'cmd',
  cmd: 'cmd',
  command: 'cmd',
  meta: 'cmd',
  win: 'cmd',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'option',
  option: 'option',
  opt: 'option',
  shift: 'shift',
  fn: 'fn',
};

/** xdotool key names the driver spells differently. Letters, digits and f1–f12 pass through. */
const KEY_NAMES: Record<string, string> = {
  return: 'return',
  enter: 'return',
  kp_enter: 'return',
  tab: 'tab',
  escape: 'escape',
  esc: 'escape',
  space: 'space',
  backspace: 'delete',
  delete: 'delete',
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  home: 'home',
  end: 'end',
  page_up: 'pageup',
  pageup: 'pageup',
  prior: 'pageup',
  page_down: 'pagedown',
  pagedown: 'pagedown',
  next: 'pagedown',
};

export type ParsedKey = { modifiers: string[]; key: string } | { error: string };

/**
 * "super+shift+z" → cmd, shift and z. One key, any number of modifiers; a key
 * the driver has no name for is an error that points at type_text.
 */
export function parseXdotoolKey(input: string): ParsedKey {
  const parts = input.trim() === '+' ? ['+'] : input.trim().split('+').map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => !part)) return { error: `"${input}" is not a key or key combination.` };
  const modifiers: string[] = [];
  for (const part of parts.slice(0, -1)) {
    const modifier = MODIFIERS[part.toLowerCase()];
    if (!modifier) return { error: `"${part}" is not a modifier key. Use super, ctrl, alt or shift.` };
    if (!modifiers.includes(modifier)) modifiers.push(modifier);
  }
  const raw = parts[parts.length - 1];
  const lower = raw.toLowerCase();
  const keypadDigit = /^kp_(\d)$/.exec(lower)?.[1];
  const key = KEY_NAMES[lower] ?? keypadDigit ?? (/^(?:[a-z0-9]|f(?:[1-9]|1[0-2]))$/.test(lower) ? lower : null);
  if (!key) {
    return {
      error: `"${raw}" is not a key Computer use can press. Use a letter, a digit, Return, Tab, Escape, space, BackSpace, an arrow, Home, End, Page_Up, Page_Down or F1–F12; type other characters with type_text.`,
    };
  }
  return { modifiers, key };
}

/** "AXShowMenu" → "show_menu"; the driver's own names pass through. */
export function normalizeSecondaryAction(action: string): string {
  const trimmed = action.trim();
  if (!/^AX[A-Z]/.test(trimmed)) return trimmed;
  return trimmed
    .slice(2)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
}
