import { timingSafeEqual } from "node:crypto";
export function authorized(request: Request, token: string) {
  const origin = request.headers.get("origin");
  if (origin && !["null", "http://127.0.0.1:5173"].includes(origin))
    return false;
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from("Bearer " + token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
