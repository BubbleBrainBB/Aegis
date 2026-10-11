// show_widget: its name is recognized however a provider namespaces it, the
// chat reads a widget only from a real input, and the tool validates what the
// chat will draw (non-empty, size cap, a note for blocked external URLs).
import assert from 'node:assert/strict';
import { isShowWidgetToolName, widgetFromToolInput, WIDGET_HTML_MAX_CHARS } from '../../src/shared/widget';
import { showWidgetTool, SHOW_WIDGET_DESCRIPTION } from '../../src/electron/libs/widget-tool';

for (const name of ['show_widget', 'mcp__aegis-sessions__show_widget', 'aegis-sessions_show_widget', 'aegis-widgets.show_widget', 'aegis-sessions/show_widget', 'Show_Widget']) {
  assert.equal(isShowWidgetToolName(name), true, name);
}
for (const name of ['showwidget', 'show_widgets', 'render_ui', 'mcp__x__show_widget_now', 42, null]) {
  assert.equal(isShowWidgetToolName(name), false, String(name));
}

assert.deepEqual(widgetFromToolInput({ html: '<b>x</b>', title: '  Sales  ' }), { html: '<b>x</b>', title: 'Sales' });
assert.deepEqual(widgetFromToolInput({ html: '<b>x</b>', title: '' }), { html: '<b>x</b>' });
assert.equal(widgetFromToolInput({ html: '   ' }), null);
assert.equal(widgetFromToolInput({ title: 'no html' }), null);
assert.equal(widgetFromToolInput('<b>x</b>'), null);

async function main() {
  const ok = await showWidgetTool({ html: '<div>chart</div>' });
  assert.equal(ok.isError, undefined);
  assert.match(ok.content[0].text, /shown to the user/);
  assert.equal((await showWidgetTool({ html: ' ' })).isError, true);
  assert.equal((await showWidgetTool({})).isError, true);
  const big = await showWidgetTool({ html: 'x'.repeat(WIDGET_HTML_MAX_CHARS + 1) });
  assert.equal(big.isError, true);
  assert.match(big.content[0].text, /limit/);
  const external = await showWidgetTool({ html: '<script src="https://cdn.example.com/x.js"></script>' });
  assert.equal(external.isError, undefined, 'an external URL is a note, not a failure');
  assert.match(external.content[0].text, /no network/);
  assert.equal((await showWidgetTool({ html: '<script src="aegis-widget://lib/chart.js"></script>' })).content[0].text.includes('no network'), false);

  // The description teaches the sandbox's rules.
  for (const part of ['aegis-widget://lib/chart.js', '--text-primary', 'aegis.sendPrompt', 'No network', 'proactively', 'Never write files or start a server', "'aegis-theme'"]) {
    assert.ok(SHOW_WIDGET_DESCRIPTION.includes(part), part);
  }
  console.log('widget-tool: name matching, input parsing, validation and description passed');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

// A script that doesn't parse is refused with where it broke, so the agent can fix it.
void (async () => {
  const { findWidgetScriptSyntaxError } = await import('../../src/electron/libs/widget-tool');
  const broken = '<div id="a"></div>\n<script>\nconst ok = 1;\n</script>\n<script>\nfunction f( {\n  return 1;\n}\n</script>';
  const message = findWidgetScriptSyntaxError(broken);
  assert.ok(message && message.startsWith('script 2, line '), String(message));
  const refused = await showWidgetTool({ html: broken });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /not shown: script 2/);
  // Library tags, JSON data and module scripts aren't compiled as classic scripts.
  assert.equal(findWidgetScriptSyntaxError('<script src="aegis-widget://lib/d3.js"></script><script type="application/json">{"a":1}</script><script type="module">import x from "y"; export {}</script><script>const a = `x`;</script>'), null);
  console.log('widget-tool: syntax errors refused with location; libraries, JSON and modules skipped');
})().catch((error) => { console.error(error); process.exitCode = 1; });

// The guide: core always, topics on request, every topic knows the others.
void (async () => {
  const { widgetGuideTool, SHOW_WIDGET_DESCRIPTION: description } = await import('../../src/electron/libs/widget-tool');
  const core = (await widgetGuideTool({})).content[0].text;
  assert.match(core, /# Widget guide/);
  assert.match(core, /More topics: chart, diagram, interactive, mockup/);
  assert.ok(!core.includes('## Charts'));
  const chart = (await widgetGuideTool({ topics: ['chart', 'nonsense'] })).content[0].text;
  assert.match(chart, /## Charts/);
  assert.ok(!chart.includes('## Diagrams'));
  // Every class the guide names is in the shell's design system.
  const { WIDGET_DESIGN_CSS } = await import('../../src/electron/widget-design-system');
  for (const name of ['.metrics', '.metric', '.panel', '.card', '.legend', '.swatch', '.chart', '.badge', '.row', '.stack', '.grid', '.arr', '.leader', '.box', '.th', '.ts', '.c-teal', '.tint-amber', '--series-8', '--grid', '--axis', '--bg-danger']) {
    assert.ok(WIDGET_DESIGN_CSS.includes(name), name);
  }
  assert.match(description, /call widget_guide/);
  console.log('widget-tool: guide topics on demand; the design system has every class the guide names');
})().catch((error) => { console.error(error); process.exitCode = 1; });
