export const adminCommands = [
  // 1. 루틴 / 실행
  { command: 'run_routine_now', description: '즉시 daily_routine 실행' },
  { command: 'today_links', description: '세미나/퀴즈 링크 모음 [날짜 지정 가능]' },
  { command: 'broadcast_today_links', description: '오늘의 링크 채널 공지' },
  { command: 'apply_seminar_now', description: '즉시 세미나 신청(apply_seminars) 실행' },
  { command: 'sync_seminars_now', description: '즉시 세미나 동기화(sync_seminars) 실행' },
  { command: 'run_quiz_now', description: '즉시 오늘의 퀴즈(today_quiz) 실행' },
  { command: 'run_intermd_quiz_now', description: '즉시 인터엠디 오늘의 퀴즈(intermd_quiz) 실행' },
  { command: 'run_docple_daily_now', description: '즉시 닥플 일일 자동화(docple_daily) 실행' },
  { command: 'run_keymedi_attendance_now', description: '즉시 키메디 출석체크(keymedi_attendance) 실행' },
  { command: 'run_hmp_attendance_now', description: '즉시 HMP 출석체크(hmp_attendance) 실행' },
  { command: 'monitor_lunch_seminar_now', description: '즉시 점심 세미나 모니터링 시작' },
  { command: 'monitor_dinner_seminar_now', description: '즉시 저녁 세미나 모니터링 시작' },
  // 2. 세미나 & 퀴즈 족보
  { command: 'run_seminar_quiz', description: '특정 세미나 퀴즈 수동 실행 (seminarId, [advanced])' },
  { command: 'set_seminar_quiz', description: '공지방 세미나 항목의 퀴즈 정답 등록/수정 (seminarId, 정답)' },
  { command: 'add_seminar_answer_batch', description: '족보 일괄 등록' },
  { command: 'list_seminar_quiz', description: '등록된 족보 목록' },
  { command: 'delete_seminar_quiz', description: '족보 삭제' },
  { command: 'list_quiz', description: 'quiz.json 등록 제품 목록' },
  { command: 'delete_quiz', description: 'quiz.json 항목 삭제' },
  { command: 'seminar_detail', description: '세미나 번호로 상세 정보 실시간 조회' },
  { command: 'delete_seminar', description: '세미나 DB 항목 삭제 (seminarId [seminarId...])' },
  // 3. 포인트 & 교환
  { command: 'check_point', description: '현재 포인트 확인' },
  { command: 'check_seminar_point', description: '세미나 번호로 포인트 지급 확인' },
  { command: 'set_seminar_point', description: '세미나 포인트 지급 상태 수동 갱신 (seminarId, [상태], [포인트])' },
  { command: 'check_advanced_seminars', description: '최근 2주 심화 세미나 포인트 일괄 확인 (방장 계정 기준)' },
  { command: 'point_exchange', description: '포인트교환 실행 (URL/guid, [횟수])' },
  { command: 'naverpay_point_exchange', description: '네이버페이포인트교환 실행' },
  { command: 'baemin_point_exchange', description: '배민포인트교환 실행' },
  { command: 'kakaopay_point_exchange', description: '카카오페이포인트교환 실행 (1만원)' },
  { command: 'kakaopay5k_point_exchange', description: '카카오페이 5천원권 교환 실행' },
  { command: 'kakaopay3k_point_exchange', description: '카카오페이 3천원권 교환 실행' },
  // 4. 시스템 & 관리
  { command: 'schedules', description: '스케줄된 작업 목록 확인' },
  { command: 'log', description: '최근 로그 확인' },
  { command: 'update_app', description: '앱 업데이트 (pnpm update:app)' },
  { command: 'inspect', description: '페이지 요소 검사' },
  // 5. 공지방 메시지 관리
  { command: 'channel_messages', description: '공지방 메시지 ID 목록 조회 [날짜]' },
  { command: 'help', description: '도움말' },
];

export const noticeCommands = [
  { command: 'settings', description: '알림 구독 항목 및 시간 설정 (/구독설정)' },
  { command: 'today_links', description: '오늘의 세미나/퀴즈/출석 링크 모음' },
  { command: 'intermd_quiz', description: '인터엠디 오늘의 퀴즈 정답 확인' },
  { command: 'seminar_detail', description: '세미나 번호로 상세 정보 조회' },
  { command: 'check_advanced_seminars', description: '최근 2주 심화 세미나 포인트 확인 (방장 계정 기준)' },
  { command: 'help', description: '도움말' },
];
