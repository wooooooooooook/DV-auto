import * as logger from './logger';

/**
 * Portainer REST API 클라이언트.
 *
 * 용도: 도커 컨테이너에서 텔레그램 /update_app 명령을 받으면
 * Portainer를 통해 git 기반 스택을 pull + 재빌드 + 재배포한다.
 *
 * 확인된 API (Portainer 소스코드 기준):
 * - 인증: X-API-Key 헤더(권장) 또는 POST /api/auth → JWT
 * - PUT /api/stacks/{id}/git/redeploy?endpointId=N
 *   body: {"prune": false, "repullImageAndRedeploy": true, "Env": [...], "RepositoryReferenceName": "..."}
 *   (swagger: "Pull and redeploy a stack via Git", 빈 body는 EOF 거부됨)
 * - 409 = 이미 배포 진행 중, 400 "not created from git" = git 스택 아님
 * - GET /api/stacks/{id} → 스택 환경변수·브랜치 조회
 *
 * 중요: Env 와 RepositoryReferenceName 은 반드시 그대로 되돌려 보내야 한다.
 * 구버전 Portainer(예: 2.21.4)는 redeploy payload 값을 stack 에 무조건 대입한다.
 *   stack.Env = payload.Env
 *   stack.GitConfig.ReferenceName = payload.RepositoryReferenceName
 * 담지 않으면 둘 다 비어 스택 환경변수와 브랜치가 함께 사라진다.
 * 신버전은 Env 를 있을 때만 대입하므로 되돌려 보내면 어느 버전에서도 안전하다.
 *
 * 필요한 환경변수:
 * - PORTAINER_URL (필수, 미설정 시 비활성화)
 * - PORTAINER_API_KEY 또는 PORTAINER_USERNAME + PORTAINER_PASSWORD
 * - PORTAINER_ENDPOINT_ID / PORTAINER_STACK_ID / PORTAINER_STACK_NAME (선택, 미지정 시 자동 발견)
 */

export class PortainerApiError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'PortainerApiError';
    this.status = status;
  }
}

export function isPortainerConfigured(): boolean {
  return Boolean(process.env.PORTAINER_URL?.trim());
}

function getBaseUrl(): string {
  return (process.env.PORTAINER_URL || '').trim().replace(/\/+$/, '');
}

function hasApiKey(): boolean {
  return Boolean(process.env.PORTAINER_API_KEY?.trim());
}

function hasUserPass(): boolean {
  return Boolean(process.env.PORTAINER_USERNAME?.trim() && process.env.PORTAINER_PASSWORD);
}

let cachedJwt: string | null = null;

/** 테스트용: 캐시된 JWT 를 비운다. */
export function resetPortainerAuthCache(): void {
  cachedJwt = null;
}

async function login(): Promise<string> {
  const res = await fetch(`${getBaseUrl()}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: process.env.PORTAINER_USERNAME?.trim(),
      password: process.env.PORTAINER_PASSWORD,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new PortainerApiError(`Portainer 로그인 실패 (HTTP ${res.status}): ${text.slice(0, 300)}`, res.status);
  }
  let jwt: string | undefined;
  try {
    jwt = (JSON.parse(text) as { jwt?: string }).jwt;
  } catch {
    jwt = undefined;
  }
  if (!jwt) {
    throw new PortainerApiError('Portainer 로그인 응답에 jwt가 없습니다.');
  }
  return jwt;
}

function authHeaders(jwt: string | null): Record<string, string> {
  if (hasApiKey()) {
    return { 'X-API-Key': process.env.PORTAINER_API_KEY!.trim() };
  }
  if (jwt) {
    return { Authorization: `Bearer ${jwt}` };
  }
  return {};
}

/**
 * Portainer API 요청 공통부. JSON 응답을 파싱해 반환한다.
 * JWT 만료 시 1회 재로그인 후 재시도한다.
 */
async function requestJson<T>(path: string, init: RequestInit = {}, retryOn401 = true): Promise<T> {
  if (!isPortainerConfigured()) {
    throw new PortainerApiError('PORTAINER_URL 미설정으로 Portainer 기능을 사용할 수 없습니다.');
  }

  if (!hasApiKey() && !hasUserPass() && !cachedJwt) {
    throw new PortainerApiError('PORTAINER_API_KEY 또는 PORTAINER_USERNAME/PORTAINER_PASSWORD가 필요합니다.');
  }

  const jwt = hasApiKey() ? null : (cachedJwt ?? (await login().then((t) => (cachedJwt = t))));

  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    ...authHeaders(jwt),
  };

  const res = await fetch(`${getBaseUrl()}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(180_000),
  });

  if (res.status === 401 && !hasApiKey() && retryOn401) {
    cachedJwt = null;
    return requestJson<T>(path, init, false);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new PortainerApiError(`Portainer API 실패 (HTTP ${res.status}) ${path}: ${text.slice(0, 300)}`, res.status);
  }

  if (!text.trim()) {
    return undefined as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

type EndpointSummary = { Id: number; Name: string };
type StackSummary = { Id: number; Name: string; EndpointId?: number };

/** portainer.Pair 에 해당하는 환경변수 한 건. */
type StackEnvPair = { Name: string; Value: string };

/** GET /api/stacks/{id} 응답에서 redeploy 보존용으로 필요한 부분. */
type StackDetail = {
  Env?: StackEnvPair[] | null;
  GitConfig?: {
    ReferenceName?: string | null;
    Authentication?: { Username?: string | null } | null;
  } | null;
  CurrentDeploymentInfo?: { ReferenceName?: string | null } | null;
};

async function resolveEndpointId(): Promise<number> {
  const fromEnv = Number.parseInt(process.env.PORTAINER_ENDPOINT_ID?.trim() || '', 10);
  if (!Number.isNaN(fromEnv)) {
    return fromEnv;
  }

  const endpoints = await requestJson<EndpointSummary[]>('/api/endpoints');
  if (!Array.isArray(endpoints) || endpoints.length === 0) {
    throw new PortainerApiError('Portainer에 등록된 environment(endpoint)가 없습니다.');
  }
  if (endpoints.length === 1) {
    return endpoints[0].Id;
  }
  const local = endpoints.find((e) => (e.Name || '').toLowerCase() === 'local');
  if (local) {
    return local.Id;
  }
  const names = endpoints.map((e) => `${e.Id}:${e.Name}`).join(', ');
  throw new PortainerApiError(`endpoint가 여러 개입니다. PORTAINER_ENDPOINT_ID로 지정해주세요. (후보: ${names})`);
}

async function resolveStackId(endpointId: number): Promise<{ id: number; name: string }> {
  const fromEnv = Number.parseInt(process.env.PORTAINER_STACK_ID?.trim() || '', 10);
  const nameEnv = process.env.PORTAINER_STACK_NAME?.trim();

  if (!Number.isNaN(fromEnv)) {
    const stacks = await requestJson<StackSummary[]>('/api/stacks');
    const found = stacks.find((s) => s.Id === fromEnv);
    return { id: fromEnv, name: found?.Name || String(fromEnv) };
  }

  const stacks = await requestJson<StackSummary[]>('/api/stacks');
  if (!Array.isArray(stacks) || stacks.length === 0) {
    throw new PortainerApiError('Portainer에 등록된 스택이 없습니다.');
  }

  const inEndpoint = stacks.filter((s) => s.EndpointId === undefined || s.EndpointId === endpointId);

  if (nameEnv) {
    const matched = inEndpoint.find((s) => s.Name.toLowerCase() === nameEnv.toLowerCase());
    if (!matched) {
      const names = inEndpoint.map((s) => s.Name).join(', ');
      throw new PortainerApiError(`PORTAINER_STACK_NAME '${nameEnv}' 스택을 찾지 못했습니다. (후보: ${names})`);
    }
    return { id: matched.Id, name: matched.Name };
  }

  if (inEndpoint.length === 1) {
    return { id: inEndpoint[0].Id, name: inEndpoint[0].Name };
  }

  const names = inEndpoint.map((s) => s.Name).join(', ');
  throw new PortainerApiError(
    `스택이 여러 개라 자동 선택할 수 없습니다. PORTAINER_STACK_NAME으로 지정해주세요. (후보: ${names})`,
  );
}

/**
 * redeploy 전에 스택 설정을 읽는다.
 *
 * Portainer 는 2.39 까지 redeploy payload 값을 stack 에 무조건 대입한다.
 *   stack.Env = payload.Env
 *   stack.GitConfig.ReferenceName = payload.RepositoryReferenceName
 * 따라서 필드를 '비어 있다' 는 이유로 빼면 안 된다. 빼면 그 필드가 nil 로 덮여
 * 환경변수와 브랜치가 사라진다. 응답에 존재하는 필드는 있는 그대로(빈 배열이어도) 되돌려 보낸다.
 *
 * 반대로 응답에 필드가 아예 없으면 값을 되돌려 보낼 근거가 없으므로 redeploy 를 중단한다.
 */
async function fetchStackPreserveSettings(stackId: number): Promise<{
  env: StackEnvPair[];
  hasEnvField: boolean;
  referenceName: string;
  hasReferenceNameField: boolean;
  repositoryUsername: string;
}> {
  const detail = await requestJson<StackDetail>(`/api/stacks/${stackId}`);

  const hasEnvField = Boolean(detail) && Object.prototype.hasOwnProperty.call(detail, 'Env');
  const env = Array.isArray(detail?.Env) ? detail.Env.filter((pair): pair is StackEnvPair => Boolean(pair?.Name)) : [];

  // 구버전은 stack.GitConfig, 신버전은 CurrentDeploymentInfo 에 브랜치를 둔다.
  const legacyRef = detail?.GitConfig?.ReferenceName;
  const currentRef = detail?.CurrentDeploymentInfo?.ReferenceName;
  const hasReferenceNameField = legacyRef !== undefined || currentRef !== undefined;
  const referenceName = (legacyRef ?? currentRef ?? '').trim();

  // 진단용. 환경변수 값은 비밀일 수 있으므로 이름만 기록한다.
  logger.info('Portainer 스택 배포 전 설정 조회', {
    stackId,
    responseKeys: detail ? Object.keys(detail) : [],
    hasEnvField,
    envCount: env.length,
    envNames: env.map((pair) => pair.Name),
    hasReferenceNameField,
    referenceName: referenceName || '(비어 있음)',
  });

  return {
    env,
    hasEnvField,
    referenceName,
    hasReferenceNameField,
    repositoryUsername: detail?.GitConfig?.Authentication?.Username?.trim() || '',
  };
}

/**
 * git 기반 Portainer 스택을 pull + 재빌드 + 재배포한다.
 * (컨테이너가 교체되므로 호출한 컨테이너는 재배포 도중 종료될 수 있다)
 *
 * @returns 사용자에게 표시할 완료 메시지
 */
export async function triggerPortainerStackRedeploy(): Promise<string> {
  const endpointId = await resolveEndpointId();
  const stack = await resolveStackId(endpointId);

  const settings = await fetchStackPreserveSettings(stack.id);

  // 되돌려 보낼 근거가 없으면 배포하지 않는다. 이 경로로 진행하면 Portainer 가
  // payload 의 nil 을 stack.Env 에 그대로 대입해 환경변수를 비운다.
  if (!settings.hasEnvField) {
    throw new PortainerApiError(
      '스택 설정에서 Env 필드를 읽지 못해 재배포를 중단했습니다. ' +
        '계속 진행할 경우 환경변수가 삭제될 수 있습니다. Portainer 에서 스택 환경변수를 확인해 주세요.',
    );
  }

  if (settings.env.length === 0) {
    // 이미 비워진 상태를 그대로 되돌려 보낸다(더 나빠지지 않는다).
    // 다만 docker-compose.yml 의 ${VAR} 가 전부 빈 문자열로 배포된다는 사실을 알린다.
    logger.warn(
      'Portainer 스택에 환경변수가 없습니다. docker-compose.yml 의 ${VAR} 는 빈 값으로 배포됩니다. ' +
        'Portainer UI 에서 스택 환경변수를 다시 입력해야 합니다.',
      { stackId: stack.id },
    );
  }

  const payload: Record<string, unknown> = {
    prune: false,
    repullImageAndRedeploy: true,
  };

  // 존재하는 필드는 빈 배열이어도 반드시 되돌려 보낸다.
  // '비어 있다' 는 이유로 빼면 그 값이 nil 로 덮여 지워진다.
  if (settings.hasEnvField) {
    payload.Env = settings.env;
  }
  if (settings.hasReferenceNameField) {
    payload.RepositoryReferenceName = settings.referenceName;
  }
  if (settings.repositoryUsername) {
    // 비밀번호는 비워 보낸다. 빈 값이면 저장된 자격증명을 유지한다.
    payload.RepositoryAuthentication = true;
    payload.RepositoryUsername = settings.repositoryUsername;
  }

  logger.info('Portainer 스택 재배포 요청', {
    stackId: stack.id,
    stackName: stack.name,
    endpointId,
    sentEnvCount: settings.hasEnvField ? settings.env.length : '(미전송)',
    sentReferenceName: settings.hasReferenceNameField ? settings.referenceName || '(빈 값)' : '(미전송)',
  });

  try {
    await requestJson<unknown>(`/api/stacks/${stack.id}/git/redeploy?endpointId=${endpointId}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  } catch (error) {
    const status = error instanceof PortainerApiError ? error.status : undefined;
    if (status === 409) {
      throw new PortainerApiError('이미 배포가 진행 중입니다. 잠시 후 다시 시도해주세요.', status);
    }
    if (status === 400 && error instanceof PortainerApiError && error.message.includes('not created from git')) {
      throw new PortainerApiError(
        '이 스택은 git(Repository) 기반이 아닙니다. Portainer 스택 유형을 확인해주세요.',
        status,
      );
    }
    throw error;
  }

  return `스택 '${stack.name}' (id: ${stack.id}) pull + 재배포 완료 응답을 받았습니다.`;
}
