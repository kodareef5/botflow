import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CARD_TAG_LIMIT,
  MAX_CARD_TAG_LIMIT,
  cardTagWindow,
  validCardTagLimit,
} from '../src/ui/card-face.ts';

test('card tag limits accept only bounded whole numbers', () => {
  assert.equal(validCardTagLimit(0), 0);
  assert.equal(validCardTagLimit(4), 4);
  assert.equal(validCardTagLimit(MAX_CARD_TAG_LIMIT), MAX_CARD_TAG_LIMIT);
  for (const value of [-1, 1.5, MAX_CARD_TAG_LIMIT + 1, '4', null, undefined]) {
    assert.equal(validCardTagLimit(value), DEFAULT_CARD_TAG_LIMIT);
  }
});

test('card tag windows report the exact hidden remainder', () => {
  assert.deepEqual(cardTagWindow(['one', 'two', 'three', 'four'], 2), {
    visible: ['one', 'two'],
    hiddenCount: 2,
  });
  assert.deepEqual(cardTagWindow(['one', 'two'], 0), {
    visible: [],
    hiddenCount: 2,
  });
  assert.deepEqual(cardTagWindow(['one', 'two'], 2), {
    visible: ['one', 'two'],
    hiddenCount: 0,
  });
});
