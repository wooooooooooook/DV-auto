**⚠️ 주의: 이 매크로 사용으로 인해 발생할 수 있는 어떠한 불이익(계정 정지, 서비스 이용 제한 등)에 대해서도 이 프로젝트는 책임지지 않습니다. 사용자 본인의 판단과 책임 하에 사용하시기 바랍니다.**

# 닥터빌(Doctorville) 일일 매크로

이 프로젝트는 닥터빌 웹사이트의 일일 작업을 자동으로 수행해주는 간단한 Node.js 스크립트입니다. `macro.js` 파일을 실행하여 출석 체크, 세미나 신청, 오늘의 세미나 확인 등의 작업을 자동으로 처리할 수 있습니다.

## 주요 기능
-   출석 체크 자동화
-   새로운 세미나 자동 신청
-   오늘의 세미나 목록 확인

## 사전 요구사항
이 스크립트를 사용하려면 컴퓨터에 아래 프로그램들이 설치되어 있어야 합니다.
-   [Node.js](https://nodejs.org/ko/)
-   npm (Node.js 설치 시 함께 설치됩니다)

## ⚙️ 설치 및 설정 가이드

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

### 2. 환경 설정 파일(.env) 생성
스크립트에 필요한 정보를 설정하는 단계입니다. 프로젝트 폴더에 `.env` 파일을 만들고 자격 증명 정보를 입력해야 합니다.

```bash
# .env.example 파일을 복사하여 .env 파일을 생성합니다.
cp .env.example .env
```
이제 생성된 `.env` 파일을 텍스트 편집기로 열고 아래 내용을 수정합니다.

#### **1단계: 닥터빌 계정 정보 입력 (필수)**
`.env` 파일에 닥터빌 로그인에 필요한 아이디와 비밀번호를 입력합니다.

```env
# 닥터빌 아이디를 입력하세요.
ID=your_doctorville_id

# 닥터빌 비밀번호를 입력하세요.
PASS=your_doctorville_password

# ----------------------------------------------------
# 아래는 알림을 받기 위한 선택 사항입니다.
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

#### **2단계: 텔레그램 봇 생성 (선택 사항)**
자동화 작업 중 발생하는 오류나 주요 정보를 텔레그램으로 알림 받고 싶다면, 아래 단계에 따라 봇을 생성하고 토큰을 발급받으세요.

1.  텔레그램에서 **[@BotFather](https://t.me/botfather)**를 검색하여 대화를 시작합니다.
2.  `/newbot` 명령어를 입력합니다.
3.  봇의 이름과 사용자 이름(username)을 차례대로 입력합니다. (사용자 이름은 `_bot`으로 끝나야 합니다.)
4.  생성이 완료되면, BotFather가 아래와 같은 메시지와 함께 **API 토큰**을 알려줍니다. 이 토큰을 복사해두세요.
    > Use this token to access the HTTP API:  
    > `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`

#### **3단계: 텔레그램 채팅 ID 확인 (선택 사항)**
봇이 메시지를 보낼 대상, 즉 당신의 채팅 ID를 확인해야 합니다.

1.  텔레그램에서 **[@get_id_bot](https://t.me/get_id_bot)**을 검색하여 대화를 시작합니다.
2.  `/start` 명령어를 입력하면, 봇이 당신의 **채팅 ID**를 알려줍니다. 이 ID를 복사해두세요.

#### **4단계: 텔레그램 정보 .env 파일에 추가 (선택 사항)**
위에서 얻은 봇 토큰과 채팅 ID를 `.env` 파일에 추가합니다.

```env
# 닥터빌 아이디를 입력하세요.
ID=your_doctorville_id

# 닥터빌 비밀번호를 입력하세요.
PASS=your_doctorville_password

# BotFather로부터 발급받은 봇 토큰을 입력하세요.
TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11

# get_id_bot으로부터 확인한 채팅 ID를 입력하세요.
TELEGRAM_CHAT_ID=123456789
```

## ▶️ 스크립트 실행하기
모든 설정이 완료되었다면, 터미널에서 아래 명령어를 입력하여 매크로를 실행할 수 있습니다.

```bash
node macro.js
```

스크립트가 실행되면 터미널에 아래와 같이 작업 진행 상황이 출력됩니다.
```
macro.js: Starting daily routine.
macro.js: Running attendance task.
macro.js: attendance task completed successfully.
macro.js: Running apply_seminar task.
macro.js: apply_seminar task completed successfully.
macro.js: Running today_seminar_check task.
macro.js: today_seminar_check task completed successfully.
macro.js: Daily routine finished.
```

오류가 발생하고 텔레그램 설정이 완료된 경우, 해당 봇을 통해 에러 메시지 알림을 받게 됩니다.
