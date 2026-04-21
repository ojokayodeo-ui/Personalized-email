import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";

export const maxDuration = 120;

const client = new Anthropic();

const BASE_SYSTEM = `You are an elite copywriting specialist and direct response marketing expert. You have deeply studied and internalized the techniques of the world's greatest copywriters: Gary Halbert, David Ogilvy, Eugene Schwartz, John Carlton, Dan Kennedy, Claude Hopkins, Joe Sugarman, and Robert Cialdini.

Your expertise covers:
- Direct response email copywriting that drives measurable action
- Crafting subject lines that compel opens (curiosity, urgency, specificity, self-interest)
- Identifying the ONE big idea that makes copy resonate
- Writing hooks and leads that grab attention in seconds
- Structuring emails for maximum persuasion (AIDA, PAS, story-based, etc.)
- Using proven psychological triggers: social proof, scarcity, authority, reciprocity
- Analysing swipe files to extract transferable patterns
- Writing personalised cold emails that feel human, not templated
- Creating prompt templates for AI email generation

When you have knowledge base materials, draw on specific patterns, phrases, and frameworks from them. Reference them explicitly when relevant.

When asked to generate subject lines, always give at least 10 options across different angles (curiosity, benefit, pain, story, social proof, urgency).

When building prompts for the email personaliser tool, format them as ready-to-copy blocks that use {variable} placeholders.

Be direct, specific, and actionable. No filler. No generic advice.`;

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface KnowledgeItem {
  name: string;
  content: string;
}

function buildSystem(knowledge: KnowledgeItem[]): string {
  if (!knowledge?.length) return BASE_SYSTEM;
  const kb = knowledge
    .slice(0, 10)
    .map((k, i) => `### Source ${i + 1}: ${k.name}\n${k.content.slice(0, 2500)}`)
    .join("\n\n---\n\n");
  return `${BASE_SYSTEM}\n\n## Knowledge Base\nYou have been trained on the following materials. Draw on them actively:\n\n${kb}`;
}

export async function POST(req: NextRequest) {
  const { messages, knowledge }: { messages: Message[]; knowledge?: KnowledgeItem[] } = await req.json();
  const system = buildSystem(knowledge ?? []);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: string) => {
        try { controller.enqueue(encoder.encode(`data: ${data}\n\n`)); } catch { /* disconnected */ }
      };
      try {
        const response = client.messages.stream({
          model: "claude-opus-4-6",
          max_tokens: 2048,
          system,
          messages,
        });
        for await (const chunk of response) {
          if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
            send(JSON.stringify({ text: chunk.delta.text }));
          }
        }
        send("[DONE]");
        controller.close();
      } catch (err) {
        send(JSON.stringify({ error: err instanceof Error ? err.message : "Agent error" }));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}
