import {afterEach, describe,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({sign:vi.fn(),credentials:vi.fn(()=>async()=>({accessKeyId:"synthetic",secretAccessKey:"synthetic"}))}));
vi.mock("@aws-sdk/dsql-signer",()=>({DsqlSigner:class {getDbConnectAuthToken=mocks.sign;}}));
vi.mock("@vercel/functions/oidc",()=>({awsCredentialsProvider:mocks.credentials}));
import {nodeDsqlPoolConfig,type NodeDsqlMetrics} from "../../src/catalog/node-dsql-catalog";
const connection={host:"synthetic.dsql.us-east-1.on.aws",region:"us-east-1",roleArn:"arn:aws:iam::123456789012:role/Synthetic",user:"synthetic_role",maxConnections:2,connectionTimeoutMillis:100,idleTimeoutMillis:1000,maxLifetimeSeconds:300,queryTimeoutMillis:500};
const metrics=():NodeDsqlMetrics=>({sqlStatements:0,transactions:0,retries:0,retryExhaustions:0,failures:0,authFailures:0,poolErrors:0,tokensGenerated:0,restoredBytes:0});
afterEach(()=>{vi.useRealTimers();vi.clearAllMocks();});
describe("DSQL connection credentials",()=>{
  it("obtains a fresh OIDC provider and token for every physical connection",async()=>{
    mocks.sign.mockResolvedValueOnce("token-one").mockResolvedValueOnce("token-two");
    const m=metrics(),config=nodeDsqlPoolConfig(connection,m);
    expect(await config.password()).toBe("token-one");expect(await config.password()).toBe("token-two");
    expect(mocks.credentials).toHaveBeenCalledTimes(2);expect(m.tokensGenerated).toBe(2);
    expect(config).toMatchObject({ssl:{rejectUnauthorized:true},max:2,maxLifetimeSeconds:300,query_timeout:500});
  });
  it("bounds a stuck credential refresh and never forwards provider secrets",async()=>{
    vi.useFakeTimers();mocks.sign.mockImplementation(()=>new Promise(()=>{}));
    const m=metrics();const pending=nodeDsqlPoolConfig(connection,m).password();
    const assertion=expect(pending).rejects.toMatchObject({code:"28000",message:"DSQL credential acquisition failed"});
    await vi.advanceTimersByTimeAsync(101);await assertion;expect(m.authFailures).toBe(1);
  });
  it.each([{user:"admin"},{maxConnections:3},{maxLifetimeSeconds:3600},{queryTimeoutMillis:0}])("rejects unsafe lifecycle options %j",overrides=>{
    expect(()=>nodeDsqlPoolConfig({...connection,...overrides},metrics())).toThrow("Invalid bounded");
  });
});
