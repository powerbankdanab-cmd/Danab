"use client";

export function Contact() {
  return (
    <section id="contact" className="bg-white px-4 py-20 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-5xl">
        <div className="text-center">
          <p className="text-sm font-bold uppercase tracking-widest text-pink-500">
            Get In Touch
          </p>
          <h2 className="mt-3 text-3xl font-black text-gray-900 sm:text-4xl">
            Contact Us
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-base text-gray-600">
            Have questions, feedback, or want to partner with us? We&apos;d love
            to hear from you.
          </p>
        </div>

        <div className="mt-12 grid gap-6 sm:grid-cols-3">
          <div className="flex flex-col items-center rounded-2xl border border-gray-100 bg-gray-50 p-8 text-center shadow-sm transition-all hover:border-pink-200 hover:shadow-md">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-gradient-to-br from-pink-500 to-purple-600 text-white shadow-md">
              <svg
                className="h-7 w-7"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 0 0 2.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 0 1-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 0 0-1.091-.852H4.5A2.25 2.25 0 0 0 2.25 4.5v2.25Z"
                />
              </svg>
            </div>
            <h3 className="text-base font-bold text-gray-900">Call Us</h3>
            <p className="mt-2 text-sm text-gray-600">Available daily</p>
            <a
              href="tel:+252616586503"
              className="mt-3 text-sm font-bold text-pink-600 hover:text-pink-700"
            >
              +252 616 586 503
            </a>
            <a
              href="tel:+252616251068"
              className="mt-1 text-sm font-bold text-pink-600 hover:text-pink-700"
            >
              +252 616 251 068
            </a>
          </div>

          <div className="flex flex-col items-center rounded-2xl border border-gray-100 bg-gray-50 p-8 text-center shadow-sm transition-all hover:border-pink-200 hover:shadow-md">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-gradient-to-br from-pink-500 to-purple-600 text-white shadow-md">
              <svg
                className="h-7 w-7"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z"
                />
              </svg>
            </div>
            <h3 className="text-base font-bold text-gray-900">Visit Us</h3>
            <p className="mt-2 text-sm text-gray-600">Mogadishu, Somalia</p>
            <p className="mt-3 text-sm font-medium text-gray-700">
              5+ locations across the city
            </p>
          </div>

          <div className="flex flex-col items-center rounded-2xl border border-gray-100 bg-gray-50 p-8 text-center shadow-sm transition-all hover:border-pink-200 hover:shadow-md">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-gradient-to-br from-pink-500 to-purple-600 text-white shadow-md">
              <svg
                className="h-7 w-7"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
                />
              </svg>
            </div>
            <h3 className="text-base font-bold text-gray-900">Hours</h3>
            <p className="mt-2 text-sm text-gray-600">Always available</p>
            <p className="mt-3 text-sm font-bold text-purple-700">
              24/7 Service
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
