/**
 * Component-chrome KO strings (partial — missing keys fall back to EN). KO has a
 * single plural form, so only the `_other` plural variant is provided.
 */
const components: {
  progress: Record<string, string>;
  storage: Record<string, string>;
  data: Record<string, string>;
  toolbar: Record<string, string>;
  player: Record<string, string>;
} = {
  progress: {
    of: '전체 {{total}} 중 {{done}}',
    etaLeft: '~{{time}} 남음',
    received: '{{bytes}} 받음',
    elapsed: '{{time}} 경과',
    live: '녹화 중 (라이브)',
  },
  storage: {
    free: '남음',
    usedOfTotal: '전체 {{total}} 중 {{used}} 사용',
    nearlyFull: '거의 가득 참',
    criticallyFull: '용량 임박',
    videos_other: '동영상 {{count}}개',
  },
  data: {
    range: '{{total}}개 중 {{from}}–{{to}}',
    prevPage: '이전 페이지',
    nextPage: '다음 페이지',
    selectAll: '전체 선택',
  },
  toolbar: {
    search: '검색…',
    moreFilters: '필터 더보기',
    filters: '필터',
    clearAll: '모두 지우기',
    done: '완료',
    sortBy: '정렬 기준',
  },
  player: {
    download: '원본 다운로드',
  },
};

export default components;
