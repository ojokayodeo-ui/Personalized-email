import { NextRequest, NextResponse } from "next/server";
import { scrapeUrl } from "@/app/lib/scrape";

export const maxDuration = 30;

export interface ScrapeItem {
  rowIndex: number;
  col: string;
  url: string;
}

export interface ScrapeResult {
  rowIndex: number;
  col: string;
  text: string;
  creditExhausted?: boolean;
}

// POST { items: ScrapeItem[] }
// Returns { results: ScrapeResult[] }
// All items are scraped in parallel. Never throws.
export async function POST(req: NextRequest) {
  const { items }: { items: ScrapeItem[] } = await req.json();

  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ results: [] });
  }

  const settled = await Promise.allSettled(
    items.map(async ({ rowIndex, col, url }): Promise<ScrapeResult> => {
      const text = await scrapeUrl(url);
      if (text === "__ENRICHLAYER_CREDITS_EXHAUSTED__") {
        return { rowIndex, col, text: "", creditExhausted: true };
      }
      return { rowIndex, col, text };
    })
  );

  const results: ScrapeResult[] = settled
    .map((r) => (r.status === "fulfilled" ? r.value : null))
    .filter((r): r is ScrapeResult => r !== null);

  const creditExhausted = results.some((r) => r.creditExhausted);

  return NextResponse.json({ results, creditExhausted });
}
