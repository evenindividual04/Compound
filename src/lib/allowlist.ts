export function isAllowed(email: string | null | undefined): boolean {
  if (!email) return false;
  const owner = process.env.OWNER_EMAIL;
  if (!owner) return false;
  return email.toLowerCase() === owner.toLowerCase();
}
