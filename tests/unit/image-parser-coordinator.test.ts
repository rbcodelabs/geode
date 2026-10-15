import { expect,it,vi } from "vitest";
import { fixture } from "./helpers/image-source-fixture";
import * as api from "../../src/renderer/image-inspection/parser-coordinator";
const NONE=0xffffffff;
const packed=()=>({version:1,sourceUnits:14,candidates:new Uint32Array([0,14,3,12,3,12,NONE,NONE,NONE,1,0,0]),definitions:new Uint32Array(),issues:new Uint32Array()});
const aborted=()=>Object.assign(new Error("Cancelled image parse."),{name:"AbortError"});
function context(){const f=fixture("![[Photo.png]]"),epoch={};return {...f,view:{},context:{...f.context,resolutionEpoch:epoch,currentResolutionEpoch:()=>epoch}};}
function fake(){
 const calls:{source:string;signal:AbortSignal;aborted:boolean;resolve:(value:unknown)=>void;reject:(error:Error)=>void}[]=[];
 let closes=0;
 return {calls,get closes(){return closes;},transport:{
  parse:(source:string,signal:AbortSignal)=>new Promise((resolve,reject)=>{const call={source,signal,aborted:signal.aborted,resolve,reject};signal.addEventListener("abort",()=>{call.aborted=true;},{once:true});calls.push(call);}),
  close:async()=>{closes++;for(const call of calls)call.reject(aborted());},
 }};
}
it("keeps only the latest pending intent and waits for cancellation settlement before parsing it",async()=>{
 expect(api.ImageParserCoordinator).toBeTypeOf("function");const f=fake(),c=new api.ImageParserCoordinator(()=>f.transport);
 const first=c.project(context().context,{}),firstRejected=expect(first).rejects.toMatchObject({name:"AbortError"});
 await vi.waitFor(()=>expect(f.calls).toHaveLength(1));
 const second=c.project(context().context,{}),secondRejected=expect(second).rejects.toMatchObject({name:"AbortError"});
 const latest=c.project(context().context,{});
 expect(f.calls[0].aborted).toBe(true);expect(f.calls).toHaveLength(1);
 f.calls[0].reject(aborted());await firstRejected;await secondRejected;
 await vi.waitFor(()=>expect(f.calls).toHaveLength(2));f.calls[1].resolve(packed());
 expect((await latest).status).toBe("ready");await c.close();
});
it("close stops admission synchronously and releases active and pending work before resolving",async()=>{
 const f=fake(),c=new api.ImageParserCoordinator(()=>f.transport);
 const first=c.project(context().context,{}),a=expect(first).rejects.toMatchObject({name:"AbortError"});
 await vi.waitFor(()=>expect(f.calls).toHaveLength(1));
 const pending=c.project(context().context,{}),b=expect(pending).rejects.toMatchObject({name:"AbortError"});
 const closed=c.close();expect(f.calls[0].aborted).toBe(true);
 await expect(c.project(context().context,{})).rejects.toThrow(/closed|unavailable/i);
 await closed;await a;await b;expect(f.closes).toBe(1);expect(f.calls).toHaveLength(1);await c.close();expect(f.closes).toBe(1);
});
it("a broker failure disables the epoch and rejects pending work without retrying",async()=>{
 const f=fake();let allocated=0;const c=new api.ImageParserCoordinator(()=>{allocated++;return f.transport;});
 const first=c.project(context().context,{}),a=expect(first).rejects.toThrow("synthetic broker failure");
 await vi.waitFor(()=>expect(f.calls).toHaveLength(1));f.calls[0].reject(Error("synthetic broker failure"));await a;
 const refusal=expect(c.project(context().context,{})).rejects.toThrow(/unavailable/i);expect(allocated).toBe(1);await refusal;expect(f.closes).toBe(1);
});
it("invalid initial epochs refuse work without allocating the broker",async()=>{
 let allocated=0;const f=context();const c=new api.ImageParserCoordinator(()=>{allocated++;throw Error("must not allocate");});
 // Exercise the untyped runtime boundary as well as the typed contract.
 const result=await c.project({...f.context,resolutionEpoch:undefined,currentResolutionEpoch:undefined} as unknown as Parameters<typeof c.project>[0],{});
 expect(result).toEqual({status:"unsupported",reason:"stale-owner"});expect(allocated).toBe(0);await c.close();
});
it("closing one exact owner leaves a pending different owner's latest intent eligible",async()=>{
 const f=fake(),c=new api.ImageParserCoordinator(()=>f.transport),one=context(),two=context();
 const first=c.project(one.context,one.view),a=expect(first).rejects.toMatchObject({name:"AbortError"});
 await vi.waitFor(()=>expect(f.calls).toHaveLength(1));const latest=c.project(two.context,two.view);
 const closing=c.closeOwner(one.view);f.calls[0].reject(aborted());await closing;await a;
 await vi.waitFor(()=>expect(f.calls).toHaveLength(2));f.calls[1].resolve(packed());expect((await latest).status).toBe("ready");await c.close();
});
it("deduplicates the private per-App coordinator and creates a fresh epoch only after explicit successful close",async()=>{
 const app={},f=fake();const one=api.imageParserCoordinatorFor(app,()=>f.transport),two=api.imageParserCoordinatorFor(app,()=>{throw Error("duplicate");});
 expect(two).toBe(one);await api.closeImageParserCoordinator(app);const next=api.imageParserCoordinatorFor(app,()=>f.transport);expect(next).not.toBe(one);await api.closeImageParserCoordinator(app);
});
it("a throwing transport factory disables the epoch without retrying allocation",async()=>{
 let allocated=0;const c=new api.ImageParserCoordinator(()=>{allocated++;throw Error("synthetic factory failure");});
 await expect(c.project(context().context,{})).rejects.toThrow("synthetic factory failure");
 const refused=expect(c.project(context().context,{})).rejects.toThrow(/unavailable/i);expect(allocated).toBe(1);await refused;await c.close();
});
it("retains cleanup rejection and cannot automatically replace that per-App epoch",async()=>{
 const app={};let closes=0;
 const transport={parse:async()=>packed(),close:async()=>{closes++;throw Error("synthetic cleanup failure");}};
 const c=api.imageParserCoordinatorFor(app,()=>transport);expect((await c.project(context().context,{})).status).toBe("ready");
 await expect(api.closeImageParserCoordinator(app)).rejects.toThrow("synthetic cleanup failure");
 expect(api.imageParserCoordinatorFor(app,()=>{throw Error("must not replace");})).toBe(c);
 await expect(c.project(context().context,{})).rejects.toThrow(/closed|unavailable/i);
 await expect(c.close()).rejects.toThrow("synthetic cleanup failure");expect(closes).toBe(1);
});

it("a fatal broker error after supersession disables the epoch and rejects the actual pending intent",async()=>{
 const f=fake(),c=new api.ImageParserCoordinator(()=>f.transport);
 const first=c.project(context().context,{}),a=expect(first).rejects.toThrow("synthetic fatal broker failure");
 await vi.waitFor(()=>expect(f.calls).toHaveLength(1));
 const pending=c.project(context().context,{}),b=expect(pending).rejects.toThrow("synthetic fatal broker failure");
 f.calls[0].reject(Error("synthetic fatal broker failure"));await a;await b;
 await expect(c.project(context().context,{})).rejects.toThrow(/unavailable/i);expect(f.calls).toHaveLength(1);expect(f.closes).toBe(1);await c.close();
});
it("closing a view does not cancel another view's pending intent for the same indexed file",async()=>{
 const f=fake(),c=new api.ImageParserCoordinator(()=>f.transport),shared=context(),firstView={},secondView={};
 const first=c.project(shared.context,firstView),a=expect(first).rejects.toMatchObject({name:"AbortError"});
 await vi.waitFor(()=>expect(f.calls).toHaveLength(1));const latest=c.project(shared.context,secondView);
 const closing=c.closeOwner(firstView);f.calls[0].reject(aborted());await closing;await a;
 await vi.waitFor(()=>expect(f.calls).toHaveLength(2));f.calls[1].resolve(packed());expect((await latest).status).toBe("ready");await c.close();
});
it("uses the explicit view token when closing an active request on a shared indexed file",async()=>{
 const f=fake(),c=new api.ImageParserCoordinator(()=>f.transport),shared=context(),firstView={},secondView={};
 const active=c.project(shared.context,secondView),rejected=expect(active).rejects.toMatchObject({name:"AbortError"});
 await vi.waitFor(()=>expect(f.calls).toHaveLength(1));await c.closeOwner(firstView);expect(f.calls[0].aborted).toBe(false);
 const closed=c.closeOwner(secondView);expect(f.calls[0].aborted).toBe(true);f.calls[0].reject(aborted());await closed;await rejected;await c.close();
});
it("rejects invalid render-owner tokens before transport allocation",async()=>{
 let allocations=0;const c=new api.ImageParserCoordinator(()=>{allocations++;throw Error("must not allocate");});
 for(const invalid of [undefined,null,1,"view"])await expect(c.project(context().context,invalid as unknown as object)).rejects.toThrow(/owner/i);
 expect(allocations).toBe(0);await c.close();
});
it("owner close waits for failed-epoch cleanup and surfaces its retained rejection",async()=>{
 const f=fake();let rejectCleanup!:(error:Error)=>void;
 const cleanup=new Promise<void>((_resolve,reject)=>{rejectCleanup=reject;});
 f.transport.close=()=>cleanup;
 const c=new api.ImageParserCoordinator(()=>f.transport),owner={};
 const active=c.project(context().context,owner),failed=expect(active).rejects.toThrow("synthetic fatal failure");
 await vi.waitFor(()=>expect(f.calls).toHaveLength(1));let settled=false;
 const closed=c.closeOwner(owner);const observed=closed.then(()=>{settled=true;},error=>{settled=true;throw error;});
 const rejected=expect(observed).rejects.toThrow("synthetic retirement failure");
 f.calls[0].reject(Error("synthetic fatal failure"));await failed;
 expect(settled).toBe(false);rejectCleanup(Error("synthetic retirement failure"));await rejected;
 await expect(c.close()).rejects.toThrow("synthetic retirement failure");
});
it("owner close synchronously stops future admission for that stable view token only",async()=>{
 const f=fake(),c=new api.ImageParserCoordinator(()=>f.transport),shared=context(),closedOwner={},liveOwner={};
 const active=c.project(shared.context,closedOwner),a=expect(active).rejects.toMatchObject({name:"AbortError"});await vi.waitFor(()=>expect(f.calls).toHaveLength(1));
 const closed=c.closeOwner(closedOwner);await expect(c.project(shared.context,closedOwner)).rejects.toThrow(/owner.*closed/i);
 const next=c.project(shared.context,liveOwner);f.calls[0].reject(aborted());await closed;await a;
 await expect(c.project(shared.context,closedOwner)).rejects.toThrow(/owner.*closed/i);
 await vi.waitFor(()=>expect(f.calls).toHaveLength(2));f.calls[1].resolve(packed());expect((await next).status).toBe("ready");await c.close();
});
it("repeated owner close retains a failed retirement outcome after active work has settled",async()=>{
 const f=fake();let rejectCleanup!:(error:Error)=>void;const cleanup=new Promise<void>((_resolve,reject)=>{rejectCleanup=reject;});f.transport.close=()=>cleanup;
 const c=new api.ImageParserCoordinator(()=>f.transport),owner={};const active=c.project(context().context,owner),failed=expect(active).rejects.toThrow("synthetic fatal");
 await vi.waitFor(()=>expect(f.calls).toHaveLength(1));const first=c.closeOwner(owner),a=expect(first).rejects.toThrow("synthetic cleanup");
 f.calls[0].reject(Error("synthetic fatal"));await failed;
 let settled=false;const second=c.closeOwner(owner);const b=expect(second.then(()=>{settled=true;},error=>{settled=true;throw error;})).rejects.toThrow("synthetic cleanup");
 await Promise.resolve();expect(settled).toBe(false);rejectCleanup(Error("synthetic cleanup"));await a;await b;
 await expect(c.closeOwner(owner)).rejects.toThrow("synthetic cleanup");await expect(c.close()).rejects.toThrow("synthetic cleanup");
});
it("registers owner retirement before abort listeners can reenter closeOwner",async()=>{
 const f=fake(),c=new api.ImageParserCoordinator(()=>f.transport),owner={};let reentrant:Promise<void>|undefined;
 const active=c.project(context().context,owner),rejected=expect(active).rejects.toMatchObject({name:"AbortError"});await vi.waitFor(()=>expect(f.calls).toHaveLength(1));
 f.calls[0].signal.addEventListener("abort",()=>{reentrant=c.closeOwner(owner);});
 const closing=c.closeOwner(owner);expect(reentrant).toBe(closing);f.calls[0].reject(aborted());await closing;await rejected;await c.close();
});
