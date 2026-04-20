import * as cheerio from "cheerio";

export const ALWAYS_BLOCKED = /facebook\.com/i;

export function scrapedVarName(col: string): string {
  return `scraped_${col.replace(/\s+/g, "_")}`;
}

async function scrapeLinkedIn(url: string): Promise<string> {
  const apiKey = process.env.ENRICHLAYER_API_KEY;
  if (!apiKey) return "";

  try {
    const isCompany = /linkedin\.com\/company\//i.test(url);
    const endpoint = isCompany
      ? "https://enrichlayer.com/api/v2/company"
      : "https://enrichlayer.com/api/v2/profile";
    const paramName = isCompany ? "company_url" : "profile_url";

    const res = await fetch(`${endpoint}?${paramName}=${encodeURIComponent(url)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      if (res.status === 402) return `__ENRICHLAYER_CREDITS_EXHAUSTED__`;
      return `[LinkedIn API error ${res.status}: ${errText.slice(0, 200)}]`;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d: any = await res.json();
    const parts: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const skillName = (s: any): string => (typeof s === "string" ? s : s?.name ?? "");

    if (isCompany) {
      if (d.name)        parts.push(`Company: ${d.name}`);
      if (d.description) parts.push(`Description: ${String(d.description).slice(0, 600)}`);
      if (d.industry)    parts.push(`Industry: ${d.industry}`);
      if (d.company_size_on_linkedin) parts.push(`Size: ${d.company_size_on_linkedin} employees`);
      if (d.hq)          parts.push(`HQ: ${[d.hq.city, d.hq.country].filter(Boolean).join(", ")}`);
      if (d.specialities?.length) parts.push(`Specialties: ${(d.specialities as string[]).slice(0, 8).join(", ")}`);
      if (d.tagline)     parts.push(`Tagline: ${d.tagline}`);
    } else {
      if (d.full_name)   parts.push(`Name: ${d.full_name}`);
      if (d.headline)    parts.push(`Headline: ${d.headline}`);
      if (d.occupation)  parts.push(`Occupation: ${d.occupation}`);
      if (d.summary)     parts.push(`Summary: ${String(d.summary).slice(0, 400)}`);
      const location = [d.city, d.state, d.country_full_name].filter(Boolean).join(", ");
      if (location)      parts.push(`Location: ${location}`);
      const exp = d.experiences?.[0];
      if (exp) {
        const co = exp.company ?? exp.company_name ?? "";
        parts.push(`Current Role: ${exp.title}${co ? ` at ${co}` : ""}`);
        if (exp.description) parts.push(`Role Description: ${String(exp.description).slice(0, 200)}`);
      }
      if (d.skills?.length) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const list = (d.skills as any[]).slice(0, 8).map(skillName).filter(Boolean);
        if (list.length) parts.push(`Skills: ${list.join(", ")}`);
      }
      if (d.education?.length) {
        const edu = d.education[0];
        parts.push(`Education: ${edu.school ?? edu.school_name ?? ""}${edu.field_of_study ? ` — ${edu.field_of_study}` : ""}`);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const activities: any[] = d.activities ?? d.posts ?? d.recent_activities ?? [];
      if (activities.length) {
        const postLines = activities.slice(0, 2)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((a: any) => {
            const text = a.text ?? a.commentary ?? a.title ?? a.description ?? a.content ?? "";
            return text ? `- ${String(text).slice(0, 300)}` : null;
          })
          .filter(Boolean);
        if (postLines.length) parts.push(`Recent LinkedIn posts:\n${postLines.join("\n")}`);
      }
    }

    return parts.length ? parts.join("\n") : "[LinkedIn profile returned no data]";
  } catch (err) {
    return `[LinkedIn scrape error: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

async function runApifyActor(actorId: string, input: object, timeoutSecs = 8): Promise<unknown[]> {
  const apiKey = process.env.APIFY_API_KEY;
  if (!apiKey) return [];
  try {
    const res = await fetch(
      `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${apiKey}&timeout=${timeoutSecs}&memory=256`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout((timeoutSecs + 3) * 1000),
      }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function scrapeTwitter(url: string): Promise<string> {
  const match = url.match(/(?:twitter|x)\.com\/([A-Za-z0-9_]{1,50})(?:[/?#]|$)/i);
  const username = match?.[1];
  if (!username || /^(home|intent|search|explore|notifications|messages|i)$/i.test(username)) return "";

  const items = await runApifyActor("apidojo~tweet-scraper", {
    startUrls: [`https://twitter.com/${username}`],
    maxTweets: 5,
    sort: "Latest",
  }, 8);

  if (!items.length) return "";
  const parts: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const first = items[0] as any;
  const author = first?.author ?? first?.user;
  if (author?.name)        parts.push(`Twitter: @${author.userName ?? username} (${author.name})`);
  if (author?.description) parts.push(`Bio: ${author.description}`);
  if (author?.followers)   parts.push(`Followers: ${Number(author.followers).toLocaleString()}`);
  const tweets = items
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((t: any) => t.text ?? t.full_text)
    .filter(Boolean)
    .slice(0, 3) as string[];
  if (tweets.length) parts.push(`Recent tweets:\n${tweets.map((t) => `- ${t.slice(0, 200)}`).join("\n")}`);
  return parts.join("\n");
}

async function scrapeInstagram(url: string): Promise<string> {
  const match = url.match(/instagram\.com\/([A-Za-z0-9_.]{1,30})(?:[/?#]|$)/i);
  const username = match?.[1];
  if (!username || /^(p|reel|explore|stories)$/i.test(username)) return "";

  const items = await runApifyActor("apify~instagram-profile-scraper", { usernames: [username] }, 8);
  if (!items.length) return "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const profile = items[0] as any;
  const parts: string[] = [];
  if (profile?.fullName)       parts.push(`Instagram: @${profile.username ?? username} (${profile.fullName})`);
  if (profile?.biography)      parts.push(`Bio: ${profile.biography}`);
  if (profile?.followersCount) parts.push(`Followers: ${Number(profile.followersCount).toLocaleString()}`);
  if (profile?.postsCount)     parts.push(`Posts: ${profile.postsCount}`);
  return parts.join("\n");
}

export async function scrapeUrl(url: string): Promise<string> {
  if (!url?.trim()) return "";
  if (/linkedin\.com/i.test(url))         return scrapeLinkedIn(url);
  if (/twitter\.com|x\.com/i.test(url))   return scrapeTwitter(url);
  if (/instagram\.com/i.test(url))         return scrapeInstagram(url);
  if (ALWAYS_BLOCKED.test(url))            return "";

  try {
    const normalized = url.startsWith("http") ? url : `https://${url}`;
    const res = await fetch(normalized, {
      signal: AbortSignal.timeout(8000),
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
    });
    if (!res.ok) return "";
    const html = await res.text();
    const $ = cheerio.load(html);
    $("script, style, nav, footer, header, noscript, iframe, svg, form, [class*='cookie'], [class*='banner'], [class*='popup']").remove();
    const selectors = ["main", "article", '[class*="about"]', '[class*="hero"]', '[class*="content"]', '[class*="home"]', "section", "body"];
    let text = "";
    for (const sel of selectors) {
      const el = $(sel);
      if (el.length) {
        text = el.text().replace(/\s+/g, " ").trim();
        if (text.length > 300) break;
      }
    }
    const lower = text.toLowerCase();
    if (
      text.length < 150 ||
      (lower.includes("sign in") && (lower.includes("password") || lower.includes("email"))) ||
      lower.includes("enable javascript to continue") ||
      lower.includes("access denied") ||
      lower.includes("403 forbidden") ||
      lower.includes("just a moment")
    ) return "";
    return text.slice(0, 2000);
  } catch {
    return "";
  }
}
