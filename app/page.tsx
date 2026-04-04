"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import Papa from "papaparse";

const STORAGE_KEY = "cold-email-session-v2";

function saveToStorage(data: object) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // QuotaExceededError — try saving without results
    try {
      const { results: _r, followUpResults: _f, ...small } = data as Record<string, unknown>;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(small));
    } catch { /* ignore */ }
  }
}

type Row = Record<string, string>;

interface ScrapingEvent {
  type: "scraping";
  index: number;
  col: string;
  url: string;
}

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

type SSEEvent = ScrapingEvent | ProgressEvent | DoneEvent;

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

function scrapedVarName(col: string): string {
  return `scraped_${col.replace(/\s+/g, "_")}`;
}

function buildSamplePrompt(cols: string[], urlCols: string[]): string {
  const find = (...patterns: RegExp[]) =>
    cols.find((c) => patterns.some((p) => p.test(c)));

  const firstName = find(/first.?name/i, /^first$/i);
  const lastName = find(/last.?name/i, /^last$/i);
  const title = find(/\btitle\b/i, /job.?title/i, /\bposition\b/i, /\brole\b/i);
  const company = find(/company.?name.?for.?email/i, /company.?name/i, /\bcompany\b/i);
  const industry = find(/\bindustry\b/i);
  const city = find(/\bcity\b/i);
  const country = find(/\bcountry\b/i);

  const nameVar = firstName
    ? `{${firstName}}${lastName ? ` {${lastName}}` : ""}`
    : "there";

  const profileLines = [
    firstName && `Name: {${firstName}}${lastName ? ` {${lastName}}` : ""}`,
    title && `Title: {${title}}`,
    company && `Company: {${company}}`,
    industry && `Industry: {${industry}}`,
    (city || country) &&
      `Location: ${[city && `{${city}}`, country && `{${country}}`].filter(Boolean).join(", ")}`,
  ]
    .filter(Boolean)
    .join("\n");

  const scrapeSection =
    urlCols.length > 0 ? `\nResearch from their website:\n{scraped_content}\n` : "";

  return `Write a short, personalized cold email to ${nameVar}.

Lead profile:
${profileLines}
${scrapeSection}
Requirements:
- Open with something specific to them — their role, company, industry, or a detail from their website
- 3–5 sentences maximum, no filler openers like "I hope this finds you well"
- Naturally reference ${title ? `{${title}}` : "their role"} at ${company ? `{${company}}` : "their company"}
- End with one clear, low-friction CTA
- Human and conversational, not salesy
- No subject line, no signature`;
}

function buildFollowUpSamplePrompt(cols: string[]): string {
  const find = (...patterns: RegExp[]) =>
    cols.find((c) => patterns.some((p) => p.test(c)));
  const firstName = find(/first.?name/i, /^first$/i);
  const company = find(/company.?name.?for.?email/i, /company.?name/i, /\bcompany\b/i);
  const nameVar = firstName ? `{${firstName}}` : "them";
  return `Write a short follow-up email to ${nameVar} who has not responded to this previous outreach:

--- Previous Email ---
{generated_email}
--- End ---

Instructions:
- 2–3 sentences only
- Acknowledge they may be busy
- Restate the value in one sentence${company ? `\n- Mention {${company}} naturally` : ""}
- End with an even softer, easier CTA than the original
- Warmer and more casual tone than the first email
- No subject line, no signature`;
}

function clientInterpolate(template: string, row: Row, urlCols: string[]): string {
  return template.replace(/\{([^}]+)\}/g, (match, key) => {
    if (key === "scraped_content") {
      return urlCols.length > 0
        ? `[scraped website content — fetched at generation time]`
        : "[no URL columns selected for scraping]";
    }
    if (key.startsWith("scraped_")) return `[scraped at generation time]`;
    if (key === "generated_email") return "[original email from Step 4 generation]";
    return row[key] ?? match;
  });
}

export default function Home() {
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [fileName, setFileName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [urlColumns, setUrlColumns] = useState<string[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [scrapingInfo, setScrapingInfo] = useState<{ col: string; url: string } | null>(null);
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [rate, setRate] = useState<number | null>(null); // rows/min
  const [results, setResults] = useState<(Row & { generated_email: string })[]>([]);
  const [previewPage, setPreviewPage] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  // Follow-up email state
  const [followUpPrompt, setFollowUpPrompt] = useState("");
  const [followUpResults, setFollowUpResults] = useState<(Row & { generated_email: string })[]>([]);
  const [generatingFollowUp, setGeneratingFollowUp] = useState(false);
  const [followUpProgress, setFollowUpProgress] = useState({ completed: 0, total: 0 });
  const [followUpRate, setFollowUpRate] = useState<number | null>(null);
  const [followUpPage, setFollowUpPage] = useState(0);
  const [showFollowUpPreview, setShowFollowUpPreview] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pendingResultsRef = useRef<(Row & { generated_email: string })[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startTimeRef = useRef<number>(0);
  const completedRef = useRef(0);

  // Follow-up refs
  const followUpAbortRef = useRef<AbortController | null>(null);
  const followUpPendingRef = useRef<(Row & { generated_email: string })[]>([]);
  const followUpFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const followUpStartRef = useRef<number>(0);
  const followUpCompletedRef = useRef(0);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Persistence ──────────────────────────────────────────────────────────

  // Load saved session on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const d = JSON.parse(raw) as Record<string, unknown>;
      if (Array.isArray(d.columns) && d.columns.length) setColumns(d.columns as string[]);
      if (Array.isArray(d.rows) && (d.rows as Row[]).length) setRows(d.rows as Row[]);
      if (typeof d.fileName === "string") setFileName(d.fileName);
      if (typeof d.prompt === "string") setPrompt(d.prompt);
      if (Array.isArray(d.urlColumns)) setUrlColumns(d.urlColumns as string[]);
      if (Array.isArray(d.results) && (d.results as Row[]).length)
        setResults(d.results as (Row & { generated_email: string })[]);
      if (typeof d.followUpPrompt === "string") setFollowUpPrompt(d.followUpPrompt);
      if (Array.isArray(d.followUpResults) && (d.followUpResults as Row[]).length)
        setFollowUpResults(d.followUpResults as (Row & { generated_email: string })[]);
    } catch { /* corrupt storage — ignore */ }
  }, []);

  // Debounced save whenever session data changes
  useEffect(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveToStorage({
        columns, rows, fileName, prompt, urlColumns,
        results: results.filter(Boolean),
        followUpPrompt,
        followUpResults: followUpResults.filter(Boolean),
      });
    }, 800);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [columns, rows, fileName, prompt, urlColumns, results, followUpPrompt, followUpResults]);

  const PREVIEW_PAGE_SIZE = 10;
  const urlLikeColumns = columns.filter((c) =>
    /url|website|site|link|web|domain|linkedin|twitter/i.test(c)
  );

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
        setRate(null);
        setPreviewPage(0);
        // Auto-select all URL-like columns
        const autoSelected = cols.filter((c) =>
          /url|website|site|link|web|domain|linkedin|twitter/i.test(c)
        );
        setUrlColumns(autoSelected);
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

  const toggleUrlColumn = (col: string) => {
    setUrlColumns((prev) =>
      prev.includes(col) ? prev.filter((c) => c !== col) : [...prev, col]
    );
  };

  const copyColumn = (col: string) => {
    navigator.clipboard.writeText(`{${col}}`);
    setCopied(col);
    setTimeout(() => setCopied(null), 1500);
  };

  const flushResults = useCallback(() => {
    const snapshot = [...pendingResultsRef.current];
    setResults(snapshot);
    const elapsed = (Date.now() - startTimeRef.current) / 1000 / 60;
    if (elapsed > 0.05) {
      setRate(Math.round(completedRef.current / elapsed));
    }
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) return;
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      flushResults();
    }, 250);
  }, [flushResults]);

  const handleGenerate = async () => {
    if (!rows.length || !prompt.trim()) return;
    setGenerating(true);
    setScrapingInfo(null);
    setResults([]);
    setProgress({ completed: 0, total: rows.length });
    setRate(null);
    setPreviewPage(0);
    pendingResultsRef.current = new Array(rows.length);
    completedRef.current = 0;
    startTimeRef.current = Date.now();

    abortRef.current = new AbortController();

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows,
          prompt,
          urlColumns,
          batchSize: 10,
        }),
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
            if (event.type === "scraping") {
              setScrapingInfo({ col: event.col, url: event.url });
            } else if (event.type === "progress") {
              setScrapingInfo(null);
              completedRef.current = event.completed;
              pendingResultsRef.current[event.index] = event.row;
              setProgress({ completed: event.completed, total: event.total });
              scheduleFlush();
            } else if (event.type === "done") {
              setScrapingInfo(null);
              pendingResultsRef.current = event.results;
              completedRef.current = event.results.length;
              setProgress({ completed: event.results.length, total: event.results.length });
              if (flushTimerRef.current) {
                clearTimeout(flushTimerRef.current);
                flushTimerRef.current = null;
              }
              flushResults();
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
      setScrapingInfo(null);
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      flushResults();
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
    setGenerating(false);
    setScrapingInfo(null);
  };

  const clearSession = () => {
    if (!confirm("Clear everything and start a new session?")) return;
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    setColumns([]);
    setRows([]);
    setFileName("");
    setPrompt("");
    setUrlColumns([]);
    setResults([]);
    setProgress({ completed: 0, total: 0 });
    setRate(null);
    setPreviewPage(0);
    setFollowUpPrompt("");
    setFollowUpResults([]);
    setFollowUpProgress({ completed: 0, total: 0 });
    setFollowUpRate(null);
    setFollowUpPage(0);
    setShowPreview(false);
    setShowFollowUpPreview(false);
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

  const flushFollowUp = useCallback(() => {
    setFollowUpResults([...followUpPendingRef.current]);
    const elapsed = (Date.now() - followUpStartRef.current) / 1000 / 60;
    if (elapsed > 0.05) setFollowUpRate(Math.round(followUpCompletedRef.current / elapsed));
  }, []);

  const scheduleFollowUpFlush = useCallback(() => {
    if (followUpFlushRef.current) return;
    followUpFlushRef.current = setTimeout(() => {
      followUpFlushRef.current = null;
      flushFollowUp();
    }, 250);
  }, [flushFollowUp]);

  const handleGenerateFollowUp = async () => {
    const source = results.filter(Boolean);
    if (!source.length || !followUpPrompt.trim()) return;
    setGeneratingFollowUp(true);
    setFollowUpResults([]);
    setFollowUpProgress({ completed: 0, total: source.length });
    setFollowUpRate(null);
    setFollowUpPage(0);
    followUpPendingRef.current = new Array(source.length);
    followUpCompletedRef.current = 0;
    followUpStartRef.current = Date.now();
    followUpAbortRef.current = new AbortController();

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: source,
          prompt: followUpPrompt,
          urlColumns: [],        // no scraping for follow-ups
          outputColumn: "follow_up_email",
          batchSize: 10,
        }),
        signal: followUpAbortRef.current.signal,
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
            const event = JSON.parse(line.slice(6));
            if (event.type === "progress") {
              followUpCompletedRef.current = event.completed;
              followUpPendingRef.current[event.index] = event.row;
              setFollowUpProgress({ completed: event.completed, total: source.length });
              scheduleFollowUpFlush();
            } else if (event.type === "done") {
              followUpPendingRef.current = event.results;
              followUpCompletedRef.current = event.results.length;
              setFollowUpProgress({ completed: event.results.length, total: source.length });
              if (followUpFlushRef.current) { clearTimeout(followUpFlushRef.current); followUpFlushRef.current = null; }
              flushFollowUp();
            }
          } catch { /* ignore malformed */ }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name !== "AbortError") console.error(err);
    } finally {
      setGeneratingFollowUp(false);
      if (followUpFlushRef.current) { clearTimeout(followUpFlushRef.current); followUpFlushRef.current = null; }
      flushFollowUp();
    }
  };

  const handleStopFollowUp = () => {
    followUpAbortRef.current?.abort();
    setGeneratingFollowUp(false);
  };

  const downloadFollowUpCSV = () => {
    const valid = followUpResults.filter(Boolean);
    if (!valid.length) return;
    const csv = Papa.unparse(valid);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${fileName.replace(/\.csv$/, "")}_with_followups.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const validResults = results.filter(Boolean);
  const progressPct =
    progress.total > 0
      ? Math.round((progress.completed / progress.total) * 100)
      : 0;
  const eta =
    rate && rate > 0 && progress.completed < progress.total
      ? formatDuration(((progress.total - progress.completed) / rate) * 60)
      : null;
  const previewData = validResults.slice(
    previewPage * PREVIEW_PAGE_SIZE,
    (previewPage + 1) * PREVIEW_PAGE_SIZE
  );
  const totalPages = Math.ceil(validResults.length / PREVIEW_PAGE_SIZE);
  const allColumns =
    validResults.length > 0 ? Object.keys(validResults[0]) : [];

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <div className="max-w-5xl mx-auto px-4 py-10 space-y-8">

        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-white">Cold Email Personalizer</h1>
            <p className="mt-1 text-gray-400 text-sm">
              Upload a CSV, scrape lead websites automatically, write a prompt using{" "}
              <code className="bg-gray-800 px-1 rounded text-blue-400">{"{column_name}"}</code>{" "}
              variables, and generate personalized emails at scale — up to 10,000+ rows.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <a
              href="/prompts"
              className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-medium transition-colors"
            >
              ✨ Prompt Library
            </a>
            {(rows.length > 0 || results.filter(Boolean).length > 0) && (
              <button
                onClick={clearSession}
                className="text-xs px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-red-900 border border-gray-700 hover:border-red-700 text-gray-400 hover:text-red-300 transition-colors"
              >
                ✕ Clear session
              </button>
            )}
          </div>
        </div>

        {/* Step 1: Upload */}
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-500">
            Step 1 — Upload CSV
          </h2>
          <div
            className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
              isDragging
                ? "border-blue-500 bg-blue-500/10"
                : "border-gray-700 hover:border-gray-500"
            }`}
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={handleFileChange}
            />
            {fileName ? (
              <div className="space-y-1">
                <p className="text-green-400 font-medium">{fileName}</p>
                <p className="text-gray-400 text-sm">
                  {rows.length.toLocaleString()} rows · {columns.length} columns
                </p>
                {rows.length > 1000 && (
                  <p className="text-yellow-400 text-xs mt-1">
                    ⚠ Large dataset — generation will run in background. Keep this tab open.
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <div className="text-4xl">📂</div>
                <p className="text-gray-300 font-medium">
                  Drop your CSV here or click to browse
                </p>
                <p className="text-gray-500 text-sm">
                  Supports any CSV with a header row · 10,000+ rows supported
                </p>
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
              {urlColumns.length > 0 && (
                <>
                  {urlColumns.map((col) => (
                    <button
                      key={`scraped_${col}`}
                      onClick={() => copyColumn(scrapedVarName(col))}
                      className="px-3 py-1 rounded-full bg-indigo-900 hover:bg-indigo-700 text-sm text-indigo-300 hover:text-white transition-colors font-mono border border-indigo-700"
                      title={`Copy {${scrapedVarName(col)}}`}
                    >
                      {copied === scrapedVarName(col) ? "✓ Copied!" : `{${scrapedVarName(col)}}`}
                    </button>
                  ))}
                  <button
                    onClick={() => copyColumn("scraped_content")}
                    className="px-3 py-1 rounded-full bg-blue-900 hover:bg-blue-600 text-sm text-blue-300 hover:text-white transition-colors font-mono border border-blue-700"
                    title="All scraped columns combined"
                  >
                    {copied === "scraped_content" ? "✓ Copied!" : "{scraped_content}"}
                  </button>
                </>
              )}
            </div>
          </section>
        )}

        {/* Step 2: Web Scraping */}
        {columns.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-500">
              Step 2 — Web Scraping (optional)
            </h2>
            <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 space-y-3">
              {urlLikeColumns.length === 0 ? (
                <p className="text-sm text-gray-500 italic">
                  No URL columns detected in this CSV. Name a column with "url", "website",
                  "linkedin", etc. to enable scraping.
                </p>
              ) : (
                <>
                  <p className="text-sm text-gray-400">
                    Check the URL columns to scrape. The page text is available in your prompt as{" "}
                    <code className="bg-gray-800 px-1 rounded text-blue-400">{"{scraped_content}"}</code>
                    {" "}(all combined) or per-column as{" "}
                    <code className="bg-gray-800 px-1 rounded text-blue-400">{"{scraped_[ColumnName]}"}</code>.
                    {" "}Note: <code className="bg-gray-800 px-1 rounded text-yellow-400">{"{Website}"}</code>{" "}
                    only inserts the raw URL — use{" "}
                    <code className="bg-gray-800 px-1 rounded text-blue-400">{"{scraped_Website}"}</code>{" "}
                    for the actual page content.
                  </p>
                  <div className="flex flex-col gap-2">
                    {urlLikeColumns.map((col) => {
                      const isChecked = urlColumns.includes(col);
                      const isBlocked = /linkedin|facebook|twitter|instagram/i.test(col);
                      return (
                        <label
                          key={col}
                          className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer border transition-colors ${
                            isChecked && !isBlocked
                              ? "bg-blue-900/40 border-blue-600 text-blue-200"
                              : isChecked && isBlocked
                              ? "bg-yellow-900/30 border-yellow-700 text-yellow-200"
                              : "bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => toggleUrlColumn(col)}
                            className="accent-blue-500 w-4 h-4 shrink-0"
                          />
                          <span className="text-sm font-mono">{col}</span>
                          {isBlocked ? (
                            <span className="ml-auto text-xs text-yellow-500 shrink-0">⚠ blocks scraping</span>
                          ) : isChecked ? (
                            <span className="ml-auto text-xs text-indigo-400 font-mono shrink-0">
                              → {"{" + scrapedVarName(col) + "}"}
                            </span>
                          ) : null}
                        </label>
                      );
                    })}
                  </div>
                  <div className="space-y-1">
                    {urlColumns.length > 0 && (
                      <p className="text-xs text-green-400">
                        ✓ Will scrape {urlColumns.length} column{urlColumns.length > 1 ? "s" : ""}. Use{" "}
                        <span className="font-mono">{"{scraped_content}"}</span> in your prompt.
                      </p>
                    )}
                    <p className="text-xs text-gray-500">
                      If a site blocks scraping, the app automatically falls back to the lead{"'"}s CSV data so every email is still personalized.
                    </p>
                  </div>
                </>
              )}
            </div>
          </section>
        )}

        {/* Step 3: Prompt */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-500">
              {columns.length > 0 ? "Step 3" : "Step 2"} — Write Your Prompt
            </h2>
            {columns.length > 0 && (
              <button
                onClick={() => setPrompt(buildSamplePrompt(columns, urlColumns))}
                className="text-xs px-3 py-1 rounded-lg bg-indigo-700 hover:bg-indigo-600 text-white transition-colors"
              >
                ✨ Generate sample prompt
              </button>
            )}
          </div>
          <textarea
            className="w-full h-56 bg-gray-900 border border-gray-700 rounded-xl p-4 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500 resize-y font-mono"
            placeholder={`Click "Generate sample prompt" above to get a ready-to-use template, or write your own.\n\nUse {First Name}, {Company Name}, {scraped_content} etc. to inject lead data.\n\nExample:\n\nWrite a short cold email to {First Name} at {Company Name}.\nResearch: {scraped_content}\nKeep it under 100 words. End with a CTA.`}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <div className="flex items-center justify-between flex-wrap gap-2">
            <p className="text-xs text-gray-500">
              Your prompt <strong className="text-gray-300">must include</strong> variables like{" "}
              <code className="bg-gray-800 px-1 rounded text-blue-400">{"{First Name}"}</code>,{" "}
              <code className="bg-gray-800 px-1 rounded text-blue-400">{"{Company Name}"}</code>,{" "}
              <code className="bg-gray-800 px-1 rounded text-blue-400">{"{scraped_content}"}</code>{" "}
              for emails to be personalized.
            </p>
            {rows.length > 0 && prompt.trim() && (
              <button
                onClick={() => setShowPreview((v) => !v)}
                className="text-xs px-3 py-1 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors shrink-0"
              >
                {showPreview ? "Hide preview" : "Preview row 1 →"}
              </button>
            )}
          </div>
          {/* Prompt preview for row 1 */}
          {showPreview && rows[0] && (
            <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 space-y-2">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                What Claude receives for row 1 (variables substituted):
              </p>
              <pre className="text-xs text-gray-300 whitespace-pre-wrap font-mono leading-relaxed max-h-60 overflow-y-auto">
                {clientInterpolate(prompt, rows[0], urlColumns)}
              </pre>
            </div>
          )}
        </section>

        {/* Step 4: Generate */}
        <section className="space-y-4">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-500">
            {columns.length > 0 ? "Step 4" : "Step 3"} — Generate
          </h2>
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

          {/* Scraping indicator */}
          {generating && scrapingInfo && (
            <div className="flex items-center gap-2 text-xs text-yellow-400">
              <span className="animate-pulse">🔍</span>
              <span className="truncate max-w-md">
                Scraping <span className="font-semibold">{scrapingInfo.col}</span>:{" "}
                <span className="font-mono">{scrapingInfo.url}</span>...
              </span>
            </div>
          )}

          {/* Progress bar + stats */}
          {(generating || progress.completed > 0) && (
            <div className="space-y-2">
              <div className="flex justify-between items-center text-xs text-gray-400">
                <span>
                  {progress.completed.toLocaleString()} / {progress.total.toLocaleString()} emails
                  {urlColumns.length > 0 && " (with scraping)"}
                </span>
                <span className="flex items-center gap-3">
                  {rate !== null && (
                    <span className="text-gray-500">{rate.toLocaleString()} rows/min</span>
                  )}
                  {eta && generating && (
                    <span className="text-blue-400">~{eta} left</span>
                  )}
                  <span>{progressPct}%</span>
                </span>
              </div>
              <div className="w-full bg-gray-800 rounded-full h-2.5">
                <div
                  className="bg-blue-500 h-2.5 rounded-full transition-all duration-500"
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
                  >←</button>
                  <span className="text-gray-400">
                    {previewPage + 1} / {totalPages}
                  </span>
                  <button
                    onClick={() =>
                      setPreviewPage((p) => Math.min(totalPages - 1, p + 1))
                    }
                    disabled={previewPage === totalPages - 1}
                    className="px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-30"
                  >→</button>
                </div>
              )}
            </div>
            <div className="overflow-x-auto rounded-xl border border-gray-800">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="bg-gray-900 border-b border-gray-800">
                    {allColumns
                      .filter((col) => !col.startsWith("scraped_"))
                      .map((col) => (
                        <th
                          key={col}
                          className={`px-4 py-3 text-left font-semibold text-xs uppercase tracking-wide whitespace-nowrap ${
                            col === "generated_email"
                              ? "text-blue-400 min-w-80"
                              : "text-gray-400"
                          }`}
                        >
                          {col === "generated_email" ? "✉ Generated Email" : col}
                        </th>
                      ))}
                  </tr>
                </thead>
                <tbody>
                  {previewData.map((row, i) => (
                    <tr
                      key={i}
                      className="border-b border-gray-800 hover:bg-gray-900/50"
                    >
                      {allColumns
                        .filter((col) => !col.startsWith("scraped_"))
                        .map((col) => (
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

        {/* Step 5: Follow-up Emails */}
        {results.filter(Boolean).length > 0 && (
          <section className="space-y-4 border-t border-gray-800 pt-8">
            <div>
              <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-500">
                Step 5 — Follow-up Emails (optional)
              </h2>
              <p className="mt-1 text-sm text-gray-400">
                Generate a follow-up sequence for leads who haven{"'"}t responded. Use{" "}
                <code className="bg-gray-800 px-1 rounded text-blue-400">{"{generated_email}"}</code>{" "}
                to reference the original email, plus any other column variables.
              </p>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs text-gray-500 uppercase tracking-widest font-semibold">Follow-up Prompt</p>
                <button
                  onClick={() => setFollowUpPrompt(buildFollowUpSamplePrompt(columns))}
                  className="text-xs px-3 py-1 rounded-lg bg-indigo-700 hover:bg-indigo-600 text-white transition-colors"
                >
                  ✨ Generate sample follow-up
                </button>
              </div>
              <textarea
                className="w-full h-44 bg-gray-900 border border-gray-700 rounded-xl p-4 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-purple-500 resize-y font-mono"
                placeholder={`Example:\n\nWrite a follow-up email to {First Name} who hasn't responded.\n\nOriginal email:\n{generated_email}\n\nKeep it 2-3 sentences. Softer CTA. No subject line or signature.`}
                value={followUpPrompt}
                onChange={(e) => setFollowUpPrompt(e.target.value)}
              />
              <div className="flex items-center justify-between flex-wrap gap-2">
                <p className="text-xs text-gray-500">
                  Use <code className="bg-gray-800 px-1 rounded text-blue-400">{"{generated_email}"}</code> to include the original email in your follow-up prompt.
                </p>
                {followUpPrompt.trim() && (
                  <button
                    onClick={() => setShowFollowUpPreview((v) => !v)}
                    className="text-xs px-3 py-1 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors shrink-0"
                  >
                    {showFollowUpPreview ? "Hide preview" : "Preview row 1 →"}
                  </button>
                )}
              </div>
              {showFollowUpPreview && results.filter(Boolean)[0] && (
                <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 space-y-2">
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                    What Claude receives for row 1:
                  </p>
                  <pre className="text-xs text-gray-300 whitespace-pre-wrap font-mono leading-relaxed max-h-52 overflow-y-auto">
                    {clientInterpolate(followUpPrompt, results.filter(Boolean)[0], [])}
                  </pre>
                </div>
              )}
            </div>

            {/* Follow-up generate button */}
            <div className="flex items-center gap-3 flex-wrap">
              <button
                onClick={generatingFollowUp ? handleStopFollowUp : handleGenerateFollowUp}
                disabled={!followUpPrompt.trim()}
                className={`px-6 py-2.5 rounded-lg font-semibold text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  generatingFollowUp
                    ? "bg-red-600 hover:bg-red-700 text-white"
                    : "bg-purple-600 hover:bg-purple-700 text-white"
                }`}
              >
                {generatingFollowUp
                  ? "⛔ Stop"
                  : `↩ Generate Follow-ups (${results.filter(Boolean).length} rows)`}
              </button>
              {followUpResults.filter(Boolean).length > 0 && !generatingFollowUp && (
                <button
                  onClick={downloadFollowUpCSV}
                  className="px-6 py-2.5 rounded-lg font-semibold text-sm bg-green-600 hover:bg-green-700 text-white transition-colors"
                >
                  ⬇ Download with follow-ups
                </button>
              )}
            </div>

            {/* Follow-up progress */}
            {(generatingFollowUp || followUpProgress.completed > 0) && (() => {
              const pct = followUpProgress.total > 0
                ? Math.round((followUpProgress.completed / followUpProgress.total) * 100) : 0;
              const etaVal = followUpRate && followUpRate > 0 && followUpProgress.completed < followUpProgress.total
                ? formatDuration(((followUpProgress.total - followUpProgress.completed) / followUpRate) * 60) : null;
              return (
                <div className="space-y-2">
                  <div className="flex justify-between items-center text-xs text-gray-400">
                    <span>{followUpProgress.completed.toLocaleString()} / {followUpProgress.total.toLocaleString()} follow-ups</span>
                    <span className="flex items-center gap-3">
                      {followUpRate !== null && <span className="text-gray-500">{followUpRate.toLocaleString()} rows/min</span>}
                      {etaVal && generatingFollowUp && <span className="text-purple-400">~{etaVal} left</span>}
                      <span>{pct}%</span>
                    </span>
                  </div>
                  <div className="w-full bg-gray-800 rounded-full h-2.5">
                    <div className="bg-purple-500 h-2.5 rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })()}

            {/* Follow-up preview table */}
            {followUpResults.filter(Boolean).length > 0 && (() => {
              const validFU = followUpResults.filter(Boolean);
              const fuCols = Object.keys(validFU[0]).filter((c) => !c.startsWith("scraped_"));
              const fuTotalPages = Math.ceil(validFU.length / PREVIEW_PAGE_SIZE);
              const fuPageData = validFU.slice(
                followUpPage * PREVIEW_PAGE_SIZE,
                (followUpPage + 1) * PREVIEW_PAGE_SIZE
              );
              return (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-semibold uppercase tracking-widest text-gray-500">
                      Follow-up Preview — {validFU.length.toLocaleString()} rows
                    </h3>
                    {fuTotalPages > 1 && (
                      <div className="flex items-center gap-2 text-sm">
                        <button onClick={() => setFollowUpPage((p) => Math.max(0, p - 1))} disabled={followUpPage === 0} className="px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-30">←</button>
                        <span className="text-gray-400">{followUpPage + 1} / {fuTotalPages}</span>
                        <button onClick={() => setFollowUpPage((p) => Math.min(fuTotalPages - 1, p + 1))} disabled={followUpPage === fuTotalPages - 1} className="px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-30">→</button>
                      </div>
                    )}
                  </div>
                  <div className="overflow-x-auto rounded-xl border border-gray-800">
                    <table className="min-w-full text-sm">
                      <thead>
                        <tr className="bg-gray-900 border-b border-gray-800">
                          {fuCols.map((col) => (
                            <th key={col} className={`px-4 py-3 text-left font-semibold text-xs uppercase tracking-wide whitespace-nowrap ${
                              col === "follow_up_email" ? "text-purple-400 min-w-80" : col === "generated_email" ? "text-blue-400 min-w-64" : "text-gray-400"
                            }`}>
                              {col === "follow_up_email" ? "↩ Follow-up Email" : col === "generated_email" ? "✉ Original Email" : col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {fuPageData.map((row, i) => (
                          <tr key={i} className="border-b border-gray-800 hover:bg-gray-900/50">
                            {fuCols.map((col) => (
                              <td key={col} className={`px-4 py-3 align-top ${
                                col === "follow_up_email" || col === "generated_email"
                                  ? "text-gray-200 whitespace-pre-wrap text-xs leading-relaxed"
                                  : "text-gray-400 text-xs max-w-32 truncate"
                              }`}>
                                {row[col] ?? ""}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })()}
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
