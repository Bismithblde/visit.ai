import { collectDiscoveryContent } from "./content-collector";
import { extractActivitiesWithOpenAI } from "./openai-extractor";
import { postprocessDiscovery } from "./postprocess";
import { buildQueryPlan } from "./query-plan";
import { TavilyDiscoveryTool } from "./tavily-tool";
import type { ActivityDiscoveryRequest, DiscoveryResponse } from "./types";

const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";

export async function discoverActivities(
  request: ActivityDiscoveryRequest,
): Promise<DiscoveryResponse> {
  const tavilyApiKey = process.env.TAVILY_API_KEY;
  const openAiApiKey = process.env.OPENAI_API_KEY;

  if (!tavilyApiKey) {
    throw new DiscoveryConfigError("Missing TAVILY_API_KEY");
  }

  if (!openAiApiKey) {
    throw new DiscoveryConfigError("Missing OPENAI_API_KEY");
  }

  const queryPlan = buildQueryPlan(request);
  const tool = new TavilyDiscoveryTool(tavilyApiKey);
  const collection = await collectDiscoveryContent(request, queryPlan, tool);
  const extracted = await extractActivitiesWithOpenAI({
    apiKey: openAiApiKey,
    model: process.env.OPENAI_ACTIVITY_MODEL || DEFAULT_OPENAI_MODEL,
    request,
    pages: collection.pages,
  });
  const postprocessed = postprocessDiscovery(
    request,
    extracted.candidates,
    extracted.clusters,
  );

  return {
    location: request.location,
    queryPlan,
    candidates: postprocessed.candidates,
    clusters: postprocessed.clusters,
    debug: collection.debug,
  };
}

export class DiscoveryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscoveryConfigError";
  }
}
