import { describe, expect, it } from 'vitest';
import { goToPage, nextPage, prevPage } from './slides.js';

describe('slide navigation (DESIGN.md 5.2)', () => {
  const deck = { page: 2, totalPages: 5 };
  it('advances and rewinds within bounds', () => {
    expect(nextPage(deck).page).toBe(3);
    expect(prevPage(deck).page).toBe(1);
    expect(prevPage({ page: 1, totalPages: 5 }).page).toBe(1); // 下限
    expect(nextPage({ page: 5, totalPages: 5 }).page).toBe(5); // 上限
  });
  it('clamps goToPage to [1, totalPages]', () => {
    expect(goToPage(deck, 99).page).toBe(5);
    expect(goToPage(deck, 0).page).toBe(1);
    expect(goToPage(deck, 3).page).toBe(3);
  });
});
