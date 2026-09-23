import { describe, it, expect, beforeEach, vi } from 'vitest';
import { parseSurveyMainListHtml } from '../src/modules/html_parser';
import * as subService from '../src/services/subscription_service';
import * as surveyMonitor from '../src/services/survey_monitor_service';
import * as seminarSurveyApi from '../src/modules/seminar_survey_api';
import * as storage from '../src/services/storage';

describe('닥터빌 참여 가능 설문 감지 및 구독 알림 테스트', () => {
  beforeEach(() => {
    storage.setDatabasePath(':memory:');
    storage.set(surveyMonitor.NOTIFIED_ACTIVE_SURVEYS_KEY, []);
  });

  describe('parseSurveyMainListHtml', () => {
    it('마감된 설문과 참여 가능한 설문을 정확하게 분류하여 파싱해야 한다', () => {
      const sampleHtml = `
        <div class="survey_list">
          <table>
            <tbody>
              <!-- 마감된 시장조사 -->
              <tr>
                <td>
                  <p class="progress">일괄지급</p><span class="point">2026-09-25</span>
                </td>
                <td class="tit_info">
                  <div class="category">시장조사</div>
                  <p class="tit">마감된 설문 테스트</p>
                  <span class="date">2026-09-16 ~ 2026-09-18</span>
                </td>
                <td></td>
              </tr>
              <!-- 참여 가능한 시장조사 -->
              <tr>
                <td>
                  <p class="progress">진행중</p><span class="point">3,000P</span>
                </td>
                <td class="tit_info">
                  <div class="category">시장조사</div>
                  <p class="tit">신규 활성 시장조사</p>
                  <span class="date">2026-09-17 ~ 2026-09-20</span>
                </td>
                <td>
                  <div class="link_info">
                    <input type="hidden" class="surveyIdCls" value="9901" />
                    <input type="hidden" class="surveyTypeCls" value="10" />
                    <input type="hidden" class="surveyUrl" value="https://survey.villeway.com/s/sample" />
                    <button type="button" class="btn_survey">설문참여</button>
                  </div>
                </td>
              </tr>
              <!-- 참여 가능한 라이브세미나 설문 (세미나 ID 연동) -->
              <tr>
                <td>
                  <p class="progress">바로지급</p><span class="point">1,000P</span>
                </td>
                <td class="tit_info">
                  <div class="category">라이브세미나</div>
                  <p class="tit">라이브 세미나 설문 테스트</p>
                  <span class="date">2026-09-17 ~ 2026-09-17</span>
                </td>
                <td>
                  <div class="link_info">
                    <input type="hidden" class="surveyIdCls" value="8802" />
                    <input type="hidden" class="surveyTypeCls" value="20" />
                    <input type="hidden" class="itemIdCls" value="5678" />
                    <button type="button" class="btn_survey">설문참여</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      `;

      const results = parseSurveyMainListHtml(sampleHtml);
      expect(results.length).toBe(3);

      // 마감된 설문
      expect(results[0].title).toBe('마감된 설문 테스트');
      expect(results[0].category).toBe('시장조사');
      expect(results[0].isAvailable).toBe(false);

      // 참여 가능한 시장조사
      expect(results[1].title).toBe('신규 활성 시장조사');
      expect(results[1].category).toBe('시장조사');
      expect(results[1].surveyId).toBe('9901');
      expect(results[1].surveyType).toBe(10);
      expect(results[1].point).toBe(3000);
      expect(results[1].pointText).toBe('3,000P');
      expect(results[1].isAvailable).toBe(true);

      // 참여 가능한 라이브세미나 설문
      expect(results[2].title).toBe('라이브 세미나 설문 테스트');
      expect(results[2].category).toBe('라이브세미나');
      expect(results[2].surveyId).toBe('8802');
      expect(results[2].itemId).toBe('5678');
      expect(results[2].url).toBe('https://m.doctorville.co.kr/cme/seminar/5678');
      expect(results[2].isAvailable).toBe(true);
    });

    it('상단 .survey_box 배너 카드 영역의 진행 중 설문도 정확히 파싱해야 한다', () => {
      const boxHtml = `
        <div class="survey_box">
          <ul class="list">
            <li class="link_info">
              <input type="hidden" class="surveyIdCls" value="3576">
              <input type="hidden" class="surveyTypeCls" value="10">
              <input type="hidden" class="itemIdCls" value="0">
              <a href="#none" class="btn_survey">
                <p class="progress"><span>진행중</span>
                  <em class="survey-timer" data-minutes-left="9500">2026-09-23 ~ 2026-09-30</em>
                </p>
                <div class="tit_info">
                  <span class="category">기타</span>
                  <p class="tit">포인트샵 신규 상품 의향 조사</p>
                  <span class="point hide">0P</span>
                </div>
              </a>
            </li>
          </ul>
        </div>
      `;

      const results = parseSurveyMainListHtml(boxHtml);
      expect(results.length).toBe(1);
      expect(results[0].surveyId).toBe('3576');
      expect(results[0].title).toBe('포인트샵 신규 상품 의향 조사');
      expect(results[0].category).toBe('기타');
      expect(results[0].isAvailable).toBe(true);
      expect(results[0].date).toBe('2026-09-23 ~ 2026-09-30');
    });
  });

  describe('subscription_service: doctorville_survey', () => {
    it('doctorville_survey 토픽을 정상적으로 토글하고 구독자를 관리해야 한다', () => {
      const chatId = 12345678;

      // 초기 상태: false
      let sub = subService.getSubscription(chatId);
      expect(sub.doctorvilleSurvey).toBe(false);

      // 토글 ON
      sub = subService.toggleTopic(chatId, 'doctorville_survey');
      expect(sub.doctorvilleSurvey).toBe(true);
      expect(subService.getSubscribersForTopic('doctorville_survey')).toContain(chatId);

      // 메뉴 렌더링 확인
      const menu = subService.buildMainMenu(chatId);
      expect(menu.text).toContain('닥터빌 설문 (시장조사 등)');
      expect(menu.text).toContain('🟢 ON');

      // 토글 OFF
      sub = subService.toggleTopic(chatId, 'doctorville_survey');
      expect(sub.doctorvilleSurvey).toBe(false);
      expect(subService.getSubscribersForTopic('doctorville_survey')).not.toContain(chatId);
    });

    it('setAllTopics로 모든 알림 켜기/끄기 시 doctorville_survey도 함께 제어되어야 한다', () => {
      const chatId = 998877;
      let sub = subService.setAllTopics(chatId, true);
      expect(sub.doctorvilleSurvey).toBe(true);

      sub = subService.setAllTopics(chatId, false);
      expect(sub.doctorvilleSurvey).toBe(false);
    });
  });

  describe('checkAndNotifyActiveSurveys', () => {
    it('참여 가능한 설문이 새로 발견되면 구독자에게 발송하고 중복 발송을 방지해야 한다', async () => {
      const chatId = 112233;
      subService.updateSubscription(chatId, { doctorvilleSurvey: true });

      const mockAvailableItems = [
        {
          surveyId: '7701',
          surveyType: 10,
          category: '시장조사',
          title: '신약 설문조사',
          date: '2026-09-17 ~ 2026-09-18',
          progress: '진행중',
          pointText: '2,000P',
          point: 2000,
          isAvailable: true,
          isOngoing: true,
          url: 'https://www.doctorville.co.kr/survey/main',
        },
      ];

      vi.spyOn(seminarSurveyApi, 'fetchSurveyMainList').mockResolvedValue({
        success: true,
        items: mockAvailableItems,
        availableItems: mockAvailableItems,
        ongoingItems: mockAvailableItems,
        isAuthExpired: false,
      });

      const sendSpy = vi.spyOn(subService, 'sendDoctorVilleSurveysToSubscribers').mockResolvedValue({
        successCount: 1,
        failCount: 0,
      });

      // 1회차 실행: 신규 발견 -> 알림 발송
      const res1 = await surveyMonitor.checkAndNotifyActiveSurveys();
      expect(res1.success).toBe(true);
      expect(res1.notifiedCount).toBe(1);
      expect(res1.newlyNotified[0].surveyId).toBe('7701');
      expect(sendSpy).toHaveBeenCalledTimes(1);

      // 2회차 실행: 동일 설문 재조회 -> 이미 알림 보냈으므로 중복 발송 안함
      const res2 = await surveyMonitor.checkAndNotifyActiveSurveys();
      expect(res2.success).toBe(true);
      expect(res2.notifiedCount).toBe(0);
      expect(sendSpy).toHaveBeenCalledTimes(1);
    });
  });
});
