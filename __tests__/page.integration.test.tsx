import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import Page from "@/app/page";

describe("trip planner page integration", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("blocks discovery when group size is invalid", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<Page />);

    fireEvent.change(screen.getByLabelText("Destination"), {
      target: { value: "Lisbon" },
    });
    fireEvent.change(screen.getByLabelText("Group size"), {
      target: { value: "" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Submit trip preferences" }));

    expect(
      screen.getByText("Group size must be an integer between 1 and 50."),
    ).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("discovers backend activities, renders them unchecked, and keeps the trip shell", async () => {
    vi.useFakeTimers();
    const discovery = deferred<Response>();
    const fetchMock = vi.fn(() => discovery.promise);
    vi.stubGlobal("fetch", fetchMock);
    render(<Page />);

    fireEvent.change(screen.getByLabelText("Budget"), {
      target: { value: "$2,400" },
    });
    fireEvent.change(screen.getByLabelText("Group size"), {
      target: { value: "4" },
    });
    fireEvent.change(screen.getByLabelText("Destination"), {
      target: { value: "Lisbon" },
    });
    fireEvent.change(
      screen.getByPlaceholderText(
        "Further personalize your trip with any concerns or preferences.",
      ),
      {
        target: { value: "quiet breakfasts and design stops" },
      },
    );

    fireEvent.click(screen.getByRole("button", { name: "Submit trip preferences" }));

    expect(screen.getByText("Searching local activity sources")).toBeDefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/activities/discover",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          cityOrLocation: "Lisbon",
          groupSize: 4,
          preferencePrompt: "quiet breakfasts and design stops",
          searchMode: "balanced",
          debugProviders: {
            tavily: true,
            googlePlaces: true,
            osm: true,
          },
        }),
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
    });
    expect(screen.getByText("Reading source details")).toBeDefined();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
    });
    expect(screen.getByText("Ranking activity candidates")).toBeDefined();

    await act(async () => {
      discovery.resolve(
        jsonResponse({
          activities: [
            {
              activityName: "Quiet Breakfast Market",
              placeName: "Mercado Quieto",
              evidenceSummary: "A calm morning market stop.",
              reason: "Matches your food preference",
              tags: ["breakfast"],
              sourceUrls: ["https://example.com/market"],
              confidenceScore: 0.61,
              preferenceMatchScore: 0.61,
              rating: 4.2,
              reviewCount: 31,
              fitsPreference: true,
              location: { label: "Alfama" },
            },
            {
              activityName: "Hidden Design Walk",
              placeName: "Atelier Baixa",
              evidenceSummary: "A source-backed small group activity in Lisbon.",
              reason: "Matches your walking preference",
              tags: ["design", "walking"],
              sourceUrls: [
                "https://example.com/design-walk",
                "https://example.com/lisbon-list",
                "https://example.com/extra",
              ],
              confidenceScore: 0.82,
              preferenceMatchScore: 0.82,
              rating: 4.8,
              reviewCount: 124,
              fitsPreference: true,
              location: { label: "Baixa" },
            },
          ],
        }),
      );
      await discovery.promise;
    });

    expect(screen.getByText("Recommendations for Lisbon")).toBeDefined();
    expect(screen.getByText("Restaurants (9 meal slots)")).toBeDefined();
    expect(screen.getByText("Activities (3 days)")).toBeDefined();

    const discoveredActivity = screen.getByRole("checkbox", {
      name: "Atelier Baixa",
    }) as HTMLInputElement;
    expect(discoveredActivity.checked).toBe(false);
    expect(screen.getAllByText("Price TBD")).toHaveLength(2);
    expect(screen.getByText("Time TBD - Baixa")).toBeDefined();
    expect(screen.getByText("82% match")).toBeDefined();
    expect(screen.getByText("4.8 stars (124)")).toBeDefined();
    expect(screen.queryByText("Source 1")).toBeNull();
    expect(screen.queryByText("+1")).toBeNull();
    expect(
      screen.getByText(
        "Recommended near Baixa for design and walking, with a 82% match to your trip preferences. It has a 4.8 star rating across 124 reviews.",
      ),
    ).toBeDefined();
    expect(
      screen
        .getAllByRole("checkbox")
        .map((checkbox) => checkbox.getAttribute("aria-label")),
    ).toEqual(
      expect.arrayContaining(["Atelier Baixa", "Mercado Quieto"]),
    );
    expect(
      screen
        .getAllByRole("checkbox")
        .map((checkbox) => checkbox.getAttribute("aria-label"))
        .indexOf("Atelier Baixa"),
    ).toBeLessThan(
      screen
        .getAllByRole("checkbox")
        .map((checkbox) => checkbox.getAttribute("aria-label"))
        .indexOf("Mercado Quieto"),
    );

    fireEvent.click(discoveredActivity);
    fireEvent.click(screen.getByRole("button", { name: "Make trip" }));

    expect(screen.getByText("Totals")).toBeDefined();
    expect(
      screen.getAllByText(/Activity: Atelier Baixa at Time TBD/),
    ).toHaveLength(3);
    expect(screen.getByText("$2,609")).toBeDefined();
  });

  test("shows discovery diagnostics when no activities are returned", async () => {
    vi.useFakeTimers();
    const discovery = deferred<Response>();
    const fetchMock = vi.fn(() => discovery.promise);
    vi.stubGlobal("fetch", fetchMock);
    render(<Page />);

    fireEvent.change(screen.getByLabelText("Group size"), {
      target: { value: "4" },
    });
    fireEvent.change(screen.getByLabelText("Destination"), {
      target: { value: "Lisbon" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Submit trip preferences" }));

    await act(async () => {
      discovery.resolve(
        jsonResponse({
          queryPlan: ["best things to do in Lisbon reddit"],
          activities: [],
          debug: {
            searchedQueries: ["best things to do in Lisbon reddit"],
            visitedUrls: ["https://example.com/source"],
            failedUrls: ["https://example.com/failure"],
            timedOutStages: ["openai-social-extraction"],
            sourceCounts: {
              osm: 0,
              reddit: 0,
              web: 0,
              merged: 0,
              returned: 0,
            },
          },
        }),
      );
      await discovery.promise;
    });

    expect(screen.getByText(/Discovery diagnostics/)).toBeDefined();
    expect(screen.getByText("openai-social-extraction")).toBeDefined();
    expect(screen.getByText("best things to do in Lisbon reddit")).toBeDefined();
    expect(screen.getByText("https://example.com/failure")).toBeDefined();
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
}
