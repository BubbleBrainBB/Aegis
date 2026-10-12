import React from 'react';
import { createRoot } from 'react-dom/client';
import { BoardFrame, type BoardInspector } from '../../src/ui/components/design/BoardFrame';
import { designFramePatchScript } from '../../src/shared/design-frame-patch';
import { sanitizeDesignHtml } from '../../src/shared/design-html';
import { boardsWithDrafts, type DesignDraftMessage } from '../../src/ui/components/design/design-drafts';
import type { DesignBoard } from '../../src/shared/design-types';

const results = document.querySelector('#results')!;
const messages: string[] = [];
const check = (value: unknown, label: string) => {
  if (!value) throw new Error(label);
  messages.push('PASS ' + label); results.textContent = messages.join('\n');
};
const until = async (fn: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 30)); }
  throw new Error('Timed out waiting for update');
};
const html = '<style>h1{color:navy} .scroll{height:60px;overflow:auto}</style><main data-aegis-node-id="main"><h1 data-aegis-node-id="title">Before</h1><p data-aegis-node-id="untouched">Unchanged sibling</p><input data-aegis-node-id="field" value="initial"><div data-aegis-node-id="scroll" class="scroll"><div style="height:300px">Scroll stays</div></div></main>';
const saved: DesignBoard[] = ['target','other'].map((id, i) => ({id,name:id,x:i*400,y:0,width:380,height:280,html:sanitizeDesignHtml(html),contentRevision:1,placementRevision:1}));
const api = React.createRef<BoardInspector>();
let loaded = 0;
const root = createRoot(document.querySelector('#root')!);
const render = (boards = saved) => root.render(<div style={{display:'flex',gap:20}}>{boards.map((board,i) => <BoardFrame key={board.id} ref={i===0?api:undefined} board={board} onLoad={()=>loaded++}/>)}</div>);

async function run() {
  // Exercise the exact trusted reconciler against an isolated DOM to assert identity,
  // something the production opaque-origin sandbox intentionally hides from its parent.
  const surface = document.createElement('iframe');
  surface.title = 'DOM state regression'; surface.style.height = '280px';
  const surfaceReady = new Promise<void>(resolve => { surface.onload = () => resolve(); });
  surface.srcdoc = saved[0].html; document.body.appendChild(surface); await surfaceReady;
  const doc = surface.contentDocument!;
  const child = surface.contentWindow as Window & { HTMLElement: typeof HTMLElement };
  const patch = new Function('document','DOMParser','scrollX','scrollY','scrollTo','HTMLElement',designFramePatchScript+';return patchDocument;')(doc,DOMParser,0,0,()=>{},child.HTMLElement);
  const title = doc.querySelector('h1')!, field = doc.querySelector('input')!, sibling = doc.querySelector('p')!;
  field.value = 'user input'; field.focus(); field.setSelectionRange(2,4);
  const scroller = doc.querySelector<HTMLElement>('.scroll')!; scroller.scrollTop = 80;
  patch(sanitizeDesignHtml(html.replace('Before','After')));
  check(doc.querySelector('h1') === title && title.textContent === 'After', 'changed text patches the existing node');
  check(scroller.scrollTop === 80 && doc.activeElement === field && field.selectionStart === 2 && field.selectionEnd === 4, 'scroll, focus and input selection survive a sibling edit');
  check(doc.querySelector('p') === sibling && doc.querySelector('input') === field && field.value === 'user input', 'unrelated nodes and input state survive');
  patch(sanitizeDesignHtml(html.replace('Before','After').replace('color:navy','color:red').replace('<p data-aegis-node-id="untouched">Unchanged sibling</p>', '').replace('</main>','<p data-aegis-node-id="untouched">Moved sibling</p></main>')));
  check(scroller.scrollTop === 80 && doc.activeElement === field && field.selectionStart === 2 && field.selectionEnd === 4, 'scroll and focus survive keyed sibling reordering');
  check(doc.querySelector('p') === sibling && sibling === doc.querySelector('main')!.lastElementChild, 'keyed reordering retains identity');
  check(doc.querySelector('style')!.textContent!.includes('red'), 'style updates apply');
  patch(sanitizeDesignHtml('<main data-aegis-node-id="main"><h2 data-aegis-node-id="title">Replacement</h2></main>'));
  check(!field.isConnected && doc.querySelector('h2')?.textContent === 'Replacement' && !doc.querySelector('h1'), 'deletions and tag changes apply');
  check(!/script|onerror|iframe|data-aegis-frame|nonce=/.test(sanitizeDesignHtml('<script>bad()</script><iframe></iframe><img onerror="bad()"><p nonce="x" data-aegis-frame>safe</p>')), 'shared sanitizer excludes active content and frame-owned markers');
  surface.remove();
  render(); await until(()=>loaded >= 2 && !!api.current);
  const frames = [...document.querySelectorAll('iframe')];
  const loads = [0,0]; frames.forEach((f,i)=>f.addEventListener('load',()=>loads[i]++));
  const sources = frames.map(f=>f.srcdoc);
  const draft: DesignDraftMessage = {type:'design_draft',toolUseId:'fixture',documentId:'fixture',boards:[{index:0,op:'content',boardId:'target',html:'<h1>Half',complete:false}]};
  render(boardsWithDrafts(saved,[draft]));
  await until(async()=> (await api.current!.snapshot()).some(n=>n.id==='title'&&n.text==='Before'));
  check(document.querySelectorAll('iframe')[0] === frames[0] && frames[0].srcdoc===sources[0], 'streaming replacement leaves committed board visible');
  const next = [{...saved[0],html:sanitizeDesignHtml(html.replace('Before','After local comment')),contentRevision:2},saved[1]];
  render(next);
  await until(async()=> (await api.current!.snapshot()).some(n=>n.id==='title'&&n.text==='After local comment'));
  check(frames.every((f,i)=>f===document.querySelectorAll('iframe')[i]&&f.srcdoc===sources[i]&&loads[i]===0), 'committed local update navigates neither target nor unrelated iframe');
  check((await api.current!.snapshot()).some(n=>n.id==='untouched'&&n.text==='Unchanged sibling'), 'comment anchors and unrelated content remain addressable');
  frames[0].contentWindow!.postMessage({type:'aegis-design-patch',nonce:'wrong-nonce',html:'<h1>forged</h1>'},'*');
  check((await api.current!.snapshot()).some(n=>n.id==='title'&&n.text==='After local comment'), 'wrong-nonce updates are ignored');
  render(saved);
  await until(async()=> (await api.current!.snapshot()).some(n=>n.id==='title'&&n.text==='Before'));
  check(loads.every(n=>n===0), 'undo patches back without frame navigation');
  render([{...saved[0],html:saved[0].html.replace('Before','Rapid A'),contentRevision:3},saved[1]]);
  await new Promise(r=>setTimeout(r,5)); render(saved);
  await until(async()=> (await api.current!.snapshot()).some(n=>n.id==='title'&&n.text==='Before'));
  check(loads.every(n=>n===0), 'rapid update and restore converge without navigation');
  // Deliberately break only this isolated test frame, then check bounded recovery.
  frames[0].srcdoc = '<h1>Broken test bridge</h1>';
  await new Promise(r=>setTimeout(r,40));
  render([{...saved[0],html:saved[0].html.replace('Before','Recovered'),contentRevision:4},saved[1]]);
  await until(async()=> (await api.current!.snapshot()).some(n=>n.id==='title'&&n.text==='Recovered'));
  check(document.querySelectorAll('iframe')[0]!==frames[0] && document.querySelectorAll('iframe')[1]===frames[1] && loads[1]===0, 'broken bridge recovers only the affected frame');
  results.textContent += '\nALL CHECKS PASSED';
}
run().catch(e=>{results.textContent += '\nFAIL '+e.stack;});
