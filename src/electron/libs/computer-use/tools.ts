// The gateway's tools: the same ten names and argument shapes agents already
// have with Codex's own Computer use (list_apps, get_app_state and eight
// actions, addressed by app name and element index), so the approval card,
// the grants, the labels and the HUD treat both backends alike. The gateway
// translates each call to cua-driver's (pid, window, element token) calls.

import { COMPUTER_USE_TOOLS } from '../../../shared/computer-use';

export type ComputerUseToolId = (typeof COMPUTER_USE_TOOLS)[number];

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

function schema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', additionalProperties: false, properties, required };
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
      "Get the state of an app's key window: its accessibility tree, where each element you can act on has an [index], and a screenshot. Opens the app in the background first when it is not running (the user is asked). Call this once per turn before acting on an app; every action returns the window's new state, so you rarely need to call it again.",
    parameters: schema({ app: APP }, ['app']),
    mutating: false,
    risk: 'medium',
  },
  {
    name: 'click',
    description:
      'Click an element by its index from the accessibility tree, or at pixel coordinates in the latest screenshot. Prefer the index: it works on a window in the background and moves no pointer.',
    parameters: schema(
      {
        app: APP,
        element_index: { type: 'string', description: 'Element index to click' },
        x: { type: 'number', description: 'X coordinate in screenshot pixel coordinates' },
        y: { type: 'number', description: 'Y coordinate in screenshot pixel coordinates' },
        click_count: { type: 'integer', description: 'Number of clicks. Defaults to 1' },
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
        app: APP,
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
        app: APP,
        element_index: { type: 'string', description: 'Element identifier' },
        value: { type: 'string', description: 'Value to assign' },
      },
      ['app', 'element_index', 'value']
    ),
    mutating: true,
    risk: 'medium',
  },
  {
    name: 'select_text',
    description:
      'Select text inside a text element, or place the text cursor before or after it. Provide text exactly as it appears in the accessibility tree.',
    parameters: schema(
      {
        app: APP,
        element_index: { type: 'string', description: 'Text element identifier' },
        text: { type: 'string', description: 'Target text as shown in the accessibility tree' },
        prefix: { type: 'string', description: 'Optional text immediately before the target' },
        suffix: { type: 'string', description: 'Optional text immediately after the target' },
        selection: {
          type: 'string',
          enum: ['text', 'cursor_before', 'cursor_after'],
          description: 'Whether to select the text or place the cursor before or after it. Defaults to text.',
        },
      },
      ['app', 'element_index', 'text']
    ),
    mutating: true,
    risk: 'low',
  },
  {
    name: 'scroll',
    description: 'Scroll an element in a direction by a number of pages.',
    parameters: schema(
      {
        app: APP,
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
        app: APP,
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
      { app: APP, key: { type: 'string', description: 'Key or key combination to press' } },
      ['app', 'key']
    ),
    mutating: true,
    risk: 'medium',
  },
  {
    name: 'type_text',
    description: 'Type literal text into the focused element of the app. Does not press Return: use press_key for that.',
    parameters: schema({ app: APP, text: { type: 'string', description: 'Literal text to type' } }, ['app', 'text']),
    mutating: true,
    risk: 'medium',
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
