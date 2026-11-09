import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cargoShell, layoutCargo } from '../src/lib/cargo-layout';

const item = (id: string, quantity: number) => ({ id, name: id, quantity, unit: 'Carton', cost: 0 });

test('five cartons take less floor area and height than a hundred', () => {
  const [large, small] = layoutCargo([item('Small', 5), item('Large', 100)]);
  assert.equal(small.item.id, 'Small');
  assert.equal(small.boxes.length, 5);
  assert.equal(large.item.id, 'Large');
  assert.ok(large.base.w * large.base.d > small.base.w * small.base.d * 3);
  assert.ok(large.top > small.top);
  const [onlySmall] = layoutCargo([item('Small', 5)]);
  assert.ok(onlySmall.base.w * onlySmall.base.d < cargoShell.length * cargoShell.depth / 10);
});

test('all lines occupy distinct footprints inside one container, including tiny loads', () => {
  const items = Array.from({ length: 28 }, (_, index) => item('Load ' + index, index === 0 ? 100000000 : index / 1000));
  const stacks = layoutCargo(items);
  assert.equal(stacks.length, items.length);
  assert.equal(new Set(stacks.map(stack => stack.item.id)).size, items.length);
  for (const [index, { base, boxes, top }] of stacks.entries()) {
    assert.ok(base.w > 0 && base.d > 0 && boxes.length > 0);
    assert.ok(base.x >= 0 && base.x + base.w <= cargoShell.length);
    assert.ok(base.z >= 0 && base.z + base.d <= cargoShell.depth);
    assert.ok(top <= cargoShell.height);
    for (const other of stacks.slice(index + 1).map(stack => stack.base)) {
      assert.ok(base.x + base.w <= other.x || other.x + other.w <= base.x ||
        base.z + base.d <= other.z || other.z + other.d <= base.z);
    }
  }
});
