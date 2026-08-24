import type { TaskContext, TaskResult } from '../types';
import { sendDoctorVilleRequest } from '../modules/http_client';
import { sendTelegram } from '../modules/utils';
import * as logger from '../services/logger';

const ATTEND_EVENT_API = 'https://api.doctorville.co.kr/api/attend-event';

interface AttendedLogItem {
  attendedDate: string;
  point: number;
}

interface AttendEventResponse {
  timestamp?: string;
  data?: {
    today?: string;
    attendedLog?: AttendedLogItem[];
  } | null;
  error?: {
    code?: string;
    message?: string;
    detail?: string;
  } | null;
}

async function run(_ctx?: TaskContext): Promise<TaskResult> {
  try {
    // 1. 출석 상태 확인 (GET)
    const getRes = await sendDoctorVilleRequest(ATTEND_EVENT_API, {
      method: 'GET',
      headers: {
        Accept: 'application/json, text/plain, */*',
      },
    });

    if (getRes.resultType === 'AUTH_EXPIRED') {
      await sendTelegram('🔒 세션이 만료되었습니다. 로그인이 필요합니다.').catch(() => {});
      return {
        success: false,
        message: '🔒 세션이 만료되었습니다. 로그인이 필요합니다.',
      };
    }

    if (getRes.status !== 200 || !getRes.body) {
      return {
        success: false,
        message: `출석 상태 조회 실패 (HTTP ${getRes.status})`,
      };
    }

    let isAvailableToAttend = false;
    try {
      const parsed: AttendEventResponse = JSON.parse(getRes.body);
      const today = parsed.data?.today;
      const attendedLogs = parsed.data?.attendedLog;

      if (!today || !Array.isArray(attendedLogs)) {
        return {
          success: false,
          message: '출석 데이터 형식이 올바르지 않습니다.',
        };
      }

      const alreadyAttended = attendedLogs.some((log) => log.attendedDate === today);
      if (alreadyAttended) {
        return {
          success: true,
          message: '출석체크: 이미 출석체크되어있습니다.',
        };
      }

      // 오늘 출석 기록이 없으므로 출석 가능
      isAvailableToAttend = true;
    } catch (parseErr) {
      logger.error('attend-event GET response parse error:', parseErr);
      return {
        success: false,
        message: '출석 상태 응답 파싱 실패',
      };
    }

    if (!isAvailableToAttend) {
      return {
        success: false,
        message: '출석 가능 상태를 확인할 수 없습니다.',
      };
    }

    // 2. 출석 가능한 경우에만 출석 체크 요청 (POST)
    const postRes = await sendDoctorVilleRequest(ATTEND_EVENT_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/plain, */*',
      },
    });

    if (postRes.resultType === 'AUTH_EXPIRED') {
      await sendTelegram('🔒 세션이 만료되었습니다. 로그인이 필요합니다.').catch(() => {});
      return {
        success: false,
        message: '🔒 세션이 만료되었습니다. 로그인이 필요합니다.',
      };
    }

    if (postRes.status === 200) {
      return {
        success: true,
        message: '출석체크 완료!',
      };
    }

    // 400 또는 기타 에러 응답 파싱
    if (postRes.body) {
      try {
        const errJson: AttendEventResponse = JSON.parse(postRes.body);
        const detail = errJson.error?.detail || errJson.error?.message || '';
        if (detail.includes('이미 출석')) {
          return {
            success: true,
            message: '출석체크: 이미 출석체크되어있습니다.',
          };
        }
        return {
          success: false,
          message: `출석체크 실패: ${detail || `HTTP ${postRes.status}`}`,
        };
      } catch {
        // ignore json parse error
      }
    }

    return {
      success: false,
      message: `출석체크 실패 (HTTP ${postRes.status})`,
    };
  } catch (error) {
    logger.error(
      'attendance task error',
      error && typeof error === 'object' && 'stack' in error ? (error as Error).stack : error,
    );
    const message = error instanceof Error ? error.message : String(error);
    await sendTelegram(`❗ 출석체크 작업 오류: ${message}`).catch(() => {});
    return {
      success: false,
      message: `출석체크 작업 오류: ${message}`,
    };
  }
}

export { run };
