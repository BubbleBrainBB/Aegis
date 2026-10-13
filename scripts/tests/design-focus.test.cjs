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
  setDesignFocus('qa',{documentId:d.id,pageId:'one',selectedBoardIds:[home.id,player.id,home.id,off.id,'missing',null],visibleBoardIds:[player.id,off.id,'missing']});
  let context=designContextText('qa');
  assert.match(context,/Selected boards: "Home".*x=100, y=500.*"Player"/);
  const visible=context.split('\n').find(l=>l.startsWith('Visible boards:'));
  assert.match(visible,/"Player"/); assert.doesNotMatch(visible,/Home|Off-page|missing/);
  assert.equal((context.match(/Selected boards:/g)||[]).length,1);
  setDesignFocus('qa',{documentId:d.id,pageId:'one',boardId:home.id,selectedBoardIds:[home.id],visibleBoardIds:[],focusedBoardId:player.id});
  context=designContextText('qa');
  assert.match(context,/Visible boards: none/); assert.match(context,/Selected: board "Home"/);
  assert.match(context,/Focused preview: "Player"/); assert.doesNotMatch(context,/Selected boards:/);
  setDesignFocus('qa',{documentId:d.id,pageId:'two',boardId:home.id,selectedBoardIds:[home.id,player.id],visibleBoardIds:[home.id,player.id]});
  context=designContextText('qa');
  assert.doesNotMatch(context,/Selected:|Selected boards:|"Home"|"Player"/,'stale state is filtered on page switches');
  setDesignFocus('qa',{documentId:d.id,pageId:'one',boardId:home.id});
  context=designContextText('qa');
  assert.match(context,/Selected: board "Home"/); assert.doesNotMatch(context,/Visible boards:/,'legacy caller retains unknown visibility');
  write([{type:'placement',boardId:home.id,expectedRevision:home.placementRevision,x:222,y:-100}]);
  assert.match(designContextText('qa'),/x=222, y=-100/,'coordinates come from the latest saved document');
  setDesignFocus('intruder',{documentId:d.id,visibleBoardIds:[home.id]});
  assert.doesNotMatch(designContextText('intruder'),/Spatial QA|Home/);
  setDesignFocus('qa',{documentId:'unrelated',open:false});
  assert.match(designContextText('qa'),/Open: "Spatial QA"/);
  setDesignFocus('qa',{documentId:d.id,open:false});
  assert.match(designContextText('qa'),/No design is open/); assert.doesNotMatch(designContextText('qa'),/Visible boards:/);
  console.log('Design focus: multi-selection, visibility, coordinates, page filtering, legacy callers, access and close passed.');
} catch(e) {console.error(e);process.exitCode=1;}
finally {repo?.close();rmSync(root,{recursive:true,force:true});app.exit(process.exitCode||0);}
