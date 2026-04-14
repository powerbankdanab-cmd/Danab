import { NextRequest, NextResponse } from "next/server";

export function middleware(request: NextRequest) {
  const hostname = request.headers.get("host") || "";
  const subdomain = hostname.split(".")[0];

  // If it's a station subdomain (e.g., station58.danab.site), rewrite to /station
  if (/^station\d+$/i.test(subdomain)) {
    const url = request.nextUrl.clone();
    url.pathname = "/station" + url.pathname;
    return NextResponse.rewrite(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/"],
};
