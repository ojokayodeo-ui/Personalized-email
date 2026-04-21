import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

const MAX_CHARS = 25_000;

async function extractPdf(buffer: Buffer): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfParse = require("pdf-parse");
  const result = await pdfParse(buffer);
  return result.text as string;
}

async function extractDocx(buffer: Buffer): Promise<string> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

async function extractEpub(buffer: Buffer): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buffer);
  const texts: string[] = [];
  for (const [filename, zipFile] of Object.entries(zip.files)) {
    if (/\.(html|xhtml|htm)$/i.test(filename)) {
      const html = await zipFile.async("string");
      // Strip tags and collapse whitespace
      const text = html.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
      if (text.length > 50) texts.push(text);
    }
  }
  return texts.join("\n\n");
}

async function extractText(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  const buffer = Buffer.from(await file.arrayBuffer());

  if (name.endsWith(".pdf"))             return extractPdf(buffer);
  if (name.endsWith(".docx") || name.endsWith(".doc")) return extractDocx(buffer);
  if (name.endsWith(".epub"))            return extractEpub(buffer);
  // Plain text formats
  return buffer.toString("utf-8");
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });

    const raw = await extractText(file);
    const text = raw.replace(/\s+/g, " ").trim().slice(0, MAX_CHARS);
    return NextResponse.json({ text, truncated: raw.length > MAX_CHARS, charCount: text.length });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to parse file" },
      { status: 500 },
    );
  }
}
