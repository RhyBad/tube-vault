/**
 * Common KO strings — a PARTIAL dictionary by design. It is intentionally NOT
 * typed as `typeof en`: any key it omits (e.g. app.tagline, lang.*) resolves to
 * the EN string at runtime via fallbackLng (the owner requirement — community
 * translations are always incomplete and must never break the build).
 */
const common: {
  app: { name: string };
  nav: Record<string, string>;
  theme: Record<string, string>;
  sse: Record<string, string>;
  action: Record<string, string>;
  common: Record<string, string>;
} = {
  app: {
    name: 'TubeVault',
  },
  nav: {
    home: '홈',
    queue: '대기열',
    live: '라이브',
    library: '라이브러리',
    channels: '채널',
    storage: '저장소',
    notifications: '알림',
    settings: '설정',
    more: '더보기',
  },
  theme: {
    label: '테마',
    light: '라이트',
    dark: '다크',
    system: '시스템',
  },
  sse: {
    connected: '연결됨',
    reconnecting: '재연결 중…',
    disconnected: '연결 끊김',
    label: '실시간 업데이트',
  },
  action: {
    retry: '다시 시도',
    cancel: '취소',
    confirm: '확인',
    close: '닫기',
    dismiss: '지우기',
    clearFilters: '필터 지우기',
    loadMore: '더 불러오기',
    seeAll: '전체 보기',
  },
  common: {
    comingSoon: '준비 중',
    comingSoonBody: '이 화면은 준비 중입니다. 다음 업데이트에서 제공될 예정입니다.',
    notFound: '페이지를 찾을 수 없습니다',
    notFoundBody: '해당 페이지가 존재하지 않습니다.',
    endOfList: '목록의 끝',
    loading: '불러오는 중…',
  },
};

export default common;
