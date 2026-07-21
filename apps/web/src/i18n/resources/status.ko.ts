/**
 * Status KO strings — partial by design (any omission falls back to EN at
 * runtime). Kept short so KO badge labels don't overflow the reserved badge zone.
 */
const status: {
  status: {
    copy: Record<string, string>;
    source: Record<string, string>;
    job: Record<string, string>;
    rescued: string;
    srcEyebrow: string;
  };
} = {
  status: {
    copy: {
      CANDIDATE: '후보',
      QUEUED: '대기 중',
      DOWNLOADING: '다운로드 중',
      VERIFYING: '검증 중',
      AWAITING_VERIFY: '완결성 확인 중',
      HEALTHY: '정상',
      FAILED: '실패',
      PARTIAL_KEPT: '부분 저장됨',
    },
    source: {
      AVAILABLE: '사용 가능',
      GEO_BLOCKED: '지역 차단',
      PRIVATE: '비공개',
      MEMBERS_ONLY: '멤버 전용',
      AGE_GATED: '연령 제한',
      DELETED: '삭제됨',
      TRANSIENT_ERROR: '일시적 오류',
      RATE_LIMITED: '요청 제한',
      UNKNOWN: '알 수 없음',
    },
    job: {
      QUEUED: '대기 중',
      RUNNING: '다운로드 중',
      PAUSED: '일시정지',
      COMPLETED: '완료',
      FAILED: '실패',
      CANCELED: '취소됨',
    },
    rescued: '구조됨',
    srcEyebrow: 'src',
  },
};

export default status;
