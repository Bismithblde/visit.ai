import type {
  ActivityCandidate,
  ActivityCluster,
  ActivityDiscoveryRequest,
  PageContent,
} from "./types";

interface ExtractionResult {
  candidates: ActivityCandidate[];
  clusters: ActivityCluster[];
}

interface OpenAIResponse {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
}

export async function extractActivitiesWithOpenAI({
  apiKey,
  model,
  request,
  pages,
}: {
  apiKey: string;
  model: string;
  request: ActivityDiscoveryRequest;
  pages: PageContent[];
}): Promise<ExtractionResult> {
  if (pages.length === 0) {
    return { candidates: [], clusters: [] };
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      instructions: buildInstructions(),
      input: buildInput(request, pages),
      text: {
        format: {
          type: "json_schema",
          name: "activity_discovery_extraction",
          strict: true,
          schema: extractionSchema,
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(
      `OpenAI extraction failed with ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as OpenAIResponse;
  const text = getOutputText(data);

  if (!text) {
    throw new Error("OpenAI extraction returned no text output");
  }

  return JSON.parse(text) as ExtractionResult;
}

function buildInstructions() {
  return [
    "Extract possible activities and activity clusters from the supplied web content.",
    "Use only the supplied content. Do not invent exact addresses, hours, prices, ratings, or verification status.",
    "This is candidate discovery only. Every candidate and cluster must set needsVerification to true.",
    "Every candidate must have at least one source URL or evidence snippet.",
    "Prefer activities that match the user's location, group size, budget, and preferences.",
    "Use confidence to reflect evidence quality, repeated mentions, and source quality.",
  ].join("\n");
}

function buildInput(request: ActivityDiscoveryRequest, pages: PageContent[]) {
  return JSON.stringify({
    request,
    pages: pages.map((page) => ({
      url: page.url,
      sourceType: page.sourceType,
      title: page.title ?? "",
      content: page.content,
    })),
  });
}

function getOutputText(data: OpenAIResponse) {
  if (typeof data.output_text === "string") {
    return data.output_text;
  }

  return (
    data.output
      ?.flatMap((item) => item.content ?? [])
      .map((content) => content.text)
      .filter((text): text is string => typeof text === "string")
      .join("") ?? ""
  );
}

const candidateSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "name",
    "type",
    "description",
    "locationHint",
    "budgetFit",
    "groupFit",
    "tags",
    "sourceUrls",
    "evidenceSnippets",
    "confidence",
    "needsVerification",
  ],
  properties: {
    name: { type: "string" },
    type: {
      type: "string",
      enum: ["place", "area", "event", "activity_type", "route"],
    },
    description: { type: "string" },
    locationHint: { type: "string" },
    budgetFit: {
      type: "string",
      enum: ["low", "medium", "high", "unknown"],
    },
    groupFit: {
      type: "string",
      enum: ["solo", "couple", "small_group", "large_group", "unknown"],
    },
    tags: { type: "array", items: { type: "string" } },
    sourceUrls: { type: "array", items: { type: "string" } },
    evidenceSnippets: { type: "array", items: { type: "string" } },
    confidence: { type: "number" },
    needsVerification: { type: "boolean" },
  },
};

const clusterSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "title",
    "theme",
    "description",
    "candidateNames",
    "tags",
    "sourceUrls",
    "confidence",
    "needsVerification",
  ],
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    theme: { type: "string" },
    description: { type: "string" },
    candidateNames: { type: "array", items: { type: "string" } },
    tags: { type: "array", items: { type: "string" } },
    sourceUrls: { type: "array", items: { type: "string" } },
    confidence: { type: "number" },
    needsVerification: { type: "boolean" },
  },
};

const extractionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["candidates", "clusters"],
  properties: {
    candidates: {
      type: "array",
      items: candidateSchema,
    },
    clusters: {
      type: "array",
      items: clusterSchema,
    },
  },
};
