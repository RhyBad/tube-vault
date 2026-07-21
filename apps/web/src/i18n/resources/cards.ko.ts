/**
 * Card KO strings (partial — missing keys fall back to EN).
 */
const cards: {
  cards: {
    channel: Record<string, string>;
    video: Record<string, string>;
    live: { heartbeatLive: string; heartbeatStale: string; state: Record<string, string> };
  };
} = {
  cards: {
    channel: {
      watchingLive: '라이브 감시 중',
      collectionStopped: '수집 중지됨',
      total: '전체',
      healthy: '정상',
      candidates: '후보',
    },
    video: {
      live: '라이브',
      members: '멤버',
    },
    live: {
      heartbeatLive: '실시간',
      heartbeatStale: '신호 확인 중',
      state: {
        DETECTED: '감지됨',
        CAPTURING: '녹화 중',
        ENDED_NORMAL: '종료됨',
        ENDED_INTERRUPTED: '조기 종료',
        FAILED: '실패',
        ENDED_PENDING: '마무리 중',
      },
    },
  },
};

export default cards;
