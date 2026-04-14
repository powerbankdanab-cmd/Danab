"use client";

const PLANS = [
  {
    price: "$0.75",
    features: [
      "Fully charged power bank",
      "Compatible with all phones",
      "Lightning + USB-C + Micro USB",
      "Return at any station",
    ],
    popular: true,
  },
];

export function Pricing() {
  return (
    <section id="pricing" className="bg-gray-50 px-4 py-20 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-4xl">
        <div className="text-center">
          <p className="text-sm font-bold uppercase tracking-widest text-pink-500">
            Simple Pricing
          </p>
          <h2 className="mt-3 text-3xl font-black text-gray-900 sm:text-4xl">
            Affordable Power
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-base text-gray-600">
            No hidden fees. No subscriptions. Just pay for the time you need.
          </p>
        </div>

        <div className="mx-auto mt-12 grid max-w-md gap-6">
          {PLANS.map((plan) => (
            <div
              key={plan.price}
              className={`relative overflow-hidden rounded-3xl border-2 p-8 shadow-sm transition-all hover:shadow-lg ${
                plan.popular
                  ? "border-pink-500 bg-white"
                  : "border-gray-200 bg-white"
              }`}
            >
              {plan.popular && (
                <div className="absolute right-0 top-0 rounded-bl-2xl bg-gradient-to-r from-pink-500 to-purple-600 px-4 py-1.5 text-xs font-bold text-white">
                  Popular
                </div>
              )}

              <p className="mt-4 text-5xl font-black text-gray-900">
                {plan.price}
              </p>

              <ul className="mt-8 space-y-3">
                {plan.features.map((feature) => (
                  <li
                    key={feature}
                    className="flex items-center gap-3 text-sm text-gray-700"
                  >
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-pink-100 text-xs text-pink-600">
                      ✓
                    </span>
                    {feature}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <p className="mt-8 text-center text-sm text-gray-500">
          Pay using <strong>EVC Plus</strong>, <strong>ZAAD</strong>, or{" "}
          <strong>SAHAL</strong> — no cash needed.
        </p>
      </div>
    </section>
  );
}
