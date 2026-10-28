import { handleBankingAgent } from "../../../../server/banking-agent.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Reuse the authenticated Banking Agent service used by the Netlify adapter.
// The route deliberately does not duplicate parsing, Core, continuation, or
// confirmation logic.
export async function POST(request: Request) {
  // Re-wrap the App Router body as a fresh Web Request. This keeps the shared
  // service compatible with both Next's request implementation and Netlify's
  // streamed adapter while preserving all headers used for auth and origin.
  const raw = await request.text();
  const forwarded = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: raw,
  });
  return handleBankingAgent(forwarded);
}
