const { Plugin, requestUrl } = require("obsidian");

module.exports.default = class RequestUrlProbe extends Plugin {
  onload() {
    window.__requestUrlProbe = {
      run: async (baseUrl) => {
        const result = {};
        // A bare fetch() call is proxied through the main process exactly
        // like requestUrl — see src/renderer/plugin-fetch.ts. It should
        // reach the real server, not be blocked by the renderer CSP.
        try {
          const rawFetchRes = await fetch(`${baseUrl}/raw-fetch`, {
            headers: { "X-Custom": "raw-fetch" },
          });
          result.rawFetch = {
            status: rawFetchRes.status,
            header: rawFetchRes.headers.get("x-probe"),
            json: await rawFetchRes.json(),
          };
        } catch (error) {
          result.rawFetch = String(error);
        }

        // The FormData case is the whole reason a raw fetch() proxy exists
        // alongside requestUrl: requestUrl's body is only string|ArrayBuffer,
        // so a plugin doing a multipart upload (e.g. Whisper transcription)
        // has no choice but to call fetch() directly.
        try {
          const form = new FormData();
          form.append("field", "value");
          form.append("file", new Blob(["file-bytes"], { type: "text/plain" }), "test.txt");
          const multipartRes = await fetch(`${baseUrl}/echo-multipart`, { method: "POST", body: form });
          result.rawFetchMultipart = await multipartRes.json();
        } catch (error) {
          result.rawFetchMultipart = String(error);
        }

        const shorthand = await requestUrl(`${baseUrl}/json`);
        result.shorthand = {
          status: shorthand.status,
          header: shorthand.headers["x-probe"],
          text: shorthand.text,
          json: shorthand.json,
          bytes: Array.from(new Uint8Array(shorthand.arrayBuffer)),
        };

        result.stringPost = (await requestUrl({
          url: `${baseUrl}/echo`,
          method: "POST",
          headers: { "X-Custom": "string" },
          contentType: "text/plain",
          body: "hello",
        })).json;
        result.binaryPost = (await requestUrl({
          url: `${baseUrl}/echo`,
          method: "POST",
          headers: { "X-Custom": "binary" },
          contentType: "application/octet-stream",
          body: Uint8Array.from([0, 1, 2, 255]).buffer,
        })).json;

        const plain = await requestUrl(`${baseUrl}/plain`);
        result.plain = { text: plain.text, json: plain.json };

        try {
          await requestUrl(`${baseUrl}/missing`);
          result.defaultThrow = "unexpected-success";
        } catch (error) {
          result.defaultThrow = String(error);
        }
        const allowedError = await requestUrl({ url: `${baseUrl}/missing`, throw: false });
        result.throwFalse = { status: allowedError.status, text: allowedError.text };

        result.invalidErrors = [];
        for (const url of ["not a url", "file:///tmp/private", "ftp://example.test/file"]) {
          try {
            await requestUrl(url);
            result.invalidErrors.push("unexpected-success");
          } catch (error) {
            result.invalidErrors.push(String(error));
          }
        }
        return result;
      },
    };
  }
};
