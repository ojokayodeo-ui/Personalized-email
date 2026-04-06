import { NextResponse } from "next/server";

export async function GET() {
  const enrichKey = process.env.ENRICHLAYER_API_KEY;

  // ── EnrichLayer balance ───────────────────────────────────────────────────
  let enrichCredits: number | null = null;
  let enrichError: string | null = null;

  if (enrichKey) {
    try {
      // Try known balance endpoints (EnrichLayer mirrors Proxycurl structure)
      const endpoints = [
        "https://enrichlayer.com/api/v2/credits",
        "https://enrichlayer.com/api/credits",
        "https://enrichlayer.com/api/v2/credit-balance",
      ];
      for (const url of endpoints) {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${enrichKey}` },
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const data = await res.json();
          // Various field names different APIs use
          const credits =
            data?.credits_remaining ??
            data?.credit_balance ??
            data?.credits ??
            data?.remaining ??
            data?.balance ??
            null;
          if (typeof credits === "number") {
            enrichCredits = credits;
            break;
          }
        }
      }
      if (enrichCredits === null) enrichError = "Balance endpoint not found";
    } catch (err) {
      enrichError = err instanceof Error ? err.message : "Failed to fetch";
    }
  } else {
    enrichError = "API key not configured";
  }

  return NextResponse.json({
    enrichlayer: { credits: enrichCredits, error: enrichError },
  });
}
