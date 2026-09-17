import { fetchSurveyMainList } from '../modules/seminar_survey_api';
import type { ActiveSurveyItem } from '../modules/html_parser';
import { sendDoctorVilleSurveysToSubscribers, type DoctorVilleSurveyNoticeItem } from './subscription_service';
import * as storage from './storage';
import * as logger from './logger';

export const NOTIFIED_ACTIVE_SURVEYS_KEY = 'survey_monitor:notified_keys';

/**
 * 설문 고유 식별 키 생성
 */
export function getSurveyUniqueKey(survey: ActiveSurveyItem | DoctorVilleSurveyNoticeItem): string {
  if (survey.surveyId && String(survey.surveyId).trim()) {
    return `id_${String(survey.surveyId).trim()}`;
  }
  const cleanTitle = (survey.title || '').replace(/\s+/g, '_');
  const cleanDate = (survey.date || '').replace(/\s+/g, '_');
  return `meta_${survey.category || 'survey'}_${cleanTitle}_${cleanDate}`;
}

export interface CheckActiveSurveysResult {
  success: boolean;
  totalSurveys: number;
  availableSurveys: ActiveSurveyItem[];
  newlyNotified: DoctorVilleSurveyNoticeItem[];
  notifiedCount: number;
  isAuthExpired: boolean;
  errorMessage?: string;
}

/**
 * 닥터빌 설문 메인(https://www.doctorville.co.kr/survey/main)의 참여 가능한 설문을 확인하고,
 * 새로 발견된 설문을 doctorville_survey 구독자들에게 알림 발송합니다.
 */
export async function checkAndNotifyActiveSurveys(page = 1): Promise<CheckActiveSurveysResult> {
  try {
    const listRes = await fetchSurveyMainList(page);
    if (!listRes.success) {
      if (listRes.isAuthExpired) {
        return {
          success: false,
          totalSurveys: 0,
          availableSurveys: [],
          newlyNotified: [],
          notifiedCount: 0,
          isAuthExpired: true,
          errorMessage: listRes.errorMessage,
        };
      }
      return {
        success: false,
        totalSurveys: 0,
        availableSurveys: [],
        newlyNotified: [],
        notifiedCount: 0,
        isAuthExpired: false,
        errorMessage: listRes.errorMessage,
      };
    }

    const availableSurveys = listRes.availableItems;
    if (availableSurveys.length === 0) {
      return {
        success: true,
        totalSurveys: listRes.items.length,
        availableSurveys: [],
        newlyNotified: [],
        notifiedCount: 0,
        isAuthExpired: false,
      };
    }

    const notifiedKeysList = storage.get<string[]>(NOTIFIED_ACTIVE_SURVEYS_KEY, []) || [];
    const notifiedKeySet = new Set<string>(notifiedKeysList);

    const newlyDiscovered: DoctorVilleSurveyNoticeItem[] = [];
    const newKeysToAdd: string[] = [];

    for (const item of availableSurveys) {
      const key = getSurveyUniqueKey(item);
      if (!notifiedKeySet.has(key)) {
        newlyDiscovered.push({
          surveyId: item.surveyId,
          surveyType: item.surveyType,
          itemId: item.itemId,
          category: item.category,
          title: item.title,
          date: item.date,
          pointText: item.pointText,
          point: item.point,
          surveyUrl: item.surveyUrl,
          url: item.url,
        });
        newKeysToAdd.push(key);
      }
    }

    if (newlyDiscovered.length > 0) {
      logger.info(
        `[survey_monitor] 신규 참여 가능 설문 ${newlyDiscovered.length}건 발견! 구독자 알림 발송 시작:`,
        newlyDiscovered.map((s) => s.title),
      );

      const { successCount, failCount } = await sendDoctorVilleSurveysToSubscribers(newlyDiscovered).catch((err) => {
        logger.error('[survey_monitor] sendDoctorVilleSurveysToSubscribers 오류:', err);
        return { successCount: 0, failCount: 0 };
      });

      logger.info(`[survey_monitor] 신규 설문 알림 발송 완료: 성공 ${successCount}건, 실패 ${failCount}건`);

      const updatedKeys = Array.from(new Set([...notifiedKeysList, ...newKeysToAdd])).slice(-500);
      storage.set(NOTIFIED_ACTIVE_SURVEYS_KEY, updatedKeys);
    }

    return {
      success: true,
      totalSurveys: listRes.items.length,
      availableSurveys,
      newlyNotified: newlyDiscovered,
      notifiedCount: newlyDiscovered.length,
      isAuthExpired: false,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('[survey_monitor] checkAndNotifyActiveSurveys 예외:', err);
    return {
      success: false,
      totalSurveys: 0,
      availableSurveys: [],
      newlyNotified: [],
      notifiedCount: 0,
      isAuthExpired: false,
      errorMessage: errorMsg,
    };
  }
}
