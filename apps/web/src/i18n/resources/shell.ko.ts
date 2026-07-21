/**
 * Shell KO strings (partial — missing keys fall back to EN).
 */
const shell: {
  shell: {
    nav: Record<string, string>;
    search: Record<string, string>;
    bell: Record<string, string>;
    bulk: Record<string, string>;
  };
} = {
  shell: {
    nav: {
      primary: '주 메뉴',
    },
    search: {
      trigger: '보관함 검색…',
      placeholder: '보관함 검색…',
      hint: '제목 또는 채널 검색',
      channels: '채널',
      videos: '동영상',
      searching: '검색 중…',
      noMatchTitle: '“{{query}}” 검색 결과가 없습니다',
      noMatchBody: '다른 제목이나 채널 이름으로 검색해 보세요.',
      seeAll: '라이브러리에서 전체 결과 보기',
      keyHint: '↑↓ 이동 · Enter 열기 · Esc 닫기',
      close: '검색 닫기',
    },
    bell: {
      open: '알림',
      title: '알림',
      unread: '안 읽음 {{count}}개',
      markAllRead: '모두 읽음 표시',
      seeAll: '알림에서 모두 보기',
      emptyTitle: '모두 확인됨',
      emptyBody: '지금은 처리할 항목이 없습니다.',
      errorTitle: '알림을 불러오지 못했습니다',
      errorBody: '연결 상태를 확인한 뒤 다시 시도해 주세요.',
      retryLoad: '다시 시도',
      viewVideo: '동영상 보기',
      retry: '지금 다시 시도',
      refreshCredential: '자격 증명 갱신',
      watchLive: '라이브 보기',
      manageStorage: '저장소 관리',
      close: '알림 닫기',
    },
    bulk: {
      selected: '{{count}}개 선택됨',
      clear: '선택 해제',
    },
  },
};

export default shell;
