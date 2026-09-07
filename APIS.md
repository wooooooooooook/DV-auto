# DoctorVille Auto (DV-auto) API 명세 및 사용 목록 문서

본 문서는 `DV-auto` 프로젝트에서 호출 및 활용하는 모든 내부/외부 HTTP API, 웹 엔드포인트 및 연동 서비스 목록을 체계적으로 정리한 문서입니다.

---

## 1. 개요 및 통신 방식

### 1.1 인증 메커니즘 (Session & Cookie)
- **저장소**: 로컬 `cookies.json` 파일에 저장된 Playwright 세션 쿠키를 기반으로 통신합니다.
- **쿠키 필터링 및 헤더 주입**: `src/modules/http_client.ts`의 `sendDoctorVilleRequest`에서 대상 URL 도메인(`*.doctorville.co.kr` 등) 및 경로와 만료 시점을 확인하여 `Cookie` 헤더를 자동 구성합니다.
- **세션 만료 감지**: 응답 본문에 로그인 리다이렉트 HTML 또는 JSON 응답 내 `code: 401` / `AUTH_EXPIRED`가 감지되면 세션 만료로 판정하고 재로그인을 유도합니다.

### 1.2 HTTP 클라이언트 (`undici`)
- `src/modules/http_client.ts`: Node.js 고성능 HTTP 클라이언트인 `undici`의 `request` 메서드를 사용하여 HTTP 요청을 수행합니다.
- 리다이렉트(301, 302, 303, 307, 308)를 RFC 7231 규격에 맞춰 자동 추적합니다.

---

## 2. 닥터빌 모바일 API (`m-api.doctorville.co.kr`)

### 2.1 메인 미래 세미나 목록 조회
- **Method / URL**: `GET https://m-api.doctorville.co.kr/api/mw/seminars/mainFuture`
- **호출 위치**: `src/modules/seminar_api.ts` (`fetchMainFutureSeminars`)
- **주요 사용 태스크**: `apply_seminar`, `today_links`, `check_advanced_seminars`
- **헤더**:
  - `Accept`: `application/json, text/plain, */*`
  - `Referer`: `https://m.doctorville.co.kr/`
- **주요 응답 데이터**:
  - `futureSeminarList.items[]`: 세미나 목록 배열
    - `seminarId`: 세미나 ID (number/string)
    - `seminarNm`: 세미나 제목
    - `startDt`, `endDt`: 세미나 시작 및 종료 일시 (예: `2026-08-24 13:00:00`)
    - `maxPeopleCnt`: 정원
    - `applyCnt`: 현재 신청 인원
    - `processState`: 세미나 진행 상태 코드
    - `useDepthSurvey`: 심화 설문 여부 (`Y` / `N`)
    - `intro`: 세미나 소개글 (포인트 미지급 문구 포함 여부 검사용)

---

### 2.2 세미나 상세 정보 조회
- **Method / URL**: `GET https://m-api.doctorville.co.kr/api/mw/seminars/{seminarId}`
- **호출 위치**: `src/modules/seminar_api.ts` (`fetchSeminarDetail`), `src/tasks/seminar_detail.ts`
- **주요 사용 태스크**: `seminar_detail`, `apply_seminar`, `monitor_seminars`, `today_links`
- **헤더**:
  - `Accept`: `application/json, text/plain, */*`
  - `Referer`: `https://m.doctorville.co.kr/`
- **주요 응답 데이터**:
  - `seminarDetail`: 세미나 기본 정보, 강사(`tutorNm`), 진료과(`diseaseCategoryNm`), VOD 여부(`useVod`)
  - `seminarMember`: 회원의 신청/입장 이력 (`joinDt`, `applyTy`, `surveyApplyTy`)
  - `survey`: 설문 및 퀴즈 정보 (`surveyId`, `point`, `hasQuiz`, `useTy`)
  - `surveyState`: 설문 상태 코드 (1: 진행중, 2: 완료, 3: 마감, 5: 미오픈)
  - `termsInfo`: 세미나 필수/선택 약관 정보 (`termsOptionsModels`)

---

### 2.3 세미나 라이브 방송 입장 권한 조회
- **Method / URL**: `GET https://m-api.doctorville.co.kr/api/mw/seminars/{seminarId}/attend`
- **호출 위치**: `src/modules/seminar_api.ts` (`attendSeminarApi`)
- **주요 사용 태스크**: `monitor_seminars` (세미나 라이브 시작 시 1차 순수 HTTP 자동 입장 시도)
- **헤더**:
  - `Accept`: `application/json, text/plain, */*`
  - `Referer`: `https://m.doctorville.co.kr/cme/seminar/attend?seminarId={seminarId}&channel={channel}`
  - `Origin`: `https://m.doctorville.co.kr`
- **주요 응답 데이터**:
  ```json
  {
    "accessAllowed": true,
    "seminarInfo": {
      "seminarId": 5585,
      "seminarNm": "세미나명",
      "broadcastUrl": "...",
      "chattingRoom": "..."
    }
  }
  ```
- **설명**: 모바일 세미나 입장 페이지 진입 시 호출되는 핵심 API로, 회원의 입장 자격 및 방송 스트림 정보를 조회합니다.

---

### 2.4 시청 세션 발급 / 확인 (UAS Session)
- **Method / URL**: `GET https://m-api.doctorville.co.kr/api/mw/uas/session`
- **호출 위치**: `src/modules/seminar_api.ts` (`attendSeminarApi`)
- **주요 사용 태스크**: `monitor_seminars`
- **헤더**:
  - `Accept`: `application/json, text/plain, */*`
  - `Referer`: `https://m.doctorville.co.kr/cme/seminar/attend?seminarId={seminarId}&channel={channel}`
- **주요 응답 데이터**:
  ```json
  {
    "response_no": "100",
    "sessionKey": "b286114e-2c8e-4767-9141-507acb484cc1",
    "response_msg": "성공"
  }
  ```

---

### 2.5 시청 활동 기록 (UAS Activity)
- **Method / URL**: `GET https://m-api.doctorville.co.kr/api/mw/uas/activity/{seminarId}?contentType=LIVE{channel}`
- **호출 위치**: `src/modules/seminar_api.ts` (`attendSeminarApi`)
- **주요 사용 태스크**: `monitor_seminars`
- **헤더**:
  - `Accept`: `application/json, text/plain, */*`
  - `Referer`: `https://m.doctorville.co.kr/cme/seminar/attend?seminarId={seminarId}&channel={channel}`
- **주요 응답 데이터**:
  ```json
  {
    "response_no": "100",
    "activityKey": "8ad5926e-d6b5-4599-ba85-51fb2a17b6c9"
  }
  ```
- **설명**: 라이브 방송 시청 출석 및 활동 로그를 기록합니다 (`contentType`: `LIVE1` 또는 `LIVE2`).

---

### 2.6 세미나 약관 동의 제출
- **Method / URL**: `POST https://m-api.doctorville.co.kr/api/mw/seminar/terms-info`
- **호출 위치**: `src/modules/seminar_api.ts` (`submitSeminarTermsAgree`)
- **주요 사용 태스크**: `apply_seminar` (세미나 신청 전 선행 동의)
- **헤더**:
  - `Content-Type`: `application/json`
  - `Referer`: `https://m.doctorville.co.kr/cme/seminar/{seminarId}`
  - `Origin`: `https://m.doctorville.co.kr`
- **요청 Body (JSON)**:
  ```json
  {
    "seminarId": 5566,
    "agreedTermsOptionsIdList": [101, 102]
  }
  ```
- **설명**: 약관 항목 중 `(선택)`이 포함되지 않은 필수 약관 옵션 ID 목록을 전송하여 동의 처리합니다.

---

### 2.7 회원 포인트 조회
- **Method / URL**: `GET https://m-api.doctorville.co.kr/api/mw/my/point`
- **호출 위치**: `src/tasks/check_point.ts` (`getPoint`)
- **주요 사용 태스크**: `check_point`, `baemin_point_exchange`, `naverpay_point_exchange`
- **헤더**:
  - `Accept`: `application/json, text/plain, */*`
- **주요 응답 데이터**:
  ```json
  {
    "pointInfo": {
      "usn": 123456,
      "savePoint": 15000,
      "chargePoint": 0,
      "extinctionPoint": 0,
      "totalPoint": 15000
    }
  }
  ```

---

### 2.8 포인트 사용/적립 내역 조회
- **Method / URL**: `GET https://m-api.doctorville.co.kr/api/mw/my/point/histories/use?page={page}&pageSize={pageSize}&startDt={YY-MM-DD}&endDt={YY-MM-DD}`
- **호출 위치**: `src/tasks/check_seminar_point.ts` (`searchSeminarPoints`)
- **주요 사용 태스크**: `check_seminar_point`, `apply_seminar`
- **헤더**:
  - `Accept`: `application/json, text/plain, */*`
- **주요 응답 데이터**:
  - `list.items[]`: 포인트 적립 및 사용 내역 목록
    - `point`: 변동 포인트 금액
    - `pointUseTypeNm`: `'적립'` 또는 `'사용'`
    - `pointUseServiceNm`: 서비스명 (예: `'라이브세미나'`, `'닥터빌'`)
    - `pathNm`: 적립 상세 내용 (예: `'8/14 설문 포인트 5544'`)
    - `pathSeq`: 관련 고유 번호 (세미나 ID 등 매칭에 활용)
    - `regDt`: 처리 일시

---

### 2.9 세미나 설문 URL 발급
- **Method / URL**: `GET https://m-api.doctorville.co.kr/api/mw/seminars/{seminarId}/survey-url`
- **호출 위치**: `src/modules/seminar_survey_api.ts` (`fetchSeminarSurveyQuizHttp`)
- **주요 사용 태스크**: `seminar_quiz`, `monitor_seminars`
- **헤더**:
  - `Accept`: `application/json, text/plain, */*`
  - `Referer`: `https://m.doctorville.co.kr/cme/seminar/{seminarId}`
- **주요 응답 데이터**:
  ```json
  {
    "surveyUrl": "https://survey.villeway.com/s/c/{companyToken}/u/{secureToken}"
  }
  ```
- **설명**: 해당 세미나의 Villeway 설문 페이지 접속용 고유 토큰이 포함된 URL을 조회합니다.

---

## 3. 닥터빌 코어 API (`api.doctorville.co.kr`)

### 3.1 세미나 수강 신청
- **Method / URL**: `POST https://api.doctorville.co.kr/api/seminars/apply`
- **호출 위치**: `src/modules/seminar_api.ts` (`applySeminarApi`)
- **주요 사용 태스크**: `apply_seminar`
- **헤더**:
  - `Content-Type`: `application/json`
  - `Referer`: `https://m.doctorville.co.kr/cme/seminar/{seminarId}`
  - `Origin`: `https://m.doctorville.co.kr`
- **요청 Body (JSON)**:
  ```json
  {
    "seminarId": 5566
  }
  ```
- **응답 검증**: 신청 API 호출 후 상세 조회 API(`fetchSeminarDetail`)를 재호출하여 `processState`가 취소 가능/입장 가능 상태로 변경되었는지 최종 검증합니다.

---

### 3.2 출석체크 현황 조회
- **Method / URL**: `GET https://api.doctorville.co.kr/api/attend-event`
- **호출 위치**: `src/tasks/attendance.ts` (`run`)
- **헤더**:
  - `Accept`: `application/json, text/plain, */*`
- **주요 응답 데이터**:
  ```json
  {
    "data": {
      "today": "2026-08-26",
      "attendedLog": [
        { "attendedDate": "2026-08-25", "point": 100 }
      ]
    }
  }
  ```

---

### 3.3 출석체크 참여 실행
- **Method / URL**: `POST https://api.doctorville.co.kr/api/attend-event`
- **호출 위치**: `src/tasks/attendance.ts` (`run`)
- **헤더**:
  - `Content-Type`: `application/json`
  - `Accept`: `application/json, text/plain, */*`
- **설명**: 오늘 출석 기록이 없을 때만 POST 요청을 보내어 당일 출석 체크를 수행합니다.

---

### 3.4 포인트 전환 가능 여부 확인
- **Method / URL**: `GET https://api.doctorville.co.kr/api/point/conversion/availability`
- **호출 위치**: `src/modules/utils.ts` (`getPointConversionAvailabilityHttp`), `src/tasks/today_links.ts`
- **헤더**:
  - `Accept`: `application/json, text/plain, */*`
- **주요 응답 데이터**:
  ```json
  {
    "data": {
      "available": true,
      "availablePlannedAt": "09:00",
      "meridiem": "AM"
    }
  }
  ```

---

### 3.5 오늘의 퀴즈 조회 (`/api/product-quiz/{quizId}`)
- **Method / URL**: `GET https://api.doctorville.co.kr/api/product-quiz/{quizId}?_={timestamp}`
- **호출 위치**: `src/modules/quiz_api.ts` (`fetchProductQuizApi`, `getTodayVerifiedQuizAnswers`)
- **주요 사용 태스크**: `today_quiz`, `today_links`
- **헤더**:
  - `Accept`: `application/json, text/plain, */*`
  - `Referer`: `https://www.doctorville.co.kr/product/productView?pId={pId}`
- **주요 응답 데이터**:
  ```json
  {
    "timestamp": "2026-09-07 13:49:14",
    "data": {
      "quizId": 3604,
      "quizNm": "에빅사",
      "point": 500,
      "useSt": "Y",
      "startDt": "2026-09-07",
      "endDt": "2026-09-07",
      "pid": 138,
      "questionList": [
        {
          "questionId": 9932,
          "quizId": 3604,
          "questionNm": "문제 지문 텍스트",
          "answerInfo": "O$X",
          "answerNum": 1,
          "answerExplanation": "정답 해설"
        }
      ]
    },
    "error": null
  }
  ```
- **설명**: 퀴즈 상세 페이지 인라인 스크립트에서 추출한 `quizId`로 직접 조회하여 당일 퀴즈 문항, 보기 및 검증된 정답을 획득합니다. 당일 최초 1회 조회 후 로컬 캐시(`storage`)에 보관되어 재사용됩니다.

---

## 4. 닥터빌 웹 스크래핑 및 HTML Form 엔드포인트

| URL | Method / 방식 | 주요 용도 | 사용 모듈 |
| :--- | :--- | :--- | :--- |
| `https://m.doctorville.co.kr/mypage/info` | `GET` (HTTP / Playwright) | 로그인 세션 검증 (회원정보수정 버튼 유무 확인) | `utils.ts` |
| `https://www.doctorville.co.kr/my/point/pointUseHistoryList` | `POST` (Form `x-www-form-urlencoded`) | 포인트 적립내역 조회 (JSON API 장애 시 폴백) | `check_seminar_point.ts` |
| `https://www.doctorville.co.kr/seminar/main` | `GET` (HTML 파싱) | PC 웹 세미나 메인 목록 파싱 (기존 방식 호환) | `apply_seminar.ts`, `today_links.ts` |
| `https://www.doctorville.co.kr/product/medicineList` | `GET` (Playwright / Cheerio) | 오늘의 퀴즈 대상 의약품 목록 조회 | `today_quiz.ts`, `today_links.ts` |
| `https://www.doctorville.co.kr/product/instrumentList` | `GET` (Playwright / Cheerio) | 오늘의 퀴즈 대상 의료기기 목록 조회 | `today_quiz.ts`, `today_links.ts` |
| `https://m.doctorville.co.kr/cme/seminar/{seminarId}` | `GET` (Playwright) | 세미나 라이브 방송 입장, 실시간 퀴즈 및 설문 응답 | `seminar_quiz.ts`, `run_seminar_quiz.ts` |
| `https://www.doctorville.co.kr/entertainment/main` | `GET` (Playwright) | 엠서클 비즈마켓 포인트몰 브릿지 이동 | `baemin_point_exchange.ts`, `naverpay_point_exchange.ts` |

---

## 5. 외부 연동 시스템 및 서드파티 API

### 5.1 엠서클 SSO 로그인 (`mims-account.mcircle.co.kr`)
- **URL**: `https://mims-account.mcircle.co.kr/login?cb=https://www.doctorville.co.kr/mims/directLogin`
- **방식**: Playwright 브라우저 자동화
- **설명**: `DV_USER`, `DV_PASS` 계정 정보로 로그인 폼을 채우고 제출하여 닥터빌 통합 세션 쿠키를 획득합니다.

### 5.2 엠서클 비즈마켓 B2B 상품권 교환 (`mcircle.bizmarketb2b.com`)
- **배달의민족 상품권 교환 URL**: `https://mcircle.bizmarketb2b.com/Goods/Content.aspx?guid=14152303&catecode=14592&eventuid=21006`
- **네이버페이 상품권 교환 URL**: `https://mcircle.bizmarketb2b.com/Goods/Content.aspx?guid=14131415&catecode=14592`
- **방식**: Playwright 자동화
- **설명**: 바로구매 클릭 -> 수령인 정보(`USER_NAME`, `USER_PHONE_*`) 입력 -> 포인트 전액 결제 체크 -> 결제 완료 확인

### 5.3 텔레그램 Bot API (`api.telegram.org` / `Telegraf`)
- **Admin Bot (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`)**:
  - 관리자 전용 대화형 명령어 수신 (`/status`, `/run`, `/today_links`, `/point`, `/seminar_detail`, `/cookies`, `/logs` 등)
  - 시스템 예외, 세션 만료, 태스크 실행 결과 통지
- **Notice Bot (`NOTICE_BOT_TOKEN`, `TELEGRAM_CHANNEL_ID`)**:
  - 신규 세미나 감지 및 정보 변경 브로드캐스팅
  - 매일 오늘의 퀴즈 및 세미나 링크 요약 발송 (`today_links`)
  - 포인트 지급 내역 알림
  - 인터엠디 퀴즈 알림 구독 및 발송

### 5.4 인터엠디 API (`https://www.intermd.co.kr`)
- **로그인 (`/login/login.do`)**:
  - `POST https://www.intermd.co.kr/login/login.do` (Form `x-www-form-urlencoded`)
  - 파라미터: `loginId`, `loginPassword`
- **세션 검증 (`/login/getSession.do`)**:
  - `GET https://www.intermd.co.kr/login/getSession.do`
  - 세션 유지 및 로그인 회원 정보(`memberInfo`, `sessionKey`) 확인
- **오늘의 퀴즈 조회 (`/quiz/getTodayQuiz.do`)**:
  - `POST https://www.intermd.co.kr/quiz/getTodayQuiz.do`
  - 당일 출제된 퀴즈의 `quizCd`, `title`, `dateText` 확인
- **퀴즈 상세 조회 (`/quiz/getQuiz.do`)**:
  - `POST https://www.intermd.co.kr/quiz/getQuiz.do` (`quizCd={quizCd}`)
  - 퀴즈 참여 여부(`userJoinCheck`), 설문 질문 코드(`quesCd`), 힌트(`hint`), 정답 해설(`guide`) 조회
- **선택지 및 정답 조회 (`/poll/getQuesItemInfo.do`)**:
  - `POST https://www.intermd.co.kr/poll/getQuesItemInfo.do` (`quesCd={quesCd}`)
  - 문항별 선택지 목록 및 정답 여부(`quesItemTitleAdd === 'Y'`) 식별
- **정답 제출 (`/quiz/saveAjax.do`)**:
  - `POST https://www.intermd.co.kr/quiz/saveAjax.do`
  - 파라미터: `quizCd`, `quesCd`, `quesItemCd`, `replyText`

### 5.5 키메디 API (`https://api.keymedi.com/api`)
- **공통 헤더**:
  - `Content-Type`: `application/json`
  - `AccessToken`: `eab08ef6278eb83448b1e12db0e33c18897060532e8425c3e2faee334e2d5ec19de474d1eee1dc621a0f223eefbf515804b7de28b4cb0d355dd498950e16ced7`
  - `Authorization`: `Bearer <access_token>` (인증 필요 요청 시)
- **로그인 (`/auth/login`)**:
  - `POST https://api.keymedi.com/api/auth/login`
  - Body: `{"uid": "<KEYMEDI_USER>", "password": "<KEYMEDI_PASS>", "remember": false}`
  - 응답: JWT 토큰 (`data.token.access_token`) 및 회원 기본 정보
- **출석 캘린더 현황 조회 (`/member/attendanceCalendar`)**:
  - `POST https://api.keymedi.com/api/member/attendanceCalendar`
  - 응답: `current_date`, 당월 출석 목록(`attendance: [{point, day, accumulate}]`), 누적 출석일(`count_attendance`)
- **출석체크 실행 (`/member/attendanceAdd`)**:
  - `POST https://api.keymedi.com/api/member/attendanceAdd`
  - 응답: 성공 시 `code: 0` (`data.point`), 이미 완료 시 `code: 1601` (`이미 출석 하였습니다.`)
- **내 정보 및 포인트 조회 (`/member/getMyInfo`)**:
  - `POST https://api.keymedi.com/api/member/getMyInfo`
  - 응답: 회원명, 전문과, 보유 포인트(`point_balance`, `total_point`)
- **설문 상단 요약 정보 조회 (`/survey/surveyTopInfo`)**:
  - `POST https://api.keymedi.com/api/survey/surveyTopInfo`
  - 응답: `possible_cnt`(참여가능 설문 수), `acquire_point`(획득가능 총 포인트)
- **설문 목록 조회 (`/survey/surveyList`)**:
  - `POST https://api.keymedi.com/api/survey/surveyList`
  - 파라미터: `type: "general"`, `page`, `per_page`
  - 응답: 설문 목록 (`idx`, `title`, `gift_point`, `vote_status`, `people_closed_status`, `medical_part`, `end_at` 등)
- **투표 목록 조회 (`/survey/voteList`)**:
  - `POST https://api.keymedi.com/api/survey/voteList`
  - 파라미터: `banner_location: "survey_pc"`, `banner_type: "survey_vote"`, `page`, `per_page`
  - 응답: 투표 목록 (`idx`, `title`, `gift_point`, `vote_status`, `medical_part`, `end_at` 등)

### 5.6 HMP API (`https://www.hmp.co.kr`)
- **인증 방식**: 세션 쿠키 기반 (`JSESSIONID`, `WMONID`, `MEM_ID`, `MEM_GBN`, `userId` 등)
- **로그인 폼 세션 발급 (`/login/loginForm.hm`)**:
  - `GET https://www.hmp.co.kr/login/loginForm.hm`
  - 초기 세션 쿠키 획득
- **로그인 인증 처리 (`/login/loginProcess.hm`)**:
  - `POST https://www.hmp.co.kr/login/loginProcess.hm` (Form `x-www-form-urlencoded`)
  - 파라미터: `memId`, `passwd`, `systemNm: "prod"`, `searchFlag: "id"`
  - 리다이렉트(`302 Found`) 및 회원 인증 쿠키 발급
- **사용자 정보 및 보유 캡슐 조회 (`/ajax/main/userInfo.hm`)**:
  - `POST https://www.hmp.co.kr/ajax/main/userInfo.hm`
  - 헤더: `X-Requested-With: XMLHttpRequest`
  - 응답: `knowCommUserInfo` (닉네임, 등급 등), `myBnftValList` (`bnftGbn === "POINT"`의 `remanPnt`가 보유 캡슐 수량)
- **출석체크 파라미터 조회 (`/event/attendanceRouletteMain.hm`)**:
  - `GET https://www.hmp.co.kr/event/attendanceRouletteMain.hm?attendMain=Y`
  - HTML 파싱: `cntntCd`, `cntntSeq`, `pointTitle`, `capsule10`, `loginCount`, 당일 수령 여부
- **출석체크 캡슐 받기 실행 (`/ajax/event/capsuleHist.hm`)**:
  - `POST https://www.hmp.co.kr/ajax/event/capsuleHist.hm` (Form `x-www-form-urlencoded`)
  - 파라미터: `cntntCd`, `cntntSeq`, `pointTitle`, `bizGbn`, `seq`
  - 응답: 성공 시 `{ "code": "800" }` (+10 캡슐 적립), 이미 완료 시 `{ "message": "1." }`

---

### 5.7 빌웨이 설문/퀴즈 API (`https://survey.villeway.com/data/v1`)
- **공통 인증 헤더**: `Authorization: Bearer <accessToken>` (인증 이후 모든 요청)
- **인증 토큰 발급 (`/auth/authenticate-via-client`)**:
  - `POST https://survey.villeway.com/data/v1/auth/authenticate-via-client`
  - Body: `{"type": "c", "secureToken": "<secureToken>"}`
  - 응답: `accessToken` (JWT), `refreshToken`
- **설문 전체 메타데이터 조회 (`/user/survey-detail`)**:
  - `GET https://survey.villeway.com/data/v1/user/survey-detail`
  - 응답: `config` (제목, 시작/종료일, 약관 등), `pageCnt` (총 페이지 수), `questionCnt` (총 문항 수), `pages[]`
- **페이지별 문항 상세 조회 (`/user/survey-page/{pageNumber}`)**:
  - `GET https://survey.villeway.com/data/v1/user/survey-page/{pageNumber}` (`1` ~ `pageCnt`)
  - 응답: `id` (pageId), `pageNumber`, `questions[]` (`id`, `subject`, `type.key`: `QUIZ_MULTIPLE_CHOICE` 등, `options[]`)
- **페이지별 답변 저장 (`/user/save-user-response-new`)**:
  - `POST https://survey.villeway.com/data/v1/user/save-user-response-new`
  - Body: `{"pageId": <pageId>, "userQuestions": [{"questionId": <id>, "optionIds": [<optionId>], "active": true}]}`
- **설문 최종 제출 (`/user/submit`)**:
  - `POST https://survey.villeway.com/data/v1/user/submit`
  - Body: `{}`
  - 응답: `isQuizPassed` (통과 여부), `quizCnt` (퀴즈 총 문항 수), `correctCnt` (정답 수), `quizPoint` (지급 포인트)

---

### 5.8 닥플 플러스 API (`https://docple-plus.com`)
- **공통 인증 헤더**: `Authorization: Bearer <accessToken>`
- **통합 로그인 (`/api/season2/auth/login`)**:
  - `POST https://docple-plus.com/api/season2/auth/login`
  - Body: `{"id": "<DOCPLE_USER>", "password": "<DOCPLE_PASS>"}`
  - 응답: `accessToken`, `refreshToken`, `joinType`, `uid`
- **토큰 갱신 (`/api/season2/auth/token/refresh`)**:
  - `POST https://docple-plus.com/api/season2/auth/token/refresh`
  - Header: `Refresh-Token: <refreshToken>`
- **회원 정보/프로필 및 보유 캐시 조회 (`/api/season2/users/info`)**:
  - `GET https://docple-plus.com/api/season2/users/info`
  - 응답: `data: { "name": "...", "joinType": "DOCTOR", "myCash": 5100, ... }`
- **최근 캐시 적립 내역 조회 (`/api/season2/cash/recent`)**:
  - `GET https://docple-plus.com/api/season2/cash/recent`
  - 응답: `data: [ { "type": "...", "date": "YYYY-MM-DD", "cash": 10 } ]`
- **출석 캘린더 조회 (`/api/season2/mission/attendance/calendar`)**:
  - `GET https://docple-plus.com/api/season2/mission/attendance/calendar`
  - 응답: `data: { "attendedDates": ["2026-09-07"], "monthCount": 1, ... }` (오늘 KST 날짜 포함 여부로 당일 출석 여부 판별)
- **출석체크 수행 (`/api/season2/mission/attendance/check`)**:
  - `POST https://docple-plus.com/api/season2/mission/attendance/check`
  - 응답: `data: { "todayDone": true, "dailyGranted": true, "dailyCash": 50 }`
- **e-디테일링 의약품 목록 (`/api/season2/e-detailing/medicines`)**:
  - `GET https://docple-plus.com/api/season2/e-detailing/medicines?page=0&size=50`
  - 응답: `data: { "content": [ { "id": 3, "medicineName": "아르시스주", "hasActiveQuiz": true, ... } ] }`
  - 상세 퀴즈 URL: `https://docple-plus.com/e-detailing/{id}`
- **e-디테일링 활성 퀴즈 목록 (`/api/season2/e-detailing/quiz`)**:
  - `GET https://docple-plus.com/api/season2/e-detailing/quiz`
  - 응답: `data: { "quizzes": [ { "quizId": 49, "quizName": "...", "rewardCash": 100, "medicineId": 3, ... } ] }`
- **e-디테일링 퀴즈 상세/문제/보기 조회 (`/api/season2/e-detailing/quiz/{quizId}`)**:
  - `GET https://docple-plus.com/api/season2/e-detailing/quiz/{quizId}`
  - 응답: `data: { "quizId": 49, "remainingAttempts": 3, "questions": [ { "questionId": 133, "questionText": "...", "options": [ { "optionId": 368, "optionText": "..." } ] } ] }`
- **e-디테일링 의약품 상세/성분/설명 조회 (`/api/season2/e-detailing/medicines/{medicineId}`)**:
  - `GET https://docple-plus.com/api/season2/e-detailing/medicines/{medicineId}`
  - 응답: `data: { "id": 3, "medicineName": "아르시스주", "mainIngredient": "L-아르기닌염산염", "therapeuticCategory": "...", ... }`
- **e-디테일링 퀴즈 정답 제출 (`/api/season2/e-detailing/quiz/{quizId}/submit`)**:
  - `POST https://docple-plus.com/api/season2/e-detailing/quiz/{quizId}/submit`
  - Body: `{"answers": [{"questionId": 133, "selectedOptionId": 369}]}`
  - 응답: `data: { "isPassed": true, "isCashGranted": true, "grantedCash": 100, "remainingAttempts": 2 }`
- **커뮤니티 비밀번호 인증 (`/api/auth/communityLogin`)**:
  - `POST https://docple-plus.com/api/auth/communityLogin`
  - Body: `{"pw": "<DOCPLE_COMM_PASS || DOCPLE_PASS>", "ispc": "P"}`
  - 응답: `resultCode === "0"`, `result: { "communityToken": "<JWT>" }`
- **커뮤니티 게시글 목록 (`/api/community/list`)**:
  - `POST https://docple-plus.com/api/community/list`
  - Header: `communityToken: <communityToken>`, `Cookie: communityToken=<communityToken>; accessToken=<accessToken>`
  - Body: `{"grpCode": "NI", "subCode": "", "page": 1, "size": 25}`
  - 응답: `result: { "communityList": [ { "bid": 2032652, "no": 100136914, "title": "...", "noticeYN": "N", "useYN": "Y", "reCom": "N", ... } ] }`
- **커뮤니티 게시글 추천 (`/api/board/recommend`)**:
  - `POST https://docple-plus.com/api/board/recommend`
  - Header: `communityToken: <communityToken>`, `Cookie: communityToken=<communityToken>; accessToken=<accessToken>`
  - Body: `{"kind": "W", "bid": "<bid>", "yesNo": "Y", "grpCode": "NI", "ispc": "P", "no": <no>}`
  - 응답: `resultCode === "0"`, `result: { "cashGrantInfo": { "rewarded": true, "cashAmount": 10 } }`

---

## 6. 주요 상태 코드 및 Enum 정리

### 6.1 세미나 진행 상태 (`ProcessState`)
| 코드 | 상수명 | 설명 |
| :---: | :--- | :--- |
| `1` | `PROCESS_ENTER` | 입장하기 (라이브 방송 입장 가능) |
| `2` | `PROCESS_APPLY` | 신청하기 (신청 필요 / 신청 가능) |
| `3` | `PROCESS_CANCEL` | 신청취소 (신청 완료 상태) |
| `4` | `PROCESS_PREPARING` | 방송 준비 중 / 대기 중 |
| `5` | `PROCESS_EXCESS` | 신청마감 (정원 초과) |
| `6` | `PROCESS_STARTED` | 방송 진행 중 (OnAir) |
| `7` | `PROCESS_END` | 방송 종료 |
| `8` | `PROCESS_COMPLETED` | 세미나 진행 완료 |

### 6.2 설문 상태 (`SurveyState`)
| 코드 | 상수명 | 설명 |
| :---: | :--- | :--- |
| `1` | `SURVEY_PROGRESS` | 설문 진행 중 (참여 가능) |
| `2` | `SURVEY_COMPLETED` | 설문 참여 완료 |
| `3` | `SURVEY_CLOSED` | 설문 마감 / 미제공 / 대상 아님 |
| `5` | `SURVEY_UNOPENED` | 설문 미오픈 (진행 예정 / 설문 없음) |

