import assert from 'node:assert/strict';
import { boardIdsInView } from '../../src/ui/components/design/canvas-geometry';
const boards = [
  {id:'home',x:0,y:500,width:390,height:844},
  {id:'player',x:470,y:500,width:390,height:844},
  {id:'other',x:3000,y:-400,width:390,height:844},
];
assert.deepEqual(boardIdsInView(boards,{x:0,y:-500,zoom:1},{width:900,height:600}),['home','player']);
assert.deepEqual(boardIdsInView(boards,{x:-500,y:-500,zoom:1},{width:400,height:600}),['player']);
assert.deepEqual(boardIdsInView(boards,{x:0,y:-250,zoom:.5},{width:450,height:300}),['home','player'],'zoom and matching viewport retain world coverage');
assert.deepEqual(boardIdsInView(boards,{x:0,y:-500,zoom:1},{width:390,height:600}),['home'],'touching edges alone do not count');
assert.deepEqual(boardIdsInView(boards,{x:0,y:0,zoom:1},{width:0,height:600}),[],'hidden pane has no visible boards');
assert.deepEqual(boardIdsInView(boards,{x:0,y:0,zoom:0},{width:900,height:600}),[]);
assert.deepEqual(boardIdsInView(boards,{x:10000,y:10000,zoom:1},{width:900,height:600}),[],'empty viewport is explicit');
console.log('Canvas awareness: pan, zoom, intersection, resize and empty viewport passed.');
