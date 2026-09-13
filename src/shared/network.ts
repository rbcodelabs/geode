export interface HostHttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
}
export interface HostHttpResponse { status: number; headers: Record<string, string>; body: ArrayBuffer; }
