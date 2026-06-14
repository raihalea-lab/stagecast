/**
 * 事前アップロードスライドのページ送りロジック (DESIGN.md 5.2)。純粋関数でテスト可能。
 */
export interface SlideDeckState {
  page: number;
  totalPages: number;
}

export function nextPage(state: SlideDeckState): SlideDeckState {
  return { ...state, page: Math.min(state.totalPages, state.page + 1) };
}

export function prevPage(state: SlideDeckState): SlideDeckState {
  return { ...state, page: Math.max(1, state.page - 1) };
}

export function goToPage(state: SlideDeckState, page: number): SlideDeckState {
  return { ...state, page: Math.min(state.totalPages, Math.max(1, page)) };
}
