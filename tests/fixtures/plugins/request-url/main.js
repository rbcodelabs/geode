const { Plugin, requestUrl } = require("obsidian");

module.exports.default = class RequestUrlProbe extends Plugin {
  onload() {
    window.__requestUrlProbe = {
      run: async (baseUrl) => {
        const result = {};
        try {
          await fetch(`${baseUrl}/raw-fetch`);
          result.rawFetch = "unexpected-success";
        } catch (error) {
          result.rawFetch = String(error);
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
