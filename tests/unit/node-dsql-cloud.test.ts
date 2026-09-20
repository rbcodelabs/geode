import {afterEach,describe,expect,it,vi} from "vitest";
import {mkdtemp,readFile,rm,access} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DEFAULT_CATALOG_LIMITS,DEFAULT_RESTORE_LIMITS} from "../../src/wiki/catalog-contract";
const mocks=vi.hoisted(()=>({commit:vi.fn(),restore:vi.fn(),close:vi.fn(),metrics:vi.fn(()=>({failures:0}))}));
vi.mock("../../src/catalog/node-dsql-catalog",()=>({createNodeDsqlCatalog:()=>({store:{commit:mocks.commit},restoreSource:()=>({restore:mocks.restore}),close:mocks.close,metrics:mocks.metrics})}));
import {createCloudCatalog} from "../../src/catalog/cloud";
const options={schema:"synthetic",objects:{} as never,pool:{} as never,limits:DEFAULT_CATALOG_LIMITS,restoreLimits:DEFAULT_RESTORE_LIMITS,metadataLimits:{maxPathBytes:1024,maxContentTypeBytes:128,maxReceiptBytes:4096},maxAttempts:3,retryBackoffMs:0};
const roots:string[]=[];
afterEach(async()=>{vi.clearAllMocks();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
describe("public cloud catalog boundary",()=>{
  it("validates requests before reaching the driver",async()=>{
    const catalog=createCloudCatalog(options);
    expect(await catalog.publish({vaultId:"../bad",mutationId:"m",baseSequence:0})).toEqual({status:"invalid-vault-id"});
    expect(mocks.commit).not.toHaveBeenCalled();
  });
  it("materializes verified restore exclusively",async()=>{
    const root=await mkdtemp(join(tmpdir(),"geode-cloud-facade-"));roots.push(root);
    mocks.restore.mockResolvedValue({status:"ok",vault:{vaultId:"vault",sequence:1,notes:[{path:"note.md",text:"hello"}],assets:[],totalBytes:5}});
    const catalog=createCloudCatalog(options), into=join(root,"restored");
    expect(await catalog.restoreFolder({into,vaultId:"vault"})).toMatchObject({status:"ok",noteCount:1,totalBytes:5});
    expect(await readFile(join(into,"note.md"),"utf8")).toBe("hello");
    expect(await catalog.restoreFolder({into,vaultId:"vault"})).toMatchObject({status:"write-failed"});
  });
  it("does not create a destination on named restore refusal",async()=>{
    const root=await mkdtemp(join(tmpdir(),"geode-cloud-facade-"));roots.push(root);
    mocks.restore.mockResolvedValue({status:"invalid-content-address"});
    const into=join(root,"refused");
    expect(await createCloudCatalog(options).restoreFolder({into,vaultId:"vault"})).toEqual({status:"invalid-content-address"});
    await expect(access(into)).rejects.toThrow();
  });
});
