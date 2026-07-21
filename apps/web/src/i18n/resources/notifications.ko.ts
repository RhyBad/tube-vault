/**
 * Notifications KO strings — S8. Parallels notifications.en; missing keys fall
 * back to EN at runtime (fallbackLng en).
 */
export default {
  notifications: {
    eyebrow: '활동 기록',
    title: '알림',
    subtitle:
      '보관소가 지금까지 한 모든 일 — 실패·만료·구조 — 을 모아, 잘 돌아가고 있는지 확인합니다.',
    view: {
      all: '전체',
      unread: '안 읽음',
      helperUnread: '처리 대기함 · 확인이 필요한 항목',
      helperAll: '전체 기록 · 최신순',
    },
    poll: {
      line: '30초마다 갱신',
      refresh: '새로고침',
    },
    newActivity_one: '새 알림 {{count}}건 — 새로고침하면 표시됩니다',
    newActivity_other: '새 알림 {{count}}건 — 새로고침하면 표시됩니다',
    filter: {
      typeAll: '모든 유형',
      typeFailures: '실패',
      typeRescues: '구조',
      typeLive: '라이브',
      typeSourceGone: '원본 삭제',
      sevAll: '모든 심각도',
      sevWarning: '주의 이상',
      sevCritical: '심각만',
      dateAny: '전체 기간',
      date1: '최근 24시간',
      date7: '최근 7일',
      date30: '최근 30일',
      typeLabel: '유형으로 필터',
      sevLabel: '심각도로 필터',
      dateLabel: '기간으로 필터',
      clear: '필터 지우기',
      loadedNote: '불러온 항목에만 적용 — 서버 측 필터 준비 중.',
    },
    markAllRead: '모두 읽음',
    markAllConfirm: {
      title: '전부 읽음 처리할까요?',
      body: '현재 필터에 맞는 항목만이 아니라 모든 알림이 읽음으로 처리됩니다. 필터는 초기화됩니다.',
      confirm: '필터 지우고 모두 읽음',
    },
    empty: {
      allTitle: '활동 없음',
      allBody: '아직 기록된 활동이 없습니다. 다운로드·원본 변경·구조 소식이 여기에 표시됩니다.',
      clearTitle: '모두 정상',
      clearBody: '지금 확인할 항목이 없습니다. 지금까지의 활동은 ‘전체’에 있습니다.',
      viewAll: '전체 활동 보기',
      filterTitle: '조건에 맞는 활동이 없습니다',
      filterBody: '필터를 넓혀 보세요. 지금까지 불러온 항목에만 적용됩니다.',
    },
    error: {
      title: '활동 기록을 불러오지 못했습니다',
      body: '불러오지 못했습니다. 보관 작업은 백그라운드에서 계속됩니다 — 다시 시도하세요.',
    },
    endOfLog: '기록 끝',
    toast: {
      dismissed: '읽음으로 표시함',
      undo: '실행 취소',
      badCursorTitle: '처음부터 다시 불러옴',
      badCursorBody: '목록 커서가 만료되어 최신 활동을 다시 불러왔습니다.',
    },
  },
};
