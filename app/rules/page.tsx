import Link from "next/link";

const rules = [
  {
    title: "Wakhtiga Kirada",
    description:
      "Battery-ga waxaad kireysan kartaa muddo 1 saac ama 2 saac. Haddii aadan soo celin mudadaas, waxaa lagu dalaci doonaa lacag dheeraad ah.",
  },
  {
    title: "Daryeelka Battery-ga",
    description:
      "Waa inaad si fiican u daryeeshaa battery-ga. Haddii uu dhaawac gaaro ama uu lumo, waxaad masuul ka tahay qiimaha buuxa ee battery-ga ($20).",
  },
  {
    title: "Soo Celinta",
    description:
      "Battery-ga waa inaad soo celisaa goobta aad ka qaadatay ama goob kale oo Danab ah. Haddii aadan soo celin 24 saac gudahood, numberkaaga waa la xiri doonaa oo waxaad bixin doontaa qiimaha buuxa.",
  },
  {
    title: "Lacag Bixinta",
    description:
      "Lacagta waxaa laga jari doonaa numberka aad gelisay. Hubi in lacag ku filan ay ku jirto accountigaaga ka hor intaadan bixin. Lacagta la bixiyay dib looma celiyo.",
  },
  {
    title: "Isticmaalka Saxda ah",
    description:
      "Battery-ga waxa loo isticmaalaa telefoonka kaliya. Ha u isticmaalin qalab kale sida laptop-yo ama qalab awood weyn u baahan. Ha ku dhejin biyo ama meel kulul.",
  },
  {
    title: "Xadidaadda Kirada",
    description:
      "Hal qof wuxuu kireysan karaa hal battery kaliya. Ma kireysn kartid mid cusub ilaa aad soo celiso midka aad haysato.",
  },
  {
    title: "Blacklist / Xirida",
    description:
      "Haddii aad ku guuldareysato inaad soo celiso battery-ga, numberkaaga waxaa lagu dari doonaa liiska xidhan. Kadib ma awoodi doontid inaad isticmaasho adeegga ilaa aad bixiso lacagta.",
  },
  {
    title: "Xiriirka Macaamiisha",
    description:
      "Haddii aad qabto wax su'aal ah, waxaad nagala soo xiriiri kartaa numberka: +252 616586503 / 616251068",
  },
];

export default function RulesPage() {
  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,#f7ddf3,#f0ebff_35%,#f8f8ff)] px-4 py-10">
      <div className="mx-auto max-w-2xl">
        <header className="mb-8 text-center">
          <h1 className="bg-gradient-to-r from-pink-500 to-purple-600 bg-clip-text text-3xl font-black text-transparent">
            Shuruudaha &amp; Xeerarka
          </h1>
          <p className="mt-2 text-slate-600">Danab Battery Rental Service</p>
        </header>

        <section className="rounded-2xl bg-white p-6 shadow-xl">
          {rules.map((rule, index) => (
            <article
              key={rule.title}
              className={index === rules.length - 1 ? "" : "mb-4 border-b border-slate-200 pb-4"}
            >
              <h2 className="mb-2 flex items-center gap-2 text-lg font-semibold text-purple-700">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-purple-500 text-sm text-white">
                  {index + 1}
                </span>
                {rule.title}
              </h2>
              <p className="text-slate-600">{rule.description}</p>
            </article>
          ))}
        </section>

        <div className="mt-6 rounded-xl border border-pink-200 bg-pink-50 p-4 text-center">
          <p className="text-sm text-pink-700">
            Marka aad isticmaasho adeegga Danab, waxaad aqbashay dhammaan shuruudahan.
          </p>
        </div>

        <div className="mt-6 text-center">
          <Link
            href="/"
            className="inline-flex rounded-xl bg-gradient-to-r from-pink-500 to-purple-500 px-6 py-2 font-semibold text-white shadow-lg transition hover:scale-105"
          >
            Ku noqo Bixinta
          </Link>
        </div>
      </div>
    </div>
  );
}
