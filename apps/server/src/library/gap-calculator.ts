export function calculateMissing(expected: Iterable<number>, stored: Iterable<number>): number[] {
  const storedEpisodes = new Set(stored);
  return [...new Set(expected)].filter((episode) => !storedEpisodes.has(episode)).sort((left, right) => left - right);
}
