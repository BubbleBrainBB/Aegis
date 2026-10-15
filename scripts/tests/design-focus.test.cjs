const assert = require('node:assert/strict');
const {mkdtempSync,rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {app} = require('electron');
const root = mkdtempSync(join(tmpdir(),'aegis-design-focus-'));
app.setPath('userData',root);
let repo;
try {
  repo = require('../../dist-electron/electron/design/service.js').getDesignRepository();
  const {setDesignFocus,designContextText,moveDesignFocus} = require('../../dist-electron/electron/design/focus.js');
  let d = repo.create('qa','Spatial QA','','create');
  let n=0;
  const write = operations => d=repo.update('qa',{documentId:d.id,operationId:`write-${++n}`,operations});
  write([{type:'canvas',expectedRevision:d.revision,pages:[{id:'one',name:'Main'},{id:'two',name:'Other'}]},
    {type:'add',name:'Home',pageId:'one',x:100,y:500,width:390,height:844},
    {type:'add',name:'Player',pageId:'one',x:570,y:600,width:390,height:844},
    {type:'add',name:'Off-page',pageId:'two',x:9000,y:-1000},
    {type:'add',name:'Auto',pageId:'one'},
    {type:'add',name:'Explicit',pageId:'one',x:-200,y:800}]);
  const [home,player,off,auto,explicit] = d.boards;
  assert.equal(auto.x,1040); assert.equal(auto.y,500,'align with smallest y on this page only');
  assert.equal(explicit.x,-200); assert.equal(explicit.y,800);
  write([{type:'canvas',expectedRevision:d.revision,pages:[...d.pages,{id:'empty',name:'Empty'}]},
    {type:'add',name:'First',pageId:'empty'}]);
  assert.equal(d.boards.at(-1).x,0); assert.equal(d.boards.at(-1).y,0);
  const {sanitizeDesignSelectionRef}=require('../../dist-electron/shared/design-selection.js');
  const snap=v=>sanitizeDesignSelectionRef(v);
  // Selection comes only from the message's snapshot; the panel's focus is open/page/visibility.
  setDesignFocus('qa',{documentId:d.id,pageId:'one',boardId:home.id,selectedBoardIds:[home.id,player.id],visibleBoardIds:[player.id,off.id,'missing']});
  let context=designContextText('qa');
  assert.doesNotMatch(context,/Selected/,'the ambient focus no longer carries a selection');
  const visible=context.split('\n').find(l=>l.startsWith('Visible boards:'));
  assert.match(visible,/"Player"/); assert.doesNotMatch(visible,/Home|Off-page|missing/);
  context=designContextText('qa',snap({documentId:d.id,boardIds:[home.id,player.id,home.id,'missing',null],label:'Home, Player'}));
  assert.match(context,/Selected boards: "Home".*x=100, y=500.*"Player"/);
  assert.equal((context.match(/Selected boards:/g)||[]).length,1);
  setDesignFocus('qa',{documentId:d.id,pageId:'one',visibleBoardIds:[],focusedBoardId:player.id});
  context=designContextText('qa',snap({documentId:d.id,boardIds:[home.id],label:'Home',contentRevision:home.contentRevision}));
  assert.match(context,/Visible boards: none/); assert.match(context,/Selected: board "Home" \(boardId /);
  assert.match(context,/Focused preview: "Player"/); assert.doesNotMatch(context,/Selected boards:|changed after/);
  // The snapshot holds even when the canvas has moved on to another page.
  setDesignFocus('qa',{documentId:d.id,pageId:'two',visibleBoardIds:[off.id]});
  assert.match(designContextText('qa',snap({documentId:d.id,boardIds:[home.id],label:'Home'})),/Current page: "Other"[\s\S]*Selected: board "Home"/);
  setDesignFocus('qa',{documentId:d.id,pageId:'one'});
  assert.doesNotMatch(designContextText('qa'),/Visible boards:/,'legacy caller retains unknown visibility');
  write([{type:'placement',boardId:home.id,expectedRevision:home.placementRevision,x:222,y:-100}]);
  assert.match(designContextText('qa',snap({documentId:d.id,boardIds:[home.id],label:'Home'})),/x=222, y=-100/,'coordinates come from the latest saved document');
  // A board edited after it was sent is called out; a vanished layer or board says so.
  const sentRevision=d.boards[0].contentRevision;
  write([{type:'content',boardId:home.id,expectedRevision:sentRevision,html:'<div data-aegis-node-id="hero" data-aegis-layer-name="Hero">Hi</div>'}]);
  context=designContextText('qa',snap({documentId:d.id,boardIds:[home.id],nodeId:'hero',label:'Hero · Home',contentRevision:sentRevision}));
  assert.match(context,/layer "Hero" \(nodeId hero\)\. The board changed after it was selected \(contentRevision \d+ → \d+\)/);
  assert.match(designContextText('qa',snap({documentId:d.id,boardIds:[home.id],nodeId:'gone',label:'Gone · Home'})),/a layer that is no longer in the board/);
  assert.match(designContextText('qa',snap({documentId:d.id,boardIds:['brd_missing'],label:'Old board'})),/Selected: "Old board", no longer in the design\./);
  // A selection in another design of this conversation names that design.
  const other=repo.create('qa','Second','','create-2');
  const otherBoard=repo.update('qa',{documentId:other.id,operationId:'o-1',operations:[{type:'add',name:'Pricing'}]}).boards[0];
  assert.match(designContextText('qa',snap({documentId:other.id,boardIds:[otherBoard.id],label:'Pricing'})),/Selected in "Second" \(documentId [^)]+\): board "Pricing"/);
  setDesignFocus('intruder',{documentId:d.id,visibleBoardIds:[home.id]});
  assert.doesNotMatch(designContextText('intruder'),/Spatial QA|Home/);
  assert.doesNotMatch(designContextText('intruder',snap({documentId:d.id,boardIds:[home.id],label:'Home'})),/Spatial QA|Home/,'a snapshot cannot reach a design the chat cannot use');
  setDesignFocus('qa',{documentId:'unrelated',open:false});
  assert.match(designContextText('qa'),/Open: "Spatial QA"/);
  setDesignFocus('qa',{documentId:d.id,open:false});
  assert.match(designContextText('qa'),/No design is open/); assert.doesNotMatch(designContextText('qa'),/Visible boards:/);
  console.log('Design focus: sent selections (single, multi, layer, changed, gone, other design), visibility, coordinates, legacy callers, access and close passed.');
} catch(e) {console.error(e);process.exitCode=1;}
finally {repo?.close();rmSync(root,{recursive:true,force:true});app.exit(process.exitCode||0);}
