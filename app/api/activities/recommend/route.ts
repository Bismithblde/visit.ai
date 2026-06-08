import { recommendActivities } from "@/lib/activity-recommendation/recommend";

export const runtime = "nodejs";
export const maxDuration = 60;

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

  const result = await recommendActivities(body);

  if (!result.ok) {
    return Response.json({ error: result.error }, { status: 400 });
  }

  return Response.json(result.response);
}
