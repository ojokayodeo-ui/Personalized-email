import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";
import * as cheerio from "cheerio";

export const maxDuration = 300;

const client = new Anthropic();

// Hard cap on how long a single row can take (scrape + Claude)
const ROW_TIMEOUT_MS = 90_000;

function interpolate(template: string, row: Record<string, string>): string {
  return template.replace(/\{([^}]+)\}/g, (_, key) => row[key] ?? `{${key}}`);
}

// Turns "Person Linkedin Url" → "scraped_Person_Linkedin_Url"
function scrapedVarName(col: string): string {
  return `scraped_${col.replace(/\s+/g, "_")}`;
}

// Domains that always block scraping (login walls, bot detection, etc.)
const ALWAYS_BLOCKED = /linkedin\.com|facebook\.com|instagram\.com|twitter\.com|x\.com/i;

async function scrapeUrl(url: string): Promise<string> {
  if (!url?.trim() || ALWAYS_BLOCKED.test(url)) return "";
  try {
    const normalized = url.startsWith("http") ? url : `https://${url}`;
    const res = await fetch(normalized, {
      signal: AbortSignal.timeout(12000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
    });
    if (!res.ok) return "";
    const html = await res.text();
    const $ = cheerio.load(html);
    $("script, style, nav, footer, header, noscript, iframe, svg, form, [class*='cookie'], [class*='banner'], [class*='popup']").remove();
    const selectors = ["main", "article", '[class*="about"]', '[class*="hero"]', '[class*="content"]', '[class*="home"]', "section", "body"];
    let text = "";
    for (const sel of selectors) {
      const el = $(sel);
      if (el.length) {
        text = el.text().replace(/\s+/g, " ").trim();
        if (text.length > 300) break;
      }
    }
    // Detect blocked/login pages
    const lower = text.toLowerCase();
    if (
      text.length < 150 ||
      (lower.includes("sign in") && (lower.includes("password") || lower.includes("email"))) ||
      lower.includes("enable javascript to continue") ||
      lower.includes("access denied") ||
      lower.includes("403 forbidden") ||
      lower.includes("just a moment") // Cloudflare
    ) {
      return "";
    }
    return text.slice(0, 2000);
  } catch {
    return "";
  }
}

async function generateEmail(prompt: string, row: Record<string, string>): Promise<string> {
  const userMessage = interpolate(prompt, row);
  const stream = await client.messages.stream({
    model: "claude-opus-4-6",
    max_tokens: 1024,
    messages: [{ role: "user", content: userMessage }],
  });
  const msg = await stream.finalMessage();
  const textBlock = msg.content.find((b) => b.type === "text");
  return textBlock && textBlock.type === "text" ? textBlock.text : "";
}

async function generateEmailWithRetry(prompt: string, row: Record<string, string>, maxRetries = 6): Promise<string> {
  let lastError: Error = new Error("Unknown error");
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await generateEmail(prompt, row);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const msg = lastError.message.toLowerCase();
      const isTransient =
        msg.includes("429") || msg.includes("rate limit") || msg.includes("rate_limit") ||
        msg.includes("overloaded") || msg.includes("529") || msg.includes("500") ||
        msg.includes("503") || msg.includes("timeout");
      if (!isTransient) throw lastError;
      const delay = Math.min(2000 * Math.pow(2, attempt), 60000);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const {
    rows,
    prompt,
    urlColumns = [],
    batchSize = 10,
    outputColumn = "generated_email",
  }: {
    rows: Record<string, string>[];
    prompt: string;
    urlColumns?: string[];
    batchSize?: number;
    outputColumn?: string;
  } = body;

  if (!rows || !prompt) {
    return new Response(JSON.stringify({ error: "Missing rows or prompt" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch { /* client disconnected */ }
      };

      const results: (Record<string, string> & { generated_email: string })[] = new Array(rows.length);
      let completed = 0;

      // Process a single row: scrape + generate. Never rejects — always returns a result.
      const processRow = async (row: Record<string, string>, idx: number): Promise<{ idx: number; email: string; row: Record<string, string> }> => {
        try {
          const enrichedRow: Record<string, string> = { ...row };

          if (urlColumns.length > 0) {
            const scrapedParts: string[] = [];
            await Promise.all(
              urlColumns.map(async (col) => {
                const url = row[col];
                if (!url) return;
                send({ type: "scraping", index: idx, col, url });
                const text = await scrapeUrl(url);
                enrichedRow[scrapedVarName(col)] = text;
                if (text) scrapedParts.push(`[${col}]\n${text}`);
              })
            );
            enrichedRow["scraped_content"] = scrapedParts.join("\n\n---\n\n");
          }

          // Fallback: when scraping returns nothing, populate {scraped_content}
          // from the row's own CSV data so every email is still personalized
          if (!enrichedRow["scraped_content"]) {
            const skipKeys = new Set(urlColumns.map((c) => c.toLowerCase()));
            const parts = Object.entries(row)
              .filter(([k, v]) =>
                v &&
                !skipKeys.has(k.toLowerCase()) &&
                !k.toLowerCase().includes("phone") &&
                !k.toLowerCase().includes("email") &&
                !k.toLowerCase().includes("id") &&
                !k.toLowerCase().includes("status")
              )
              .map(([k, v]) => `${k}: ${v}`)
              .join("\n");
            if (parts) {
              enrichedRow["scraped_content"] =
                `[Website unavailable — using lead profile data]\n${parts}`;
            }
          }

          const email = await generateEmailWithRetry(prompt, enrichedRow);
          return { idx, email, row: enrichedRow };
        } catch (err) {
          return { idx, email: `Error: ${err instanceof Error ? err.message : String(err)}`, row };
        }
      };

      // Wrap a row promise with a hard timeout so one stuck row never blocks the batch
      const processRowWithTimeout = (row: Record<string, string>, idx: number) =>
        Promise.race([
          processRow(row, idx),
          new Promise<{ idx: number; email: string; row: Record<string, string> }>((resolve) =>
            setTimeout(() => resolve({ idx, email: "Error: row timed out after 90s", row }), ROW_TIMEOUT_MS)
          ),
        ]);

      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);

        // Use allSettled so an unexpected rejection never aborts the batch
        const settled = await Promise.allSettled(
          batch.map((row, batchIdx) => processRowWithTimeout(row, i + batchIdx))
        );

        for (const outcome of settled) {
          const { idx, email, row } =
            outcome.status === "fulfilled"
              ? outcome.value
              : { idx: -1, email: "Error: unexpected batch failure", row: {} };

          if (idx < 0) continue;

          const exportRow: Record<string, string> = {};
          for (const [k, v] of Object.entries(row)) {
            if (!k.startsWith("scraped_")) exportRow[k] = String(v ?? "");
          }
          exportRow[outputColumn] = email;
          results[idx] = exportRow as Record<string, string> & { generated_email: string };
          completed++;
          // Force a progress event for every row so the client never misses a result
          send({ type: "progress", completed, total: rows.length, row: results[idx], index: idx });
        }
      }

      // Safety net: fill any slots that somehow never received a result
      for (let i = 0; i < rows.length; i++) {
        if (!results[i]) {
          results[i] = { ...rows[i], generated_email: "Error: row did not complete" };
        }
      }

      send({ type: "done", results });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
