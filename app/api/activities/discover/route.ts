import { discoverActivities, DiscoveryConfigError } from "@/lib/activity-discovery/discover";
import { parseDiscoveryRequest } from "@/lib/activity-discovery/validation";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const parsed = parseDiscoveryRequest(body);

  if (!parsed.ok || !parsed.request) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  try {
    const discovery = await discoverActivities(parsed.request);
    return Response.json(discovery);
  } catch (error) {
    if (error instanceof DiscoveryConfigError) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    const message =
      error instanceof Error ? error.message : "Activity discovery failed.";

    return Response.json({ error: message }, { status: 502 });
  }
}
