/**
 * Absolute timestamp, precise to the second — relative labels ("just now")
 * collapse rapid successive saves into indistinguishable rows, hiding their
 * order. Time-only for today's versions; date-prefixed for older ones.
 */
export function formatVersionTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay ? hms : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hms}`;
}
