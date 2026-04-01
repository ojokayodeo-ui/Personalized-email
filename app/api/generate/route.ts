import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";
import * as cheerio from "cheerio";

const client = new Anthropic();

function interpolate(template: string, row: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => row[key] ?? `{${key}}`);
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

    // Remove non-content elements
    $("script, style, nav, footer, header, noscript, iframe, svg").remove();

    // Prefer meaningful content sections
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
        text = el
          .text()
          .replace(/\s+/g, " ")
          .trim();
        if (text.length > 200) break;
      }
    }

    // Trim to ~1500 chars to keep token usage reasonable
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

export async function POST(req: NextRequest) {
  const body = await req.json();
  const {
    rows,
    prompt,
    urlColumn,
    batchSize = 5,
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
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
        );
      };

      const results: (Record<string, string> & {
        generated_email: string;
      })[] = [];

      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);

        const batchPromises = batch.map(async (row, batchIdx) => {
          const idx = i + batchIdx;
          try {
            // Scrape URL if a URL column is specified
            let enrichedRow = { ...row };
            if (urlColumn && row[urlColumn]) {
              send({ type: "scraping", index: idx, url: row[urlColumn] });
              const scraped = await scrapeUrl(row[urlColumn]);
              enrichedRow.scraped_content = scraped;
            }

            const email = await generateEmail(prompt, enrichedRow);
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
          send({
            type: "progress",
            completed: results.filter(Boolean).length,
            total: rows.length,
            row: results[idx],
            index: idx,
          });
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
