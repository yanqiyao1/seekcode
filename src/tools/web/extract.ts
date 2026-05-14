import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import type { ContentProfile } from "./types.js";

export function decodeHtml(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

export function normalizeText(text: string): string {
  return decodeHtml(text.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

export function processBody(body: string, contentType: string, format: "markdown" | "text" | "raw"): string {
  if (format === "raw") return body;
  const isHtml = contentType.includes("text/html") || /<html[\s>]/i.test(body) || /<(article|main|body|p|h1|h2)[\s>]/i.test(body);
  if (!isHtml) return formatStructuredText(body, contentType);
  return format === "markdown" ? htmlToMarkdown(body) : htmlToText(body);
}

export function contentProfile(body: string, contentType: string, processed: string, truncated: boolean): ContentProfile {
  const normalizedType = contentType.toLowerCase();
  const format: ContentProfile["format"] = normalizedType.includes("html")
    ? "html"
    : normalizedType.includes("json")
      ? "json"
      : normalizedType.includes("xml")
        ? "xml"
        : /^text\//.test(normalizedType) || !normalizedType
          ? "text"
          : "binary";
  let title: string | undefined;
  let mainContentRatio: number | undefined;
  if (format === "html") {
    const $ = cheerio.load(body);
    title = normalizeText($("title").first().text()) || undefined;
    const total = Math.max(1, normalizeText($("body").text() || $.text()).length);
    mainContentRatio = Math.min(1, normalizeText(selectReadableRoot($).text()).length / total);
  }
  return {
    ...(title ? { title } : {}),
    format,
    character_count: processed.length,
    word_count: processed.split(/\s+/).filter(Boolean).length,
    truncated,
    ...(mainContentRatio !== undefined ? { main_content_ratio: Number(mainContentRatio.toFixed(3)) } : {}),
  };
}

function htmlToText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, nav, footer, header, noscript, svg, iframe, canvas").remove();
  const title = normalizeText($("title").first().text());
  const root = selectReadableRoot($);
  root.find("br").replaceWith("\n");
  root.find("pre,code,li,p,div,section,article,tr").each((_, el) => { $(el).append("\n"); });
  const text = root.text().split("\n").map(line => normalizeText(line)).filter(Boolean).join("\n");
  return [title, text].filter(Boolean).join("\n\n").replace(/\n{3,}/g, "\n\n");
}

function htmlToMarkdown(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, nav, footer, header, noscript, svg, iframe, canvas").remove();
  $("br").replaceWith("\n");
  $("pre").each((_, el) => {
    const text = $(el).text().replace(/\n+$/g, "");
    $(el).replaceWith(`\n\`\`\`\n${text}\n\`\`\`\n`);
  });
  $("code").each((_, el) => {
    const text = normalizeText($(el).text());
    if (text) $(el).replaceWith(`\`${text.replace(/`/g, "\\`")}\``);
  });
  $("table").each((_, el) => {
    const rows = $(el).find("tr").map((_, row) =>
      $(row).find("th,td").map((_, cell) => normalizeText($(cell).text())).get().join(" | ")
    ).get().filter(Boolean);
    if (rows.length) $(el).replaceWith(`\n${rows.join("\n")}\n`);
  });
  $("a[href]").each((_, el) => {
    const text = normalizeText($(el).text());
    const href = $(el).attr("href") || "";
    if (text && /^https?:\/\//i.test(href)) $(el).replaceWith(`${text} (${href})`);
  });
  $("h1,h2,h3,h4").each((_, el) => {
    const tag = el.tagName.toLowerCase();
    const level = tag === "h1" ? "# " : tag === "h2" ? "## " : tag === "h3" ? "### " : "#### ";
    $(el).replaceWith(`\n${level}${normalizeText($(el).text())}\n`);
  });
  $("li").each((_, el) => {
    $(el).replaceWith(`\n- ${normalizeText($(el).text())}`);
  });
  $("p,div,section,article").each((_, el) => {
    $(el).append("\n");
  });
  const title = normalizeText($("title").first().text());
  const body = selectReadableRoot($).text();
  const text = decodeHtml(body).split("\n").map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
  return [title ? `# ${title}` : "", text].filter(Boolean).join("\n\n").replace(/\n{3,}/g, "\n\n");
}

function selectReadableRoot($: cheerio.CheerioAPI): cheerio.Cheerio<any> {
  const candidates = $("article, main, [role='main'], .markdown-body, .doc, .docs, .documentation, body").toArray();
  let best: Element | null = null;
  let bestScore = -1;
  for (const candidate of candidates) {
    const node = $(candidate);
    const textLength = normalizeText(node.text()).length;
    const linkLength = normalizeText(node.find("a").text()).length;
    const headingCount = node.find("h1,h2,h3").length;
    const codeCount = node.find("pre,code").length;
    const score = textLength - Math.floor(linkLength * 0.7) + headingCount * 120 + codeCount * 80;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best ? $(best) : $.root();
}

function formatStructuredText(body: string, contentType: string): string {
  const trimmed = body.trim();
  if (!trimmed) return body;
  if (contentType.includes("json") || /^[\[{]/.test(trimmed)) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return body;
    }
  }
  return body;
}
