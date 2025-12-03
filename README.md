**⚠️ 주의: 이 매크로 사용으로 인해 발생할 수 있는 어떠한 불이익(계정 정지, 서비스 이용 제한 등)에 대해서도 이 프로젝트는 책임지지 않습니다. 사용자 본인의 판단과 책임 하에 사용하시기 바랍니다.**

# 닥터빌(Doctorville) 자동화 매크로

이 프로젝트는 닥터빌 웹사이트의 일일 작업을 자동으로 수행해주는 Node.js 기반의 스크립트입니다. GitHub Actions를 활용하여 클라우드 환경에서 정해진 시간에 닥터빌의 출석 체크, 세미나 신청, 오늘의 세미나 확인 등의 작업을 자동으로 처리할 수 있습니다.

## 주요 기능
-   출석 체크 자동화
-   새로운 세미나 자동 신청
-   오늘의 세미나 목록 확인 및 텔레그램 알림
-   오늘의 브랜드 퀴즈 알림

## 🚀 권장 설정: GitHub Actions를 이용한 자동화

이 프로젝트는 GitHub Actions를 통해 클라우드에서 자동으로 매크로를 실행하도록 설정하는 것을 권장합니다. 한 번 설정해두면 서버 없이도 매일 정해진 시간에 닥터빌 작업을 자동으로 처리할 수 있습니다.

### 1. 저장소 Fork

먼저 이 저장소를 본인의 GitHub 계정으로 Fork(포크)합니다. GitHub 페이지 오른쪽 상단의 `Fork` 버튼을 클릭하세요.

### 2. GitHub Secrets 설정

포크한 저장소에서 매크로 실행에 필요한 환경 변수들을 GitHub Secrets로 설정해야 합니다. 이 Secrets들은 `.env` 파일과 동일한 역할을 하지만, GitHub 환경에서 안전하게 관리됩니다.

1.  본인의 포크한 저장소로 이동합니다.
2.  상단 메뉴에서 `Settings` 탭을 클릭합니다.
3.  왼쪽 사이드바에서 `Secrets and variables` > `Actions`를 클릭합니다.
4.  `New repository secret` 버튼을 클릭하여 아래 Secrets들을 추가합니다:

    *   `DV_USER`: 닥터빌 로그인 아이디 (필수)
    *   `DV_PASS`: 닥터빌 로그인 비밀번호 (필수)
    *   `TELEGRAM_BOT_TOKEN`: 텔레그램 봇 토큰 (선택 사항)
    *   `TELEGRAM_CHAT_ID`: 텔레그램 알림을 받을 채팅 ID (선택 사항)

    **⚠️ 중요:** `DV_USER`와 `DV_PASS`는 반드시 설정해야 합니다. 텔레그램 알림 기능을 사용하려면 `TELEGRAM_BOT_TOKEN`과 `TELEGRAM_CHAT_ID`를 함께 설정해야 합니다. 텔레그램 봇 토큰 및 채팅 ID를 얻는 방법은 아래 "텔레그램 봇 및 채팅 ID 설정 (선택 사항)" 섹션을 참고하세요.

### 3. 워크플로우 실행 확인 및 스케줄 조정

Secrets 설정이 완료되면, GitHub Actions 워크플로우가 자동으로 활성화됩니다.

*   **스케줄:** 기본적으로 매일 UTC 자정(한국 시간 오전 9시)에 실행되도록 설정되어 있습니다. `.github/workflows/cron.yml` 파일에서 `cron: '0 0 * * *'` 부분을 수정하여 스케줄을 변경할 수 있습니다. (UTC 시간 기준, 한국 시간 -9시간)
*   **수동 실행:** GitHub 저장소의 `Actions` 탭으로 이동하여 `Run Macro` 워크플로우를 선택한 후 `Run workflow` 버튼을 클릭하여 수동으로 실행할 수도 있습니다.
*   **로그 확인:** `Actions` 탭에서 워크플로우 실행 결과를 클릭하여 자세한 로그를 확인할 수 있습니다.

이제 GitHub Actions를 통해 닥터빌 매크로를 자동으로 실행하고, 설정한 텔레그램 봇으로 알림을 받을 수 있습니다.

## 🤖 텔레그램 봇 및 채팅 ID 설정 (선택 사항)

자동화 작업 중 발생하는 오류나 주요 정보를 텔레그램으로 알림 받고 싶다면, 아래 단계에 따라 봇을 생성하고 토큰 및 채팅 ID를 발급받아 GitHub Secrets에 추가하세요.

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
-   [Node.js](https://nodejs.org/ko/) (npm은 Node.js 설치 시 함께 설치됩니다)

### 1. 프로젝트 다운로드 및 설치
먼저, 프로젝트 파일을 컴퓨터로 다운로드하고 필요한 라이브러리를 설치합니다.

```bash
# 1. 프로젝트 저장소를 복제(clone)합니다.
git clone https://github.com/seia-soto/doctorville-auto.git

# 2. 프로젝트 폴더로 이동합니다.
cd doctorville-auto

# 3. 필요한 라이브러리를 설치합니다.
npm install

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
node main.js
```

스크립트가 실행되면 터미널에 작업 진행 상황이 출력됩니다.
```
main.js: Starting daily routine.
main.js: Running attendance task.
main.js: attendance task completed successfully.
main.js: Running apply_seminar task.
main.js: apply_seminar task completed successfully.
main.js: Running today_links task.
main.js: today_links task completed successfully.
main.js: Daily routine finished.
```

오류가 발생하고 텔레그램 설정이 완료된 경우, 해당 봇을 통해 에러 메시지 알림을 받게 됩니다.
