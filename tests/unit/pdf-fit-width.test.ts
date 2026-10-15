import {afterEach,expect,it,vi} from "vitest";
const api=await import("../../src/renderer/pdf/fit-width").catch(()=>({})) as typeof import("../../src/renderer/pdf/fit-width");
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
it("ignores height-only changes so rendering status cannot perpetually reset layout persistence",()=>{
 expect(api.observePdfFitWidth).toBeTypeOf("function");vi.useFakeTimers();let resized!:()=>void;const disconnect=vi.fn();vi.stubGlobal("ResizeObserver",class{constructor(callback:()=>void){resized=callback;}observe(){}disconnect=disconnect;});const viewport={clientWidth:600},render=vi.fn(),stop=api.observePdfFitWidth(viewport as HTMLElement,render);
 for(let i=0;i<8;i++){resized();vi.advanceTimersByTime(150);}expect(render).not.toHaveBeenCalled();viewport.clientWidth=500;resized();vi.advanceTimersByTime(50);viewport.clientWidth=450;resized();vi.advanceTimersByTime(120);expect(render).toHaveBeenCalledOnce();resized();vi.advanceTimersByTime(200);expect(render).toHaveBeenCalledOnce();viewport.clientWidth=400;resized();stop();vi.advanceTimersByTime(200);expect(render).toHaveBeenCalledOnce();expect(disconnect).toHaveBeenCalledOnce();
});
it("handles hidden-to-visible width once and ignores queued notices after disposal",()=>{
 vi.useFakeTimers();let resized!:()=>void;vi.stubGlobal("ResizeObserver",class{constructor(callback:()=>void){resized=callback;}observe(){}disconnect(){}});const viewport={clientWidth:0},render=vi.fn(),stop=api.observePdfFitWidth(viewport as HTMLElement,render);resized();vi.advanceTimersByTime(200);expect(render).not.toHaveBeenCalled();viewport.clientWidth=600;resized();vi.advanceTimersByTime(120);expect(render).toHaveBeenCalledOnce();stop();viewport.clientWidth=700;resized();vi.advanceTimersByTime(200);expect(render).toHaveBeenCalledOnce();
});
