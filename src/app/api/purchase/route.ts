import { handlePurchaseRequest } from "../../../../server/purchase-api.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.text();
  return handlePurchaseRequest(new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
  }));
}
