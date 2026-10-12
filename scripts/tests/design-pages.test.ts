import assert from 'node:assert/strict';
import { designForPage, designPageId, designPages } from '../../src/shared/design-pages';
import type { DesignDocument } from '../../src/shared/design-types';
const document = { id:'doc', sessionId:'session',title:'QA',brief:'',revision:1,createdAt:1,updatedAt:1,
  pages:[{id:'one',name:'First'},{id:'two',name:'Second'}],
  boards:[{id:'legacy'},{id:'invalid',pageId:'missing'},{id:'second',pageId:'two'}],
  marks:[{id:'note-legacy'},{id:'note-second',pageId:'two'}],
  comments:[{id:'first-comment',boardId:'legacy'},{id:'second-comment',boardId:'second'}]
} as DesignDocument;
assert.deepEqual(designPages({}),[{id:'page-1',name:'Page 1'}]);
assert.equal(designPageId(document,{}),'one');
assert.equal(designPageId(document,{pageId:'missing'}),'one');
const first=designForPage(document,'one');
assert.deepEqual(first.boards.map(x=>x.id),['legacy','invalid']);
assert.deepEqual(first.marks?.map(x=>x.id),['note-legacy']);
assert.deepEqual(first.comments.map(x=>x.id),['first-comment']);
const second=designForPage(document,'two');
assert.deepEqual(second.boards.map(x=>x.id),['second']);
assert.deepEqual(second.marks?.map(x=>x.id),['note-second']);
assert.deepEqual(second.comments.map(x=>x.id),['second-comment']);
assert.equal(document.boards.length,3);
assert.throws(()=>designForPage(document,'missing'),/no longer exists/);
console.log('Design pages: legacy fallback and page-scoped export isolation passed.');
