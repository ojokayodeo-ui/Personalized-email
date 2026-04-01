import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";
import * as cheerio from "cheerio";

export const maxDuration = 300; // 5 minutes (Vercel Pro / self-hosted)

const client = new Anthropic();

function interpolate(template: string, row: Record<string, string>): string {
  // Match {anything} including column names with spaces, e.g. {First Name}
  return template.replace(/\{([^}]+)\}/g, (_, key) => row[key] ?? `{${key}}`);
}

async function scrapeUrl(url: string): Promise<string> {
  try {
    const normalized = url.startsWith("http") ? url : `https://${url}`;
    const res = await fetch(normalized, {
      signal: AbortSignal.timeout(10000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      },
    });
    if (!res.ok) return "";
    const html = await res.text();
    const $ = cheerio.load(html);
    $("script, style, nav, footer, header, noscript, iframe, svg").remove();
    const selectors = [
      "main",
      "article",
      '[class*="about"]',
      '[class*="hero"]',
      '[class*="content"]',
      "body",
    ];
    let text = "";
    for (const sel of selectors) {
      const el = $(sel);
      if (el.length) {
        text = el.text().replace(/\s+/g, " ").trim();
        if (text.length > 200) break;
      }
    }
    return text.slice(0, 1500);
  } catch {
    return "";
  }
}

async function generateEmail(
  prompt: string,
  row: Record<string, string>
): Promise<string> {
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

// Retry with exponential backoff — handles 429 rate limits and transient 5xx errors
async function generateEmailWithRetry(
  prompt: string,
  row: Record<string, string>,
  maxRetries = 6
): Promise<string> {
  let lastError: Error = new Error("Unknown error");
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await generateEmail(prompt, row);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const msg = lastError.message.toLowerCase();
      const isRateLimit =
        msg.includes("429") ||
        msg.includes("rate limit") ||
        msg.includes("rate_limit") ||
        msg.includes("overloaded") ||
        msg.includes("529");
      const isTransient =
        isRateLimit ||
        msg.includes("500") ||
        msg.includes("503") ||
        msg.includes("timeout");

      if (!isTransient) throw lastError; // non-retryable, fail fast

      // Exponential backoff: 2s, 4s, 8s, 16s, 32s, 60s
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
    urlColumn,
    batchSize = 10, // 10 concurrent requests by default
  }: {
    rows: Record<string, string>[];
    prompt: string;
    urlColumn?: string;
    batchSize?: number;
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
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
          );
        } catch {
          // client disconnected
        }
      };

      const results: (Record<string, string> & {
        generated_email: string;
      })[] = new Array(rows.length);

      let completed = 0;
      // Throttle progress events: send at most every 500ms to avoid flooding
      let lastProgressSent = 0;
      const PROGRESS_INTERVAL_MS = 500;

      const sendProgress = (index: number, row: Record<string, string> & { generated_email: string }, force = false) => {
        const now = Date.now();
        if (force || now - lastProgressSent >= PROGRESS_INTERVAL_MS) {
          lastProgressSent = now;
          send({ type: "progress", completed, total: rows.length, row, index });
        }
      };

      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);

        const batchPromises = batch.map(async (row, batchIdx) => {
          const idx = i + batchIdx;
          try {
            let enrichedRow = { ...row };

            // Scrape URL if configured
            if (urlColumn && row[urlColumn]) {
              send({ type: "scraping", index: idx, url: row[urlColumn] });
              const scraped = await scrapeUrl(row[urlColumn]);
              enrichedRow.scraped_content = scraped;
            }

            const email = await generateEmailWithRetry(prompt, enrichedRow);
            return { idx, email, row: enrichedRow };
          } catch (err) {
            const errorMsg =
              err instanceof Error ? err.message : "Unknown error";
            return { idx, email: `Error: ${errorMsg}`, row };
          }
        });

        const batchResults = await Promise.all(batchPromises);

        for (const { idx, email, row } of batchResults) {
          results[idx] = { ...row, generated_email: email };
          completed++;
          // Force-send on last item, throttle otherwise
          sendProgress(idx, results[idx], completed === rows.length);
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
