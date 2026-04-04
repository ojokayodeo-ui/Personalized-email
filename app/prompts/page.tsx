"use client";

import { useState, useEffect, useCallback, useRef } from "react";

// ── Types ────────────────────────────────────────────────────────────────────

interface Variable {
  name: string;
  description?: string;
  default?: string;
}

interface Prompt {
  id: string;
  title: string;
  description?: string;
  content: string;
  tags: string[];
  category?: string;
  is_favorite: boolean;
  usage_count: number;
  variables: Variable[];
  created_at: string;
  updated_at: string;
}

interface Category {
  id: string;
  name: string;
  color: string;
  icon?: string;
}

interface Version {
  id: string;
  prompt_id: string;
  content: string;
  version_number: number;
  change_note?: string;
  created_at: string;
}

type SortOption = "recent" | "most_used" | "az" | "favorites";
type AIMode = "improve" | "rewrite" | "structure" | "generate";
type ActiveView = "library" | "editor" | "detail";

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractVariables(content: string): string[] {
  return [...new Set(content.match(/\{\{(\w+)\}\}/g)?.map((v) => v.slice(2, -2)) ?? [])];
}

function applyVariables(content: string, values: Record<string, string>): string {
  return content.replace(/\{\{(\w+)\}\}/g, (_, k) => values[k] ?? `{{${k}}}`);
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

async function api(path: string, opts?: RequestInit) {
  const res = await fetch(`/api/prompts${path}`, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: "Unknown error" }));
    throw new Error(err.detail ?? "Request failed");
  }
  return res.json();
}

// ── Tag badge ─────────────────────────────────────────────────────────────────

function Tag({ label, onRemove, color }: { label: string; onRemove?: () => void; color?: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium"
      style={{ background: color ? `${color}22` : "#6366f122", color: color ?? "#6366f1" }}
    >
      {label}
      {onRemove && (
        <button onClick={onRemove} className="hover:opacity-70 leading-none">×</button>
      )}
    </span>
  );
}

// ── Prompt Card ───────────────────────────────────────────────────────────────

function PromptCard({
  prompt,
  onSelect,
  onFavorite,
  onDelete,
  categoryColor,
}: {
  prompt: Prompt;
  onSelect: () => void;
  onFavorite: () => void;
  onDelete: () => void;
  categoryColor?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await navigator.clipboard.writeText(prompt.content);
    await fetch(`/api/prompts/${prompt.id}/use`, { method: "POST" });
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      onClick={onSelect}
      className="group relative bg-white border border-gray-100 rounded-xl p-4 cursor-pointer hover:border-indigo-200 hover:shadow-md transition-all duration-150"
    >
      {/* Category color strip */}
      {categoryColor && (
        <div
          className="absolute left-0 top-3 bottom-3 w-0.5 rounded-full"
          style={{ background: categoryColor }}
        />
      )}

      <div className="flex items-start justify-between gap-2 mb-2">
        <h3 className="font-semibold text-gray-900 text-sm leading-tight line-clamp-1 flex-1">
          {prompt.title}
        </h3>
        <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={(e) => { e.stopPropagation(); onFavorite(); }}
            className={`p-1 rounded-md hover:bg-gray-100 transition-colors text-sm ${prompt.is_favorite ? "text-amber-400" : "text-gray-300"}`}
            title={prompt.is_favorite ? "Remove favorite" : "Add favorite"}
          >
            ★
          </button>
          <button
            onClick={copy}
            className="p-1 rounded-md hover:bg-indigo-50 text-gray-400 hover:text-indigo-600 transition-colors text-xs"
            title="Copy to clipboard"
          >
            {copied ? "✓" : "⎘"}
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="p-1 rounded-md hover:bg-red-50 text-gray-300 hover:text-red-500 transition-colors text-xs"
            title="Delete"
          >
            ✕
          </button>
        </div>
        {/* Always-visible favorite star */}
        {prompt.is_favorite && (
          <span className="text-amber-400 text-sm shrink-0 group-hover:hidden">★</span>
        )}
      </div>

      {prompt.description && (
        <p className="text-xs text-gray-500 mb-2 line-clamp-1">{prompt.description}</p>
      )}

      <p className="text-xs text-gray-600 line-clamp-2 mb-3 font-mono leading-relaxed">
        {prompt.content}
      </p>

      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1 flex-1 min-w-0">
          {prompt.tags.slice(0, 3).map((t) => (
            <Tag key={t} label={t} />
          ))}
          {prompt.tags.length > 3 && (
            <span className="text-xs text-gray-400">+{prompt.tags.length - 3}</span>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-400 shrink-0">
          {prompt.usage_count > 0 && <span>{prompt.usage_count}× used</span>}
          <span>{timeAgo(prompt.created_at)}</span>
        </div>
      </div>
    </div>
  );
}

// ── Variable Filler Panel ─────────────────────────────────────────────────────

function VariablePanel({
  content,
  vars,
  onClose,
}: {
  content: string;
  vars: string[];
  onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);
  const filled = applyVariables(content, values);

  const copy = async () => {
    await navigator.clipboard.writeText(filled);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-2xl shadow-2xl flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <h2 className="font-semibold text-gray-900">Fill Variables & Copy</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg">×</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {vars.length > 0 ? (
            <>
              <p className="text-sm text-gray-500">Fill in the placeholders below, then copy the completed prompt.</p>
              <div className="grid gap-3">
                {vars.map((v) => (
                  <div key={v}>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      <code className="text-indigo-600">{`{{${v}}}`}</code>
                    </label>
                    <input
                      type="text"
                      placeholder={`Enter ${v.replace(/_/g, " ")}…`}
                      value={values[v] ?? ""}
                      onChange={(e) => setValues((p) => ({ ...p, [v]: e.target.value }))}
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-300"
                    />
                  </div>
                ))}
              </div>
              <hr className="border-gray-100" />
            </>
          ) : (
            <p className="text-sm text-gray-500">No variables found. Ready to copy.</p>
          )}

          <div>
            <label className="block text-xs font-medium text-gray-500 mb-2">Preview</label>
            <pre className="bg-gray-50 rounded-lg p-4 text-xs font-mono whitespace-pre-wrap text-gray-800 max-h-64 overflow-y-auto">
              {filled}
            </pre>
          </div>
        </div>

        <div className="p-5 border-t border-gray-100">
          <button
            onClick={copy}
            className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-medium text-sm transition-colors"
          >
            {copied ? "✓ Copied!" : "Copy to Clipboard"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Prompt Editor / Detail ────────────────────────────────────────────────────

function PromptEditor({
  prompt,
  categories,
  onSave,
  onCancel,
  isNew,
}: {
  prompt: Partial<Prompt>;
  categories: Category[];
  onSave: (p: Partial<Prompt>) => Promise<void>;
  onCancel: () => void;
  isNew: boolean;
}) {
  const [form, setForm] = useState<Partial<Prompt>>({ ...prompt });
  const [tagInput, setTagInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiMode, setAiMode] = useState<AIMode>("improve");
  const [aiResult, setAiResult] = useState<string | null>(null);
  const [showVars, setShowVars] = useState(false);
  const [versions, setVersions] = useState<Version[]>([]);
  const [showVersions, setShowVersions] = useState(false);
  const [error, setError] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const detectedVars = extractVariables(form.content ?? "");

  useEffect(() => {
    if (!isNew && prompt.id) {
      fetch(`/api/prompts/${prompt.id}/versions`)
        .then((r) => r.json())
        .then((d) => setVersions(d.versions ?? []));
    }
  }, [prompt.id, isNew]);

  const addTag = () => {
    const t = tagInput.trim().toLowerCase();
    if (t && !(form.tags ?? []).includes(t)) {
      setForm((p) => ({ ...p, tags: [...(p.tags ?? []), t] }));
    }
    setTagInput("");
  };

  const removeTag = (tag: string) =>
    setForm((p) => ({ ...p, tags: (p.tags ?? []).filter((t) => t !== tag) }));

  const handleSave = async () => {
    if (!form.title?.trim()) { setError("Title is required"); return; }
    if (!form.content?.trim()) { setError("Prompt content is required"); return; }
    setSaving(true);
    setError("");
    try {
      await onSave(form);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const runAI = async () => {
    if (!form.content?.trim()) { setError("Enter prompt content first"); return; }
    setAiLoading(true);
    setError("");
    try {
      const res = await api("/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: form.content, mode: aiMode }),
      });
      setAiResult(res.enhanced);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "AI enhancement failed");
    } finally {
      setAiLoading(false);
    }
  };

  const acceptAI = () => {
    if (aiResult) {
      setForm((p) => ({ ...p, content: aiResult }));
      setAiResult(null);
    }
  };

  const AI_MODES: { value: AIMode; label: string; desc: string }[] = [
    { value: "improve", label: "Improve", desc: "Make clearer & more specific" },
    { value: "rewrite", label: "Rewrite", desc: "Full professional rewrite" },
    { value: "structure", label: "Structure", desc: "Add role/task/format sections" },
    { value: "generate", label: "Generate", desc: "Generate from description" },
  ];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {showVars && (
        <VariablePanel
          content={form.content ?? ""}
          vars={detectedVars}
          onClose={() => setShowVars(false)}
        />
      )}

      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
        <h2 className="font-semibold text-gray-900">{isNew ? "New Prompt" : "Edit Prompt"}</h2>
        <div className="flex gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-100 rounded-lg transition-colors">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1.5 text-sm bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg font-medium transition-colors"
          >
            {saving ? "Saving…" : "Save Prompt"}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
        {error && (
          <div className="bg-red-50 border border-red-100 text-red-700 text-sm px-4 py-2.5 rounded-lg">
            {error}
          </div>
        )}

        {/* Title + Description */}
        <div className="grid gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Title *</label>
            <input
              type="text"
              placeholder="e.g. Cold Email Subject Line Generator"
              value={form.title ?? ""}
              onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-300"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Description</label>
            <input
              type="text"
              placeholder="Brief description of what this prompt does"
              value={form.description ?? ""}
              onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-300"
            />
          </div>
        </div>

        {/* Prompt Content */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs font-medium text-gray-600">
              Prompt Content *
              {detectedVars.length > 0 && (
                <span className="ml-2 text-indigo-500 font-normal">
                  {detectedVars.length} variable{detectedVars.length > 1 ? "s" : ""} detected
                </span>
              )}
            </label>
            <div className="flex gap-1">
              {detectedVars.length > 0 && (
                <button
                  onClick={() => setShowVars(true)}
                  className="text-xs text-indigo-600 hover:underline px-2 py-0.5 hover:bg-indigo-50 rounded"
                >
                  Fill variables
                </button>
              )}
              {!isNew && (
                <button
                  onClick={() => setShowVersions(!showVersions)}
                  className="text-xs text-gray-500 hover:underline px-2 py-0.5 hover:bg-gray-50 rounded"
                >
                  History {versions.length > 0 ? `(${versions.length})` : ""}
                </button>
              )}
            </div>
          </div>
          <textarea
            ref={textareaRef}
            placeholder="Write your prompt here… Use {{variable_name}} for dynamic parts."
            value={form.content ?? ""}
            onChange={(e) => setForm((p) => ({ ...p, content: e.target.value }))}
            rows={10}
            className="w-full text-sm font-mono border border-gray-200 rounded-lg px-3 py-3 focus:outline-none focus:ring-2 focus:ring-indigo-300 resize-y leading-relaxed"
          />
          <p className="text-xs text-gray-400 mt-1">
            Tip: Use <code className="bg-gray-100 px-1 rounded">{"{{variable_name}}"}</code> for dynamic placeholders.
          </p>
        </div>

        {/* Version History */}
        {showVersions && versions.length > 0 && (
          <div className="border border-gray-100 rounded-xl p-4 space-y-2">
            <p className="text-xs font-medium text-gray-600 mb-2">Version History</p>
            {versions.map((v) => (
              <div key={v.id} className="bg-gray-50 rounded-lg p-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium text-gray-700">v{v.version_number}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-400">{timeAgo(v.created_at)}</span>
                    <button
                      onClick={() => { setForm((p) => ({ ...p, content: v.content })); setShowVersions(false); }}
                      className="text-xs text-indigo-600 hover:underline"
                    >
                      Restore
                    </button>
                  </div>
                </div>
                {v.change_note && <p className="text-xs text-gray-500 mb-1">{v.change_note}</p>}
                <pre className="text-xs font-mono text-gray-600 line-clamp-3 whitespace-pre-wrap">
                  {v.content}
                </pre>
              </div>
            ))}
          </div>
        )}

        {/* AI Enhancement */}
        <div className="border border-indigo-100 bg-indigo-50/30 rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-700">✨ AI Enhancement</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {AI_MODES.map((m) => (
              <button
                key={m.value}
                onClick={() => setAiMode(m.value)}
                title={m.desc}
                className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                  aiMode === m.value
                    ? "bg-indigo-600 text-white border-indigo-600"
                    : "bg-white text-gray-600 border-gray-200 hover:border-indigo-300"
                }`}
              >
                {m.label}
              </button>
            ))}
            <button
              onClick={runAI}
              disabled={aiLoading}
              className="ml-auto text-xs px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg font-medium transition-colors"
            >
              {aiLoading ? "Thinking…" : "Run AI"}
            </button>
          </div>

          {aiResult && (
            <div className="space-y-2">
              <pre className="bg-white rounded-lg border border-indigo-100 p-3 text-xs font-mono whitespace-pre-wrap text-gray-800 max-h-48 overflow-y-auto">
                {aiResult}
              </pre>
              <div className="flex gap-2">
                <button
                  onClick={acceptAI}
                  className="text-xs px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-medium transition-colors"
                >
                  Use this version
                </button>
                <button
                  onClick={() => setAiResult(null)}
                  className="text-xs px-3 py-1.5 bg-white border border-gray-200 text-gray-600 hover:bg-gray-50 rounded-lg transition-colors"
                >
                  Discard
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Tags + Category */}
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Tags</label>
            <div className="flex flex-wrap gap-1 mb-2">
              {(form.tags ?? []).map((t) => (
                <Tag key={t} label={t} onRemove={() => removeTag(t)} />
              ))}
            </div>
            <div className="flex gap-1">
              <input
                type="text"
                placeholder="Add tag…"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addTag(); } }}
                className="flex-1 text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-300"
              />
              <button
                onClick={addTag}
                className="text-xs px-2.5 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
              >
                Add
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Category</label>
            <select
              value={form.category ?? ""}
              onChange={(e) => setForm((p) => ({ ...p, category: e.target.value || undefined }))}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-300 bg-white"
            >
              <option value="">No category</option>
              {categories.map((c) => (
                <option key={c.id} value={c.name}>{c.name}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Favorite toggle */}
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={form.is_favorite ?? false}
            onChange={(e) => setForm((p) => ({ ...p, is_favorite: e.target.checked }))}
            className="w-4 h-4 accent-indigo-600"
          />
          <span className="text-sm text-gray-700">Mark as favorite ★</span>
        </label>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function PromptsPage() {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [total, setTotal] = useState(0);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterTag, setFilterTag] = useState("");
  const [filterCategory, setFilterCategory] = useState("");
  const [sort, setSort] = useState<SortOption>("recent");
  const [activeView, setActiveView] = useState<ActiveView>("library");
  const [selectedPrompt, setSelectedPrompt] = useState<Prompt | null>(null);
  const [editingPrompt, setEditingPrompt] = useState<Partial<Prompt> | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [newCatName, setNewCatName] = useState("");
  const [newCatColor, setNewCatColor] = useState("#6366f1");
  const [toast, setToast] = useState<{ msg: string; type: "ok" | "err" } | null>(null);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (msg: string, type: "ok" | "err" = "ok") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const fetchPrompts = useCallback(async (s?: string, tag?: string, cat?: string, so?: SortOption) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (s) params.set("search", s);
      if (tag) params.set("tags", tag);
      if (cat) params.set("category", cat);
      if (so) params.set("sort", so);
      const data = await api(`?${params}`);
      setPrompts(data.prompts ?? []);
      setTotal(data.total ?? 0);
    } catch {
      showToast("Failed to load prompts", "err");
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchCategories = useCallback(async () => {
    try {
      const data = await api("/categories");
      setCategories(data.categories ?? []);
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    fetchPrompts(search, filterTag, filterCategory, sort);
    fetchCategories();
  }, []);

  // Debounced search
  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => {
      fetchPrompts(search, filterTag, filterCategory, sort);
    }, 300);
    return () => { if (searchTimeout.current) clearTimeout(searchTimeout.current); };
  }, [search, filterTag, filterCategory, sort, fetchPrompts]);

  const handleSelectPrompt = (p: Prompt) => {
    setSelectedPrompt(p);
    setEditingPrompt({ ...p });
    setIsNew(false);
    setActiveView("editor");
  };

  const handleNewPrompt = () => {
    setSelectedPrompt(null);
    setEditingPrompt({ title: "", content: "", tags: [], is_favorite: false, variables: [] });
    setIsNew(true);
    setActiveView("editor");
  };

  const handleSave = async (form: Partial<Prompt>) => {
    if (isNew) {
      await api("", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      showToast("Prompt created");
    } else if (selectedPrompt) {
      await api(`/${selectedPrompt.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      showToast("Prompt updated");
    }
    setActiveView("library");
    await fetchPrompts(search, filterTag, filterCategory, sort);
  };

  const handleFavorite = async (p: Prompt) => {
    await api(`/${p.id}/favorite`, { method: "POST" });
    setPrompts((prev) =>
      prev.map((x) => (x.id === p.id ? { ...x, is_favorite: !x.is_favorite } : x))
    );
  };

  const handleDelete = async (p: Prompt) => {
    if (!confirm(`Delete "${p.title}"?`)) return;
    await api(`/${p.id}`, { method: "DELETE" });
    showToast("Prompt deleted");
    if (selectedPrompt?.id === p.id) setActiveView("library");
    await fetchPrompts(search, filterTag, filterCategory, sort);
  };

  const handleCreateCategory = async () => {
    if (!newCatName.trim()) return;
    try {
      await api("/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newCatName.trim(), color: newCatColor }),
      });
      showToast("Category created");
      setNewCatName("");
      setShowCategoryModal(false);
      await fetchCategories();
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : "Failed", "err");
    }
  };

  const handleExport = async (fmt: "json" | "csv") => {
    const params = new URLSearchParams({ fmt });
    if (filterCategory) params.set("category", filterCategory);
    if (filterTag) params.set("tags", filterTag);
    window.open(`/api/prompts/export?${params}`, "_blank");
    setShowExportMenu(false);
  };

  // Collect all unique tags for filter chips
  const allTags = [...new Set(prompts.flatMap((p) => p.tags))].sort();

  const catMap = Object.fromEntries(categories.map((c) => [c.name, c.color]));

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Toast */}
      {toast && (
        <div
          className={`fixed top-4 right-4 z-50 px-4 py-2.5 rounded-xl text-sm font-medium shadow-lg transition-all ${
            toast.type === "ok" ? "bg-emerald-600 text-white" : "bg-red-600 text-white"
          }`}
        >
          {toast.msg}
        </div>
      )}

      {/* Category Modal */}
      {showCategoryModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm shadow-2xl p-6 space-y-4">
            <h3 className="font-semibold text-gray-900">New Category</h3>
            <input
              type="text"
              placeholder="Category name"
              value={newCatName}
              onChange={(e) => setNewCatName(e.target.value)}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-300"
              autoFocus
            />
            <div className="flex items-center gap-3">
              <label className="text-xs text-gray-600">Color</label>
              <input
                type="color"
                value={newCatColor}
                onChange={(e) => setNewCatColor(e.target.value)}
                className="w-8 h-8 rounded cursor-pointer border-0"
              />
              <span className="text-xs text-gray-500">{newCatColor}</span>
            </div>
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => setShowCategoryModal(false)}
                className="flex-1 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateCategory}
                className="flex-1 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-medium"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Top Nav */}
      <header className="bg-white border-b border-gray-100 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <a href="/" className="text-gray-400 hover:text-gray-600 text-sm transition-colors">← Back</a>
          <div className="h-4 w-px bg-gray-200" />
          <h1 className="text-lg font-bold text-gray-900">Prompt Library</h1>
          <span className="text-xs bg-indigo-100 text-indigo-600 px-2 py-0.5 rounded-full font-medium">
            {total} prompt{total !== 1 ? "s" : ""}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* Export */}
          <div className="relative">
            <button
              onClick={() => setShowExportMenu(!showExportMenu)}
              className="text-sm px-3 py-1.5 border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50 transition-colors"
            >
              Export ↓
            </button>
            {showExportMenu && (
              <div className="absolute right-0 top-full mt-1 bg-white border border-gray-100 rounded-xl shadow-lg py-1 z-20 w-32">
                <button onClick={() => handleExport("json")} className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
                  JSON
                </button>
                <button onClick={() => handleExport("csv")} className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
                  CSV
                </button>
              </div>
            )}
          </div>
          <button
            onClick={handleNewPrompt}
            className="text-sm px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-medium transition-colors"
          >
            + New Prompt
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-56 shrink-0 bg-white border-r border-gray-100 flex flex-col overflow-y-auto">
          <div className="p-4 space-y-1">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider px-2 mb-2">Sort</p>
            {([
              ["recent", "Recently Added"],
              ["most_used", "Most Used"],
              ["az", "A → Z"],
              ["favorites", "Favorites First"],
            ] as [SortOption, string][]).map(([val, label]) => (
              <button
                key={val}
                onClick={() => setSort(val)}
                className={`w-full text-left text-sm px-3 py-1.5 rounded-lg transition-colors ${
                  sort === val ? "bg-indigo-50 text-indigo-700 font-medium" : "text-gray-600 hover:bg-gray-50"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <hr className="border-gray-100 mx-4" />

          <div className="p-4 space-y-1">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider px-2 mb-2">Categories</p>
            <button
              onClick={() => setFilterCategory("")}
              className={`w-full text-left text-sm px-3 py-1.5 rounded-lg transition-colors ${
                !filterCategory ? "bg-indigo-50 text-indigo-700 font-medium" : "text-gray-600 hover:bg-gray-50"
              }`}
            >
              All prompts
            </button>
            {categories.map((c) => (
              <button
                key={c.id}
                onClick={() => setFilterCategory(filterCategory === c.name ? "" : c.name)}
                className={`w-full text-left text-sm px-3 py-1.5 rounded-lg transition-colors flex items-center gap-2 ${
                  filterCategory === c.name ? "bg-indigo-50 text-indigo-700 font-medium" : "text-gray-600 hover:bg-gray-50"
                }`}
              >
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: c.color }} />
                <span className="truncate">{c.name}</span>
              </button>
            ))}
            <button
              onClick={() => setShowCategoryModal(true)}
              className="w-full text-left text-xs px-3 py-1.5 text-indigo-500 hover:text-indigo-700 hover:bg-indigo-50 rounded-lg transition-colors"
            >
              + New category
            </button>
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 flex flex-col overflow-hidden">
          {activeView === "library" ? (
            <>
              {/* Search + Tag filters */}
              <div className="bg-white border-b border-gray-100 px-6 py-3 space-y-2">
                <input
                  type="text"
                  placeholder="Search prompts by title, content, or description…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full text-sm border border-gray-200 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-300"
                />
                {allTags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {allTags.slice(0, 20).map((t) => (
                      <button
                        key={t}
                        onClick={() => setFilterTag(filterTag === t ? "" : t)}
                        className={`text-xs px-2.5 py-0.5 rounded-full border transition-colors ${
                          filterTag === t
                            ? "bg-indigo-600 text-white border-indigo-600"
                            : "bg-white text-gray-500 border-gray-200 hover:border-indigo-300 hover:text-indigo-600"
                        }`}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Prompt Grid */}
              <div className="flex-1 overflow-y-auto p-6">
                {loading ? (
                  <div className="text-center py-20 text-gray-400 text-sm">Loading…</div>
                ) : prompts.length === 0 ? (
                  <div className="text-center py-20">
                    <p className="text-gray-400 text-sm mb-3">
                      {search || filterTag || filterCategory
                        ? "No prompts match your filters."
                        : "No prompts yet. Create your first one!"}
                    </p>
                    <button
                      onClick={handleNewPrompt}
                      className="text-sm px-4 py-2 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 font-medium transition-colors"
                    >
                      + New Prompt
                    </button>
                  </div>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {prompts.map((p) => (
                      <PromptCard
                        key={p.id}
                        prompt={p}
                        onSelect={() => handleSelectPrompt(p)}
                        onFavorite={() => handleFavorite(p)}
                        onDelete={() => handleDelete(p)}
                        categoryColor={p.category ? catMap[p.category] : undefined}
                      />
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 overflow-hidden">
              <PromptEditor
                prompt={editingPrompt ?? {}}
                categories={categories}
                onSave={handleSave}
                onCancel={() => setActiveView("library")}
                isNew={isNew}
              />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
