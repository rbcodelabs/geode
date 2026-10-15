import {describe,expect,it,vi} from "vitest";
import {EditorState,Transaction,Text} from "@codemirror/state";
import {history,redoDepth,undoDepth} from "@codemirror/commands";
const api=await import("../../src/renderer/editor/core-adapter").catch(()=>({})) as typeof import("../../src/renderer/editor/core-adapter");
function fixture(doc:string|Text="alpha\nbeta") {
 expect(api.EditorCoreAdapter).toBeTypeOf("function");
 const transactions:Transaction[]=[];
 const native={state:EditorState.create({doc,extensions:[history(),EditorState.allowMultipleSelections.of(true)]}),hasFocus:false,dispatch(transaction:Transaction){expect(this).toBe(native);expect(transaction.startState).toBe(this.state);transactions.push(transaction);this.state=transaction.state;}};
 let current=true,editable=true;
 const host={native,isCurrent:vi.fn((instance:typeof native)=>current&&instance===native),isEditable:vi.fn(()=>editable),focus:vi.fn(()=>{native.hasFocus=true;}),blur:vi.fn(()=>{native.hasFocus=false;}),hasFocus:vi.fn(()=>native.hasFocus)};
 const editor=new api.EditorCoreAdapter(host);
 return {native,host,editor,transactions,retire:()=>{current=false;},readOnly:()=>{editable=false;},type:(text:string)=>native.dispatch(native.state.update({changes:{from:native.state.doc.length,insert:text},userEvent:"input.type"}))};
}
describe("unwired Editor core — ADR0036 Geode policy, not an Obsidian oracle",()=>{
 it("reads the live LF buffer, clamps lines and handles an empty document",()=>{
  const f=fixture("");expect(f.editor.getDoc()).toBe(f.editor);expect(f.editor.getValue()).toBe("");expect(f.editor.lineCount()).toBe(1);expect(f.editor.lastLine()).toBe(0);expect(f.editor.getLine(99)).toBe("");
  f.type("first\r\nsecond");expect(f.editor.getValue()).toBe("first\nsecond");expect(f.editor.getLine(-3)).toBe("first");expect(f.editor.getLine(90)).toBe("second");expect(f.editor.lineCount()).toBe(2);expect(f.editor.lastLine()).toBe(1);
 });
 it("converts every UTF16 offset including surrogate halves, combining marks and newline boundaries",()=>{
  const f=fixture("A😀e\u0301\nβ\n");for(let offset=0;offset<=f.native.state.doc.length;offset++){const p=f.editor.offsetToPos(offset);expect(f.editor.posToOffset(p)).toBe(offset);}
  expect(f.editor.offsetToPos(2)).toEqual({line:0,ch:2});expect(f.editor.posToOffset({line:1,ch:1})).toBe(7);expect(f.editor.offsetToPos(5)).toEqual({line:0,ch:5});expect(f.editor.offsetToPos(6)).toEqual({line:1,ch:0});
  expect(f.editor.offsetToPos(-10)).toEqual({line:0,ch:0});expect(f.editor.offsetToPos(999)).toEqual({line:2,ch:0});expect(f.editor.posToOffset({line:-5,ch:999})).toBe(5);expect(f.editor.posToOffset({line:999,ch:-2})).toBe(8);
 });
 it("rejects malformed numeric inputs without changing state or dispatching",()=>{
  const f=fixture(),state=f.native.state;
  for(const value of [NaN,Infinity,-Infinity,0.5]){for(const call of [()=>f.editor.getLine(value),()=>f.editor.offsetToPos(value),()=>f.editor.posToOffset({line:value,ch:0}),()=>f.editor.posToOffset({line:0,ch:value}),()=>f.editor.setCursor(value,0)])expect(call).toThrow();}
  expect(()=>f.editor.posToOffset(null as never)).toThrow();expect(()=>f.editor.setValue(8 as never)).toThrow();expect(()=>f.editor.replaceRange("x",{line:0,ch:0},undefined,8 as never)).toThrow();expect(f.native.state).toBe(state);expect(f.transactions).toHaveLength(0);
 });
 it("returns fresh positions and selections while preserving reversed main and secondary selections",()=>{
  const f=fixture("abcdef");f.editor.setSelections([{anchor:{line:0,ch:5},head:{line:0,ch:3}},{anchor:{line:0,ch:1}}],0);
  expect(f.editor.getCursor()).toEqual({line:0,ch:3});expect(f.editor.getCursor("anchor")).toEqual({line:0,ch:5});expect(f.editor.getCursor("from")).toEqual({line:0,ch:3});expect(f.editor.getCursor("to")).toEqual({line:0,ch:5});expect(f.editor.getSelection()).toBe("de");
  const selections=f.editor.listSelections(),cursor=f.editor.getCursor();selections[0].anchor.ch=99;cursor.ch=99;expect(f.editor.getCursor()).toEqual({line:0,ch:3});expect(f.editor.listSelections()).toEqual([{anchor:{line:0,ch:1},head:{line:0,ch:1}},{anchor:{line:0,ch:5},head:{line:0,ch:3}}]);
 });
 it("uses the requested main selection by identity after CM sorting and normalization",()=>{
  const f=fixture("abcdef");f.editor.setSelections([{anchor:{line:0,ch:5}},{anchor:{line:0,ch:1},head:{line:0,ch:2}}],0);expect(f.editor.getCursor()).toEqual({line:0,ch:5});expect(f.editor.getSelection()).toBe("");expect(f.editor.somethingSelected()).toBe(true);
  f.editor.setSelections([{anchor:{line:0,ch:1}},{anchor:{line:0,ch:1}}],1);expect(f.editor.listSelections()).toHaveLength(1);expect(f.editor.getCursor()).toEqual({line:0,ch:1});
 });
 it("rejects empty or invalid selections atomically",()=>{
  const f=fixture(),state=f.native.state;for(const call of [()=>f.editor.setSelections([]),()=>f.editor.setSelections([{anchor:{line:0,ch:0}}],-1),()=>f.editor.setSelections([{anchor:{line:0,ch:0}}],1),()=>f.editor.setSelections([{anchor:{line:0,ch:0}}],0.5),()=>f.editor.setSelections([{anchor:{line:0,ch:0}},{anchor:{line:NaN,ch:0}}])])expect(call).toThrow();expect(f.native.state).toBe(state);expect(f.transactions).toHaveLength(0);
 });
 it("normalizes reversed explicit ranges and inserts when the end is absent",()=>{
  const f=fixture("abc\ndef");expect(f.editor.getRange({line:1,ch:2},{line:0,ch:1})).toBe("bc\nde");f.editor.replaceRange("X",{line:1,ch:2},{line:0,ch:1},"input.plugin");expect(f.editor.getValue()).toBe("aXf");expect(f.transactions).toHaveLength(1);expect(f.transactions[0].annotation(Transaction.userEvent)).toBe("input.plugin");
  f.editor.replaceRange("!",{line:99,ch:99});expect(f.editor.getValue()).toBe("aXf!");expect(f.transactions[1].annotation(Transaction.userEvent)).toBeUndefined();
 });
 it("replaces all selections once and preserves CM's mapped main selection",()=>{
  const f=fixture("abcdef");f.editor.setSelections([{anchor:{line:0,ch:0},head:{line:0,ch:1}},{anchor:{line:0,ch:5},head:{line:0,ch:3}}],1);f.transactions.length=0;f.editor.replaceSelection("XY");expect(f.editor.getValue()).toBe("XYbcXYf");expect(f.transactions).toHaveLength(1);expect(f.editor.getCursor()).toEqual({line:0,ch:6});expect(f.editor.listSelections()).toHaveLength(2);f.editor.undo();expect(f.editor.getValue()).toBe("abcdef");f.editor.redo();expect(f.editor.getValue()).toBe("XYbcXYf");
 });
 it("isolates each public mutation from adjacent typing as one undo step",()=>{
  const f=fixture("a");f.type("b");f.editor.replaceRange("X",{line:0,ch:2});f.type("c");expect(f.editor.getValue()).toBe("abXc");expect(undoDepth(f.native.state)).toBe(3);f.editor.undo();expect(f.editor.getValue()).toBe("abX");f.editor.undo();expect(f.editor.getValue()).toBe("ab");f.editor.undo();expect(f.editor.getValue()).toBe("a");expect(redoDepth(f.native.state)).toBe(3);f.editor.redo();f.editor.redo();f.editor.redo();expect(f.editor.getValue()).toBe("abXc");
 });
 it("setLine preserves line boundaries and setValue retains existing history",()=>{
  const f=fixture("one\ntwo\nthree");f.editor.setLine(1,"SECOND");expect(f.editor.getValue()).toBe("one\nSECOND\nthree");expect(f.transactions).toHaveLength(1);f.editor.setValue("replacement\r\ntext");expect(f.editor.getValue()).toBe("replacement\ntext");expect(f.transactions).toHaveLength(2);f.editor.undo();expect(f.editor.getValue()).toBe("one\nSECOND\nthree");f.editor.undo();expect(f.editor.getValue()).toBe("one\ntwo\nthree");
 });
 it("selection-only methods do not create a content undo step",()=>{
  const f=fixture();f.editor.setCursor(1,2);f.editor.setSelection({line:0,ch:3});expect(f.editor.getCursor()).toEqual({line:0,ch:3});expect(undoDepth(f.native.state)).toBe(0);expect(f.transactions.every(tr=>!tr.docChanged)).toBe(true);
 });
 it("allows read/selection/focus on a current noneditable owner but no content, history or legacy dispatch",()=>{
  const f=fixture();f.readOnly();const reads=f.editor.getValue();f.editor.setCursor({line:0,ch:1});f.editor.focus();expect(f.editor.hasFocus()).toBe(true);f.editor.blur();expect(f.editor.hasFocus()).toBe(false);expect(typeof f.native.hasFocus).toBe("boolean");const before=f.native.state,count=f.transactions.length;
  for(const call of [()=>f.editor.setValue("x"),()=>f.editor.setLine(0,"x"),()=>f.editor.replaceSelection("x"),()=>f.editor.replaceRange("x",{line:0,ch:0}),()=>f.editor.undo(),()=>f.editor.redo(),()=>f.editor.dispatch({changes:{from:0,insert:"x"}})])expect(call).toThrow(/editable/i);expect(f.editor.getValue()).toBe(reads);expect(f.native.state).toBe(before);expect(f.transactions).toHaveLength(count);
 });
 it("refuses all stale operations and never follows a new native instance",()=>{
  const f=fixture();f.retire();const state=f.native.state;for(const call of [()=>f.editor.getDoc(),()=>f.editor.getValue(),()=>f.editor.getLine(0),()=>f.editor.lineCount(),()=>f.editor.lastLine(),()=>f.editor.getRange({line:0,ch:0},{line:0,ch:1}),()=>f.editor.getSelection(),()=>f.editor.somethingSelected(),()=>f.editor.getCursor(),()=>f.editor.listSelections(),()=>f.editor.posToOffset({line:0,ch:0}),()=>f.editor.offsetToPos(0),()=>f.editor.setCursor(0,0),()=>f.editor.setSelections([{anchor:{line:0,ch:0}}]),()=>f.editor.focus(),()=>f.editor.blur(),()=>f.editor.hasFocus(),()=>f.editor.cm,()=>f.editor.state,()=>f.editor.setValue("x"),()=>f.editor.undo(),()=>f.editor.redo()])expect(call).toThrow(/unavailable/i);expect(f.native.state).toBe(state);expect(f.transactions).toHaveLength(0);expect(f.host.focus).not.toHaveBeenCalled();
 });
 it("keeps explicit legacy access bound, without raw CM mutation or forwarding unknown fields",()=>{
  const f=fixture();expect(f.editor.cm).toBe(f.native);expect(f.editor.state).toBe(f.native.state);const dispatch=f.editor.dispatch;dispatch({changes:{from:0,to:5,insert:"LIVE"}});expect(f.editor.getValue()).toBe("LIVE\nbeta");expect(f.editor.state).toBe(f.native.state);expect((f.editor as unknown as {unknown?:unknown}).unknown).toBeUndefined();expect(typeof f.native.hasFocus).toBe("boolean");
 });
});

it("works directly with CM Text and keeps captured native instances isolated",()=>{
 const first=fixture(Text.of(["A😀","e\u0301"])),second=fixture("same independent buffer");const captured=first.native;first.host.native=second.native;expect(first.editor.cm).toBe(captured);first.editor.replaceRange("!",{line:1,ch:2});expect(first.editor.getValue()).toBe("A😀\ne\u0301!");expect(second.editor.getValue()).toBe("same independent buffer");first.retire();expect(()=>first.editor.getValue()).toThrow(/unavailable/);second.editor.setValue("other");expect(captured.state.doc.toString()).toBe("A😀\ne\u0301!");
});
it("does not mutate caller selections and does not retain their position objects",()=>{
 const f=fixture("abcdef"),ranges=[{anchor:{line:0,ch:5},head:{line:0,ch:3}},{anchor:{line:0,ch:1},head:{line:0,ch:1}}],original=structuredClone(ranges);f.editor.setSelections(ranges,0);expect(ranges).toEqual(original);ranges[0].anchor.ch=0;ranges[0].head.ch=0;expect(f.editor.getCursor("anchor")).toEqual({line:0,ch:5});expect(f.editor.getCursor()).toEqual({line:0,ch:3});
});
it("does not dispatch empty undo or redo operations",()=>{
 const f=fixture();f.editor.undo();f.editor.redo();expect(f.transactions).toHaveLength(0);
});
it("isolates every content mutation from typing and publishes one transaction",()=>{
 for(const mutate of [(f:ReturnType<typeof fixture>)=>f.editor.setValue("new"),(f:ReturnType<typeof fixture>)=>f.editor.setLine(0,"new"),(f:ReturnType<typeof fixture>)=>f.editor.replaceRange("new",{line:0,ch:0}),(f:ReturnType<typeof fixture>)=>f.editor.replaceSelection("new")]){const f=fixture("original");f.type("!");const before=f.editor.getValue(),count=f.transactions.length;mutate(f);const changed=f.editor.getValue();expect(f.transactions.length-count).toBe(1);f.type("?");expect(undoDepth(f.native.state)).toBe(3);f.editor.undo();expect(f.editor.getValue()).toBe(changed);f.editor.undo();expect(f.editor.getValue()).toBe(before);f.editor.undo();expect(f.editor.getValue()).toBe("original");}
});
