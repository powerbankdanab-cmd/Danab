const STATION_NAMES: Record<string, string> = {
  "58": "Danab-Cafe Castello\nTaleex",
  "59": "Danab-Feynuus\nBowling",
  "60": "Danab-Java\nTaleex",
  "61": "Danab-Delik\nSomalia",
  "62": "Danab-Arena Cafe\nMogadishu",
};

export function getStationCode(): string {
  if (typeof window === "undefined") {
    return "";
  }

  const url = new URL(window.location.href);
  const requestedStationCode =
    url.searchParams.get("stationCode")?.replace(/\D/g, "") || "";
  if (requestedStationCode) {
    return requestedStationCode;
  }

  const hostname = window.location.hostname;
  const subdomain = hostname.split(".")[0];
  return subdomain.replace(/\D/g, "");
}

export function getStationName(): string {
  const stationNumber = getStationCode();

  if (stationNumber && STATION_NAMES[stationNumber]) {
    return STATION_NAMES[stationNumber];
  }

  return "Danab Power Bank";
}
