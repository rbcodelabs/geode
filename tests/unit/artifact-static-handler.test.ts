import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStaticArtifactHandler } from "../../src/main/artifact-static-handler";

const ID = "demo";
let root: string;
let handle: (request: { url: string; method: string }) => Promise<Response>;

async function get(pathname: string, method = "GET") {
  const response = await handle({ url: `geode-artifact://${ID}${pathname}`, method });
  return { status: response.status, body: await response.text(), headers: Object.fromEntries(response.headers) };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "geode-static-"));
  await mkdir(path.join(root, ".threads-design", "selections"), { recursive: true });
  await writeFile(path.join(root, ".threads-design", "selections", "sel.json"), '{"comment":"private"}');
  await writeFile(path.join(root, ".threads-design", "secret.txt"), "private");
  await writeFile(path.join(root, "index.html"), "<main>hi</main>");
  await mkdir(path.join(root, "captures"));
  await writeFile(path.join(root, "captures", "shot.png"), "png");
  await mkdir(path.join(root, ".threads-design-notes"));
  await writeFile(path.join(root, ".threads-design-notes", "a.txt"), "notes");
  await mkdir(path.join(root, "threads-design"));
  await writeFile(path.join(root, "threads-design", "a.txt"), "plain");
  await mkdir(path.join(root, "sub", ".threads-design"), { recursive: true });
  await writeFile(path.join(root, "sub", ".threads-design", "a.txt"), "nested ordinary");
  await symlink(path.join(root, ".threads-design"), path.join(root, "public"));
  handle = createStaticArtifactHandler(ID, root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("static artifact handler: reserved .threads-design/", () => {
  const variants: [string, string][] = [
    ["exact path", "/.threads-design"],
    ["trailing slash", "/.threads-design/"],
    ["nested file", "/.threads-design/selections/sel.json"],
    ["file at top of directory", "/.threads-design/secret.txt"],
    ["upper case", "/.THREADS-DESIGN/secret.txt"],
    ["mixed case", "/.Threads-Design/selections/sel.json"],
    ["%2e", "/%2ethreads-design/secret.txt"],
    ["%2E", "/%2Ethreads-design/secret.txt"],
    ["double-encoded", "/%252ethreads-design/secret.txt"],
    ["double-encoded name", "/.threads%252ddesign/secret.txt"],
    ["traversal into it", "/sub/../.threads-design/secret.txt"],
    ["encoded traversal into it", "/sub/%2e%2e/.threads-design/secret.txt"],
    ["encoded dot-dot", "/sub/%2E%2E/.threads-design/secret.txt"],
    ["backslash", "/.threads-design%5Csecret.txt"],
    ["raw backslash", "/.threads-design\\secret.txt"],
    ["symlink alias", "/public/secret.txt"],
    ["symlink alias directory", "/public"],
    ["U+017F folding", "/.threadſ-design/secret.txt"],
    ["U+017F folding encoded", "/.thread%C5%BF-design/secret.txt"],
    ["trailing dot", "/.threads-design./secret.txt"],
    ["trailing space", "/.threads-design%20/secret.txt"],
    ["zero width space", "/.threads%E2%80%8B-design/secret.txt"],
  ];

  it("a missing file produces the reference 404", async () => {
    const missing = await get("/nope.txt");
    expect(missing.status).toBe(404);
    expect(missing.body).toBe("Artifact file not found.");
  });

  for (const [name, pathname] of variants) {
    it(`404 identical to a missing file: ${name}`, async () => {
      const missing = await get("/does-not-exist-anywhere.txt");
      const denied = await get(pathname);
      expect(denied.status).toBe(404);
      expect(denied.body).toBe(missing.body);
      expect(denied.headers).toEqual(missing.headers);
      expect(denied.body).not.toContain("private");
    });
  }

  it("denies HEAD the same way", async () => {
    const denied = await get("/.threads-design/secret.txt", "HEAD");
    expect(denied.status).toBe(404);
  });
});

describe("static artifact handler: non-regressions", () => {
  const served: [string, string][] = [
    ["/index.html", "<main>hi</main>"],
    ["/captures/shot.png", "png"],
    ["/.threads-design-notes/a.txt", "notes"],
    ["/threads-design/a.txt", "plain"],
    ["/sub/.threads-design/a.txt", "nested ordinary"],
  ];
  for (const [pathname, body] of served) {
    it(`serves ${pathname}`, async () => {
      const result = await get(pathname);
      expect(result.status).toBe(200);
      expect(result.body).toBe(body);
      expect(result.headers["cache-control"]).toBe("no-store");
    });
  }

  it("keeps rejecting foreign origins and unsafe methods", async () => {
    expect((await handle({ url: "geode-artifact://other/index.html", method: "GET" })).status).toBe(403);
    expect((await handle({ url: `geode-artifact://${ID}/index.html`, method: "POST" })).status).toBe(405);
  });
});
