const riyalsPerPound = 5n;

export function poundsFromRiyals(sarMinor: number) {
  const poundsMinor = Number((BigInt(Math.abs(sarMinor)) + riyalsPerPound / 2n) / riyalsPerPound);
  return sarMinor < 0 && poundsMinor ? -poundsMinor : poundsMinor;
}
