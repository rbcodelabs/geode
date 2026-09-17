export interface PrivilegedRequestUrlParam {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  contentType?: string;
  /**
   * Whole-request deadline in milliseconds, covering both the `fetch()` and
   * the response body read. Omitted/invalid values fall back to
   * `DEFAULT_REQUEST_TIMEOUT_MS` in `src/main/request-url.ts`. An
   * `AbortSignal` cannot cross the IPC boundary, so callers that need a
   * longer budget carry the number and main builds the controller.
   */
  timeout?: number;
}

export interface PrivilegedRequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
}
