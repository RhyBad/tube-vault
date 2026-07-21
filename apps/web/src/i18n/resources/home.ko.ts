/**
 * Home KO strings — partial by design (any omission falls back to EN at runtime).
 * Mirrors the home.en shape; plural suffix keys (_one/_other) resolve via i18next
 * even though Korean has a single plural form.
 */
const home = {
  home: {
    eyebrow: '홈',
    title: '개요',
    subtitle:
      '한눈에 보는 보관함 — 지금 무엇이 돌아가고, 무엇이 저장돼 있으며, 방금 무엇이 보존됐는지.',
    w1: {
      title: '진행 현황',
      loading: '진행 중인 작업 불러오는 중…',
      summary: {
        downloads_other: '다운로드 {{count}}건',
        live_other: '라이브 녹화 {{count}}건',
        idle: '진행 중인 작업 없음',
      },
      link: {
        queue: '큐',
        live: '라이브',
      },
      liveDivider: '라이브 녹화',
      viewQueue: '큐 전체 보기',
      waiting_other: '큐에서 {{count}}건 더 보기',
      waitingCapped: '큐에서 나머지 보기',
      empty: {
        title: '진행 중인 작업 없음',
        body: '새 다운로드와 라이브 녹화가 여기에 표시됩니다.',
        cta: '라이브러리 둘러보기',
      },
      error: '진행 상황을 불러오지 못했습니다.',
    },
    w2: {
      title: '용량 현황',
      subtitle: '보관함 용량 · 상위 채널',
      loading: '용량 정보 불러오는 중…',
      link: '스토리지',
      more: '스토리지 상세',
      empty: {
        title: '아직 보관물 없음',
        body: '영상을 보존하면 보관함 사용량이 여기에 표시됩니다.',
        cta: '채널 추가',
      },
      error: '용량 정보를 불러오지 못했습니다.',
    },
    w3: {
      title: '최근 보존',
      subtitle: '보관함에 가장 최근 들어온 사본',
      loading: '최근 활동 불러오는 중…',
      link: '라이브러리',
      more: '라이브러리 열기',
      empty: {
        title: '아직 보존된 영상 없음',
        body: '채널을 추가해 영상 보관을 시작하세요.',
        cta: '채널 추가',
      },
      error: '최근 활동을 불러오지 못했습니다.',
    },
    w4: {
      title: '채널',
      subtitle: '새 영상·라이브 감시 중',
      loading: '채널 불러오는 중…',
      link: '전체 채널',
      more: '채널 전체 보기',
      empty: {
        title: '아직 채널 없음',
        body: '채널을 추가해 보관을 시작하세요.',
        cta: '채널 추가',
      },
      error: '채널을 불러오지 못했습니다.',
    },
  },
};

export default home;
