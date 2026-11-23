export function sessionCookie(res: { cookies: { name: string; value: string }[] }): string {
  return `vibehub_session=${res.cookies.find((cookie) => cookie.name === "vibehub_session")?.value ?? ""}`;
}
