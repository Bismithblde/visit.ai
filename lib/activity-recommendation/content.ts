import { createHash } from "crypto";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { cleanWhitespace } from "@/lib/activities/normalize";
import { getSourceType } from "@/lib/activity-discovery/source-quality";
import type { SourceType } from "@/lib/activity-discovery/types";

export interface FetchedPage {
  url: string;
  normalizedUrl: string;
  title?: string;
  html: string;
  fetchedAt: Date;
  contentHash: string;
  sourceType: SourceType;
}

export interface CleanedChunk {
  pageTitle: string;
  url: string;
  heading: string;
  text: string;
  links: Array<{ text: string; href: string }>;
}

const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src",
  "utm_campaign",
  "utm_content",
  "utm_medium",
  "utm_source",
  "utm_term",
]);

const BOILERPLATE_PATTERNS = [
  /accept cookies/i,
  /advertisement/i,
  /all rights reserved/i,
  /follow us/i,
  /newsletter/i,
  /privacy policy/i,
  /read more/i,
  /related posts/i,
  /share this article/i,
  /sign in/i,
  /subscribe/i,
];

export function normalizeUrl(rawUrl: string) {
  const parsed = new URL(rawUrl);
  parsed.hash = "";
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");

  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase()) || key.toLowerCase().startsWith("utm_")) {
      parsed.searchParams.delete(key);
    }
  }

  parsed.searchParams.sort();
  const url = parsed.toString();
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export async function fetchHtmlPage(url: string): Promise<FetchedPage> {
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "visit-ai-activity-recommendation/0.1",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(12_000),
  });

  if (!response.ok) {
    throw new Error(`Fetch failed for ${url}: ${response.status}`);
  }

  const finalUrl = normalizeUrl(response.url || url);
  const html = await response.text();
  const title = extractTitle(html);

  return {
    url: finalUrl,
    normalizedUrl: finalUrl,
    title,
    html,
    fetchedAt: new Date(),
    contentHash: contentHash(html),
    sourceType: getSourceType(finalUrl),
  };
}

export function contentHash(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

export function cleanPageToChunks(page: Pick<FetchedPage, "url" | "title" | "html">): CleanedChunk[] {
  const dom = new JSDOM(page.html, { url: page.url });
  const document = dom.window.document;

  removeNonContent(document);
  const readable = new Readability(document.cloneNode(true) as Document).parse();
  const sourceDocument = readable?.content
    ? new JSDOM(readable.content, { url: page.url }).window.document
    : document.body.ownerDocument;
  const title = cleanWhitespace(readable?.title || page.title || document.title || page.url);

  return chunkDocument(sourceDocument, title, page.url).filter(isUsefulChunk);
}

export function isUsefulChunk(chunk: CleanedChunk) {
  const text = cleanWhitespace(chunk.text);
  if (text.length < 80) return false;
  if (!/[a-zA-Z]{3,}/.test(text)) return false;

  const lower = text.toLowerCase();
  const boilerplateHits = BOILERPLATE_PATTERNS.filter((pattern) => pattern.test(lower)).length;
  if (boilerplateHits >= 2) return false;

  const hasActivitySignal =
    /\b(activity|activities|things to do|visit|restaurant|food|park|museum|market|tour|class|karaoke|arcade|walk|event|venue|experience|group|indoor|outdoor)\b/i.test(
      text,
    );
  const hasLocationOrLink = /\b(street|avenue|neighborhood|near|located|address|ny|queens|flushing|city)\b/i.test(text) || chunk.links.length > 0;

  return hasActivitySignal && hasLocationOrLink;
}

function removeNonContent(document: Document) {
  const selectors = [
    "script",
    "style",
    "noscript",
    "header",
    "footer",
    "nav",
    "aside",
    "[role='banner']",
    "[role='navigation']",
    "[aria-modal='true']",
    ".ad",
    ".ads",
    ".advertisement",
    ".cookie",
    ".modal",
    ".newsletter",
    ".popup",
    ".sidebar",
    "[class*='cookie']",
    "[class*='newsletter']",
    "[class*='popup']",
    "[id*='cookie']",
  ];

  document.querySelectorAll(selectors.join(",")).forEach((node) => node.remove());
}

function chunkDocument(document: Document, pageTitle: string, url: string) {
  const chunks: CleanedChunk[] = [];
  const root = document.body ?? document;
  let currentHeading = pageTitle;
  let currentText: string[] = [];
  let currentLinks: Array<{ text: string; href: string }> = [];
  const seenBlocks = new Set<string>();

  function flush() {
    const text = dedupeLines(currentText).join("\n");
    if (text.trim()) {
      chunks.push({
        pageTitle,
        url,
        heading: currentHeading,
        text,
        links: currentLinks,
      });
    }
    currentText = [];
    currentLinks = [];
  }

  for (const element of Array.from(root.querySelectorAll("h1,h2,h3,h4,p,li,td,th,figcaption"))) {
    const tag = element.tagName.toLowerCase();
    const text = cleanWhitespace(element.textContent ?? "");
    if (!text || BOILERPLATE_PATTERNS.some((pattern) => pattern.test(text))) continue;

    if (/^h[1-4]$/.test(tag)) {
      flush();
      currentHeading = text;
      continue;
    }

    const key = text.toLowerCase();
    if (seenBlocks.has(key)) continue;
    seenBlocks.add(key);
    currentText.push(text);

    for (const link of Array.from(element.querySelectorAll("a[href]"))) {
      const href = link.getAttribute("href");
      const label = cleanWhitespace(link.textContent ?? "");
      if (href && label) {
        currentLinks.push({ text: label, href: new URL(href, url).toString() });
      }
    }

    if (currentText.join(" ").length > 2_000) {
      flush();
    }
  }

  flush();
  return chunks;
}

function dedupeLines(lines: string[]) {
  const seen = new Set<string>();
  return lines.filter((line) => {
    const key = line.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractTitle(html: string) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeHtml(match[1]) : undefined;
}

function decodeHtml(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
