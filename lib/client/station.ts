const STATION_NAMES: Record<string, string> = {
  "58": "Danab-Cafe Castello\nTaleex",
  "59": "Danab-Feynuus\nBowling",
  "60": "Danab-Java\nTaleex",
  "61": "Danab-Delik\nSomalia",
  "62": "Danab-Arena Cafe\nMogadishu",
};

export function getStationName(): string {
  if (typeof window === "undefined") {
    return "Danab Power Bank";
  }

  const hostname = window.location.hostname;

  // Extract station number from subdomain (e.g., station58.danab.site -> 58)
  const subdomain = hostname.split(".")[0];
  const stationNumber = subdomain.replace(/\D/g, "");

  if (stationNumber && STATION_NAMES[stationNumber]) {
    return STATION_NAMES[stationNumber];
  }

  return "Danab Power Bank";
}
