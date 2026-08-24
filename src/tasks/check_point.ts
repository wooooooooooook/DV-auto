import type { TaskContext, TaskResult } from '../types';
import { httpGetJson, sendDoctorVilleRequest } from '../modules/http_client';
import { sendTelegram } from '../modules/utils';
import * as logger from '../services/logger';

const POINT_PAGE_URL = 'https://www.doctorville.co.kr/my/point/pointUseHistoryList';
const POINT_API_URL = 'https://m-api.doctorville.co.kr/api/mw/my/point';

export interface PointApiResponse {
  pointInfo?: {
    usn?: number | null;
    savePoint?: number;
    chargePoint?: number;
    extinctionPoint?: number;
    totalPoint?: number;
  };
}

async function getPoint(_context?: unknown): Promise<string> {
  try {
    const res = await sendDoctorVilleRequest(POINT_API_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/json, text/plain, */*',
      },
    });

    if (res.resultType === 'AUTH_EXPIRED') {
      await sendTelegram('🔒 세션이 만료되었습니다. 로그인이 필요합니다.').catch(() => {});
      return 'AUTH_EXPIRED';
    }

    if (res.status === 200 && res.body) {
      const data: PointApiResponse = JSON.parse(res.body);
      const totalPoint = data.pointInfo?.totalPoint;
      if (typeof totalPoint === 'number') {
        return `${totalPoint.toLocaleString()}P`;
      }
    }
    return '조회 실패';
  } catch (error) {
    logger.error(
      'getPoint error',
      error && typeof error === 'object' && 'stack' in error ? (error as Error).stack : error,
    );
    return '조회 실패';
  }
}

async function run(_ctx?: TaskContext): Promise<TaskResult> {
  try {
    const pointText = await getPoint();

    if (pointText === 'AUTH_EXPIRED') {
      return {
        success: false,
        message: '🔒 세션이 만료되었습니다. 로그인이 필요합니다.',
      };
    }

    if (pointText === '조회 실패') {
      return {
        success: false,
        message: '포인트를 조회할 수 없습니다. 로그인 상태를 확인해주세요.',
      };
    }

    return {
      success: true,
      message: `현재 포인트: ${pointText}\n${POINT_PAGE_URL}`,
    };
  } catch (error) {
    logger.error(
      'check_point task error',
      error && typeof error === 'object' && 'stack' in error ? (error as Error).stack : error,
    );
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `포인트 조회 중 오류 발생: ${message}`,
    };
  }
}

export { run, getPoint };
