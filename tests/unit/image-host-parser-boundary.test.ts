import { expect,it,vi } from "vitest";
vi.mock("@lezer/markdown",()=>{throw new Error("The host projection must not load the parser grammar.");});
it("loads the host projection without importing or configuring the worker grammar",async()=>{
  const api=await import("../../src/renderer/image-inspection/async-source");
  expect(api.projectPackedOwnedImages).toBeTypeOf("function");
});
it("loads the actual source facade, Reading authority and coordinator without the worker grammar",async()=>{
 const facade=await import("../../src/renderer/image-inspection/source"),reading=await import("../../src/renderer/image-inspection/reading-bindings"),coordinator=await import("../../src/renderer/image-inspection/parser-coordinator");
 expect(facade.projectOwnedImages).toBeTypeOf("function");expect(facade.isImageProjectionCurrent).toBeTypeOf("function");expect(reading.prepareOwnedImageReading).toBeTypeOf("function");expect(coordinator.ImageParserCoordinator).toBeTypeOf("function");
});
