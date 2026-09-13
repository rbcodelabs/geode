import { describe, expect, it, vi } from 'vitest';
import { applyPortableConfig, parsePortableConfig, projectPortableConfig, serializePortableConfig, type PortableConfigDocument, type PortableConfigOwners } from '../../src/renderer/sync/portable-config';
import { DEFAULT_SYNC_SCOPE } from '../../src/renderer/sync/scope';
const encoder=new TextEncoder();
const bytes=(value:unknown)=>encoder.encode(JSON.stringify(value)).buffer;
const editor={readableLineLength:true,foldHeading:false,showLineNumber:false,showRibbon:true,showStatusBar:true};
const appearance={theme:'dark' as const,baseFontSize:16,cssTheme:''};
const daily={enabled:true,folder:'',format:'YYYY-MM-DD',template:''};
const source=(values:Record<string,unknown>)=>({read:vi.fn(async(name:string)=>values[name]??null)});
const owners=():PortableConfigOwners=>({applyEditor:vi.fn(async()=>{}),applyAppearance:vi.fn(async()=>{}),applyHotkeys:vi.fn(async()=>{}),applyDailyNotes:vi.fn(async()=>{})});
describe('portable configuration',()=>{
  it('exports known deterministic defaults when configuration is absent',async()=>{
    expect(await projectPortableConfig(source({}),DEFAULT_SYNC_SCOPE)).toEqual([
      {name:'editor.json',value:editor},{name:'appearance.json',value:appearance},
      {name:'hotkeys.json',value:{version:1,overrides:{}}},{name:'daily-notes.json',value:daily},
    ]);
  });
  it('never exports confidential or machine-local fields from app or category config',async()=>{
    const out=await projectPortableConfig(source({app:{...editor,...appearance,metadataScanCapBytes:42,webViewer:{secret:'private'},accessToken:'secret'},'daily-notes':{...daily,deviceId:'private'},hotkeys:{version:1,overrides:{},password:'secret'}}),DEFAULT_SYNC_SCOPE);
    const serialized=JSON.stringify(out); expect(serialized).not.toMatch(/private|secret|password|accessToken|metadataScanCapBytes|webViewer|deviceId/); expect(out).toHaveLength(4);
  });
  it('reads only selected categories and does not publish disabled categories as defaults',async()=>{
    const config=source({}); const out=await projectPortableConfig(config,{...DEFAULT_SYNC_SCOPE,mainSettings:false,appearance:false,corePlugins:false});
    expect(out.map(d=>d.name)).toEqual(['hotkeys.json']); expect(config.read.mock.calls).toEqual([['hotkeys']]);
  });
  it('roundtrips canonical UTF8 independent of input object key order',()=>{
    const a:PortableConfigDocument={name:'appearance.json',value:{cssTheme:'Thème',baseFontSize:18,theme:'light'}};
    const b:PortableConfigDocument={name:'appearance.json',value:{theme:'light',baseFontSize:18,cssTheme:'Thème'}};
    expect(serializePortableConfig(a)).toEqual(serializePortableConfig(b)); expect(parsePortableConfig(a.name,serializePortableConfig(a))).toEqual(a);
  });
  it('normalizes existing structured hotkey bindings without exporting extra fields',async()=>{
    const out=await projectPortableConfig(source({hotkeys:{version:1,overrides:{'app:test':[{code:'KeyK',modifiers:['Shift','Mod'],secret:'never'}]}}}),DEFAULT_SYNC_SCOPE);
    expect(out.find(d=>d.name==='hotkeys.json')).toEqual({name:'hotkeys.json',value:{version:1,overrides:{'app:test':[{code:'KeyK',modifiers:['Mod','Shift']}]}}});
  });
  it('passes only editor fields through its owning callback, preserving unrelated local config',async()=>{
    const local={...editor,...appearance,webViewer:{private:true},metadataScanCapBytes:42}; const handlers=owners(); handlers.applyEditor=vi.fn(async patch=>{Object.assign(local,patch);});
    await applyPortableConfig({name:'editor.json',value:{...editor,showRibbon:false}},handlers);
    expect(local).toEqual({...editor,...appearance,showRibbon:false,webViewer:{private:true},metadataScanCapBytes:42});
    expect(handlers.applyAppearance).not.toHaveBeenCalled(); expect(handlers.applyHotkeys).not.toHaveBeenCalled(); expect(handlers.applyDailyNotes).not.toHaveBeenCalled();
  });
  it.each([
    ['editor.json',{...editor,password:'secret'}],['editor.json',{...editor,showRibbon:'yes'}],['editor.json',{}],
    ['appearance.json',{...appearance,theme:'auto'}],['appearance.json',{...appearance,baseFontSize:0}],['appearance.json',{...appearance,cssTheme:'../escape'}],
    ['daily-notes.json',{...daily,folder:'../outside'}],['daily-notes.json',{...daily,template:'/outside.md'}],['daily-notes.json',{...daily,template:'.geode/secrets.json'}],
    ['daily-notes.json',{...daily,format:'[../]YYYY'}],['daily-notes.json',{...daily,extra:'bad'}],
    ['hotkeys.json',{version:2,overrides:{}}],['hotkeys.json',{version:1,overrides:{x:[{code:'MetaLeft',modifiers:[]}]}}],
    ['hotkeys.json',{version:1,overrides:{x:[{code:'KeyK',modifiers:['Mod','Mod']}]}}],
    ['hotkeys.json',{version:1,overrides:{x:[{code:'KeyK',modifiers:['Mod'],unknown:true}]}}],
    ['other.json',{}],['../editor.json',editor],
  ])('rejects invalid incoming %s payload %j',(name,value)=>{
    expect(()=>parsePortableConfig(name as string,bytes(value))).toThrow();
  });
  it('rejects malformed JSON and malformed UTF8',()=>{
    expect(()=>parsePortableConfig('editor.json',encoder.encode('{').buffer)).toThrow();
    expect(()=>parsePortableConfig('editor.json',new Uint8Array([255]).buffer)).toThrow();
  });
  it('validates forged typed documents before invoking any owner',async()=>{
    const callbacks=owners(); const bad={name:'editor.json',value:{...editor,webViewer:{private:true}}} as PortableConfigDocument;
    await expect(applyPortableConfig(bad,callbacks)).rejects.toThrow(); expect(callbacks.applyEditor).not.toHaveBeenCalled();
  });
  it('preserves legitimate nested daily note formats and template paths',()=>{
    const value={...daily,folder:'Journal/Daily',format:'YYYY/MMMM/YYYY-MMM-DD',template:'Templates/Daily.md'};
    expect(parsePortableConfig('daily-notes.json',bytes(value))).toEqual({name:'daily-notes.json',value});
  });
  it('rejects invalid local known values instead of silently syncing replacement defaults',async()=>{
    await expect(projectPortableConfig(source({app:{baseFontSize:-1}}),DEFAULT_SYNC_SCOPE)).rejects.toThrow();
  });
  it('does not turn failed reads or failed owner writes into success',async()=>{
    await expect(projectPortableConfig({read:async()=>{throw new Error('read failed');}},DEFAULT_SYNC_SCOPE)).rejects.toThrow('read failed');
    const callbacks=owners(); callbacks.applyAppearance=async()=>{throw new Error('write failed');};
    await expect(applyPortableConfig({name:'appearance.json',value:appearance},callbacks)).rejects.toThrow('write failed');
  });
  it.each([
    [{name:'appearance.json',value:appearance},'applyAppearance'],
    [{name:'hotkeys.json',value:{version:1,overrides:{}}},'applyHotkeys'],
    [{name:'daily-notes.json',value:daily},'applyDailyNotes'],
  ] as const)('routes %j only to %s',async(document,owner)=>{
    const callbacks=owners(); await applyPortableConfig(document as PortableConfigDocument,callbacks);
    expect(callbacks[owner]).toHaveBeenCalledWith(document.value);
    for (const [key,callback] of Object.entries(callbacks)) if(key!==owner) expect(callback).not.toHaveBeenCalled();
  });
  it('rejects prototype-mutating command IDs',()=>{
    const raw=JSON.parse('{"version":1,"overrides":{"__proto__":[]}}'); expect(()=>parsePortableConfig('hotkeys.json',bytes(raw))).toThrow();
  });
  it('bounds incoming configuration bytes',()=>{
    expect(()=>parsePortableConfig('editor.json',new ArrayBuffer(1024*1024+1))).toThrow();
  });
  it('does not preserve aliases to mutable input bindings in an owner callback',async()=>{
    const input:PortableConfigDocument={name:'hotkeys.json',value:{version:1,overrides:{test:[{code:'KeyK',modifiers:['Mod']}]}}}; const callbacks=owners();
    callbacks.applyHotkeys=async patch=>{patch.overrides.test[0].modifiers.push('Shift');};
    await applyPortableConfig(input,callbacks); expect(input.value.overrides.test[0].modifiers).toEqual(['Mod']);
  });
  it('rejects a time token that renders a filesystem-unsafe daily-note filename',()=>{
    expect(()=>parsePortableConfig('daily-notes.json',bytes({...daily,format:'LTS'}))).toThrow();
  });
});
