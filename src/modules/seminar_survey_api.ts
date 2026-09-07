import { sendDoctorVilleRequest } from './http_client';
import {
  loadCheatsheet,
  findMatchingKeywords,
  resolveBestKeywordMatch,
  type Cheatsheet,
  type QuizQuestion,
} from '../tasks/seminar_quiz';

export interface HttpQuizQuestion {
  pageNumber: number;
  questionNumber: number;
  questionId: number;
  questionText: string;
  typeKey: string;
  typeName: string;
  isRequired: boolean;
  options: Array<{ index: number; text: string; value: string; optionId: number }>;
  selectedIndex: number | null;
  selectedText: string | null;
  matchedKeyword: string | null;
  multipleMatches?: string[] | null;
}

export interface SurveyQuizHttpResult {
  success: boolean;
  seminarId: string;
  surveyUrl?: string;
  surveyTitle?: string;
  totalPageCnt: number;
  totalQuestionCnt: number;
  quizQuestionCnt: number;
  depthSurveyQuestionCnt: number;
  isAdvancedSurvey: boolean;
  quizzes: HttpQuizQuestion[];
  allQuestions: HttpQuizQuestion[];
  quizSummaryMessage: string;
  errorMessage?: string;
}

export const DOCTORVILLE_SURVEY_URL_API = 'https://m-api.doctorville.co.kr/api/mw/seminars';
export const VILLEWAY_API_BASE_URL = 'https://survey.villeway.com/data/v1';

/**
 * 닥터빌 세미나의 설문/퀴즈를 순수 HTTP API로 조회하여
 * 전체 페이지(1 ~ N) 문항을 탐색하고 퀴즈 정답 및 심화설문 정보를 추출합니다.
 */
export async function fetchSeminarSurveyQuizHttp(
  seminarId: string | number,
  customCheatsheet?: Cheatsheet,
): Promise<SurveyQuizHttpResult> {
  const sid = String(seminarId).trim();
  try {
    // 1. 닥터빌에서 설문 URL 조회
    const surveyUrlEndpoint = `${DOCTORVILLE_SURVEY_URL_API}/${sid}/survey-url`;
    const surveyUrlRes = await sendDoctorVilleRequest(surveyUrlEndpoint, {
      headers: {
        Referer: `https://m.doctorville.co.kr/cme/seminar/${sid}`,
        Accept: 'application/json, text/plain, */*',
      },
    });

    if (surveyUrlRes.status !== 200 || !surveyUrlRes.body) {
      return {
        success: false,
        seminarId: sid,
        totalPageCnt: 0,
        totalQuestionCnt: 0,
        quizQuestionCnt: 0,
        depthSurveyQuestionCnt: 0,
        isAdvancedSurvey: false,
        quizzes: [],
        allQuestions: [],
        quizSummaryMessage: '',
        errorMessage: `설문 URL 조회 실패 (HTTP ${surveyUrlRes.status})`,
      };
    }

    let parsedSurveyUrlData: { surveyUrl?: string; code?: number | string; message?: string };
    try {
      parsedSurveyUrlData = JSON.parse(surveyUrlRes.body);
    } catch {
      return {
        success: false,
        seminarId: sid,
        totalPageCnt: 0,
        totalQuestionCnt: 0,
        quizQuestionCnt: 0,
        depthSurveyQuestionCnt: 0,
        isAdvancedSurvey: false,
        quizzes: [],
        allQuestions: [],
        quizSummaryMessage: '',
        errorMessage: '설문 URL 응답 JSON 파싱 실패',
      };
    }

    const surveyUrl = parsedSurveyUrlData.surveyUrl;
    if (!surveyUrl) {
      return {
        success: false,
        seminarId: sid,
        totalPageCnt: 0,
        totalQuestionCnt: 0,
        quizQuestionCnt: 0,
        depthSurveyQuestionCnt: 0,
        isAdvancedSurvey: false,
        quizzes: [],
        allQuestions: [],
        quizSummaryMessage: '',
        errorMessage: parsedSurveyUrlData.message || '설문 URL이 제공되지 않았습니다 (설문 미오픈 또는 없음)',
      };
    }

    // 2. URL에서 token 추출 및 Villeway 인증
    // URL 패턴: https://survey.villeway.com/s/c/{companyToken}/u/{secureToken}
    const urlObj = new URL(surveyUrl);
    const pathParts = urlObj.pathname.split('/').filter(Boolean);
    const sIndex = pathParts.indexOf('s');
    const authType = sIndex !== -1 && pathParts[sIndex + 1] ? pathParts[sIndex + 1] : 'c';
    const secureToken = pathParts[pathParts.length - 1] || '';

    const authEndpoint = `${VILLEWAY_API_BASE_URL}/auth/authenticate-via-${authType === 'c' ? 'client' : authType === 'p' ? 'password' : 'token'}`;
    const authRes = await sendDoctorVilleRequest(authEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://survey.villeway.com',
        Referer: surveyUrl,
      },
      body: JSON.stringify({
        type: authType,
        secureToken,
      }),
    });

    if (authRes.status !== 200 || !authRes.body) {
      return {
        success: false,
        seminarId: sid,
        surveyUrl,
        totalPageCnt: 0,
        totalQuestionCnt: 0,
        quizQuestionCnt: 0,
        depthSurveyQuestionCnt: 0,
        isAdvancedSurvey: false,
        quizzes: [],
        allQuestions: [],
        quizSummaryMessage: '',
        errorMessage: `Villeway 설문 인증 실패 (HTTP ${authRes.status})`,
      };
    }

    let authData: { data?: { accessToken?: string }; accessToken?: string };
    try {
      authData = JSON.parse(authRes.body);
    } catch {
      return {
        success: false,
        seminarId: sid,
        surveyUrl,
        totalPageCnt: 0,
        totalQuestionCnt: 0,
        quizQuestionCnt: 0,
        depthSurveyQuestionCnt: 0,
        isAdvancedSurvey: false,
        quizzes: [],
        allQuestions: [],
        quizSummaryMessage: '',
        errorMessage: 'Villeway 인증 응답 JSON 파싱 실패',
      };
    }

    const accessToken = authData.data?.accessToken || authData.accessToken;
    if (!accessToken) {
      return {
        success: false,
        seminarId: sid,
        surveyUrl,
        totalPageCnt: 0,
        totalQuestionCnt: 0,
        quizQuestionCnt: 0,
        depthSurveyQuestionCnt: 0,
        isAdvancedSurvey: false,
        quizzes: [],
        allQuestions: [],
        quizSummaryMessage: '',
        errorMessage: 'Villeway accessToken 발급 실패',
      };
    }

    // 3. 설문 전체 메타데이터 조회
    const detailRes = await sendDoctorVilleRequest(`${VILLEWAY_API_BASE_URL}/user/survey-detail`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Origin: 'https://survey.villeway.com',
        Referer: 'https://survey.villeway.com/',
      },
    });

    if (detailRes.status !== 200 || !detailRes.body) {
      return {
        success: false,
        seminarId: sid,
        surveyUrl,
        totalPageCnt: 0,
        totalQuestionCnt: 0,
        quizQuestionCnt: 0,
        depthSurveyQuestionCnt: 0,
        isAdvancedSurvey: false,
        quizzes: [],
        allQuestions: [],
        quizSummaryMessage: '',
        errorMessage: `설문 상세 조회 실패 (HTTP ${detailRes.status})`,
      };
    }

    const detailJson = JSON.parse(detailRes.body);
    const surveyData = detailJson.data || detailJson;
    const totalPageCnt = typeof surveyData.pageCnt === 'number' ? surveyData.pageCnt : 1;
    const totalQuestionCnt = typeof surveyData.questionCnt === 'number' ? surveyData.questionCnt : 0;
    const surveyTitle = surveyData.config?.title || '';

    // 심화설문 판별: 제목에 "심화", "만족도", 또는 2페이지 이상/문항 수가 많은 경우 등
    const isAdvancedSurvey =
      surveyTitle.includes('심화') ||
      surveyTitle.includes('만족도') ||
      totalQuestionCnt >= 15 ||
      Boolean(surveyData.config?.useDepthSurvey);

    // 4. 각 페이지 순회 및 문항 수집
    const allQuestions: HttpQuizQuestion[] = [];
    const cheatsheet = customCheatsheet || (await loadCheatsheet());

    for (let pageNo = 1; pageNo <= totalPageCnt; pageNo++) {
      const pageRes = await sendDoctorVilleRequest(`${VILLEWAY_API_BASE_URL}/user/survey-page/${pageNo}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Origin: 'https://survey.villeway.com',
          Referer: 'https://survey.villeway.com/',
        },
      });

      if (pageRes.status !== 200 || !pageRes.body) continue;

      let pageData: { data?: { questions?: unknown[] }; questions?: unknown[] };
      try {
        pageData = JSON.parse(pageRes.body);
      } catch {
        continue;
      }

      const rawQuestions = (pageData.data?.questions || pageData.questions || []) as Array<Record<string, unknown>>;

      for (const q of rawQuestions) {
        const qId = Number(q.id ?? 0);
        const qNum = Number(q.questionNumber ?? 0);
        const qText = String(q.subject ?? '').trim();
        const typeObj = (q.type || {}) as Record<string, unknown>;
        const typeKey = String(typeObj.key ?? '');
        const typeName = String(typeObj.nameKo ?? typeObj.value ?? '');
        const configObj = (q.config || {}) as Record<string, unknown>;
        const isRequired = configObj.required !== false;

        const rawOptions = (q.options || []) as Array<Record<string, unknown>>;
        const options: HttpQuizQuestion['options'] = rawOptions.map((opt, idx) => ({
          index: idx + 1,
          text: String(opt.text ?? opt.title ?? '').trim(),
          value: String(opt.value ?? idx),
          optionId: Number(opt.id ?? 0),
        }));

        let selectedIndex: number | null = null;
        let selectedText: string | null = null;
        let matchedKeyword: string | null = null;
        let multipleMatches: string[] | null = null;

        // 퀴즈 여부 판별: type.key가 QUIZ_MULTIPLE_CHOICE 이거나 지문에 [퀴즈] 마커 포함
        const isQuizType = typeKey === 'QUIZ_MULTIPLE_CHOICE' || /\[\s*(퀴즈|O\s*X|주관식)\s*\]/i.test(qText);

        if (isQuizType && options.length > 0) {
          const matchKeywords = findMatchingKeywords(qText, cheatsheet);
          if (matchKeywords.length > 1) {
            multipleMatches = matchKeywords;
          }
          const best = resolveBestKeywordMatch(qText, options as QuizQuestion['options'], cheatsheet);
          if (best) {
            matchedKeyword = best.keyword;
            selectedIndex = best.option.index;
            selectedText = best.option.text;
          }
        }

        allQuestions.push({
          pageNumber: pageNo,
          questionNumber: qNum,
          questionId: qId,
          questionText: qText,
          typeKey,
          typeName,
          isRequired,
          options,
          selectedIndex,
          selectedText,
          matchedKeyword,
          multipleMatches,
        });
      }
    }

    // 5. 퀴즈 문항만 필터링
    const quizzes = allQuestions.filter(
      (q) => q.typeKey === 'QUIZ_MULTIPLE_CHOICE' || /\[\s*(퀴즈|O\s*X|주관식)\s*\]/i.test(q.questionText),
    );

    // 6. 심화설문 문항 수: 마지막 페이지(totalPageCnt)의 문제 개수
    const lastPageQuestions = allQuestions.filter((q) => q.pageNumber === totalPageCnt);
    const depthSurveyQuestionCnt = isAdvancedSurvey ? lastPageQuestions.length : 0;

    // 퀴즈 정답 요약 메시지 생성 (예: "퀴즈 정답 412 + 심화1" 또는 "퀴즈 정답 412")
    let quizSummaryMessage = '';
    const depthSuffix = isAdvancedSurvey && depthSurveyQuestionCnt > 0 ? ` + 심화${depthSurveyQuestionCnt}` : '';

    if (quizzes.length > 0) {
      const ansNums = quizzes.map((q) => (q.selectedIndex !== null ? String(q.selectedIndex) : '-')).join('');
      const hasUnknown = quizzes.some((q) => q.selectedIndex === null);
      quizSummaryMessage = `퀴즈 정답 ${ansNums}${depthSuffix}${hasUnknown ? ' (일부 미해결)' : ''}`;
    } else if (isAdvancedSurvey && depthSurveyQuestionCnt > 0) {
      quizSummaryMessage = `심화${depthSurveyQuestionCnt}`;
    }

    return {
      success: true,
      seminarId: sid,
      surveyUrl,
      surveyTitle,
      totalPageCnt,
      totalQuestionCnt: allQuestions.length || totalQuestionCnt,
      quizQuestionCnt: quizzes.length,
      depthSurveyQuestionCnt,
      isAdvancedSurvey,
      quizzes,
      allQuestions,
      quizSummaryMessage,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      seminarId: sid,
      totalPageCnt: 0,
      totalQuestionCnt: 0,
      quizQuestionCnt: 0,
      depthSurveyQuestionCnt: 0,
      isAdvancedSurvey: false,
      quizzes: [],
      allQuestions: [],
      quizSummaryMessage: '',
      errorMessage: `fetchSeminarSurveyQuizHttp 오류: ${errorMsg}`,
    };
  }
}
