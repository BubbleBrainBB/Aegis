// Chat markdown in a real page: a ```mermaid fence becomes its diagram, in the
// light and the dark theme, and stays source while it streams or cannot parse.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '../..');
const electronBin = path.join(
  projectRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron.cmd' : 'electron'
);

function runElectron(mainPath, extraEnv) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...extraEnv };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electronBin, [mainPath], { cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Markdown mermaid Electron check timed out\n${stdout}\n${stderr}`));
    }, 90_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout);
      else reject(new Error(`Markdown mermaid Electron check exited with ${code}\n${stdout}\n${stderr}`));
    });
  });
}

// The kind of diagram that was reported as plain text: Chinese subgraph names,
// <br/> in labels, and "/", "≥", "→" in node and edge text.
const FLOWCHART = `flowchart TD
    A[用户提交订单] --> B{库存 ≥ 下单数量?}

    subgraph 订单校验
        B -->|是| C[锁定库存<br/>生成支付单]
        B -->|否 / 缺货| D[提示补货 → 加入到货提醒]
    end

    subgraph 支付与履约
        C --> E{支付成功?}
        E -->|成功| F[扣减库存 / 通知仓库<br/>预计 24h 内发货]
        E -->|失败 或 超时 ≥ 15min| G[释放库存 → 订单关闭]
    end

    F --> H((完成))
    D --> H
    G --> H`;

const WIDE = `flowchart LR
    S1[需求评审 / 排期] --> S2[方案设计 → 技术评审] --> S3[开发实现<br/>单元测试] --> S4[联调 / 集成测试] --> S5[灰度发布 ≥ 10%] --> S6[全量发布 → 监控] --> S7[复盘 / 归档] --> S8[下一迭代的需求收集]`;

async function writeHarness(tmpDir) {
  const harness = `
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MDContent } from '/src/ui/render/markdown.tsx';
import { DEFAULT_APPEARANCE, DEFAULT_UI_FONT_FAMILY, renderAppearance } from '/src/ui/theme/themes.ts';
import '/src/ui/index.css';

function snapshot() {
  const blocks = [...document.querySelectorAll('.md-mermaid')].map((block) => {
    const svg = block.querySelector('.md-mermaid-canvas > svg');
    const viewport = block.querySelector('.md-mermaid-viewport');
    const box = svg?.getBoundingClientRect();
    const node = svg?.querySelector('.node rect, .node polygon, .node circle');
    const labels = svg ? [...svg.querySelectorAll('foreignObject')] : [];
    return {
      state: block.getAttribute('data-mermaid-state'),
      label: block.querySelector('.md-code-language')?.textContent || null,
      svgId: svg?.id || null,
      width: box ? Math.round(box.width) : 0,
      height: box ? Math.round(box.height) : 0,
      nodes: svg ? svg.querySelectorAll('.node').length : 0,
      clusters: svg ? [...svg.querySelectorAll('.cluster')].map((cluster) => cluster.textContent.trim()) : [],
      edges: svg ? svg.querySelectorAll('.edgePaths path, path.flowchart-link').length : 0,
      text: svg ? [...svg.querySelectorAll('foreignObject, text')].map((label) => label.textContent).join(' | ') : '',
      breaks: svg ? svg.querySelectorAll('foreignObject br').length : 0,
      // A label wider or taller than the box Mermaid measured for it is cut off.
      clipped: labels.filter((label) => {
        const inner = label.firstElementChild;
        if (!inner) return false;
        const outer = label.getBoundingClientRect();
        const content = inner.getBoundingClientRect();
        return content.width > outer.width + 1.5 || content.height > outer.height + 1.5;
      }).length,
      labels: labels.length,
      nodeFill: node ? getComputedStyle(node).fill : null,
      nodeText: labels[0]?.firstElementChild ? getComputedStyle(labels[0].firstElementChild).color : null,
      source: block.querySelector('.highlighted-code-block')?.textContent || null,
      error: block.querySelector('.md-mermaid-error')?.textContent?.trim() || null,
      buttons: [...block.querySelectorAll('.md-code-action')].map((button) => button.getAttribute('aria-label')),
      scrollsSideways: viewport ? viewport.scrollWidth > viewport.clientWidth + 1 : false,
      viewportWidth: viewport ? viewport.clientWidth : 0,
    };
  });
  return {
    blocks,
    leftovers: document.querySelectorAll('.md-mermaid-sandbox .md-mermaid-canvas > *').length,
    strayErrors: document.querySelectorAll('body > [id^="daegis-mermaid"], body > svg').length,
    prose: [...document.querySelectorAll('.markdown-content > p')].map((p) => p.textContent).join(' | '),
  };
}

// Where a link of a diagram would be sent; the page itself must stay.
window.__AegisMermaidOpened = [];
window.electron = { openExternalUrl: (url) => { window.__AegisMermaidOpened.push(url); return Promise.resolve({ ok: true }); } };

function Harness() {
  const [content, setContent] = useState('');
  useEffect(() => {
    window.__AegisMermaidVerify = {
      ready: true,
      snapshot,
      setContent,
      // The app's own way of changing theme, which is what a diagram listens to.
      setDark: (dark) => renderAppearance({
        mode: dark ? 'dark' : 'light',
        state: DEFAULT_APPEARANCE,
        uiFontFamily: DEFAULT_UI_FONT_FAMILY,
      }),
      press: (label) => {
        const button = document.querySelector('.md-mermaid .md-code-action[aria-label="' + label + '"]');
        if (!button) return false;
        button.click();
        return true;
      },
    };
  }, []);
  return (
    <div style={{ width: 900, padding: '24px 32px', background: 'var(--bg-primary)', color: 'var(--text-primary)', minHeight: 900 }}>
      <MDContent content={content} />
    </div>
  );
}

createRoot(document.getElementById('root')).render(<Harness />);
`;

  const main = `
const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('force-prefers-no-reduced-motion');
const fs = require('node:fs');
const path = require('node:path');

const FLOWCHART = ${JSON.stringify(FLOWCHART)};
const WIDE = ${JSON.stringify(WIDE)};
const fence = (code) => '\`\`\`mermaid\\n' + code + '\\n\`\`\`';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ webPreferences: { backgroundThrottling: false }, width: 1000, height: 1000, show: false });
  const consoleErrors = [];
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) consoleErrors.push(message);
  });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const snapshot = () => js('window.__AegisMermaidVerify.snapshot()');
  const setContent = (content) => js('window.__AegisMermaidVerify.setContent(' + JSON.stringify(content) + ')');
  const until = async (test, what) => {
    let last;
    for (let index = 0; index < 150; index += 1) {
      last = await snapshot();
      if (test(last)) return last;
      await delay(100);
    }
    throw new Error('Timed out waiting for ' + what + ': ' + JSON.stringify(last) + ' ' + JSON.stringify(consoleErrors));
  };
  const capture = async (name) => {
    const outputDir = process.env.AEGIS_MARKDOWN_MERMAID_CAPTURE_DIR;
    if (!outputDir) return;
    fs.mkdirSync(outputDir, { recursive: true });
    const size = await js('({ width: document.documentElement.scrollWidth, height: Math.min(1600, document.documentElement.scrollHeight) })');
    win.setContentSize(Math.max(1000, size.width), Math.max(400, size.height));
    await delay(250);
    fs.writeFileSync(path.join(outputDir, name), (await win.webContents.capturePage()).toPNG());
  };
  const drawn = (state) => state.blocks.length === 1 && state.blocks[0].state === 'diagram' && state.blocks[0].nodes > 0;

  try {
    await win.loadURL(process.env.AEGIS_MARKDOWN_MERMAID_VERIFY_URL);
    for (let index = 0; index < 100 && !(await js('Boolean(window.__AegisMermaidVerify?.ready)')); index += 1) await delay(100);
    await js('window.__AegisMermaidVerify.setDark(false)');
    const result = {};
    const message = '下单流程如下：\\n\\n' + fence(FLOWCHART) + '\\n\\n其中 **库存校验** 在支付前完成。';

    // While the answer streams the fence is open: source, never an error.
    result.streaming = [];
    const fenceStart = message.indexOf('\`\`\`mermaid');
    const fenceEnd = message.lastIndexOf('\`\`\`');
    for (const cut of [fenceStart + 10, fenceStart + 24, fenceStart + 60, fenceStart + 140, fenceEnd, fenceEnd + 2]) {
      await setContent(message.slice(0, cut));
      await delay(120);
      const state = await snapshot();
      result.streaming.push({ cut, blocks: state.blocks.map((block) => ({ state: block.state, error: block.error, source: block.source })) });
    }
    await capture('streaming.png');

    // Closed: the diagram.
    await setContent(message);
    result.light = await until(drawn, 'the diagram in the light theme');
    await capture('light.png');

    await js('window.__AegisMermaidVerify.setDark(true)');
    result.dark = await until(
      (state) => drawn(state) && state.blocks[0].svgId !== result.light.blocks[0].svgId && state.blocks[0].nodeFill !== result.light.blocks[0].nodeFill,
      'the diagram redrawn for the dark theme'
    );
    await capture('dark.png');
    await js('window.__AegisMermaidVerify.setDark(false)');
    await until((state) => drawn(state) && state.blocks[0].nodeFill === result.light.blocks[0].nodeFill, 'the light theme again');

    // Source and back.
    result.pressedSource = await js('window.__AegisMermaidVerify.press("Show source")');
    result.source = await until((state) => state.blocks[0]?.state === 'source', 'the source view');
    await capture('source.png');
    result.pressedDiagram = await js('window.__AegisMermaidVerify.press("Show diagram")');
    result.back = await until(drawn, 'the diagram again');

    // A diagram wider than the message shrinks to a floor, and can be shown at full size.
    await setContent(fence(WIDE));
    result.wide = await until((state) => drawn(state) && state.blocks[0].text.includes('S8') === false && state.blocks[0].text.includes('下一迭代'), 'the wide diagram');
    await capture('wide-fit.png');
    result.pressedFullSize = await js('window.__AegisMermaidVerify.press("Show at full size")');
    result.fullSize = await until((state) => drawn(state) && state.blocks[0].buttons.includes('Fit to width'), 'the full size view');
    await capture('wide-full-size.png');

    // Closed but not a diagram: source with a note, and nothing left on the page.
    await setContent('坏的图：\\n\\n' + fence('flowchart TD\\n    A[未闭合 --> B{{\\n    subgraph') + '\\n\\n后面的文字照常显示。');
    result.invalid = await until((state) => state.blocks[0]?.state === 'error', 'the note of a diagram that does not parse');
    await capture('invalid.png');

    // Two fences in one answer, one of another diagram type.
    await setContent(fence(FLOWCHART) + '\\n\\n' + fence('sequenceDiagram\\n    用户->>服务: 下单 / 支付\\n    服务-->>用户: 结果 → 成功'));
    result.pair = await until((state) => state.blocks.length === 2 && state.blocks.every((block) => block.state === 'diagram'), 'two diagrams');
    await capture('pair.png');

    // Links on nodes: a web link goes to the browser, nothing navigates the page.
    await setContent(fence('flowchart LR\\n    A[文档] --> B[本地]\\n    click A href "https://example.com/docs?q=1"\\n    click B href "other.html"'));
    await until((state) => drawn(state) && state.blocks[0].text.includes('文档'), 'the linked diagram');
    const before = await js('location.href');
    result.links = await js('[...document.querySelectorAll(".md-mermaid-canvas a")].map((a) => a.getAttribute("href") ?? a.getAttribute("xlink:href"))');
    await js('document.querySelectorAll(".md-mermaid-canvas a").forEach((a) => a.querySelector(".node, rect, span, p")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })))');
    await delay(400);
    result.stayed = (await js('location.href')) === before;
    result.opened = await js('window.__AegisMermaidOpened');

    console.log(JSON.stringify({ ok: true, result, consoleErrors }));
    app.exit(0);
  } catch (error) {
    console.error(error);
    await capture('failure.png').catch(() => {});
    app.exit(1);
  }
});
`;

  await writeFile(
    path.join(tmpDir, 'index.html'),
    '<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>'
  );
  await writeFile(path.join(tmpDir, 'harness.tsx'), harness);
  await writeFile(path.join(tmpDir, 'electron-main.cjs'), main);
}

async function main() {
  const qaRoot = path.join(projectRoot, '.aegis-design-qa');
  await mkdir(qaRoot, { recursive: true });
  const tmpDir = await mkdtemp(path.join(qaRoot, 'markdown-mermaid-'));
  let server;
  try {
    await writeHarness(tmpDir);
    server = await createServer({
      root: projectRoot,
      configFile: path.join(projectRoot, 'vite.config.ts'),
      cacheDir: path.join(tmpDir, 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, strictPort: false, watch: { ignored: ['**/.aegis-design-qa/**'] } },
    });
    await server.listen();
    const baseUrl = server.resolvedUrls?.local?.[0];
    assert.ok(baseUrl, 'Vite did not report a local URL');
    const harnessPath = path.relative(projectRoot, tmpDir).split(path.sep).join('/');
    const stdout = await runElectron(path.join(tmpDir, 'electron-main.cjs'), {
      AEGIS_MARKDOWN_MERMAID_VERIFY_URL: new URL(`${harnessPath}/index.html`, baseUrl).href,
      AEGIS_MARKDOWN_MERMAID_CAPTURE_DIR: process.env.AEGIS_MARKDOWN_MERMAID_CAPTURE_DIR || '',
    });
    const resultLine = stdout.trim().split('\n').filter(Boolean).pop();
    assert.ok(resultLine, 'Electron did not return the markdown mermaid results');
    const { ok, result, consoleErrors } = JSON.parse(resultLine);
    assert.equal(ok, true);

    for (const step of result.streaming) {
      assert.equal(step.blocks.length, 1, `one block at cut ${step.cut}`);
      assert.equal(step.blocks[0].state, 'source', `an open fence stays source at cut ${step.cut}`);
      assert.equal(step.blocks[0].error, null, `no error while streaming at cut ${step.cut}`);
    }
    assert.ok(result.streaming.at(-1).blocks[0].source.includes('G --> H'), 'the streamed source is shown');

    for (const [theme, state] of [['light', result.light], ['dark', result.dark], ['back', result.back]]) {
      const [block] = state.blocks;
      assert.equal(block.label, 'Mermaid', theme);
      assert.equal(block.nodes, 8, `${theme}: eight nodes`);
      assert.ok(block.edges >= 9, `${theme}: nine edges (${block.edges})`);
      assert.deepEqual([...block.clusters].sort(), ['支付与履约', '订单校验'], `${theme}: subgraph titles`);
      for (const text of ['库存 ≥ 下单数量?', '否 / 缺货', '提示补货 → 加入到货提醒', '失败 或 超时 ≥ 15min', '预计 24h 内发货', '完成']) {
        assert.ok(block.text.includes(text), `${theme}: "${text}" is in the diagram`);
      }
      assert.ok(!block.text.includes('<br'), `${theme}: <br/> is a line break, not text`);
      assert.ok(block.breaks >= 2, `${theme}: <br/> breaks the label (${block.breaks})`);
      assert.equal(block.clipped, 0, `${theme}: no label is cut off (${block.labels} labels)`);
      assert.ok(block.width > 200 && block.width <= block.viewportWidth, `${theme}: fits the message (${block.width}/${block.viewportWidth})`);
      assert.ok(block.height > 300, `${theme}: has its height (${block.height})`);
      assert.equal(block.scrollsSideways, false, theme);
      assert.deepEqual(block.buttons, ['Show source', 'Copy code'], theme);
      assert.equal(state.leftovers, 0, `${theme}: the measuring host is empty`);
      assert.equal(state.strayErrors, 0, `${theme}: nothing left on the page`);
      assert.ok(state.prose.includes('库存校验'), `${theme}: the text around it is kept`);
    }
    assert.notEqual(result.dark.blocks[0].nodeFill, result.light.blocks[0].nodeFill, 'node fill follows the theme');
    assert.notEqual(result.dark.blocks[0].nodeText, result.light.blocks[0].nodeText, 'label color follows the theme');

    assert.equal(result.pressedSource, true);
    assert.ok(result.source.blocks[0].source.includes('subgraph 订单校验'), 'the source view shows the code');
    assert.deepEqual(result.source.blocks[0].buttons, ['Show diagram', 'Enable word wrap', 'Copy code']);
    assert.equal(result.pressedDiagram, true);

    const wide = result.wide.blocks[0];
    assert.equal(wide.scrollsSideways, true, 'a wide diagram scrolls sideways once at its floor');
    assert.deepEqual(wide.buttons, ['Show at full size', 'Show source', 'Copy code']);
    assert.equal(result.pressedFullSize, true);
    assert.ok(result.fullSize.blocks[0].width > wide.width, 'full size is larger than the fit');
    assert.equal(result.fullSize.blocks[0].clipped, 0, 'full size cuts no label');

    const invalid = result.invalid.blocks[0];
    assert.equal(invalid.error, 'Couldn’t draw this diagram');
    assert.ok(invalid.source.includes('A[未闭合 --> B{{'), 'the source of a broken diagram is shown');
    assert.deepEqual(invalid.buttons, ['Enable word wrap', 'Copy code']);
    assert.ok(result.invalid.prose.includes('后面的文字照常显示。'), 'the rest of the answer is shown');
    assert.equal(result.invalid.leftovers, 0);
    assert.equal(result.invalid.strayErrors, 0, 'no error drawing is left on the page');

    const [first, second] = result.pair.blocks;
    assert.notEqual(first.svgId, second.svgId, 'each diagram has its own ids');
    assert.ok(second.text.includes('下单 / 支付') && second.text.includes('结果 → 成功'), 'a sequence diagram draws too');

    assert.equal(result.links.length, 2, 'both nodes are links');
    assert.equal(result.stayed, true, 'a link in a diagram does not navigate the app');
    assert.deepEqual(result.opened, ['https://example.com/docs?q=1'], 'only the web link is opened, in the browser');

    assert.deepEqual(consoleErrors, []);
    console.log('markdown mermaid Electron check passed');
  } finally {
    if (server) await server.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
}

await main();
