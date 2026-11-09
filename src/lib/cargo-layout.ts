import { type CargoItem } from './container-cargo';

export const cargoShell = { length: 850, depth: 310, height: 164 };
type Footprint = { x: number; z: number; w: number; d: number };
export type CargoBox = Footprint & { y: number; h: number };
type Stack = { item: CargoItem; index: number; tiers: number; weight: number };
type WeightedStack = Stack & { area: number };
const floorMargin = 18;
const cartonArea = 2200;

function aspectRatio(area: number, largest: number, smallest: number, shortSide: number) {
  return Math.max(shortSide ** 2 * largest / area ** 2, area ** 2 / (shortSide ** 2 * smallest));
}

function packStacks(stacks: WeightedStack[], floor: Footprint) {
  const packed: (Stack & { footprint: Footprint })[] = [];
  let { x, z, w, d } = floor;
  let start = 0;
  while (start < stacks.length) {
    const vertical = w >= d;
    const shortSide = vertical ? d : w;
    let end = start + 1;
    const largest = stacks[start].area;
    let bandArea = largest;
    while (end < stacks.length) {
      const next = stacks[end].area;
      if (aspectRatio(bandArea + next, largest, next, shortSide) >
        aspectRatio(bandArea, largest, stacks[end - 1].area, shortSide)) break;
      bandArea += next;
      end++;
    }

    const thickness = end === stacks.length ? (vertical ? w : d) : bandArea / shortSide;
    let offset = 0;
    for (let i = start; i < end; i++) {
      const stack = stacks[i];
      const span = i === end - 1 ? shortSide - offset : stack.area / bandArea * shortSide;
      const footprint = vertical ? { x, z: z + offset, w: thickness, d: span } : { x: x + offset, z, w: span, d: thickness };
      packed.push({ ...stack, footprint });
      offset += span;
    }
    if (vertical) { x += thickness; w -= thickness; }
    else { z += thickness; d -= thickness; }
    start = end;
  }
  return packed;
}

export function layoutCargo(items: CargoItem[]) {
  if (!items.length) return [];
  const stacks = items.map((item, index): Stack => {
    const quantity = item.quantity;
    const tiers = quantity <= 8 ? 1 : quantity <= 32 ? 2 : 3;
    const weight = quantity <= 8 ? Math.max(1, quantity) : quantity <= 32 ? 8 + (quantity - 8) / 2 : 20 + (quantity - 32) / 3;
    return { item, index, tiers, weight };
  }).sort((a, b) => b.weight - a.weight);

  const weightTotal = stacks.reduce((sum, stack) => sum + stack.weight, 0);
  const innerLength = cargoShell.length - floorMargin * 2;
  const innerDepth = cargoShell.depth - floorMargin * 2;
  const totalArea = Math.min(innerLength * innerDepth, weightTotal * cartonArea);
  const d = Math.min(innerDepth, Math.sqrt(totalArea));
  const floor = { x: floorMargin, z: floorMargin, w: totalArea / d, d };
  // Reserve a small share for tiny lines so that they stay visible beside much larger ones.
  const weighted = stacks.map(stack => ({ ...stack, area: totalArea * (0.96 * stack.weight / weightTotal + 0.04 / stacks.length) }));

  return packStacks(weighted, floor).map(({ item, index, tiers, footprint }) => {
    const inset = Math.min(5, footprint.w * .08, footprint.d * .08);
    const base: CargoBox = { x: footprint.x + inset, y: 0, z: footprint.z + inset,
      w: footprint.w - 2 * inset, h: Math.min(8, inset * 2), d: footprint.d - 2 * inset };
    const slots = Math.min(28, Math.ceil(item.quantity / tiers), Math.max(1, Math.ceil(base.w * base.d / 1400)));
    const columns = Math.min(slots, Math.max(1, Math.round(Math.sqrt(slots * base.w / base.d))));
    const rows = Math.ceil(slots / columns);
    const tileWidth = base.w / columns, tileDepth = base.d / rows;
    const boxHeight = Math.min(33, Math.min(tileWidth, tileDepth) * .75);
    const count = Math.min(Math.ceil(item.quantity), slots * tiers);
    const boxes = Array.from({ length: count }, (_, boxIndex): CargoBox => {
      const tile = boxIndex % slots;
      return { x: base.x + (tile % columns + .06) * tileWidth, y: base.h + Math.floor(boxIndex / slots) * boxHeight,
        z: base.z + (Math.floor(tile / columns) + .06) * tileDepth, w: tileWidth * .88, h: boxHeight, d: tileDepth * .88 };
    });
    return { item, index, base, boxes, top: base.h + Math.ceil(count / slots) * boxHeight };
  });
}
