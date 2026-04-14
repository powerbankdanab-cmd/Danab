"use client";

export function About() {
  return (
    <section id="about" className="bg-gray-50 px-4 py-20 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-5xl">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div>
            <p className="text-sm font-bold uppercase tracking-widest text-pink-500">
              About Danab
            </p>
            <h2 className="mt-3 text-3xl font-black text-gray-900 sm:text-4xl">
              Powering Somalia&apos;s Mobile Generation
            </h2>
            <p className="mt-5 text-base leading-relaxed text-gray-600">
              Danab is Somalia&apos;s first portable power bank rental service.
              We place smart charging stations at the best cafes, restaurants,
              and public spaces across Mogadishu so you never have to worry
              about your phone dying.
            </p>
            <p className="mt-4 text-base leading-relaxed text-gray-600">
              Our mission is simple: keep you connected. Whether you&apos;re
              working from a cafe, meeting friends, or just enjoying your day
              out — Danab ensures your device stays charged and ready.
            </p>

            <div className="mt-8 grid grid-cols-2 gap-6">
              <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                <p className="text-2xl font-black text-purple-700">Fast</p>
                <p className="mt-1 text-sm text-gray-600">
                  Quick grab-and-go power banks
                </p>
              </div>
              <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                <p className="text-2xl font-black text-purple-700">Safe</p>
                <p className="mt-1 text-sm text-gray-600">
                  Certified & tested batteries
                </p>
              </div>
            </div>
          </div>

          <div className="relative">
            <div className="overflow-hidden rounded-3xl bg-gradient-to-br from-pink-500 to-purple-700 p-8 text-white shadow-2xl sm:p-12">
              <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-white/20">
                <svg
                  className="h-9 w-9"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.8}
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"
                  />
                </svg>
              </div>
              <h3 className="text-2xl font-black">Why Danab?</h3>
              <ul className="mt-6 space-y-4">
                <li className="flex items-start gap-3">
                  <span className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/20 text-xs">
                    ✓
                  </span>
                  <span className="text-sm font-medium text-white/90">
                    No app download required
                  </span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/20 text-xs">
                    ✓
                  </span>
                  <span className="text-sm font-medium text-white/90">
                    Pay with EVC Plus, ZAAD, or SAHAL
                  </span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/20 text-xs">
                    ✓
                  </span>
                  <span className="text-sm font-medium text-white/90">
                    Works with all phone models
                  </span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/20 text-xs">
                    ✓
                  </span>
                  <span className="text-sm font-medium text-white/90">
                    Return at any Danab station
                  </span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/20 text-xs">
                    ✓
                  </span>
                  <span className="text-sm font-medium text-white/90">
                    24/7 customer support
                  </span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
