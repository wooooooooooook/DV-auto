**⚠️ 주의: 이 매크로 사용으로 인해 발생할 수 있는 어떠한 불이익(계정 정지, 서비스 이용 제한 등)에 대해서도 이 프로젝트는 책임지지 않습니다. 사용자 본인의 판단과 책임 하에 사용하시기 바랍니다.**

# 닥터빌(Doctorville) 자동화 매크로

이 프로젝트는 **데일리 루틴(`daily_routine`) 매크로만 자동 실행**하도록 고정되어 있습니다. GitHub Actions 등을 활용해 타사 사이트 인센티브를 획득할 목적으로 사용하면 서비스 이용 위반이 될 수 있으므로 절대 사용하지 마세요.

## 주요 기능
- 출석 체크 자동화
- 새로운 세미나 자동 신청
- 오늘의 세미나 목록 확인 및 텔레그램 알림
- 오늘의 브랜드 퀴즈 알림

## 🤖 텔레그램 봇 및 채팅 ID 설정 (선택 사항)

자동화 작업 중 발생하는 오류나 주요 정보를 텔레그램으로 알림 받고 싶다면, 아래 단계에 따라 봇을 생성하고 토큰 및 채팅 ID를 발급받아 `.env` 또는 환경 변수로 설정하세요.

1.  **텔레그램 봇 생성:**
    *   텔레그램에서 **[@BotFather](https://t.me/botfather)**를 검색하여 대화를 시작합니다.
    *   `/newbot` 명령어를 입력합니다.
    *   봇의 이름과 사용자 이름(username, `_bot`으로 끝나야 함)을 차례대로 입력합니다.
    *   생성이 완료되면, BotFather가 **API 토큰**을 알려줍니다. 이 토큰을 복사하여 `TELEGRAM_BOT_TOKEN` Secret 값으로 사용합니다.

2.  **텔레그램 채팅 ID 확인:**
    *   **BotFather**를 통해 발급받은 봇(`TELEGRAM_BOT_TOKEN`으로 설정할 봇)에게 메시지(아무 내용이나 가능)를 보냅니다.
    *   웹 브라우저에서 다음 URL에 접속합니다 (YOUR_BOT_TOKEN 부분에 발급받은 봇 토큰을 입력):
        `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
    *   접속 후 나타나는 JSON 응답에서 `result` 배열을 찾습니다. 그 안에 있는 `chat` 객체에서 `id` 값을 찾습니다. 이 `id` 값이 당신의 채팅 ID입니다.
    *   예시: `{"ok":true,"result":[{"update_id":...,"message":{"message_id":...,"from":{...},"chat":{"id":123456789,"first_name":...` 여기서 `123456789`가 채팅 ID입니다.
    *   이 ID를 복사하여 `TELEGRAM_CHAT_ID` Secret 값으로 사용합니다.

---

## 🛠️ 고급 사용자를 위한 로컬 실행

GitHub Actions를 사용하지 않고 로컬 환경에서 직접 스크립트를 실행하고자 하는 고급 사용자를 위한 가이드입니다.

### 사전 요구사항
이 스크립트를 로컬에서 사용하려면 컴퓨터에 아래 프로그램들이 설치되어 있어야 합니다.
-   [Node.js](https://nodejs.org/ko/) (Corepack 활성화로 pnpm 사용 권장: `corepack enable`)

### 1. 프로젝트 다운로드 및 설치
먼저, 프로젝트 파일을 컴퓨터로 다운로드하고 필요한 라이브러리를 설치합니다.

```bash
# 1. 프로젝트 저장소를 복제(clone)합니다.
git clone https://github.com/seia-soto/doctorville-auto.git

# 2. 프로젝트 폴더로 이동합니다.
cd doctorville-auto

# 3. 필요한 라이브러리를 설치합니다.
pnpm install

# 4. 자동화에 필요한 웹 브라우저 드라이버를 설치합니다.
npx playwright install
```

### 2. 환경 설정 파일(.env) 생성 및 설정
스크립트에 필요한 정보를 설정하는 단계입니다. 프로젝트 폴더에 `.env` 파일을 만들고 자격 증명 정보를 입력해야 합니다.

```bash
# .env.example 파일을 복사하여 .env 파일을 생성합니다.
cp .env.example .env
```
이제 생성된 `.env` 파일을 텍스트 편집기로 열고 아래 내용을 수정합니다.

#### **닥터빌 계정 정보 입력 (필수)**
`.env` 파일에 닥터빌 로그인에 필요한 아이디와 비밀번호를 입력합니다.

```env
# 닥터빌 아이디를 입력하세요.
DV_USER=your_doctorville_id

# 닥터빌 비밀번호를 입력하세요.
DV_PASS=your_doctorville_password

# ----------------------------------------------------
# 아래는 알림을 받기 위한 선택 사항입니다.
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
HEADLESS=true # 브라우저를 화면 없이 실행할지 여부를 설정 (true/false), 기본값은 true
```

텔레그램 알림 설정을 원하는 경우, 위 "텔레그램 봇 및 채팅 ID 설정 (선택 사항)" 섹션을 참고하여 토큰과 채팅 ID를 얻은 후 `.env` 파일에 추가하세요.

### 3. 스크립트 실행하기
모든 설정이 완료되었다면, 터미널에서 아래 명령어를 입력하여 매크로를 실행할 수 있습니다.

```bash
pnpm run build   # TypeScript를 dist/로 컴파일
pnpm start       # dist/core/main.js 실행
# 개발 중 즉시 실행하려면:
pnpm run dev     # ts-node src/core/main.ts
```

스크립트가 실행되면 터미널에 작업 진행 상황이 출력됩니다.
```
[info] 2024-xx-xxTxx:xx:xx.xxxZ Scheduled `daily_routine` at 0 2 * * * timezone= Asia/Seoul
[info] 2024-xx-xxTxx:xx:xx.xxxZ daily_routine: launching browser to perform daily tasks
[info] 2024-xx-xxTxx:xx:xx.xxxZ runTask start attendance
[info] 2024-xx-xxTxx:xx:xx.xxxZ runTask start apply_seminar
[info] 2024-xx-xxTxx:xx:xx.xxxZ runTask start today_links
[info] 2024-xx-xxTxx:xx:xx.xxxZ runTask start today_quiz
[info] 2024-xx-xxTxx:xx:xx.xxxZ daily_routine ... finished
```

오류가 발생하고 텔레그램 설정이 완료된 경우, 해당 봇을 통해 에러 메시지 알림을 받게 됩니다.
