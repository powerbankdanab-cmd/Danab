"use client";

const STATIONS = [
  {
    id: 58,
    name: "Cafe Castello Taleex",
    area: "Taleex",
  },
  {
    id: 59,
    name: "Feynuus Bowling",
    area: "Mogadishu",
  },
  {
    id: 60,
    name: "Java Taleex",
    area: "Taleex",
  },
  {
    id: 61,
    name: "Delik Somalia",
    area: "Mogadishu",
  },
  {
    id: 62,
    name: "Arena cafe Mogadishu",
    area: "Mogadishu",
  },
];

function getStationBaseDomain() {
  if (typeof window === "undefined") {
    return "danab.com";
  }

  const hostname = window.location.hostname.toLowerCase();

  if (hostname === "localhost" || hostname.endsWith(".vercel.app")) {
    return "danab.com";
  }

  if (hostname.startsWith("www.")) {
    return hostname.slice(4);
  }

  const parts = hostname.split(".");
  if (parts.length >= 3 && /^station\d+$/i.test(parts[0])) {
    return parts.slice(1).join(".");
  }

  return hostname;
}

export function Stations() {
  const baseDomain = getStationBaseDomain();

  return (
    <section id="stations" className="bg-white px-4 py-20 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-5xl">
        <div className="text-center">
          <p className="text-sm font-bold uppercase tracking-widest text-pink-500">
            Our Locations
          </p>
          <h2 className="mt-3 text-3xl font-black text-gray-900 sm:text-4xl">
            Find a Station
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-base text-gray-600">
            Danab stations are placed at popular cafes and restaurants across
            Mogadishu. More locations coming soon.
          </p>
        </div>

        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {STATIONS.map((station) => (
            <a
              key={station.id}
              href={`https://station${station.id}.${baseDomain}`}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-center gap-4 rounded-2xl border border-gray-100 bg-gray-50 p-5 shadow-sm transition-all hover:border-pink-200 hover:bg-pink-50 hover:shadow-md"
            >
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-pink-500 to-purple-600 text-sm font-black text-white shadow-md">
                {station.id}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold text-gray-900 group-hover:text-pink-600">
                  {station.name}
                </p>
                <p className="mt-0.5 text-xs text-gray-500">{station.area}</p>
              </div>
              <svg
                className="h-5 w-5 shrink-0 text-gray-400 transition-transform group-hover:translate-x-1 group-hover:text-pink-500"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="m9 5 7 7-7 7"
                />
              </svg>
            </a>
          ))}
        </div>

        <div className="relative mt-10 rounded-2xl border border-pink-200 bg-gradient-to-r from-pink-50 to-purple-50 p-6 text-center sm:p-8">
          <a
            href="https://www.danabadmins.online/"
            target="_blank"
            rel="noopener noreferrer"
            className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-white/60 hover:text-gray-600"
            aria-label="Admin"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
              />
            </svg>
          </a>
          <h3 className="text-lg font-bold text-gray-900">Admin System</h3>
          <p className="mt-2 text-sm text-gray-600">
            Manage stations, view rentals, and monitor your Danab network.
          </p>
        </div>

        <div className="mt-6 rounded-2xl border border-purple-100 bg-purple-50 p-6 text-center sm:p-8">
          <h3 className="text-lg font-bold text-purple-900">
            Want Danab at Your Location?
          </h3>
          <p className="mt-2 text-sm text-purple-700">
            We&apos;re expanding! If you own a cafe, restaurant, or business and
            want a Danab station, contact us.
          </p>
          <a
            href="#contact"
            className="mt-4 inline-block rounded-xl bg-purple-700 px-6 py-3 text-sm font-bold text-white shadow-md transition-all hover:bg-purple-800 hover:shadow-lg"
          >
            Partner With Us
          </a>
        </div>
      </div>
    </section>
  );
}
