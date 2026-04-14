"use client";

export function Footer() {
  return (
    <footer className="bg-gray-900 px-4 py-12 text-white sm:px-6 lg:px-8">
      <div className="mx-auto max-w-5xl">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          <div className="sm:col-span-2 lg:col-span-1">
            <h3 className="text-xl font-black">
              <span className="bg-gradient-to-r from-pink-400 to-purple-400 bg-clip-text text-transparent">
                Danab
              </span>
            </h3>
            <p className="mt-3 text-sm leading-relaxed text-gray-400">
              Somalia&apos;s first portable power bank rental service. Stay
              charged, stay connected.
            </p>
          </div>

          <div>
            <h4 className="text-sm font-bold uppercase tracking-wider text-gray-300">
              Company
            </h4>
            <ul className="mt-4 space-y-3">
              <li>
                <a
                  href="#about"
                  className="text-sm text-gray-400 transition hover:text-pink-400"
                >
                  About Us
                </a>
              </li>
              <li>
                <a
                  href="#stations"
                  className="text-sm text-gray-400 transition hover:text-pink-400"
                >
                  Stations
                </a>
              </li>
              <li>
                <a
                  href="#pricing"
                  className="text-sm text-gray-400 transition hover:text-pink-400"
                >
                  Pricing
                </a>
              </li>
              <li>
                <a
                  href="#contact"
                  className="text-sm text-gray-400 transition hover:text-pink-400"
                >
                  Contact
                </a>
              </li>
            </ul>
          </div>

          <div>
            <h4 className="text-sm font-bold uppercase tracking-wider text-gray-300">
              Support
            </h4>
            <ul className="mt-4 space-y-3">
              <li>
                <a
                  href="#how-it-works"
                  className="text-sm text-gray-400 transition hover:text-pink-400"
                >
                  How It Works
                </a>
              </li>
              <li>
                <a
                  href="/rules"
                  className="text-sm text-gray-400 transition hover:text-pink-400"
                >
                  Terms of Service
                </a>
              </li>
              <li>
                <a
                  href="#contact"
                  className="text-sm text-gray-400 transition hover:text-pink-400"
                >
                  FAQs
                </a>
              </li>
            </ul>
          </div>

          <div>
            <h4 className="text-sm font-bold uppercase tracking-wider text-gray-300">
              Contact
            </h4>
            <ul className="mt-4 space-y-3">
              <li className="text-sm text-gray-400">+252 616 586 503</li>
              <li className="text-sm text-gray-400">+252 616 251 068</li>
              <li className="text-sm text-gray-400">Mogadishu, Somalia</li>
            </ul>
          </div>
        </div>

        <div className="mt-10 border-t border-gray-800 pt-8 text-center">
          <p className="text-sm text-gray-500">
            &copy; 2025 Danab. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
