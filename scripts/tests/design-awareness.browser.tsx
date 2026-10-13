import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {DesignCanvas} from '../../src/ui/components/design/DesignCanvas';
import type {DesignBoard,DesignCanvasAwareness} from '../../src/shared/design-types';
import '../../src/ui/index.css';
import '../../src/ui/components/design/design.css';
import '../../src/ui/components/design/design-claude.css';
const board=(id:string,x:number):DesignBoard=>({id,name:id,x,y:500,width:390,height:400,html:`<main style="padding:30px;background:#eee;height:400px"><h1>${id}</h1><p>World coordinates: x=${x}, y=500</p></main>`,contentRevision:1,placementRevision:1});
const pages={one:[board('Home',0),board('Player',470),board('Offscreen',3000)],two:[board('Second-page',0)]};
for(const page of ['one','two'])localStorage.setItem('spatial-qa-'+page,JSON.stringify({x:40,y:-400,zoom:1}));
function App(){
 const [page,setPage]=useState<'one'|'two'>('one'),[small,setSmall]=useState(false),[selected,setSelected]=useState<string[]>([]),[awareness,setAwareness]=useState<DesignCanvasAwareness>({visibleBoardIds:[]});
 return <><nav><button onClick={()=>{setPage('one');setSelected([])}}>Page one</button><button onClick={()=>{setPage('two');setSelected([])}}>Page two</button><button onClick={()=>setSmall(s=>!s)}>Resize viewport</button></nav>
 <pre id="context" aria-label="Reported context">{JSON.stringify({page,selected,...awareness},null,2)}</pre>
 <div className="design-panel" style={{position:"relative",inset:"auto",width:small?450:950,height:500}}><DesignCanvas key={page} boards={pages[page]} storageKey={'spatial-qa-'+page} selectedIds={selected} editable onSelectionChange={setSelected} onAwarenessChange={setAwareness} onElementSelect={()=>{}} onElementCommand={()=>{}} onChange={async()=>{}} onPreviewChange={()=>{}}/></div></>;
}
createRoot(document.getElementById('root')!).render(<App/>);
