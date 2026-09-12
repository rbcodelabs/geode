import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const fixtureDir = path.join(repoRoot, "tests", "fixtures", "plugins", "request-url");

test("plugin requestUrl bypasses renderer CSP through the privileged HTTP transport", async () => {
  const requests: Array<{ url: string; method: string; headers: http.IncomingHttpHeaders; body: number[] }> = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      requests.push({
        url: request.url ?? "",
        method: request.method ?? "",
        headers: request.headers,
        body: Array.from(body),
      });
      if (request.url === "/json") {
        response.writeHead(200, { "Content-Type": "application/json", "X-Probe": "yes" });
        response.end('{"ok":true}');
      } else if (request.url === "/raw-fetch") {
        response.writeHead(200, { "Content-Type": "application/json", "X-Probe": "raw" });
        response.end('{"raw":true}');
      } else if (request.url === "/echo") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          method: request.method,
          custom: request.headers["x-custom"],
          contentType: request.headers["content-type"],
          body: Array.from(body),
        }));
      } else if (request.url === "/echo-multipart") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          contentType: request.headers["content-type"] ?? null,
          bodyLength: body.length,
        }));
      } else if (request.url === "/plain") {
        response.writeHead(200, { "Content-Type": "text/plain" });
        response.end("plain response");
      } else {
        response.writeHead(418, { "Content-Type": "text/plain" });
        response.end("missing");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind to TCP");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-request-url-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-request-url-ud-"));
  const pluginDir = path.join(vaultDir, ".geode", "plugins", "request-url-probe");
  fs.mkdirSync(pluginDir, { recursive: true });
  for (const name of ["manifest.json", "main.js"]) {
    fs.copyFileSync(path.join(fixtureDir, name), path.join(pluginDir, name));
  }
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Request URL\n");
  fs.writeFileSync(path.join(vaultDir, ".geode", "plugins.json"), JSON.stringify(["request-url-probe"]));
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }),
  );

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    await expect.poll(() => window.evaluate(() => typeof (window as any).__requestUrlProbe?.run)).toBe("function");
    const result = await window.evaluate(
      (url) => (window as any).__requestUrlProbe.run(url),
      baseUrl,
    );

    // A plugin's raw fetch() reaches the real server via the same
    // privileged-IPC bypass as requestUrl — see plugin-fetch.ts. Before that
    // proxy existed, this call was blocked by the renderer CSP.
    expect(result.rawFetch).toEqual({ status: 200, header: "raw", json: { raw: true } });
    expect(result.rawFetchMultipart.contentType).toMatch(/^multipart\/form-data; boundary=.+/);
    expect(result.rawFetchMultipart.bodyLength).toBeGreaterThan(0);
    expect(result.shorthand).toEqual({
      status: 200,
      header: "yes",
      text: '{"ok":true}',
      json: { ok: true },
      bytes: Array.from(Buffer.from('{"ok":true}')),
    });
    expect(result.stringPost).toEqual({
      method: "POST",
      custom: "string",
      contentType: "text/plain",
      body: Array.from(Buffer.from("hello")),
    });
    expect(result.binaryPost).toEqual({
      method: "POST",
      custom: "binary",
      contentType: "application/octet-stream",
      body: [0, 1, 2, 255],
    });
    expect(result.plain).toEqual({ text: "plain response", json: null });
    expect(result.defaultThrow).toContain("418");
    expect(result.throwFalse).toEqual({ status: 418, text: "missing" });
    expect(result.invalidErrors).toHaveLength(3);
    for (const error of result.invalidErrors) expect(error).toMatch(/http|url/i);

    expect(requests.some((request) => request.url === "/raw-fetch")).toBe(true);
    expect(requests.some((request) => request.url === "/echo-multipart")).toBe(true);
    expect(requests.filter((request) => request.url === "/echo")).toHaveLength(2);
    expect(requests).toHaveLength(8);
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
