import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";

export const maxDuration = 300;

const client = new Anthropic();

// Per-row hard cap: Claude generation only (no scraping here)
const ROW_TIMEOUT_MS = 30_000;

function interpolate(template: string, row: Record<string, string>): string {
  return template.replace(/\{([^}]+)\}/g, (_, key) => row[key] ?? `{${key}}`);
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

async function generateEmailWithRetry(
  prompt: string,
  row: Record<string, string>,
  onCreditExhausted: () => void,
  maxRetries = 6,
): Promise<string> {
  let lastError: Error = new Error("Unknown error");
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await generateEmail(prompt, row);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const msg = lastError.message.toLowerCase();
      if (
        msg.includes("credit balance too low") ||
        msg.includes("insufficient_quota") ||
        msg.includes("billing_hard_limit") ||
        (msg.includes("400") && msg.includes("credit"))
      ) {
        onCreditExhausted();
        throw lastError;
      }
      const isTransient =
        msg.includes("429") || msg.includes("rate limit") || msg.includes("rate_limit") ||
        msg.includes("overloaded") || msg.includes("529") || msg.includes("500") ||
        msg.includes("503") || msg.includes("timeout");
      if (!isTransient) throw lastError;
      await new Promise((r) => setTimeout(r, Math.min(2000 * Math.pow(2, attempt), 60000)));
    }
  }
  throw lastError;
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const {
    rows,
    prompt,
    outputColumn = "generated_email",
    batchSize = 5,
  }: {
    rows: Record<string, string>[];
    prompt: string;
    outputColumn?: string;
    batchSize?: number;
  } = body;

  if (!rows?.length || !prompt) {
    return new Response(JSON.stringify({ error: "Missing rows or prompt" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); }
        catch { /* client disconnected */ }
      };

      const results: (Record<string, string> & { generated_email: string })[] = new Array(rows.length);
      let completed = 0;

      const processRow = async (
        row: Record<string, string>,
        idx: number,
      ): Promise<{ idx: number; email: string; row: Record<string, string> }> => {
        try {
          // Fallback: if no scraped_content pre-populated, build from CSV data
          const enrichedRow = { ...row };
          if (!enrichedRow["scraped_content"]) {
            const parts = Object.entries(row)
              .filter(([k, v]) =>
                v &&
                !k.startsWith("scraped_") &&
                !k.toLowerCase().includes("phone") &&
                !k.toLowerCase().includes("email") &&
                !k.toLowerCase().includes(" id") &&
                !k.toLowerCase().includes("status")
              )
              .map(([k, v]) => `${k}: ${v}`)
              .join("\n");
            if (parts) enrichedRow["scraped_content"] = `[Using lead profile data]\n${parts}`;
          }

          const email = await generateEmailWithRetry(
            prompt,
            enrichedRow,
            () => send({ type: "credit_exhausted", service: "anthropic" }),
          );
          return { idx, email, row: enrichedRow };
        } catch (err) {
          return { idx, email: `Error: ${err instanceof Error ? err.message : String(err)}`, row };
        }
      };

      const processRowWithTimeout = (row: Record<string, string>, idx: number) =>
        Promise.race([
          processRow(row, idx),
          new Promise<{ idx: number; email: string; row: Record<string, string> }>((resolve) =>
            setTimeout(() => resolve({ idx, email: "Error: generation timed out", row }), ROW_TIMEOUT_MS)
          ),
        ]);

      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        const settled = await Promise.allSettled(
          batch.map((row, batchIdx) => processRowWithTimeout(row, i + batchIdx))
        );

        for (const outcome of settled) {
          const { idx, email, row } =
            outcome.status === "fulfilled"
              ? outcome.value
              : { idx: -1, email: "Error: unexpected failure", row: {} };
          if (idx < 0) continue;

          const exportRow: Record<string, string> = {};
          for (const [k, v] of Object.entries(row)) {
            if (!k.startsWith("scraped_")) exportRow[k] = String(v ?? "");
          }
          exportRow[outputColumn] = email;
          results[idx] = exportRow as Record<string, string> & { generated_email: string };
          completed++;
          send({ type: "progress", completed, total: rows.length, row: results[idx], index: idx });
        }
      }

      for (let i = 0; i < rows.length; i++) {
        if (!results[i]) results[i] = { ...rows[i], [outputColumn]: "Error: row did not complete" } as Record<string, string> & { generated_email: string };
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
