import { describe,expect,it } from "vitest";
import { assertActionAllowed } from "../../scripts/cloud-preview/operator-policy.mjs";
describe("preview operator phase policy",()=>{
  const id="dpl_fixture";
  const inspected={kind:"inspect-result",id,result:{status:"ok"}};
  const setup={kind:"setup-result",id,result:{status:"ok"}};
  const cleaned={kind:"cleanup-result",id,result:{status:"ok",zeroResidue:true}};
  it("permits setup only after same-deployment inspection",()=>{
    expect(()=>assertActionAllowed([inspected],"setup",id)).not.toThrow();
    expect(()=>assertActionAllowed([],"setup",id)).toThrow();
    expect(()=>assertActionAllowed([{...inspected,id:"dpl_other"}],"setup",id)).toThrow();
  });
  it("requires successful setup before the single run",()=>{
    expect(()=>assertActionAllowed([setup],"run",id)).not.toThrow();
    expect(()=>assertActionAllowed([],"run",id)).toThrow();
    expect(()=>assertActionAllowed([setup,{kind:"run-intent",id}],"run",id)).toThrow();
  });
  it("cannot create resources after cleanup started",()=>{
    for(const action of ["setup","run"]) expect(()=>assertActionAllowed([inspected,setup,{kind:"cleanup-intent",id},cleaned],action,id)).toThrow();
  });
  it("cannot remove using cleanup evidence older than a resource write",()=>{
    expect(()=>assertActionAllowed([cleaned,{kind:"setup-intent",id}],"remove",id)).toThrow();
    expect(()=>assertActionAllowed([cleaned,{kind:"run-intent",id}],"remove",id)).toThrow();
    expect(()=>assertActionAllowed([{kind:"run-intent",id},cleaned],"remove",id)).not.toThrow();
    expect(()=>assertActionAllowed([{...cleaned,id:"dpl_other"}],"remove",id)).toThrow();
  });
  it("blocks duplicate deployment and leaves recovery and cleanup available",()=>{
    expect(()=>assertActionAllowed([{kind:"deploy-intent"}],"deploy")).toThrow();
    expect(()=>assertActionAllowed([{kind:"deploy-intent"}],"recover")).not.toThrow();
    expect(()=>assertActionAllowed([{kind:"setup-intent",id}],"cleanup",id)).not.toThrow();
  });
  it("does not treat an empty eventually consistent listing as authority to redeploy",()=>{
    expect(()=>assertActionAllowed([{kind:"deploy-intent"},{kind:"deployment-absent"}],"deploy")).toThrow();
    expect(()=>assertActionAllowed([{kind:"deployment-absent"},{kind:"deploy-intent"}],"deploy")).toThrow();
  });
});
