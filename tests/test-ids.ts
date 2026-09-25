// A well-formed id that can never be `id` itself: the same id with its last
// hex digit changed, since (d + 1) % 16 is never d. Tests use it for an id
// that looks registered but isn't, where a fixed id could by chance be the
// one the registry generated at random.
export function otherId(id: string) {
  const last = Number.parseInt(id.slice(-1), 16);
  if (Number.isNaN(last)) throw new Error(`${id} doesn't end in a hex digit`);
  return id.slice(0, -1) + ((last + 1) % 16).toString(16);
}
