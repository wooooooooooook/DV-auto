/**
 * 메디게이트 실시간(On-Air) 심포지움 상태 및 시청 URL 조회 헬퍼 스크립트
 * 
 * 실행 방법:
 *   node scripts/inspect_medigate_live.mjs [webinarIdx]
 */

import dotenv from 'dotenv';
import { MedigateClient } from '../dist/modules/medigate_api.js';

dotenv.config();

async function main() {
  const user = process.env.MEDIGATE_USER;
  const pass = process.env.MEDIGATE_PASS;

  if (!user || !pass) {
    console.error('❌ .env에 MEDIGATE_USER 또는 MEDIGATE_PASS가 설정되어 있지 않습니다.');
    process.exit(1);
  }

  const client = new MedigateClient();
  const loginRes = await client.login(user, pass);
  if (!loginRes.success) {
    console.error('❌ 로그인 실패:', loginRes.message);
    process.exit(1);
  }

  const targetIdx = process.argv[2] ? parseInt(process.argv[2], 10) : null;

  if (targetIdx) {
    console.log(`\n🔍 지정된 심포지움 [Idx: ${targetIdx}] 분석 중...`);
    const detail = await client.getSymposiumDetail(targetIdx);
    if (!detail) {
      console.error('❌ 심포지움 상세 정보를 가져올 수 없습니다.');
      return;
    }

    console.log(`- 제목: ${detail.webinar.subject}`);
    console.log(`- 상태: ${detail.webinar.status}`);
    console.log(`- 일시: ${detail.webinar.dateDesc || detail.webinar.startDate}`);
    console.log(`- 신청 여부: ${detail.applyInfo?.applyFlag}`);

    console.log(`\n🎥 시청 URL 발급 시도...`);
    const watchRes = await client.getSymposiumWatchUrl(targetIdx);
    if (watchRes.success && watchRes.watchUrl) {
      console.log(`✅ [성공] 시청 URL 발급 완료:`);
      console.log(`🔗 URL: ${watchRes.watchUrl}\n`);
      console.log(`💡 이 URL을 브라우저 개발자 도구(F12 Network 탭)와 함께 열어서 웹소켓 또는 Heartbeat 요청을 분석하세요.`);
    } else {
      console.log(`⚠️ 시청 불가: ${watchRes.message || '현재 방송 진행 중이 아닙니다.'}`);
    }
    return;
  }

  console.log(`\n📋 전체 심포지움 목록 검사 중...`);
  const list = await client.getSymposiumList();
  console.log(`총 ${list.length}개의 심포지움 확인.`);

  const onAirItems = list.filter(item => item.status === 'ING');
  console.log(`\n🔴 현재 On-Air(진행 중) 심포지움: ${onAirItems.length}개`);

  for (const item of onAirItems) {
    console.log(`\n[On-Air 발견] ${item.subject} (Idx: ${item.webinarIdx})`);
    console.log(`- 일시: ${item.dateDesc || item.startDate}`);
    console.log(`- 사전 신청 여부: ${item.applyFlag}`);

    const watchRes = await client.getSymposiumWatchUrl(item.webinarIdx);
    if (watchRes.success && watchRes.watchUrl) {
      console.log(`🔗 시청 URL: ${watchRes.watchUrl}`);
    } else {
      console.log(`⚠️ URL 발급 실패: ${watchRes.message}`);
    }
  }

  if (onAirItems.length === 0) {
    console.log(`\n현재 진행 중인(On-Air) 심포지움이 없습니다.`);
    console.log(`다가오는 예정 심포지움 상위 3건:`);
    for (const item of list.slice(0, 3)) {
      console.log(`- [Idx: ${item.webinarIdx}] ${item.startDate} | ${item.subject} (신청여부: ${item.applyFlag})`);
    }
    console.log(`\n💡 특정 심포지움을 지정하여 테스트하려면: node scripts/inspect_medigate_live.mjs 4941`);
  }
}

main().catch(err => {
  console.error('오류 발생:', err);
});
