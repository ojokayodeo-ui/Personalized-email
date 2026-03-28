import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";

const client = new Anthropic();

function interpolate(template: string, row: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => row[key] ?? `{${key}}`);
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
  const { rows, prompt, batchSize = 5 }: { rows: Record<string, string>[]; prompt: string; batchSize?: number } = body;

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
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      const results: (Record<string, string> & { generated_email: string })[] = [];

      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        const batchPromises = batch.map(async (row, batchIdx) => {
          const idx = i + batchIdx;
          try {
            const email = await generateEmail(prompt, row);
            return { idx, email, row };
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : "Unknown error";
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
