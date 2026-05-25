import { getSourceType } from "./source-quality";
import type { PageContent } from "./types";

export function isRedditUrl(url: string) {
  try {
    return new URL(url).hostname.toLowerCase().endsWith("reddit.com");
  } catch {
    return false;
  }
}

export async function fetchRedditJson(url: string): Promise<PageContent> {
  const jsonUrl = toRedditJsonUrl(url);
  const response = await fetch(jsonUrl, {
    headers: {
      Accept: "application/json",
      "User-Agent": "visit-ai-activity-discovery/0.1",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Reddit JSON failed with ${response.status} ${response.statusText}`,
    );
  }

  const json = (await response.json()) as unknown;
  const lines = collectRedditText(json);
  const content = uniqueStrings(lines)
    .filter((line) => line.length > 20)
    .slice(0, 80)
    .join("\n\n");

  if (!content.trim()) {
    throw new Error("Reddit JSON contained no readable text");
  }

  return {
    url,
    content,
    sourceType: getSourceType(url),
  };
}

function toRedditJsonUrl(url: string) {
  const parsed = new URL(url);
  parsed.search = "";
  parsed.hash = "";

  if (!parsed.pathname.endsWith(".json")) {
    parsed.pathname = parsed.pathname.replace(/\/?$/, ".json");
  }

  return parsed.toString();
}

function collectRedditText(value: unknown): string[] {
  const lines: string[] = [];

  function visit(node: unknown) {
    if (!node || typeof node !== "object") {
      return;
    }

    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }

    const record = node as Record<string, unknown>;
    const data = record.data;

    if (data && typeof data === "object") {
      const dataRecord = data as Record<string, unknown>;
      pushString(lines, dataRecord.title);
      pushString(lines, dataRecord.selftext);
      pushString(lines, dataRecord.body);
      pushString(lines, dataRecord.public_description);
    }

    Object.values(record).forEach(visit);
  }

  visit(value);
  return lines;
}

function pushString(lines: string[], value: unknown) {
  if (typeof value === "string") {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (normalized) {
      lines.push(normalized);
    }
  }
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}
