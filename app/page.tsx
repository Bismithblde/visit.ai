"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import Calendar from "react-calendar";
import "react-calendar/dist/Calendar.css";

const processSteps = [
  "Searching local activity sources",
  "Reading source details",
  "Ranking activity candidates",
];

const hotels = [
  {
    id: "juniper",
    name: "The Juniper House",
    intro: "Garden courtyard, central transit, calm rooms",
    cost: 930,
  },
  {
    id: "aster",
    name: "Aster Canal Hotel",
    intro: "Waterfront lobby, breakfast terrace, late checkout",
    cost: 855,
  },
  {
    id: "maison",
    name: "Maison Vale",
    intro: "Quiet block, suite upgrade, walkable dining",
    cost: 1020,
  },
];

interface Coordinates {
  latitude: number;
  longitude: number;
}

interface ActivityOption {
  id: string;
  name: string;
  description: string;
  time: Date | null;
  location: Coordinates | null;
  price: number;
  priceLabel: string;
  timeLabel: string;
  locationLabel: string;
  tags: string[];
  sourceUrls: string[];
  confidence: number | null;
  needsVerification: boolean;
}

interface ActivityCandidate {
  name: string;
  description: string;
  locationHint: string;
  tags: string[];
  sourceUrls: string[];
  confidence: number;
  needsVerification: true;
}

interface DiscoveryResponse {
  candidates: ActivityCandidate[];
}

interface RestaurantOption {
  id: string;
  name: string;
  description: string;
  averagePrice: number;
  cuisine: string;
}

const restaurants: RestaurantOption[] = [
  {
    id: "mira",
    name: "Mira Counter",
    description: "Viral seafood bar with counter seating and a raw menu.",
    averagePrice: 188,
    cuisine: "Seafood",
  },
  {
    id: "nori",
    name: "Nori & Clay",
    description: "Open-fire small plates built around charcoal and seasonal rice.",
    averagePrice: 244,
    cuisine: "Japanese",
  },
  {
    id: "sol",
    name: "Cafe Sol",
    description: "Brunch queue favorite with bright pastries and strong coffee.",
    averagePrice: 132,
    cuisine: "Cafe",
  },
  {
    id: "lumen",
    name: "Lumen Table",
    description: "All-day neighborhood dining with local vegetables and wine.",
    averagePrice: 164,
    cuisine: "Modern European",
  },
  {
    id: "puebla",
    name: "Puebla House",
    description: "Family-style plates, masa snacks, and late-night desserts.",
    averagePrice: 118,
    cuisine: "Mexican",
  },
  {
    id: "fig",
    name: "Fig & Laurel",
    description: "Quiet breakfast room with mezze, flatbreads, and tea service.",
    averagePrice: 96,
    cuisine: "Mediterranean",
  },
];

const activities: ActivityOption[] = [
  {
    id: "tile",
    name: "Tile museum",
    description: "A 90-minute guided collection walk through ceramic history.",
    time: new Date("2026-01-02T10:00:00"),
    location: { latitude: 38.7139, longitude: -9.1394 },
    price: 96,
    priceLabel: "$96",
    timeLabel: "10:00 AM",
    locationLabel: "38.7139, -9.1394",
    tags: ["museum", "guided"],
    sourceUrls: [],
    confidence: null,
    needsVerification: false,
  },
  {
    id: "sail",
    name: "Sunset sail",
    description: "A two-hour private harbor route timed for golden hour.",
    time: new Date("2026-01-02T17:30:00"),
    location: { latitude: 38.6928, longitude: -9.2158 },
    price: 352,
    priceLabel: "$352",
    timeLabel: "5:30 PM",
    locationLabel: "38.6928, -9.2158",
    tags: ["waterfront", "private"],
    sourceUrls: [],
    confidence: null,
    needsVerification: false,
  },
  {
    id: "market",
    name: "Market crawl",
    description: "Three-stop tasting walk through produce, pastries, and seafood.",
    time: new Date("2026-01-03T11:00:00"),
    location: { latitude: 38.7078, longitude: -9.1466 },
    price: 184,
    priceLabel: "$184",
    timeLabel: "11:00 AM",
    locationLabel: "38.7078, -9.1466",
    tags: ["food", "walking"],
    sourceUrls: [],
    confidence: null,
    needsVerification: false,
  },
  {
    id: "atelier",
    name: "Design atelier",
    description: "Studio visit with a maker-led workshop and a small keepsake.",
    time: new Date("2026-01-04T14:00:00"),
    location: { latitude: 38.7167, longitude: -9.1536 },
    price: 128,
    priceLabel: "$128",
    timeLabel: "2:00 PM",
    locationLabel: "38.7167, -9.1536",
    tags: ["design", "workshop"],
    sourceUrls: [],
    confidence: null,
    needsVerification: false,
  },
  {
    id: "garden",
    name: "Botanical garden",
    description: "Self-paced garden circuit with shaded paths and overlooks.",
    time: new Date("2026-01-05T09:30:00"),
    location: { latitude: 38.7211, longitude: -9.1489 },
    price: 42,
    priceLabel: "$42",
    timeLabel: "9:30 AM",
    locationLabel: "38.7211, -9.1489",
    tags: ["garden", "self-paced"],
    sourceUrls: [],
    confidence: null,
    needsVerification: false,
  },
];

const baseTravel = [
  ["Hotel", "Mira Counter", 12],
  ["Mira Counter", "Tile museum", 18],
  ["Tile museum", "Sunset sail", 26],
];

type CalendarValuePiece = Date | null;
type CalendarValue =
  | CalendarValuePiece
  | [CalendarValuePiece, CalendarValuePiece];
type MealName = "Breakfast" | "Lunch" | "Dinner";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
});

export default function Page() {
  const [destination, setDestination] = useState("");
  const [dates, setDates] = useState("");
  const [personalization, setPersonalization] = useState("");
  const [calendarValue, setCalendarValue] = useState<CalendarValue>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [budget, setBudget] = useState("");
  const [groupSize, setGroupSize] = useState("");
  const [status, setStatus] = useState<"idle" | "processing" | "ready">("idle");
  const [activeStep, setActiveStep] = useState(0);
  const [submittedDestination, setSubmittedDestination] = useState("");
  const [formError, setFormError] = useState("");
  const [activityOptions, setActivityOptions] = useState<ActivityOption[]>(activities);
  const [hasDiscoveredActivities, setHasDiscoveredActivities] = useState(false);
  const [selectedHotel, setSelectedHotel] = useState(hotels[0].id);
  const [selectedRestaurants, setSelectedRestaurants] = useState([
    restaurants[0].id,
    restaurants[2].id,
    restaurants[3].id,
    restaurants[5].id,
  ]);
  const [selectedActivities, setSelectedActivities] = useState([
    activities[0].id,
    activities[1].id,
    activities[2].id,
  ]);
  const [tripMade, setTripMade] = useState(false);
  const calendarRef = useRef<HTMLDivElement>(null);

  const selectedHotelItem =
    hotels.find((hotel) => hotel.id === selectedHotel) ?? hotels[0];
  const selectedRestaurantItems = restaurants.filter((restaurant) =>
    selectedRestaurants.includes(restaurant.id),
  );
  const selectedActivityItems = activityOptions.filter((activity) =>
    selectedActivities.includes(activity.id),
  );
  const tripDays = useMemo(() => getTripDays(calendarValue), [calendarValue]);
  const tripDayLabels = useMemo(
    () => tripDays.map((date) => formatFullDate(date)),
    [tripDays],
  );
  const requestedActivityCount = tripDayLabels.length;
  const requestedRestaurantCount = requestedActivityCount * 3;
  const mealPlan = useMemo(
    () => buildMealPlan(tripDayLabels, selectedRestaurantItems),
    [selectedRestaurantItems, tripDayLabels],
  );
  const activityPlan = useMemo(
    () => buildActivityPlan(tripDayLabels, selectedActivityItems),
    [selectedActivityItems, tripDayLabels],
  );

  const totals = useMemo(() => {
    const hotelTotal = selectedHotelItem.cost;
    const foodTotal = mealPlan.reduce(
      (sum, item) => sum + (item.restaurant?.averagePrice ?? 0),
      0,
    );
    const activityTotal = activityPlan.reduce(
      (sum, item) => sum + (item.activity?.price ?? 0),
      0,
    );
    const travelMinutes =
      14 +
      selectedRestaurantItems.length * 11 +
      selectedActivityItems.length * 16;
    const transitTotal = Math.max(48, Math.round(travelMinutes * 1.8));

    return {
      activityTotal,
      foodTotal,
      hotelTotal,
      totalBudget: hotelTotal + foodTotal + activityTotal + transitTotal,
      transitTotal,
      travelMinutes,
    };
  }, [
    mealPlan,
    activityPlan,
    selectedHotelItem,
    selectedActivityItems.length,
    selectedRestaurantItems,
  ]);

  const title = useMemo(() => {
    return `Recommendations for ${submittedDestination || "your trip"}`;
  }, [submittedDestination]);

  useEffect(() => {
    if (status !== "processing") {
      return;
    }

    const timers = [
      window.setTimeout(() => setActiveStep(1), 850),
      window.setTimeout(() => setActiveStep(2), 1700),
    ];

    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [status]);

  useEffect(() => {
    if (!calendarOpen) {
      return;
    }

    function closeCalendar(event: MouseEvent) {
      if (
        calendarRef.current &&
        event.target instanceof Node &&
        !calendarRef.current.contains(event.target)
      ) {
        setCalendarOpen(false);
      }
    }

    window.addEventListener("mousedown", closeCalendar);
    return () => window.removeEventListener("mousedown", closeCalendar);
  }, [calendarOpen]);

  function updateDates(nextValue: CalendarValue) {
    setCalendarValue(nextValue);
    setDates(formatCalendarValue(nextValue));

    if (Array.isArray(nextValue) && nextValue[0] && nextValue[1]) {
      setCalendarOpen(false);
    }
  }

  async function submitFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const location = destination.trim();
    const parsedGroupSize = Number(groupSize);

    if (!location) {
      setFormError("Destination is required.");
      return;
    }

    if (
      !Number.isInteger(parsedGroupSize) ||
      parsedGroupSize < 1 ||
      parsedGroupSize > 50
    ) {
      setFormError("Group size must be an integer between 1 and 50.");
      return;
    }

    setSubmittedDestination(location);
    setSelectedActivities([]);
    setSelectedRestaurants(selectByCount(restaurants, requestedRestaurantCount));
    setActiveStep(0);
    setFormError("");
    setTripMade(false);
    setStatus("processing");

    try {
      const response = await fetch("/api/activities/discover", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          location,
          groupSize: parsedGroupSize,
          budget: "unknown",
          preferences: personalization,
          searchMode: "balanced",
        }),
      });

      const body = (await response.json()) as DiscoveryResponse | { error?: string };

      if (!response.ok) {
        throw new Error(
          "error" in body && body.error ? body.error : "Activity discovery failed.",
        );
      }

      if (!isDiscoveryResponse(body)) {
        throw new Error("Activity discovery returned an unexpected response.");
      }

      setActivityOptions(mapActivityCandidates(body.candidates));
      setHasDiscoveredActivities(true);
      setStatus("ready");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Activity discovery failed.";
      setFormError(message);
      setStatus(hasDiscoveredActivities ? "ready" : "idle");
    }
  }

  function toggleRestaurant(id: string) {
    setTripMade(false);
    setSelectedRestaurants((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    );
  }

  function toggleActivity(id: string) {
    setTripMade(false);
    setSelectedActivities((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    );
  }

  return (
    <main className="min-h-screen w-full max-w-full overflow-x-hidden bg-[#fbfaf7] px-5 py-10 text-[#18201d]">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        <form
          onSubmit={submitFilters}
          className="grid w-full gap-3 rounded-[1.75rem] border border-[#e2e8df] bg-white/82 p-3 shadow-[0_22px_70px_rgba(82,95,86,0.14)] backdrop-blur md:grid-cols-[1fr_0.9fr_0.7fr_1.2fr]"
        >
          <CalendarField
            calendarOpen={calendarOpen}
            onChange={updateDates}
            onOpenChange={setCalendarOpen}
            refObject={calendarRef}
            value={calendarValue}
            valueLabel={dates}
          />
          <Field
            label="Budget"
            value={budget}
            onChange={setBudget}
            placeholder="$2,400"
          />
          <Field
            label="Group size"
            value={groupSize}
            onChange={setGroupSize}
            placeholder="4"
          />
          <Field
            label="Destination"
            value={destination}
            onChange={setDestination}
            placeholder="Search a city"
            type="search"
          />
          <div
            aria-label="Trip personalization chat"
            className="flex min-h-16 w-full items-center gap-3 rounded-[1.35rem] bg-[#fffdf8] px-4 py-3 ring-1 ring-[#e2e8df] transition focus-within:ring-[#9fc7b5] md:col-span-4"
          >
            <input
              className="min-w-0 flex-1 bg-transparent text-base font-medium text-[#202923] outline-none placeholder:text-[#8b9991]"
              onChange={(event) => setPersonalization(event.target.value)}
              placeholder="Further personalize your trip with any concerns or preferences."
              type="text"
              value={personalization}
            />
            <button
              aria-label="Submit trip preferences"
              className="grid h-11 w-11 shrink-0 place-items-center rounded-[0.95rem] bg-[#1c241f] text-white shadow-[0_10px_24px_rgba(28,36,31,0.18)] transition hover:-translate-y-0.5 hover:bg-[#29342e] focus:outline-none focus:ring-4 focus:ring-[#b8dfce] active:translate-y-0"
              title="Send"
              type="submit"
            >
              <svg
                aria-hidden="true"
                className="h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
              >
                <path
                  d="m5 12 14-7-4 14-3-6-7-1Z"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                />
              </svg>
            </button>
          </div>
        </form>

        {formError && (
          <p
            className="rounded-[1rem] border border-[#f0c9bd] bg-[#fff5f1] px-4 py-3 text-sm font-semibold text-[#9b3d24]"
            role="alert"
          >
            {formError}
          </p>
        )}

        {status === "processing" && (
          <section className="flex min-h-40 flex-col items-center justify-center gap-5 text-center">
            <span className="spinner" aria-hidden="true" />
            <p className="text-2xl font-semibold text-[#202923] md:text-3xl">
              {processSteps[activeStep]}
            </p>
          </section>
        )}

        {status === "ready" && (
          <section className="space-y-6">
            <div className="flex flex-col gap-4 py-3 md:flex-row md:items-end md:justify-between">
              <h2 className="max-w-5xl text-4xl font-semibold tracking-normal text-[#202923] md:text-6xl">
                {title}
              </h2>
              <button
                className="w-full rounded-[1.1rem] border border-[#1c241f] bg-[#1c241f] px-6 py-4 text-sm font-semibold text-white shadow-[0_12px_24px_rgba(28,36,31,0.18)] transition hover:-translate-y-0.5 hover:bg-[#29342e] focus:outline-none focus:ring-4 focus:ring-[#b8dfce] md:w-auto"
                onClick={() => setTripMade(true)}
                type="button"
              >
                Make trip
              </button>
            </div>

            <div className="grid gap-3">
              <SelectorGroup title="Hotels">
                {hotels.map((hotel) => (
                  <OptionRow
                    checked={selectedHotel === hotel.id}
                    cost={`$${hotel.cost}`}
                    intro={hotel.intro}
                    key={hotel.id}
                    name={hotel.name}
                    onChange={() => {
                      setTripMade(false);
                      setSelectedHotel(hotel.id);
                    }}
                    type="radio"
                  />
                ))}
              </SelectorGroup>

              <SelectorGroup
                title={`Restaurants (${requestedRestaurantCount} meal slots)`}
              >
                {restaurants.map((restaurant) => (
                  <OptionRow
                    checked={selectedRestaurants.includes(restaurant.id)}
                    cost={`$${restaurant.averagePrice} avg`}
                    intro={`${restaurant.cuisine} - ${restaurant.description}`}
                    key={restaurant.id}
                    name={restaurant.name}
                    onChange={() => toggleRestaurant(restaurant.id)}
                    type="checkbox"
                  />
                ))}
              </SelectorGroup>

              <SelectorGroup
                title={`Activities (${requestedActivityCount} day${requestedActivityCount === 1 ? "" : "s"})`}
              >
                {activityOptions.length > 0 ? (
                  activityOptions.map((activity) => (
                    <ActivityOptionRow
                      activity={activity}
                      checked={selectedActivities.includes(activity.id)}
                      key={activity.id}
                      onChange={() => toggleActivity(activity.id)}
                    />
                  ))
                ) : (
                  <p className="px-3 py-4 text-sm font-medium text-[#66736c]">
                    No activity candidates returned. Try a broader destination or
                    preference.
                  </p>
                )}
              </SelectorGroup>
            </div>

            {tripMade && (
              <div className="grid gap-6 border-t border-[#e2e8df] pt-6 lg:grid-cols-[0.72fr_1.28fr]">
                <aside className="rounded-[1.35rem] border border-[#e3e9e2] bg-white p-5 shadow-sm">
                  <h3 className="text-2xl font-semibold text-[#202923]">
                    Totals
                  </h3>
                  <p className="mt-7 text-5xl font-semibold text-[#202923]">
                    ${totals.totalBudget.toLocaleString()}
                  </p>
                  <div className="mt-8 grid gap-3 text-sm font-medium text-[#4f5b55]">
                    <LineItem label="Hotel" value={`$${totals.hotelTotal}`} />
                    <LineItem label="Food" value={`$${totals.foodTotal}`} />
                    <LineItem
                      label="Activities"
                      value={`$${totals.activityTotal}`}
                    />
                    <LineItem
                      label="Transit"
                      value={`$${totals.transitTotal}`}
                    />
                    <LineItem
                      label="Travel time"
                      value={`${totals.travelMinutes} min`}
                    />
                  </div>
                </aside>

                <div className="space-y-3">
                  {tripDayLabels.map((date, index) => (
                    <DayBreakdown
                      activity={
                        activityPlan[index]?.activity
                      }
                      date={date}
                      hotel={selectedHotelItem}
                      key={date}
                      mealSlots={mealPlan.filter((meal) => meal.date === date)}
                      travel={baseTravel[index] ?? baseTravel[0]}
                    />
                  ))}
                </div>
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}

function SelectorGroup({
  children,
  title,
}: {
  children: React.ReactNode;
  title: string;
}) {
  return (
    <details
      className="group rounded-[1.2rem] border border-[#e2e8df] bg-white shadow-sm"
      open
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-xl font-semibold text-[#202923] marker:hidden">
        <span>{title}</span>
        <span className="text-sm font-semibold text-[#718077] transition group-open:rotate-180">
          v
        </span>
      </summary>
      <div className="grid border-t border-[#eef2ed] p-3">{children}</div>
    </details>
  );
}

function OptionRow({
  checked,
  cost,
  intro,
  name,
  onChange,
  type,
}: {
  checked: boolean;
  cost: string;
  intro: string;
  name: string;
  onChange: () => void;
  type: "checkbox" | "radio";
}) {
  return (
    <label className="grid cursor-pointer gap-3 rounded-[0.95rem] px-3 py-3 transition hover:bg-[#fbfaf7] md:grid-cols-[auto_1fr_auto] md:items-center">
      <input
        checked={checked}
        className="h-5 w-5 accent-[#1c241f]"
        onChange={onChange}
        type={type}
      />
      <span>
        <span className="block text-base font-semibold text-[#202923]">
          {name}
        </span>
        <span className="mt-1 block text-sm text-[#66736c]">{intro}</span>
      </span>
      <span className="text-sm font-semibold text-[#202923]">{cost}</span>
    </label>
  );
}

function LineItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-[#edf1ec] pb-3 last:border-b-0 last:pb-0">
      <span>{label}</span>
      <span className="text-[#202923]">{value}</span>
    </div>
  );
}

function DayBreakdown({
  activity,
  date,
  hotel,
  mealSlots,
  travel,
}: {
  activity?: (typeof activities)[number];
  date: string;
  hotel: (typeof hotels)[number];
  mealSlots: {
    date: string;
    meal: MealName;
    restaurant?: RestaurantOption;
  }[];
  travel: (typeof baseTravel)[number];
}) {
  return (
    <article className="rounded-[1.35rem] border border-[#e3e9e2] bg-white p-5 shadow-sm">
      <h3 className="text-2xl font-semibold text-[#202923]">{date}</h3>
      <ol className="mt-5 grid gap-4 text-sm text-[#4f5b55]">
        {mealSlots.map((slot) => (
          <li className="flex justify-between gap-4" key={slot.meal}>
            <span>
              {slot.meal}: {slot.restaurant?.name ?? "Open restaurant slot"}
            </span>
            <span>{slot.restaurant?.cuisine ?? "TBD"}</span>
          </li>
        ))}
        <li className="flex justify-between gap-4">
          <span>
            Activity: {activity?.name ?? "open walk"}
            {activity ? ` at ${formatActivityTime(activity)}` : ""}
          </span>
          <span>{travel[2]} min</span>
        </li>
        <li className="flex justify-between gap-4">
          <span>Then {hotel.name}</span>
          <span>{Number(travel[2]) + 11} min</span>
        </li>
      </ol>
    </article>
  );
}

function buildMealPlan(
  dates: string[],
  selectedRestaurants: RestaurantOption[],
) {
  const meals: MealName[] = ["Breakfast", "Lunch", "Dinner"];

  return dates.flatMap((date, dayIndex) =>
    meals.map((meal, mealIndex) => ({
      date,
      meal,
      restaurant:
        selectedRestaurants[
          (dayIndex * meals.length + mealIndex) %
            Math.max(selectedRestaurants.length, 1)
        ],
    })),
  );
}

function buildActivityPlan(dates: string[], selectedActivities: ActivityOption[]) {
  return dates.map((date, index) => ({
    date,
    activity:
      selectedActivities[index % Math.max(selectedActivities.length, 1)],
  }));
}

function getTripDays(value: CalendarValue) {
  if (Array.isArray(value)) {
    const [start, end] = value;

    if (start && end) {
      return enumerateDays(start, end);
    }

    if (start) {
      return [startOfDay(start)];
    }
  }

  if (value instanceof Date) {
    return [startOfDay(value)];
  }

  return enumerateDays(
    new Date("2026-01-02T00:00:00"),
    new Date("2026-01-04T00:00:00"),
  );
}

function enumerateDays(start: Date, end: Date) {
  const first = startOfDay(start);
  const last = startOfDay(end);
  const days: Date[] = [];

  for (
    let current = first;
    current <= last;
    current = addDays(current, 1)
  ) {
    days.push(current);
  }

  return days;
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number) {
  const nextDate = new Date(date);
  nextDate.setDate(nextDate.getDate() + days);
  return nextDate;
}

function selectByCount<T extends { id: string }>(items: T[], count: number) {
  return items.slice(0, Math.max(1, count)).map((item) => item.id);
}

function formatFullDate(date: Date) {
  return date.toLocaleDateString("en-US");
}

function formatShortTime(date: Date) {
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatActivityTime(activity: ActivityOption) {
  return activity.time ? formatShortTime(activity.time) : activity.timeLabel;
}

function mapActivityCandidates(candidates: ActivityCandidate[]) {
  return candidates.map((candidate, index) => ({
    id: `${slugify(candidate.name)}-${index}`,
    name: candidate.name,
    description: candidate.description,
    time: null,
    location: null,
    price: 0,
    priceLabel: "Price TBD",
    timeLabel: "Time TBD",
    locationLabel: candidate.locationHint || "Location TBD",
    tags: candidate.tags,
    sourceUrls: candidate.sourceUrls,
    confidence: candidate.confidence,
    needsVerification: candidate.needsVerification,
  }));
}

function isDiscoveryResponse(value: unknown): value is DiscoveryResponse {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    Array.isArray((value as DiscoveryResponse).candidates)
  );
}

function slugify(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "activity"
  );
}

function ActivityOptionRow({
  activity,
  checked,
  onChange,
}: {
  activity: ActivityOption;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <div className="grid gap-3 rounded-[0.95rem] px-3 py-3 transition hover:bg-[#fbfaf7] md:grid-cols-[auto_1fr_auto] md:items-start">
      <input
        aria-label={activity.name}
        checked={checked}
        className="mt-1 h-5 w-5 accent-[#1c241f]"
        onChange={onChange}
        type="checkbox"
      />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-base font-semibold text-[#202923]">
            {activity.name}
          </span>
          {activity.needsVerification && (
            <span className="rounded-full bg-[#fff0d8] px-2 py-1 text-[0.68rem] font-bold uppercase tracking-[0.12em] text-[#8a5a11]">
              Verify
            </span>
          )}
          {activity.confidence !== null && (
            <span className="text-xs font-semibold text-[#718077]">
              {Math.round(activity.confidence * 100)}% match
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-[#66736c]">{activity.description}</p>
        <p className="mt-2 text-xs font-semibold text-[#718077]">
          {activity.timeLabel} - {activity.locationLabel}
        </p>
        {activity.tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {activity.tags.slice(0, 5).map((tag) => (
              <span
                className="rounded-full border border-[#e2e8df] px-2 py-1 text-xs font-semibold text-[#536159]"
                key={tag}
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-2 text-sm font-semibold text-[#202923] md:items-end">
        <span>{activity.priceLabel}</span>
        {activity.sourceUrls.length > 0 && (
          <div className="flex flex-wrap gap-2 md:justify-end">
            {activity.sourceUrls.slice(0, 2).map((url, index) => (
              <a
                className="text-xs font-bold text-[#346b55] underline-offset-4 hover:underline"
                href={url}
                key={url}
                rel="noreferrer"
                target="_blank"
              >
                Source {index + 1}
              </a>
            ))}
            {activity.sourceUrls.length > 2 && (
              <span className="text-xs text-[#718077]">
                +{activity.sourceUrls.length - 2}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function CalendarField({
  calendarOpen,
  onChange,
  onOpenChange,
  refObject,
  value,
  valueLabel,
}: {
  calendarOpen: boolean;
  onChange: (value: CalendarValue) => void;
  onOpenChange: (open: boolean) => void;
  refObject: React.RefObject<HTMLDivElement | null>;
  value: CalendarValue;
  valueLabel: string;
}) {
  return (
    <div className="relative" ref={refObject}>
      <button
        aria-expanded={calendarOpen}
        aria-haspopup="dialog"
        className="grid min-h-16 w-full rounded-[1.1rem] border border-[#e6ebe5] bg-[#fbfaf7] px-4 py-3 text-left transition hover:border-[#bfd8cc] hover:bg-white focus:outline-none focus:ring-4 focus:ring-[#b8dfce]"
        onClick={() => onOpenChange(!calendarOpen)}
        type="button"
      >
        <span className="block text-xs font-semibold uppercase tracking-[0.14em] text-[#6d7a73]">
          Dates
        </span>
        <span className="mt-2 flex items-center justify-between gap-3 text-base font-semibold text-[#202923]">
          <span>{valueLabel || "Select Dates"}</span>
          <span aria-hidden="true" className="text-[#8ba196]">
            +
          </span>
        </span>
      </button>

      {calendarOpen && (
        <div
          className="absolute left-0 top-[calc(100%+0.75rem)] z-30 w-[min(22rem,calc(100vw-2.5rem))] rounded-[1.35rem] bg-[#fffdf8] p-3 shadow-[0_24px_70px_rgba(41,52,46,0.18)]"
          role="dialog"
        >
          <Calendar
            calendarType="gregory"
            className="trip-calendar"
            minDate={new Date()}
            next2Label={null}
            onChange={onChange}
            prev2Label={null}
            selectRange
            value={value}
          />
        </div>
      )}
    </div>
  );
}

function formatCalendarValue(value: CalendarValue) {
  if (Array.isArray(value)) {
    const [start, end] = value;

    if (start && end) {
      return `${dateFormatter.format(start)} - ${dateFormatter.format(end)}`;
    }

    if (start) {
      return dateFormatter.format(start);
    }

    return "";
  }

  return value ? dateFormatter.format(value) : "";
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  type?: string;
}) {
  return (
    <label className="rounded-[1.1rem] border border-[#e6ebe5] bg-[#fbfaf7] px-4 py-3 transition focus-within:border-[#9fc7b5] focus-within:bg-white">
      <span className="block text-xs font-semibold uppercase tracking-[0.14em] text-[#6d7a73]">
        {label}
      </span>
      <input
        className="mt-2 w-full bg-transparent text-base font-semibold text-[#202923] outline-none placeholder:text-[#9da9a2]"
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        type={type}
        value={value}
      />
    </label>
  );
}
