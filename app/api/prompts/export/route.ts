import { NextRequest, NextResponse } from "next/server";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8000";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const params = url.searchParams.toString();
  const res = await fetch(`${BACKEND}/api/prompts/export${params ? `?${params}` : ""}`, {
    cache: "no-store",
  });
  // Stream the file download directly
  const blob = await res.blob();
  const fmt = url.searchParams.get("fmt") ?? "json";
  return new NextResponse(blob, {
    status: res.status,
    headers: {
      "Content-Type": fmt === "csv" ? "text/csv" : "application/json",
      "Content-Disposition": `attachment; filename=prompts.${fmt}`,
    },
  });
}
