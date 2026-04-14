type JsonObject = Record<string, unknown>;

export async function parseResponseBody(response: Response) {
  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function toErrorMessage(payload: unknown, fallback: string) {
  if (!payload) {
    return fallback;
  }

  if (typeof payload === "string") {
    return payload;
  }

  if (typeof payload === "object") {
    const objectPayload = payload as JsonObject;
    const message = objectPayload.error || objectPayload.message;

    if (typeof message === "string") {
      return message;
    }

    try {
      return JSON.stringify(payload);
    } catch {
      return fallback;
    }
  }

  return fallback;
}
