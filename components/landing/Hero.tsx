"use client";

export function Hero() {
  return (
    <section className="relative overflow-hidden bg-gradient-to-br from-pink-500 via-purple-600 to-indigo-700 px-4 pb-20 pt-32 text-white sm:px-6 lg:px-8">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-[-120px] top-[-100px] h-96 w-96 rounded-full bg-pink-400/30 blur-3xl" />
        <div className="absolute bottom-[-80px] right-[-80px] h-96 w-96 rounded-full bg-indigo-400/30 blur-3xl" />
        <div className="absolute left-1/2 top-1/3 h-72 w-72 -translate-x-1/2 rounded-full bg-purple-300/20 blur-3xl" />
      </div>

      <div className="relative mx-auto max-w-5xl text-center">
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium backdrop-blur-sm">
          <span className="h-2 w-2 rounded-full bg-green-400" />
          Now available in Mogadishu
        </div>

        <h1 className="text-4xl font-black leading-tight sm:text-5xl md:text-6xl lg:text-7xl">
          Never Run Out
          <br />
          <span className="bg-gradient-to-r from-pink-200 to-white bg-clip-text text-transparent">
            of Battery Again 
          </span>
        </h1>

        <p className="mx-auto mt-6 max-w-2xl text-lg font-medium text-white/85 sm:text-xl">
          Danab provides portable power bank rentals at your favorite cafes and
          restaurants. Scan, pay, and charge — it&apos;s that simple.
        </p>

        <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
          <a
            href="#how-it-works"
            className="rounded-xl bg-white px-8 py-4 text-base font-bold text-purple-700 shadow-lg transition-all hover:scale-[1.03] hover:shadow-xl active:scale-[0.98]"
          >
            How It Works
          </a>
          <a
            href="#stations"
            className="rounded-xl border-2 border-white/30 bg-white/10 px-8 py-4 text-base font-bold text-white backdrop-blur-sm transition-all hover:scale-[1.03] hover:bg-white/20 active:scale-[0.98]"
          >
            Find a Station
          </a>
        </div>

        <div className="mt-16 grid grid-cols-3 gap-6 sm:gap-8">
          <div className="rounded-2xl border border-white/10 bg-white/10 p-4 backdrop-blur-sm sm:p-6">
            <p className="text-2xl font-black sm:text-3xl">5+</p>
            <p className="mt-1 text-xs font-medium text-white/80 sm:text-sm">
              Active Stations
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/10 p-4 backdrop-blur-sm sm:p-6">
            <p className="text-2xl font-black sm:text-3xl">24/7</p>
            <p className="mt-1 text-xs font-medium text-white/80 sm:text-sm">
              Available
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/10 p-4 backdrop-blur-sm sm:p-6">
            <p className="text-2xl font-black sm:text-3xl">$0.75</p>
            <p className="mt-1 text-xs font-medium text-white/80 sm:text-sm">
              Starting Price
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
