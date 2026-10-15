import { expect,it,vi } from "vitest";
vi.mock("@lezer/markdown",()=>{throw new Error("The host projection must not load the parser grammar.");});
it("loads the host projection without importing or configuring the worker grammar",async()=>{
  const api=await import("../../src/renderer/image-inspection/async-source");
  expect(api.projectPackedOwnedImages).toBeTypeOf("function");
});
