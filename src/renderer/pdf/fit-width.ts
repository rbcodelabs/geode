/** Own the fit-width resize subscription independently of the PDF engine. */
export function observePdfFitWidth(viewport:HTMLElement,render:()=>void):()=>void {
  let active=true;
  let width=viewport.clientWidth;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const observer=new ResizeObserver(()=>{
    if(!active)return;
    const next=viewport.clientWidth;
    if(next===width)return;
    width=next;
    clearTimeout(timer);timer=setTimeout(render,120);
  });
  observer.observe(viewport);
  return ()=>{active=false;observer.disconnect();clearTimeout(timer);};
}
