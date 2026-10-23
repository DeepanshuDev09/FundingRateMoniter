export function isAdmin(req: Request): boolean {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return false; // no password configured = admin disabled
  return req.headers.get("x-admin-password") === pw;
}
