// The policy file the driver starts with: a second layer under the gateway.
//
// The gateway only ever sends the calls below. The driver is told the same
// list (deny by default once a policy is set), so a gateway bug cannot reach
// the driver's other tools (kill_app, the clipboard, run_script, the browser
// tools that attach to a signed-in profile, recording, self-update). Input is
// held to background delivery inside one window: no fronting an app, no
// screen-coordinate input, nothing written to a path the model names.

/** Driver tools the gateway calls with any arguments: observation and its own bookkeeping. */
export const DRIVER_OPEN_TOOLS = ['check_permissions', 'list_apps', 'list_windows', 'end_session'] as const;

/** Driver tools the gateway calls for input, each held to one window in the background. */
export const DRIVER_INPUT_TOOLS = [
  'click',
  'double_click',
  'set_value',
  'scroll',
  'drag',
  'press_key',
  'hotkey',
  'type_text',
] as const;

const ABSENT = '{ optional: true, allowed: [] }';

function inputRule(tool: string): string {
  return [
    `    - tool: ${tool}`,
    '      constraints:',
    '        delivery_mode: { optional: true, allowed: [background] }',
    '        scope: { optional: true, allowed: [window] }',
    `        target: ${ABSENT}`,
    ...(tool === 'click' ? [`        debug_image_out: ${ABSENT}`] : []),
  ].join('\n');
}

export function buildCuaDriverPolicy(): string {
  return [
    '# Written by Aegis each time it starts the driver. Edits are overwritten.',
    'allow:',
    '  tools:',
    ...DRIVER_OPEN_TOOLS.map((tool) => `    - ${tool}`),
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
    ...DRIVER_INPUT_TOOLS.map(inputRule),
    '',
  ].join('\n');
}
