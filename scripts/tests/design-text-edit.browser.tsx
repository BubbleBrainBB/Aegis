import React from 'react';
import { createRoot } from 'react-dom/client';
import { InlineTextEditor } from '../../src/ui/components/design/InlineTextEditor';
import { designFrameHtml } from '../../src/shared/design-frame';
import { editableLayerStyles } from '../../src/shared/design-layers';
import { designTextStyles } from '../../src/shared/design-text';
import '../../src/ui/components/design/design.css';

const stage = document.querySelector<HTMLElement>('#stage')!;
const root = createRoot(document.querySelector('#root')!);
const results = document.querySelector('#results')!;
const messages: string[] = [];
function check(value: unknown, label: string) {
  if (!value) throw new Error(label);
  messages.push('PASS '+label); results.textContent=messages.join('\n');
}
const tick = () => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
const textRect = (node: Node) => { const r=node.ownerDocument!.createRange();r.selectNodeContents(node);return r.getBoundingClientRect(); };
const fixtures = [
  ['Purple CTA', '<div style="height:52px;display:flex;align-items:center;justify-content:center;background:#4f46d5;color:white;border-radius:10px;font:600 15px/20px system-ui">生成播客</div>'],
  ['Plain text', '<p style="margin:0;font:600 15px/20px system-ui;color:#222">BubbleBrain</p>'],
  ['Native button', '<button style="width:358px;height:52px;background:#4f46d5;color:white;border:2px solid #332c99;border-radius:10px;font:600 15px/20px system-ui">生成播客</button>'],
  ['Grid badge', '<div style="display:grid;place-items:center;height:52px;background:linear-gradient(90deg,#483faa,#272344);color:white;border:3px solid currentColor;font:600 15px/20px system-ui">生成播客</div>'],
] as const;
async function run() {
  for (const zoom of [0.6,1]) for (const [label, markup] of fixtures) {
    root.render(null); await tick();
    stage.querySelector('iframe')?.remove();
    const nonce=crypto.randomUUID();
    const f=document.createElement('iframe');f.title=label;f.width='400';f.height='180';f.style.transform=`scale(${zoom})`;
    const ready=new Promise<void>(r=>{f.onload=()=>r();});
    f.srcdoc=designFrameHtml(`<body style="padding:20px"><main style="width:358px">${markup}</main></body>`,nonce);
    stage.prepend(f);await ready;
    // Same-origin only in this isolated fixture, to measure real glyph geometry.
    const doc=f.contentDocument!,win=f.contentWindow!,target=doc.querySelector('main')!.firstElementChild as HTMLElement;
    const sourceStyle=target.getAttribute('style'),before=win.getComputedStyle(target),background=before.backgroundImage+' '+before.backgroundColor,border=before.borderColor;
    const styles=Object.fromEntries([...editableLayerStyles,...designTextStyles].map(k=>[k,before.getPropertyValue(k)]));styles['element-tag']=target.tagName.toLowerCase();
    const box=target.getBoundingClientRect(),glyph=textRect(target),fr=f.getBoundingClientRect(),sr=stage.getBoundingClientRect();
    const rect={x:fr.x-sr.x+box.x*zoom,y:fr.y-sr.y+box.y*zoom,width:box.width*zoom,height:box.height*zoom};
    win.postMessage({type:'aegis-design-mask',nonce,nodeId:target.getAttribute('data-aegis-node-id')},'*');await tick();
    const masked=win.getComputedStyle(target);
    check(masked.visibility!=='hidden'&&masked.backgroundImage+' '+masked.backgroundColor===background&&masked.borderColor===border,`${label} @${zoom}: original background and border remain`);
    check(masked.getPropertyValue('-webkit-text-fill-color')==='rgba(0, 0, 0, 0)'&&target.getAttribute('style')===sourceStyle,`${label} @${zoom}: only glyphs are hidden, authored styles untouched`);
    root.render(<InlineTextEditor rect={rect} zoom={zoom} styles={styles} text={target.textContent!} onCommit={()=>{}} onCancel={()=>{}}/>);await tick();
    const editor=document.querySelector<HTMLElement>('.design-inline-text')!,edited=textRect(editor);
    const expected={x:fr.x+glyph.x*zoom,y:fr.y+glyph.y*zoom};
    check(Math.abs(edited.x-expected.x)<1.5&&Math.abs(edited.y-expected.y)<1.5,`${label} @${zoom}: edited text stays aligned (dx=${(edited.x-expected.x).toFixed(2)}, dy=${(edited.y-expected.y).toFixed(2)})`);
    check(getComputedStyle(editor).color===styles.color,`${label} @${zoom}: original text color retained`);
    win.postMessage({type:'aegis-design-mask',nonce,nodeId:null},'*');await tick();
    check(!target.hasAttribute('data-aegis-masked')&&target.getAttribute('style')===sourceStyle,`${label} @${zoom}: leaving edit restores original text`);
  }
  results.textContent+='\nALL CHECKS PASSED';
}
run().catch(e=>{results.textContent+='\nFAIL '+e.stack;});
