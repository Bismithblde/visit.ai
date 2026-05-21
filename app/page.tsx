"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

const processSteps = [
  "Looking up hotels",
  "Grepping viral restaurants",
  "Balancing for budget",
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

const restaurants = [
  {
    id: "mira",
    name: "Mira Counter",
    intro: "Viral seafood bar",
    cost: 188,
  },
  {
    id: "nori",
    name: "Nori & Clay",
    intro: "Open-fire small plates",
    cost: 244,
  },
  {
    id: "sol",
    name: "Cafe Sol",
    intro: "Brunch queue favorite",
    cost: 132,
  },
];

const activities = [
  {
    id: "tile",
    name: "Tile museum",
    intro: "90 min",
    cost: 96,
  },
  {
    id: "sail",
    name: "Sunset sail",
    intro: "2 hr",
    cost: 352,
  },
  {
    id: "market",
    name: "Market crawl",
    intro: "3 stops",
    cost: 184,
  },
];

const baseTravel = [
  ["Hotel", "Mira Counter", 12],
  ["Mira Counter", "Tile museum", 18],
  ["Tile museum", "Sunset sail", 26],
];

const tripDates = ["1/2/2026", "1/3/2026", "1/4/2026"];

export default function Page() {
  const [destination, setDestination] = useState("");
  const [dates, setDates] = useState("");
  const [budget, setBudget] = useState("");
  const [groupSize, setGroupSize] = useState("");
  const [status, setStatus] = useState<"idle" | "processing" | "ready">("idle");
  const [activeStep, setActiveStep] = useState(0);
  const [submittedDestination, setSubmittedDestination] = useState("");
  const [selectedHotel, setSelectedHotel] = useState(hotels[0].id);
  const [selectedRestaurants, setSelectedRestaurants] = useState([
    restaurants[0].id,
    restaurants[2].id,
  ]);
  const [selectedActivities, setSelectedActivities] = useState([
    activities[0].id,
    activities[1].id,
  ]);
  const [tripMade, setTripMade] = useState(false);

  const selectedHotelItem = hotels.find((hotel) => hotel.id === selectedHotel) ?? hotels[0];
  const selectedRestaurantItems = restaurants.filter((restaurant) =>
    selectedRestaurants.includes(restaurant.id),
  );
  const selectedActivityItems = activities.filter((activity) =>
    selectedActivities.includes(activity.id),
  );

  const totals = useMemo(() => {
    const hotelTotal = selectedHotelItem.cost;
    const foodTotal = selectedRestaurantItems.reduce((sum, item) => sum + item.cost, 0);
    const activityTotal = selectedActivityItems.reduce((sum, item) => sum + item.cost, 0);
    const travelMinutes = 14 + selectedRestaurantItems.length * 11 + selectedActivityItems.length * 16;
    const transitTotal = Math.max(48, Math.round(travelMinutes * 1.8));

    return {
      activityTotal,
      foodTotal,
      hotelTotal,
      totalBudget: hotelTotal + foodTotal + activityTotal + transitTotal,
      transitTotal,
      travelMinutes,
    };
  }, [selectedActivityItems, selectedHotelItem, selectedRestaurantItems]);

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
      window.setTimeout(() => setStatus("ready"), 2700),
    ];

    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [status]);

  function submitFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmittedDestination(destination);
    setActiveStep(0);
    setTripMade(false);
    setStatus("processing");
  }

  function toggleRestaurant(id: string) {
    setTripMade(false);
    setSelectedRestaurants((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }

  function toggleActivity(id: string) {
    setTripMade(false);
    setSelectedActivities((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }

  return (
    <main className="min-h-screen w-full max-w-full overflow-x-hidden bg-[#fbfaf7] px-5 py-10 text-[#18201d]">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        <form
          onSubmit={submitFilters}
          className="grid w-full gap-3 rounded-[1.75rem] border border-[#e2e8df] bg-white/82 p-3 shadow-[0_22px_70px_rgba(82,95,86,0.14)] backdrop-blur md:grid-cols-[1fr_0.9fr_0.7fr_1.2fr_auto]"
        >
          <Field label="Dates" value={dates} onChange={setDates} placeholder="Jan 2 - Jan 4" />
          <Field label="Budget" value={budget} onChange={setBudget} placeholder="$2,400" />
          <Field label="Group size" value={groupSize} onChange={setGroupSize} placeholder="4" />
          <Field
            label="Destination"
            value={destination}
            onChange={setDestination}
            placeholder="Search a city"
            type="search"
          />
          <button
            type="submit"
            className="min-h-16 rounded-[1.1rem] border border-[#1c241f] bg-[#1c241f] px-6 text-sm font-semibold text-white shadow-[0_12px_24px_rgba(28,36,31,0.22)] transition hover:-translate-y-0.5 hover:bg-[#29342e] focus:outline-none focus:ring-4 focus:ring-[#b8dfce]"
          >
            Request plan
          </button>
        </form>

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

              <SelectorGroup title="Restaurants">
                {restaurants.map((restaurant) => (
                  <OptionRow
                    checked={selectedRestaurants.includes(restaurant.id)}
                    cost={`$${restaurant.cost}`}
                    intro={restaurant.intro}
                    key={restaurant.id}
                    name={restaurant.name}
                    onChange={() => toggleRestaurant(restaurant.id)}
                    type="checkbox"
                  />
                ))}
              </SelectorGroup>

              <SelectorGroup title="Activities">
                {activities.map((activity) => (
                  <OptionRow
                    checked={selectedActivities.includes(activity.id)}
                    cost={`$${activity.cost}`}
                    intro={activity.intro}
                    key={activity.id}
                    name={activity.name}
                    onChange={() => toggleActivity(activity.id)}
                    type="checkbox"
                  />
                ))}
              </SelectorGroup>
            </div>

            {tripMade && (
              <div className="grid gap-6 border-t border-[#e2e8df] pt-6 lg:grid-cols-[0.72fr_1.28fr]">
                <aside className="rounded-[1.35rem] border border-[#e3e9e2] bg-white p-5 shadow-sm">
                  <h3 className="text-2xl font-semibold text-[#202923]">Totals</h3>
                  <p className="mt-7 text-5xl font-semibold text-[#202923]">
                    ${totals.totalBudget.toLocaleString()}
                  </p>
                  <div className="mt-8 grid gap-3 text-sm font-medium text-[#4f5b55]">
                    <LineItem label="Hotel" value={`$${totals.hotelTotal}`} />
                    <LineItem label="Food" value={`$${totals.foodTotal}`} />
                    <LineItem label="Activities" value={`$${totals.activityTotal}`} />
                    <LineItem label="Transit" value={`$${totals.transitTotal}`} />
                    <LineItem label="Travel time" value={`${totals.travelMinutes} min`} />
                  </div>
                </aside>

                <div className="space-y-3">
                  {tripDates.map((date, index) => (
                    <DayBreakdown
                      activity={selectedActivityItems[index % Math.max(selectedActivityItems.length, 1)]}
                      date={date}
                      hotel={selectedHotelItem}
                      key={date}
                      restaurant={selectedRestaurantItems[index % Math.max(selectedRestaurantItems.length, 1)]}
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
    <details className="group rounded-[1.2rem] border border-[#e2e8df] bg-white shadow-sm" open>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-xl font-semibold text-[#202923] marker:hidden">
        <span>{title}</span>
        <span className="text-sm font-semibold text-[#718077] transition group-open:rotate-180">v</span>
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
        <span className="block text-base font-semibold text-[#202923]">{name}</span>
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
  restaurant,
  travel,
}: {
  activity?: (typeof activities)[number];
  date: string;
  hotel: (typeof hotels)[number];
  restaurant?: (typeof restaurants)[number];
  travel: (typeof baseTravel)[number];
}) {
  return (
    <article className="rounded-[1.35rem] border border-[#e3e9e2] bg-white p-5 shadow-sm">
      <h3 className="text-2xl font-semibold text-[#202923]">{date}</h3>
      <ol className="mt-5 grid gap-4 text-sm text-[#4f5b55]">
        <li className="flex justify-between gap-4">
          <span>First go to {activity?.name ?? "open walk"}</span>
          <span>{travel[2]} min</span>
        </li>
        <li className="flex justify-between gap-4">
          <span>Then {restaurant?.name ?? "local dinner"}</span>
          <span>{Number(travel[2]) + 7} min</span>
        </li>
        <li className="flex justify-between gap-4">
          <span>Then {hotel.name}</span>
          <span>{Number(travel[2]) + 11} min</span>
        </li>
      </ol>
    </article>
  );
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
