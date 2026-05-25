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
          location: "Lisbon",
          groupSize: 4,
          budget: "unknown",
          preferences: "quiet breakfasts and design stops",
          searchMode: "balanced",
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
          candidates: [
            {
              name: "Hidden Design Walk",
              description: "A source-backed small group activity in Lisbon.",
              locationHint: "Baixa",
              tags: ["design", "walking"],
              sourceUrls: [
                "https://example.com/design-walk",
                "https://example.com/lisbon-list",
                "https://example.com/extra",
              ],
              confidence: 0.82,
              needsVerification: true,
            },
            {
              name: "Quiet Breakfast Market",
              description: "A calm morning market stop.",
              locationHint: "Alfama",
              tags: ["breakfast"],
              sourceUrls: ["https://example.com/market"],
              confidence: 0.61,
              needsVerification: true,
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
      name: "Hidden Design Walk",
    }) as HTMLInputElement;
    expect(discoveredActivity.checked).toBe(false);
    expect(screen.getAllByText("Price TBD")).toHaveLength(2);
    expect(screen.getByText("Time TBD - Baixa")).toBeDefined();
    expect(screen.getByText("82% match")).toBeDefined();
    expect(screen.getByText("+1")).toBeDefined();

    fireEvent.click(discoveredActivity);
    fireEvent.click(screen.getByRole("button", { name: "Make trip" }));

    expect(screen.getByText("Totals")).toBeDefined();
    expect(
      screen.getAllByText(/Activity: Hidden Design Walk at Time TBD/),
    ).toHaveLength(3);
    expect(screen.getByText("$2,609")).toBeDefined();
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
