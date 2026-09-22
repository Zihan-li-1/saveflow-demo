import { saveflowMock } from "@/lib/saveflow-mock";

// Static snapshot only. POST operations require an external sandbox BFF.
export const dynamic = "force-static";
export async function GET() {
  return Response.json({ code: "OK", message: "Synthetic demo fixtures only", requestId: "static-demo-fixtures", data: saveflowMock });
}
