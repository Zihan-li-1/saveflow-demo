const mode = process.env.NEXT_PUBLIC_SAVEFLOW_API_MODE ?? "mock";
if (mode !== "mock" && mode !== "http") throw new Error("SAVEFLOW_API_MODE 必须为 mock 或 http");
const baseUrl = process.env.NEXT_PUBLIC_SAVEFLOW_API_BASE_URL ?? "";
if (baseUrl && !/^https:\/\/[^/]+/.test(baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(baseUrl)) {
  throw new Error("远程接口必须使用 HTTPS；本机联调可使用 HTTP");
}
const timeoutMs = Number(process.env.NEXT_PUBLIC_SAVEFLOW_API_TIMEOUT_MS ?? 10000);
if (!Number.isFinite(timeoutMs) || timeoutMs < 500 || timeoutMs > 60000) throw new Error("接口超时须为 500–60000 毫秒");
export const apiConfig = { mode, baseUrl: baseUrl.replace(/\/$/, ""), timeoutMs, endpoint: "/api/saveflow" } as const;
