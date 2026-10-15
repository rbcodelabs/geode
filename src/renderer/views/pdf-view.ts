import type { App } from "../app";
import type { TFile } from "../types";
import { buildViewHeaderNavButtons, type View } from "../workspace";
import { RenderScope, nativeRenderOwnership } from "../workspaces/render-ownership";
import { PdfFrame } from "../pdf/frame";
import { PDF_LIMITS } from "../../shared/pdf";
/** Native read-only PDF tab; all PDF-derived display stays in the fixed iframe. */
export class PdfView implements View {
  readonly viewType="pdf";
  readonly containerEl:HTMLElement;
  readonly renderOwner:RenderScope;
  file:TFile|null=null;
  private readonly title:HTMLElement;
  private readonly body:HTMLElement;
  private frame:PdfFrame|undefined;
  private generation=0;
  private initialPage=1;
  private closed=false;
  private opened=false;
  private readonly unsubscribe:(()=>void)[]=[];
  constructor(private readonly app:App,parent?:RenderScope) {
    this.renderOwner=parent?parent.child({close:()=>this.closeNative()}):nativeRenderOwnership(app).create(this,{close:()=>this.closeNative()});
    this.containerEl=document.createElement("div");this.containerEl.className="pdf-view";Object.assign(this.containerEl.style,{display:"flex",flexDirection:"column",height:"100%",minHeight:"0"});
    const header=document.createElement("div");header.className="view-header";const left=document.createElement("div");left.className="view-header-left";left.append(buildViewHeaderNavButtons());const titleContainer=document.createElement("div");titleContainer.className="view-header-title-container mod-at-start mod-fade mod-at-end";this.title=document.createElement("div");this.title.className="view-header-title";titleContainer.append(this.title);header.append(left,titleContainer);
    this.body=document.createElement("div");this.body.className="pdf-view-body";Object.assign(this.body.style,{flex:"1",minHeight:"0",display:"flex"});this.containerEl.append(header,this.body);
    for(const event of ["modify","rename"])this.unsubscribe.push(app.vault.on(event,(file:TFile)=>{if(file===this.file&&!this.closed)void this.reloadExternally(file);}));
    this.unsubscribe.push(app.vault.on("delete",(file:TFile)=>{if(file!==this.file)return;this.generation++;this.file=null;void this.frame?.close().catch(error=>{this.body.textContent="Could not close the removed PDF. Retry closing this tab.";this.app.notify(`Could not close PDF: ${error instanceof Error?error.message:String(error)}`);});this.body.textContent="This PDF was removed from the vault.";}));
  }
  getDisplayText():string{return this.file?.basename??"PDF";}
  getIcon():string{return "file-text";}
  getFile():TFile|null{return this.file;}
  getState():unknown{return this.file?{file:this.file.path,page:this.frame?.page??this.initialPage}:{};}
  async setState(state:unknown):Promise<void> {
    const input=state as {file?:unknown;page?:unknown};if(!input||typeof input.file!=="string")throw new Error("PDF state requires a vault file.");
    const file=this.app.vault.getFileByPath(input.file);if(!file)throw new Error("The restored PDF is missing from the vault.");const page=input.page===undefined?1:input.page;
    if(typeof page!=="number"||!Number.isSafeInteger(page)||page<1||page>PDF_LIMITS.pages)throw new Error("The restored PDF page is invalid.");
    if(file===this.file&&this.frame)this.frame.navigate(page);else await this.setFile(file,page);
  }
  async setFile(file:TFile,page=1):Promise<void> {
    if(!Number.isSafeInteger(page)||page<1||page>PDF_LIMITS.pages)throw new Error("The PDF page is invalid.");
    await this.renderOwner.run(async token=>{
      const generation=++this.generation;
      await this.frame?.close();token.check();if(generation!==this.generation||this.closed)return;
      this.file=file;this.initialPage=page;this.title.textContent=file.basename;const root=this.app.vault.root,path=file.path;
      const frame=new PdfFrame(this.app,this.renderOwner,{path,label:file.name,page,current:()=>!this.closed&&generation===this.generation&&this.file===file&&file.path===path&&this.app.vault.root===root,onPage:()=>this.app.workspace.trigger("layout-change")});this.frame=frame;this.body.replaceChildren(frame.containerEl);if(this.opened)await frame.open();token.check();
    });
  }
  setPage(page:number):void{try{this.frame?.navigate(page);}catch(error){this.app.notify(error instanceof Error?error.message:String(error));}}
  async onOpen():Promise<void>{if(this.closed)return;this.opened=true;await this.frame?.open();}
  private async reloadExternally(file:TFile):Promise<void>{
    try{await this.setFile(file,this.frame?.page??this.initialPage);}
    catch(error){if(!this.closed)this.app.notify(`Could not reload PDF: ${error instanceof Error?error.message:String(error)}`);}
  }
  onClose():Promise<void>{this.closed=true;this.generation++;return Promise.resolve(this.frame?.close()).then(()=>this.renderOwner.close());}
  private async closeNative():Promise<void>{this.closed=true;this.generation++;this.unsubscribe.splice(0).forEach(off=>off());await this.frame?.close();this.containerEl.remove();}
}
