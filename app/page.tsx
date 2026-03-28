"use client";

import { useState, useRef, useCallback } from "react";
import Papa from "papaparse";

type Row = Record<string, string>;

interface ProgressEvent {
  type: "progress";
  completed: number;
  total: number;
  row: Row & { generated_email: string };
  index: number;
}

interface DoneEvent {
  type: "done";
  results: (Row & { generated_email: string })[];
}

type SSEEvent = ProgressEvent | DoneEvent;

export default function Home() {
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [fileName, setFileName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [results, setResults] = useState<(Row & { generated_email: string })[]>([]);
  const [previewPage, setPreviewPage] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const PREVIEW_PAGE_SIZE = 10;

  const parseCSV = useCallback((file: File) => {
    setFileName(file.name);
    Papa.parse<Row>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (result) => {
        const cols = result.meta.fields ?? [];
        setColumns(cols);
        setRows(result.data);
        setResults([]);
        setProgress({ completed: 0, total: 0 });
        setPreviewPage(0);
      },
    });
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) parseCSV(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file && file.name.endsWith(".csv")) parseCSV(file);
  };

  const copyColumn = (col: string) => {
    navigator.clipboard.writeText(`{${col}}`);
    setCopied(col);
    setTimeout(() => setCopied(null), 1500);
  };

  const handleGenerate = async () => {
    if (!rows.length || !prompt.trim()) return;
    setGenerating(true);
    setResults([]);
    setProgress({ completed: 0, total: rows.length });
    setPreviewPage(0);

    abortRef.current = new AbortController();

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows, prompt, batchSize: 5 }),
        signal: abortRef.current.signal,
      });

      if (!res.body) throw new Error("No response body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event: SSEEvent = JSON.parse(line.slice(6));
            if (event.type === "progress") {
              setProgress({ completed: event.completed, total: event.total });
              setResults((prev) => {
                const updated = [...prev];
                updated[event.index] = event.row;
                return updated;
              });
            } else if (event.type === "done") {
              setResults(event.results);
              setProgress({ completed: event.results.length, total: event.results.length });
            }
          } catch {
            // skip malformed events
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name !== "AbortError") {
        console.error(err);
      }
    } finally {
      setGenerating(false);
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
    setGenerating(false);
  };

  const downloadCSV = () => {
    const validResults = results.filter(Boolean);
    if (!validResults.length) return;
    const csv = Papa.unparse(validResults);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${fileName.replace(/\.csv$/, "")}_with_emails.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const validResults = results.filter(Boolean);
  const progressPct = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;
  const previewData = validResults.slice(previewPage * PREVIEW_PAGE_SIZE, (previewPage + 1) * PREVIEW_PAGE_SIZE);
  const totalPages = Math.ceil(validResults.length / PREVIEW_PAGE_SIZE);
  const allColumns = validResults.length > 0 ? Object.keys(validResults[0]) : [];

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <div className="max-w-5xl mx-auto px-4 py-10 space-y-8">

        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold text-white">Cold Email Personalizer</h1>
          <p className="mt-1 text-gray-400 text-sm">
            Upload a CSV lead list, write a prompt using{" "}
            <code className="bg-gray-800 px-1 rounded text-blue-400">{"{column_name}"}</code>{" "}
            variables, and generate a personalized email for every lead.
          </p>
        </div>

        {/* Step 1: Upload */}
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-500">Step 1 — Upload CSV</h2>
          <div
            className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
              isDragging ? "border-blue-500 bg-blue-500/10" : "border-gray-700 hover:border-gray-500"
            }`}
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <input ref={fileInputRef} type="file" accept=".csv" className="hidden" onChange={handleFileChange} />
            {fileName ? (
              <div className="space-y-1">
                <p className="text-green-400 font-medium">{fileName}</p>
                <p className="text-gray-400 text-sm">
                  {rows.length.toLocaleString()} rows · {columns.length} columns
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="text-4xl">📂</div>
                <p className="text-gray-300 font-medium">Drop your CSV here or click to browse</p>
                <p className="text-gray-500 text-sm">Supports any CSV with a header row</p>
              </div>
            )}
          </div>
        </section>

        {/* Column chips */}
        {columns.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-500">
              Available Columns — click to copy variable
            </h2>
            <div className="flex flex-wrap gap-2">
              {columns.map((col) => (
                <button
                  key={col}
                  onClick={() => copyColumn(col)}
                  className="px-3 py-1 rounded-full bg-gray-800 hover:bg-blue-600 text-sm text-gray-200 hover:text-white transition-colors font-mono"
                  title={`Copy {${col}}`}
                >
                  {copied === col ? "✓ Copied!" : `{${col}}`}
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Step 2: Prompt */}
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-500">Step 2 — Write Your Prompt</h2>
          <textarea
            className="w-full h-48 bg-gray-900 border border-gray-700 rounded-xl p-4 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500 resize-y font-mono"
            placeholder={`Example:\n\nWrite a short, personalized cold email to {first_name} who works as a {job_title} at {company}. Mention their industry ({industry}) and how our product can help them. Keep it under 150 words and end with a clear call to action.`}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <p className="text-xs text-gray-500">
            Use{" "}
            <code className="bg-gray-800 px-1 rounded text-blue-400">{"{column_name}"}</code>{" "}
            to inject lead data. Claude generates one email per row.
          </p>
        </section>

        {/* Step 3: Generate */}
        <section className="space-y-4">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-500">Step 3 — Generate</h2>
          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={generating ? handleStop : handleGenerate}
              disabled={!rows.length || !prompt.trim()}
              className={`px-6 py-2.5 rounded-lg font-semibold text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                generating
                  ? "bg-red-600 hover:bg-red-700 text-white"
                  : "bg-blue-600 hover:bg-blue-700 text-white"
              }`}
            >
              {generating ? "⛔ Stop Generation" : "⚡ Generate Emails"}
            </button>
            {validResults.length > 0 && !generating && (
              <button
                onClick={downloadCSV}
                className="px-6 py-2.5 rounded-lg font-semibold text-sm bg-green-600 hover:bg-green-700 text-white transition-colors"
              >
                ⬇ Download CSV
              </button>
            )}
          </div>

          {/* Progress bar */}
          {(generating || progress.completed > 0) && (
            <div className="space-y-2">
              <div className="flex justify-between text-xs text-gray-400">
                <span>
                  {progress.completed.toLocaleString()} / {progress.total.toLocaleString()} emails generated
                </span>
                <span>{progressPct}%</span>
              </div>
              <div className="w-full bg-gray-800 rounded-full h-2.5">
                <div
                  className="bg-blue-500 h-2.5 rounded-full transition-all duration-300"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>
          )}
        </section>

        {/* Preview Table */}
        {validResults.length > 0 && (
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-500">
                Preview — {validResults.length.toLocaleString()} rows ready
              </h2>
              {totalPages > 1 && (
                <div className="flex items-center gap-2 text-sm">
                  <button
                    onClick={() => setPreviewPage((p) => Math.max(0, p - 1))}
                    disabled={previewPage === 0}
                    className="px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-30"
                  >
                    ←
                  </button>
                  <span className="text-gray-400">{previewPage + 1} / {totalPages}</span>
                  <button
                    onClick={() => setPreviewPage((p) => Math.min(totalPages - 1, p + 1))}
                    disabled={previewPage === totalPages - 1}
                    className="px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-30"
                  >
                    →
                  </button>
                </div>
              )}
            </div>
            <div className="overflow-x-auto rounded-xl border border-gray-800">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="bg-gray-900 border-b border-gray-800">
                    {allColumns.map((col) => (
                      <th
                        key={col}
                        className={`px-4 py-3 text-left font-semibold text-xs uppercase tracking-wide whitespace-nowrap ${
                          col === "generated_email" ? "text-blue-400 min-w-80" : "text-gray-400"
                        }`}
                      >
                        {col === "generated_email" ? "✉ Generated Email" : col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewData.map((row, i) => (
                    <tr key={i} className="border-b border-gray-800 hover:bg-gray-900/50">
                      {allColumns.map((col) => (
                        <td
                          key={col}
                          className={`px-4 py-3 align-top ${
                            col === "generated_email"
                              ? "text-gray-200 whitespace-pre-wrap text-xs leading-relaxed min-w-80"
                              : "text-gray-400 text-xs max-w-32 truncate"
                          }`}
                        >
                          {row[col] ?? ""}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Footer */}
        <p className="text-center text-xs text-gray-700 pb-4">
          Powered by Claude · Emails are AI-generated — review before sending
        </p>
      </div>
    </div>
  );
}
