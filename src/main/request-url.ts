import type {
  PrivilegedRequestUrlParam,
  PrivilegedRequestUrlResponse,
} from "../shared/request-url";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export async function performRequestUrl(
  request: PrivilegedRequestUrlParam,
  fetchImpl: Fetch,
): Promise<PrivilegedRequestUrlResponse> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw new Error(`requestUrl requires a valid HTTP(S) URL: ${request.url}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`requestUrl only supports HTTP(S) URLs: ${request.url}`);
  }

  const headers = new Headers(request.headers);
  if (request.contentType) headers.set("Content-Type", request.contentType);
  const response = await fetchImpl(url.href, {
    method: request.method ?? "GET",
    headers,
    body: request.body,
    redirect: "follow",
  });
  const arrayBuffer = await response.arrayBuffer();
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    responseHeaders[name] = value;
  });
  return { status: response.status, headers: responseHeaders, arrayBuffer };
}
