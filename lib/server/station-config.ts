export type StationConfig = {
  code: string;
  imei: string;
  name: string;
};

const STATION_NAMES: Record<string, string> = {
  "58": "Danab-Cafe Castello\nTaleex",
  "59": "Danab-Feynuus\nBowling",
  "60": "Danab-Java\nTaleex",
  "61": "Danab-Delik\nSomalia",
  "62": "Danab-Arena Cafe\nMogadishu",
};

export const STATION_CONFIGS: Record<string, StationConfig> = {
  "station58.danab.com": {
    code: "58",
    imei: process.env.STATION_58_IMEI || "",
    name: STATION_NAMES["58"],
  },
  "station58.danab.site": {
    code: "58",
    imei: process.env.STATION_58_IMEI || "",
    name: STATION_NAMES["58"],
  },
  "station59.danab.com": {
    code: "59",
    imei: process.env.STATION_59_IMEI || "",
    name: STATION_NAMES["59"],
  },
  "station59.danab.site": {
    code: "59",
    imei: process.env.STATION_59_IMEI || "",
    name: STATION_NAMES["59"],
  },
  "station60.danab.com": {
    code: "60",
    imei: process.env.STATION_60_IMEI || "",
    name: STATION_NAMES["60"],
  },
  "station60.danab.site": {
    code: "60",
    imei: process.env.STATION_60_IMEI || "",
    name: STATION_NAMES["60"],
  },
  "station61.danab.com": {
    code: "61",
    imei: process.env.STATION_61_IMEI || "",
    name: STATION_NAMES["61"],
  },
  "station61.danab.site": {
    code: "61",
    imei: process.env.STATION_61_IMEI || "",
    name: STATION_NAMES["61"],
  },
  "station62.danab.com": {
    code: "62",
    imei: process.env.STATION_62_IMEI || "",
    name: STATION_NAMES["62"],
  },
  "station62.danab.site": {
    code: "62",
    imei: process.env.STATION_62_IMEI || "",
    name: STATION_NAMES["62"],
  },
};

function normalizeStationCode(code: string): string {
  return String(code || "").replace(/\D/g, "");
}

export function getStationConfigByDomain(
  hostname: string,
): StationConfig | null {
  const config = STATION_CONFIGS[hostname.toLowerCase()];
  if (config) {
    return config;
  }

  const subdomain = hostname.split(".")[0];
  const stationNumber = subdomain.replace(/\D/g, "");
  if (stationNumber) {
    const envImei = process.env[`STATION_${stationNumber}_IMEI`];
    if (envImei) {
      return {
        code: stationNumber,
        imei: envImei,
        name: `Station ${stationNumber}`,
      };
    }
  }

  if (process.env.STATION_CODE && process.env.STATION_IMEI) {
    return {
      code: process.env.STATION_CODE,
      imei: process.env.STATION_IMEI,
      name: process.env.STATION_NAME || `Station ${process.env.STATION_CODE}`,
    };
  }

  return null;
}

export function getStationConfigByCode(code: string): StationConfig | null {
  const normalizedCode = normalizeStationCode(code);
  if (!normalizedCode) {
    return null;
  }

  const envImei = process.env[`STATION_${normalizedCode}_IMEI`];
  if (envImei) {
    return {
      code: normalizedCode,
      imei: envImei,
      name: STATION_NAMES[normalizedCode] || `Station ${normalizedCode}`,
    };
  }

  return null;
}

export function getPublicStationConfigs(): StationConfig[] {
  const seen = new Set<string>();
  const stations: StationConfig[] = [];

  for (const code of Object.keys(STATION_NAMES)) {
    const config = getStationConfigByCode(code);
    if (config && !seen.has(config.code)) {
      seen.add(config.code);
      stations.push(config);
    }
  }

  stations.sort((a, b) => Number(a.code) - Number(b.code));
  return stations;
}
