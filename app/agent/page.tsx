"use client";

import { useState, useRef, useEffect, useCallback } from "react";

const KB_KEY = "copywriter-knowledge-v1";
const CHAT_KEY = "copywriter-chat-v1";

interface KnowledgeItem {
  id: string;
  name: string;
  type: "file" | "url";
  content: string;
  charCount: number;
  addedAt: number;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

type Tab = "chat" | "brainstorm" | "knowledge" | "prompt";

const BRAINSTORM_TOOLS = [
  { id: "subject", label: "Subject Lines", icon: "✉", prompt: (ctx: string) => `Generate 12 compelling subject lines for this email campaign. Give a mix of: curiosity, benefit-driven, pain-point, story-based, social proof, and urgency angles. For each, add a 1-line note on the psychological trigger used.\n\nContext: ${ctx}` },
  { id: "hook", label: "Opening Hooks", icon: "🎣", prompt: (ctx: string) => `Write 8 powerful opening hooks for a cold email. Each should grab attention in the first line without using clichés like "I hope this finds you well". Use different angles: bold statement, provocative question, surprising stat, mini-story, pattern interrupt.\n\nContext: ${ctx}` },
  { id: "angles", label: "Email Angles", icon: "🎯", prompt: (ctx: string) => `Brainstorm 8 distinct email angles for this offer. Each angle should approach the pitch differently — different emotion, different story, different objection addressed. For each: angle name, core emotion, one-line description, example opening sentence.\n\nOffer/Context: ${ctx}` },
  { id: "cta", label: "CTAs", icon: "🚀", prompt: (ctx: string) => `Write 10 call-to-action variations for a cold email. Mix of: low-friction (just a question), direct ask, curiosity-based, benefit-framed, time-sensitive. Label each type.\n\nContext: ${ctx}` },
  { id: "ps", label: "P.S. Lines", icon: "📝", prompt: (ctx: string) => `Write 8 P.S. lines for a cold email. The P.S. is often the most-read part — make each one reinforce the key benefit, add urgency, or offer a secondary hook. Keep each under 2 sentences.\n\nContext: ${ctx}` },
  { id: "swipe", label: "Analyse Swipe", icon: "🔍", prompt: (ctx: string) => `Analyse this copy as an expert copywriter. Break down: (1) the big idea, (2) the lead/hook technique, (3) psychological triggers used, (4) structure and flow, (5) what makes it work, (6) what could be improved, (7) transferable patterns I can steal.\n\nCopy to analyse:\n${ctx}` },
];

const PROMPT_QUESTIONS = [
  { key: "offer", label: "What is your offer or product?", placeholder: "e.g. SaaS tool that saves 10h/week on reporting" },
  { key: "audience", label: "Who is your target audience?", placeholder: "e.g. Marketing directors at B2B SaaS companies" },
  { key: "pain", label: "What pain point do you solve?", placeholder: "e.g. Manual reporting wastes hours each week" },
  { key: "proof", label: "Any social proof or results?", placeholder: "e.g. 200+ customers, saves avg 10h/week" },
  { key: "cta", label: "What action should they take?", placeholder: "e.g. Book a 15-min demo" },
  { key: "tone", label: "What tone? (optional)", placeholder: "e.g. Friendly but professional, direct" },
];

export default function AgentPage() {
  const [tab, setTab] = useState<Tab>("chat");
  const [knowledge, setKnowledge] = useState<KnowledgeItem[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [scrapingUrl, setScrapingUrl] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [brainstormTool, setBrainstormTool] = useState(BRAINSTORM_TOOLS[0].id);
  const [brainstormCtx, setBrainstormCtx] = useState("");
  const [brainstormResult, setBrainstormResult] = useState("");
  const [brainstormStreaming, setBrainstormStreaming] = useState(false);
  const [promptAnswers, setPromptAnswers] = useState<Record<string, string>>({});
  const [promptResult, setPromptResult] = useState("");
  const [promptStreaming, setPromptStreaming] = useState(false);
  const [copied, setCopied] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Load from localStorage
  useEffect(() => {
    try {
      const kb = localStorage.getItem(KB_KEY);
      if (kb) setKnowledge(JSON.parse(kb));
      const ch = localStorage.getItem(CHAT_KEY);
      if (ch) setMessages(JSON.parse(ch));
    } catch { /* ignore */ }
  }, []);

  // Save knowledge
  useEffect(() => {
    try { localStorage.setItem(KB_KEY, JSON.stringify(knowledge)); } catch { /* ignore */ }
  }, [knowledge]);

  // Save chat
  useEffect(() => {
    try { localStorage.setItem(CHAT_KEY, JSON.stringify(messages.slice(-50))); } catch { /* ignore */ }
  }, [messages]);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, streaming]);

  // ── Streaming helper ──────────────────────────────────────────────────────
  const streamChat = useCallback(async (
    msgs: ChatMessage[],
    onToken: (t: string) => void,
    onDone: () => void,
    signal: AbortSignal,
  ) => {
    const res = await fetch("/api/agent/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: msgs, knowledge }),
      signal,
    });
    if (!res.body) { onDone(); return; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6);
        if (payload === "[DONE]") { onDone(); return; }
        try { const { text } = JSON.parse(payload); if (text) onToken(text); } catch { /* skip */ }
      }
    }
    onDone();
  }, [knowledge]);

  // ── Chat send ─────────────────────────────────────────────────────────────
  const sendMessage = async () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    const newMessages: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages(newMessages);
    setStreaming(true);
    let reply = "";
    setMessages([...newMessages, { role: "assistant", content: "" }]);
    abortRef.current = new AbortController();
    try {
      await streamChat(
        newMessages,
        (token) => { reply += token; setMessages([...newMessages, { role: "assistant", content: reply }]); },
        () => { setStreaming(false); },
        abortRef.current.signal,
      );
    } catch { setStreaming(false); }
  };

  // ── Brainstorm ────────────────────────────────────────────────────────────
  const runBrainstorm = async () => {
    if (!brainstormCtx.trim() || brainstormStreaming) return;
    const tool = BRAINSTORM_TOOLS.find((t) => t.id === brainstormTool)!;
    const userMsg = tool.prompt(brainstormCtx);
    setBrainstormResult("");
    setBrainstormStreaming(true);
    let out = "";
    abortRef.current = new AbortController();
    try {
      await streamChat(
        [{ role: "user", content: userMsg }],
        (token) => { out += token; setBrainstormResult(out); },
        () => { setBrainstormStreaming(false); },
        abortRef.current.signal,
      );
    } catch { setBrainstormStreaming(false); }
  };

  // ── Prompt builder ────────────────────────────────────────────────────────
  const buildPrompt = async () => {
    if (promptStreaming) return;
    const filled = Object.entries(promptAnswers).filter(([, v]) => v.trim()).map(([k, v]) => `${k}: ${v}`).join("\n");
    if (!filled) return;
    setPromptResult("");
    setPromptStreaming(true);
    const userMsg = `Create a detailed prompt template for an AI email personalizer tool. The prompt should use {First Name}, {Company Name}, {scraped_content} and other {variable} placeholders where relevant. It should instruct Claude to write a short, personalised cold email.

Details about this campaign:
${filled}

Format the output as:
1. A ready-to-use prompt block (copy-paste ready, with {placeholders})
2. 5 subject line options for this campaign
3. A brief note on the angle/strategy chosen`;

    let out = "";
    abortRef.current = new AbortController();
    try {
      await streamChat(
        [{ role: "user", content: userMsg }],
        (token) => { out += token; setPromptResult(out); },
        () => { setPromptStreaming(false); },
        abortRef.current.signal,
      );
    } catch { setPromptStreaming(false); }
  };

  // ── Knowledge: add URL ────────────────────────────────────────────────────
  const addUrl = async () => {
    const url = urlInput.trim();
    if (!url || scrapingUrl) return;
    setScrapingUrl(true);
    try {
      const res = await fetch("/api/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ rowIndex: 0, col: "url", url }] }),
      });
      const { results } = await res.json() as { results: { text: string }[] };
      const text = results[0]?.text ?? "";
      if (!text) { alert("Could not scrape that URL — it may block bots."); return; }
      const item: KnowledgeItem = {
        id: crypto.randomUUID(),
        name: url.replace(/^https?:\/\//, "").slice(0, 60),
        type: "url",
        content: text,
        charCount: text.length,
        addedAt: Date.now(),
      };
      setKnowledge((prev) => [item, ...prev]);
      setUrlInput("");
    } catch { alert("Failed to scrape URL."); }
    finally { setScrapingUrl(false); }
  };

  // ── Knowledge: upload file ────────────────────────────────────────────────
  const uploadFile = async (file: File) => {
    setUploadingFile(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/agent/ingest", { method: "POST", body: fd });
      const { text, error } = await res.json() as { text?: string; error?: string };
      if (error || !text) { alert(error ?? "Failed to extract text from file."); return; }
      const item: KnowledgeItem = {
        id: crypto.randomUUID(),
        name: file.name,
        type: "file",
        content: text,
        charCount: text.length,
        addedAt: Date.now(),
      };
      setKnowledge((prev) => [item, ...prev]);
    } catch { alert("Upload failed."); }
    finally { setUploadingFile(false); }
  };

  const handleFiles = (files: FileList | null) => {
    if (!files) return;
    Array.from(files).forEach(uploadFile);
  };

  const copyText = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const totalKbChars = knowledge.reduce((s, k) => s + k.charCount, 0);

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col">
      {/* ── Top nav ─────────────────────────────────────────────── */}
      <header className="border-b border-gray-800 px-4 py-3 flex items-center gap-4">
        <a href="/" className="text-xs text-gray-500 hover:text-gray-300 transition-colors">← Email Personalizer</a>
        <div className="w-px h-4 bg-gray-700" />
        <h1 className="font-bold text-white text-sm">Copywriting Agent</h1>
        {knowledge.length > 0 && (
          <span className="ml-auto text-xs text-indigo-400 bg-indigo-900/30 px-2 py-0.5 rounded-full border border-indigo-800">
            {knowledge.length} source{knowledge.length !== 1 ? "s" : ""} · {Math.round(totalKbChars / 1000)}k chars trained
          </span>
        )}
      </header>

      {/* ── Tabs ────────────────────────────────────────────────── */}
      <div className="border-b border-gray-800 px-4 flex gap-1">
        {([ ["chat","💬 Chat"], ["brainstorm","⚡ Brainstorm"], ["prompt","🛠 Build Prompt"], ["knowledge","📚 Knowledge Base"] ] as [Tab, string][]).map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${tab === t ? "border-indigo-500 text-white" : "border-transparent text-gray-500 hover:text-gray-300"}`}>
            {label}
            {t === "knowledge" && knowledge.length > 0 && (
              <span className="ml-1.5 text-xs bg-indigo-800 text-indigo-200 px-1.5 py-0.5 rounded-full">{knowledge.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* ── Chat ────────────────────────────────────────────────── */}
      {tab === "chat" && (
        <div className="flex-1 flex flex-col max-w-4xl w-full mx-auto px-4 py-4" style={{ minHeight: 0 }}>
          {messages.length === 0 && (
            <div className="flex-1 flex flex-col items-center justify-center text-center space-y-4 py-16">
              <div className="text-5xl">✍️</div>
              <h2 className="text-xl font-bold text-white">Your Copywriting Specialist</h2>
              <p className="text-gray-400 text-sm max-w-md">Ask anything about copywriting, email strategy, or request subject lines, hooks, and angles. Add books and swipe files to the Knowledge Base to train the agent on your style.</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-4 w-full max-w-lg">
                {["Write me 10 subject lines for a cold email promoting a productivity SaaS to CTOs",
                  "What makes Gary Halbert's copywriting so effective? Give me 5 transferable principles",
                  "Analyse this subject line and tell me why it works: 'Your competitor is already using this'",
                  "Write a P.S. line for a cold email offering a free audit to marketing agencies"
                ].map((s) => (
                  <button key={s} onClick={() => { setInput(s); }}
                    className="text-left text-xs bg-gray-900 hover:bg-gray-800 border border-gray-700 hover:border-gray-500 rounded-lg px-3 py-2.5 text-gray-400 hover:text-gray-200 transition-colors">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="flex-1 overflow-y-auto space-y-4 pb-4">
            {messages.map((msg, i) => (
              <div key={i} className={`flex gap-3 ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                {msg.role === "assistant" && (
                  <div className="w-7 h-7 rounded-full bg-indigo-700 flex items-center justify-center text-xs shrink-0 mt-0.5">✍</div>
                )}
                <div className={`max-w-[80%] rounded-xl px-4 py-3 text-sm whitespace-pre-wrap leading-relaxed ${
                  msg.role === "user" ? "bg-blue-700 text-white" : "bg-gray-800 text-gray-100"
                }`}>
                  {msg.content}
                  {msg.role === "assistant" && msg.content && (
                    <button onClick={() => copyText(msg.content)}
                      className="mt-2 text-xs text-gray-500 hover:text-gray-300 block transition-colors">
                      {copied ? "✓ Copied" : "Copy"}
                    </button>
                  )}
                </div>
                {msg.role === "user" && (
                  <div className="w-7 h-7 rounded-full bg-blue-700 flex items-center justify-center text-xs shrink-0 mt-0.5">You</div>
                )}
              </div>
            ))}
            {streaming && messages[messages.length - 1]?.role === "assistant" && !messages[messages.length - 1]?.content && (
              <div className="flex gap-3"><div className="w-7 h-7 rounded-full bg-indigo-700 flex items-center justify-center text-xs">✍</div>
                <div className="bg-gray-800 rounded-xl px-4 py-3"><span className="animate-pulse text-gray-400 text-sm">Thinking…</span></div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>
          <div className="flex gap-2 pt-2 border-t border-gray-800">
            {messages.length > 0 && (
              <button onClick={() => { abortRef.current?.abort(); setStreaming(false); setMessages([]); }}
                className="text-xs px-3 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-400 transition-colors shrink-0">
                Clear
              </button>
            )}
            <textarea
              className="flex-1 bg-gray-900 border border-gray-700 focus:border-indigo-500 rounded-xl px-4 py-2.5 text-sm text-gray-100 placeholder-gray-600 focus:outline-none resize-none"
              rows={2}
              placeholder="Ask about copywriting, request subject lines, analyse copy…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
            />
            <button onClick={streaming ? () => { abortRef.current?.abort(); setStreaming(false); } : sendMessage}
              disabled={!input.trim() && !streaming}
              className={`px-4 py-2 rounded-xl text-sm font-semibold transition-colors shrink-0 ${
                streaming ? "bg-red-600 hover:bg-red-700 text-white" : "bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-40"
              }`}>
              {streaming ? "Stop" : "Send"}
            </button>
          </div>
        </div>
      )}

      {/* ── Brainstorm ──────────────────────────────────────────── */}
      {tab === "brainstorm" && (
        <div className="flex-1 max-w-4xl w-full mx-auto px-4 py-6 space-y-6">
          <div className="space-y-2">
            <h2 className="text-lg font-bold text-white">Copywriting Brainstorm Tools</h2>
            <p className="text-gray-400 text-sm">Pick a tool, describe your campaign or paste your copy, get expert output instantly.</p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {BRAINSTORM_TOOLS.map((t) => (
              <button key={t.id} onClick={() => { setBrainstormTool(t.id); setBrainstormResult(""); }}
                className={`px-3 py-2.5 rounded-xl text-sm font-medium border transition-colors text-left ${
                  brainstormTool === t.id ? "bg-indigo-800 border-indigo-600 text-white" : "bg-gray-900 border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200"
                }`}>
                <span className="mr-1.5">{t.icon}</span>{t.label}
              </button>
            ))}
          </div>
          <div className="space-y-2">
            <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
              {brainstormTool === "swipe" ? "Paste the copy to analyse" : "Describe your campaign / offer / audience"}
            </label>
            <textarea
              className="w-full bg-gray-900 border border-gray-700 focus:border-indigo-500 rounded-xl px-4 py-3 text-sm text-gray-100 placeholder-gray-600 focus:outline-none resize-y"
              rows={4}
              placeholder={brainstormTool === "swipe" ? "Paste email copy, subject lines, or any marketing text here…" : "e.g. SaaS tool for marketing agencies, saves 10h/week on reporting, targeting marketing directors…"}
              value={brainstormCtx}
              onChange={(e) => setBrainstormCtx(e.target.value)}
            />
          </div>
          <button onClick={brainstormStreaming ? () => { abortRef.current?.abort(); setBrainstormStreaming(false); } : runBrainstorm}
            disabled={!brainstormCtx.trim() && !brainstormStreaming}
            className={`px-6 py-2.5 rounded-xl font-semibold text-sm transition-colors disabled:opacity-40 ${
              brainstormStreaming ? "bg-red-600 hover:bg-red-700 text-white" : "bg-indigo-600 hover:bg-indigo-700 text-white"
            }`}>
            {brainstormStreaming ? "⛔ Stop" : `⚡ Run ${BRAINSTORM_TOOLS.find(t => t.id === brainstormTool)?.label}`}
          </button>
          {brainstormResult && (
            <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Result</span>
                <button onClick={() => copyText(brainstormResult)}
                  className="text-xs px-2.5 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white transition-colors">
                  {copied ? "✓ Copied" : "Copy all"}
                </button>
              </div>
              <pre className="text-sm text-gray-200 whitespace-pre-wrap leading-relaxed font-sans">{brainstormResult}</pre>
              {brainstormStreaming && <span className="animate-pulse text-indigo-400 text-xs">Writing…</span>}
            </div>
          )}
        </div>
      )}

      {/* ── Build Prompt ─────────────────────────────────────────── */}
      {tab === "prompt" && (
        <div className="flex-1 max-w-4xl w-full mx-auto px-4 py-6 space-y-6">
          <div className="space-y-1">
            <h2 className="text-lg font-bold text-white">Prompt Builder</h2>
            <p className="text-gray-400 text-sm">Answer a few questions and get a ready-to-use prompt for the Email Personalizer — complete with {"{variable}"} placeholders and subject line options.</p>
          </div>
          <div className="space-y-4">
            {PROMPT_QUESTIONS.map((q) => (
              <div key={q.key} className="space-y-1.5">
                <label className="text-sm font-medium text-gray-300">{q.label}</label>
                <textarea
                  className="w-full bg-gray-900 border border-gray-700 focus:border-indigo-500 rounded-xl px-4 py-2.5 text-sm text-gray-100 placeholder-gray-600 focus:outline-none resize-none"
                  rows={2}
                  placeholder={q.placeholder}
                  value={promptAnswers[q.key] ?? ""}
                  onChange={(e) => setPromptAnswers((p) => ({ ...p, [q.key]: e.target.value }))}
                />
              </div>
            ))}
          </div>
          <button onClick={promptStreaming ? () => { abortRef.current?.abort(); setPromptStreaming(false); } : buildPrompt}
            disabled={!Object.values(promptAnswers).some(v => v.trim()) && !promptStreaming}
            className={`px-6 py-2.5 rounded-xl font-semibold text-sm transition-colors disabled:opacity-40 ${
              promptStreaming ? "bg-red-600 hover:bg-red-700 text-white" : "bg-indigo-600 hover:bg-indigo-700 text-white"
            }`}>
            {promptStreaming ? "⛔ Stop" : "🛠 Build My Prompt"}
          </button>
          {promptResult && (
            <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Generated Prompt + Subject Lines</span>
                <div className="flex gap-2">
                  <button onClick={() => copyText(promptResult)}
                    className="text-xs px-2.5 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white transition-colors">
                    {copied ? "✓ Copied" : "Copy"}
                  </button>
                  <a href="/" className="text-xs px-2.5 py-1 rounded bg-indigo-800 hover:bg-indigo-700 text-indigo-200 transition-colors">
                    → Use in Personalizer
                  </a>
                </div>
              </div>
              <pre className="text-sm text-gray-200 whitespace-pre-wrap leading-relaxed font-sans">{promptResult}</pre>
              {promptStreaming && <span className="animate-pulse text-indigo-400 text-xs">Writing…</span>}
            </div>
          )}
        </div>
      )}

      {/* ── Knowledge Base ───────────────────────────────────────── */}
      {tab === "knowledge" && (
        <div className="flex-1 max-w-4xl w-full mx-auto px-4 py-6 space-y-6">
          <div className="space-y-1">
            <h2 className="text-lg font-bold text-white">Knowledge Base</h2>
            <p className="text-gray-400 text-sm">Upload marketing books, swipe files, and paste URLs. The agent uses this material in every conversation and brainstorm.</p>
          </div>

          {/* File upload */}
          <div
            className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${isDragging ? "border-indigo-500 bg-indigo-500/10" : "border-gray-700 hover:border-gray-500"}`}
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => { e.preventDefault(); setIsDragging(false); handleFiles(e.dataTransfer.files); }}
            onClick={() => fileInputRef.current?.click()}
          >
            <input ref={fileInputRef} type="file" className="hidden" multiple
              accept=".pdf,.docx,.doc,.epub,.txt,.md,.rtf,.csv"
              onChange={(e) => handleFiles(e.target.files)} />
            {uploadingFile ? (
              <div className="space-y-2">
                <div className="animate-spin text-3xl">⚙️</div>
                <p className="text-gray-300">Extracting text…</p>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="text-4xl">📚</div>
                <p className="text-gray-300 font-medium">Drop files or click to upload</p>
                <p className="text-gray-500 text-sm">PDF, DOCX, EPUB, TXT, MD — marketing books, swipe files, frameworks</p>
              </div>
            )}
          </div>

          {/* URL scraper */}
          <div className="space-y-2">
            <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Add Swipe File URL</label>
            <div className="flex gap-2">
              <input
                className="flex-1 bg-gray-900 border border-gray-700 focus:border-indigo-500 rounded-xl px-4 py-2.5 text-sm text-gray-100 placeholder-gray-600 focus:outline-none"
                placeholder="https://swipefile.com/… or any page with copy"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") addUrl(); }}
              />
              <button onClick={addUrl} disabled={!urlInput.trim() || scrapingUrl}
                className="px-4 py-2.5 rounded-xl bg-indigo-700 hover:bg-indigo-600 text-white text-sm font-semibold transition-colors disabled:opacity-40 shrink-0">
                {scrapingUrl ? "Scraping…" : "Add URL"}
              </button>
            </div>
          </div>

          {/* Knowledge items */}
          {knowledge.length === 0 ? (
            <div className="bg-gray-900 border border-gray-700 rounded-xl px-6 py-8 text-center">
              <p className="text-gray-500 text-sm">No sources yet. Upload a PDF or add a URL to start training the agent.</p>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{knowledge.length} Source{knowledge.length !== 1 ? "s" : ""} · {Math.round(totalKbChars / 1000)}k chars</span>
                <button onClick={() => { if (confirm("Remove all knowledge sources?")) setKnowledge([]); }}
                  className="text-xs text-gray-600 hover:text-red-400 transition-colors">Clear all</button>
              </div>
              <div className="space-y-2">
                {knowledge.map((item) => (
                  <div key={item.id} className="flex items-start gap-3 bg-gray-900 border border-gray-700 rounded-xl px-4 py-3">
                    <span className="text-lg shrink-0">{item.type === "file" ? "📄" : "🔗"}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-200 truncate">{item.name}</p>
                      <p className="text-xs text-gray-500">{Math.round(item.charCount / 1000)}k chars · {new Date(item.addedAt).toLocaleDateString()}</p>
                      <p className="text-xs text-gray-600 mt-1 line-clamp-2">{item.content.slice(0, 150)}…</p>
                    </div>
                    <button onClick={() => setKnowledge((prev) => prev.filter((k) => k.id !== item.id))}
                      className="text-gray-600 hover:text-red-400 transition-colors text-lg shrink-0">✕</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
