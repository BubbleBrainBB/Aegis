// The policy file the driver starts with: a second layer under the gateway.
//
// The gateway only ever sends the calls below. The driver is told the same
// list (deny by default once a policy is set), so a gateway bug cannot reach
// the driver's other tools (kill_app, the clipboard, run_script, the browser
// tools that attach to a signed-in profile, recording, self-update).
//
// Input is held to background delivery inside one window: no fronting an
// app, no screen-coordinate input, nothing written to a path the model
// names. Where a driver tool takes `delivery_mode` or `scope`, the gateway
// sends the value on every call and the policy requires it to be there:
// what the driver would do when it is left out is the driver's to change.

/** Driver tools the gateway calls with any arguments: observation and its own bookkeeping. */
export const DRIVER_OPEN_TOOLS = ['check_permissions', 'list_apps', 'list_windows', 'end_session', 'verify_state', 'zoom'] as const;

/**
 * Driver tools the gateway calls for input, and the arguments each one is
 * always sent with. A tool has only the ones its schema defines (the driver
 * rejects unknown arguments).
 */
export const DRIVER_INPUT_TOOLS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  invoke_menu: { delivery_mode: 'background' },
  click: { delivery_mode: 'background', scope: 'window' },
  double_click: { delivery_mode: 'background' },
  set_value: {},
  scroll: { delivery_mode: 'background', scope: 'window' },
  drag: { delivery_mode: 'background', scope: 'window' },
  press_key: { delivery_mode: 'background', scope: 'window' },
  hotkey: { delivery_mode: 'background', scope: 'window' },
  type_text: { delivery_mode: 'background', scope: 'window' },
};

// From the pinned driver's input schemas. New tools opt in after their schema is checked.
export const REVISION_INPUT_TOOLS: ReadonlySet<string> = new Set([
  'click', 'double_click', 'set_value', 'scroll', 'drag', 'press_key', 'hotkey', 'type_text',
]);

/** The arguments an input call to the driver always carries. */
export function fixedDriverInputArgs(tool: string): Record<string, string> {
  return { ...(DRIVER_INPUT_TOOLS[tool] || {}) };
}

const ABSENT = '{ optional: true, allowed: [] }';

function inputRule(tool: string): string {
  const fixed = DRIVER_INPUT_TOOLS[tool];
  return [
    `    - tool: ${tool}`,
    '      constraints:',
    // No `optional`: the argument must be there, with this value.
    ...Object.entries(fixed).map(([name, value]) => `        ${name}: { allowed: [${value}] }`),
    // Another way to name a target, which would get round `scope`.
    ...('scope' in fixed ? [`        target: ${ABSENT}`] : []),
    ...(tool === 'click' ? [`        debug_image_out: ${ABSENT}`] : []),
  ].join('\n');
}

export function buildCuaDriverPolicy(): string {
  const inputTools = Object.keys(DRIVER_INPUT_TOOLS);
  // An input tool with nothing to hold it to (set_value acts on one element
  // through accessibility, and takes neither argument) is allowed as it is.
  const unconstrained = inputTools.filter((tool) => Object.keys(DRIVER_INPUT_TOOLS[tool]).length === 0);
  return [
    '# Written by Aegis each time it starts the driver. Edits are overwritten.',
    'allow:',
    '  tools:',
    ...[...DRIVER_OPEN_TOOLS, ...unconstrained].map((tool) => `    - ${tool}`),
    '  rules:',
    // Open an app in the background: nothing handed to it, no extra arguments.
    '    - tool: launch_app',
    '      constraints:',
    `        urls: ${ABSENT}`,
    `        additional_arguments: ${ABSENT}`,
    `        webkit_inspector_port: ${ABSENT}`,
    // Read one window; the screenshot comes back inline, never to a file.
    '    - tool: get_window_state',
    '      constraints:',
    `        screenshot_out_file: ${ABSENT}`,
    ...inputTools.filter((tool) => !unconstrained.includes(tool)).map(inputRule),
    '',
  ].join('\n');
}
