import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { SelectionTools, selectionStyleEdit } from '../../src/ui/components/design/SelectionTools';
import { DesignFloatingToolbar } from '../../src/ui/components/design/DesignChrome';
import { normalizeDesignLayers, readDesignLayers, findDesignLayer } from '../../src/shared/design-layers';
import { designFrameHtml } from '../../src/shared/design-frame';
import type { DesignBoard, DesignAnchor } from '../../src/shared/design-types';
import '../../src/ui/components/design/design.css';
import '../../src/ui/components/design/design-claude.css';
const results=document.querySelector('#results')!;
const check=(ok:unknown,label:string)=>{if(!ok)throw Error(label);results.textContent+='PASS '+label+'\n';};
const cases = {
 Text:'<p id="target" style="color:#232333;font:400 18px/1.5 system-ui;text-decoration:line-through">BubbleBrain</p>',
 Button:'<button id="target" style="background:#4f5bd5;color:white;width:358px;height:52px;border:0;border-radius:12px;font:600 17px system-ui">生成播客</button>',
 Container:'<div id="target" style="background:#e5e7eb;padding:20px;border:1px solid #aaa"><p>Keep nested content</p></div>',
 Image:'<img id="target" alt="Fixture image" style="width:220px;height:100px;object-fit:contain" src="data:image/svg+xml,%3Csvg xmlns=\"http://www.w3.org/2000/svg\" width=\"120\" height=\"80\"%3E%3Crect width=\"120\" height=\"80\" fill=\"%234f5bd5\"/%3E%3C/svg%3E">',
 Vector:'<svg width="200" height="100"><rect id="target" width="150" height="60" fill="#4f5bd5" stroke="#333" stroke-width="2"/></svg>',
 Locked:'<section data-aegis-locked="true"><p id="target">Locked by parent</p></section>',
};
const boardFor=(name:keyof typeof cases)=>({id:'qa',name:'QA',html:normalizeDesignLayers(`<body style="padding:20px">${cases[name]}<p id="other">Unrelated text</p></body>`),contentRevision:1,placementRevision:1,x:0,y:0,width:500,height:220} as DesignBoard);
const targetId=(html:string)=>new DOMParser().parseFromString(html,'text/html').querySelector('#target')!.getAttribute('data-aegis-node-id')!;
const anchorFor=(b:DesignBoard):DesignAnchor=>{const n=targetId(b.html);const el=new DOMParser().parseFromString(b.html,'text/html').querySelector('#target') as HTMLElement;return {nodeId:n,computedStyles:Object.fromEntries(Array.from(el.style).map(k=>[k,el.style.getPropertyValue(k)]))};};
async function run(){
 for(const name of Object.keys(cases) as (keyof typeof cases)[]){
  const b=boardFor(name),anchor=anchorFor(b),div=document.createElement('div');
  div.innerHTML=renderToStaticMarkup(<SelectionTools board={b} anchor={anchor} revision={1} editable onChange={async()=>{}} onEditText={()=>{}} onComment={()=>{}} onProperties={()=>{}}/>);
  const has=(label:string)=>!!div.querySelector(`[aria-label="${label}"]`);
  check(!has('Quick edit')&&!has('Layers')&&!div.textContent?.includes('Duplicate'),name+': no obsolete actions');
  check(has('Comment')&&has('Properties'),name+': shared actions available');
  if(name==='Text')check(has('Bold')&&has('Italic')&&has('Underline')&&has('Text style')&&!has('Fill'),'Text: contextual formatting');
  if(name==='Button')check(has('Text style')&&has('Fill')&&has('Border')&&!has('Bold'),'Button: typography and surface controls');
  if(name==='Container')check(has('Fill')&&has('Border')&&!has('Text style'),'Container: no misleading text controls');
  if(name==='Image')check(has('Image fit')&&!has('Fill')&&!has('Text style'),'Image: image-specific controls');
  if(name==='Vector')check(has('Stroke')&&has('Stroke width')&&!has('Text style'),'Vector: paint and stroke controls');
  if(name==='Locked')check(div.querySelector('[aria-label="Text style"]')?.hasAttribute('disabled'),'Locked parent disables mutations');
 }
 const board=boardFor('Container'),id=targetId(board.html);
 const changed=selectionStyleEdit(board,1,id,{'background-color':'#ef4444','border-radius':'8px'});
 const doc=new DOMParser().parseFromString(changed,'text/html'),el=doc.querySelector('#target') as HTMLElement;
 check(el.style.backgroundColor==='rgb(239, 68, 68)'&&el.style.borderRadius==='8px','Multiple style values saved in one change');
 check(el.style.getPropertyPriority('background-color')==='important','Overrides stylesheet declarations');
 check(el.textContent==='Keep nested content'&&doc.querySelector('#other')?.textContent==='Unrelated text','Nested and unrelated content preserved');
 check(targetId(changed)===id,'Layer identity preserved');
 for(const [label,run]of [
  ['stale revision',()=>selectionStyleEdit(board,0,id,{color:'red'})],
  ['invalid CSS',()=>selectionStyleEdit(board,1,id,{color:'not-a-color'})],
  ['missing node',()=>selectionStyleEdit(board,1,'missing',{color:'red'})],
  ['locked ancestor',()=>{const b=boardFor('Locked');selectionStyleEdit(b,1,targetId(b.html),{color:'red'});}]
 ] as const){let rejected=false;try{run()}catch{rejected=true}check(rejected,'Rejects '+label);}
 results.textContent+='ALL CHECKS PASSED';
}
function App(){
 const [name,setName]=useState<keyof typeof cases>('Text'),[board,setBoard]=useState(boardFor('Text'));
 const [anchor,setAnchor]=useState<DesignAnchor>(anchorFor(board)),[revision,setRevision]=useState(0),[history,setHistory]=useState<DesignBoard[]>([]),[message,setMessage]=useState('Ready');
 const frame=useRef<HTMLIFrameElement>(null);
 const load=()=>{const el=frame.current!.contentDocument!.querySelector('#target')!,css=frame.current!.contentWindow!.getComputedStyle(el);setAnchor({nodeId:targetId(board.html),computedStyles:Object.fromEntries(Array.from(css).map(k=>[k,css.getPropertyValue(k)]))});setRevision(board.contentRevision)};
 return <><nav>{Object.keys(cases).map(n=><button key={n} onClick={()=>{setName(n as keyof typeof cases);setBoard(boardFor(n as keyof typeof cases));setRevision(0);setHistory([])}}>{n}</button>)}<button disabled={!history.length} onClick={()=>{setBoard(history.at(-1)!);setHistory(history.slice(0,-1));setMessage('Undone')}}>Undo</button></nav><p role="status">{message} · revision {board.contentRevision}</p><div className="design-panel" id="fixture"><DesignFloatingToolbar rect={{x:30,y:80,width:400,height:50}} viewport={{width:700,height:370}}><SelectionTools key={name} board={board} anchor={anchor} revision={revision} editable onChange={async(b,html)=>{setHistory([...history,b]);setBoard({...b,html,contentRevision:b.contentRevision+1});setRevision(0);setMessage('Saved')}} onEditText={()=>setMessage('Edit text invoked')} onComment={()=>setMessage('Comment invoked')} onProperties={()=>setMessage('Properties invoked')}/></DesignFloatingToolbar><iframe ref={frame} title="QA preview" className="qa-preview" srcDoc={designFrameHtml(board.html,'selection-qa')} onLoad={load}/></div></>;
}
createRoot(document.querySelector('#app')!).render(<App/>);run().catch(e=>results.textContent+='FAIL '+e.stack);
