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
 *   body: {"prune": false, "repullImageAndRedeploy": true}
 *   (swagger: "Pull and redeploy a stack via Git", 빈 body는 EOF 거부됨)
 * - 409 = 이미 배포 진행 중, 400 "not created from git" = git 스택 아님
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
 * git 기반 Portainer 스택을 pull + 재빌드 + 재배포한다.
 * (컨테이너가 교체되므로 호출한 컨테이너는 재배포 도중 종료될 수 있다)
 *
 * @returns 사용자에게 표시할 완료 메시지
 */
export async function triggerPortainerStackRedeploy(): Promise<string> {
  const endpointId = await resolveEndpointId();
  const stack = await resolveStackId(endpointId);

  logger.info('Portainer 스택 재배포 요청', { stackId: stack.id, stackName: stack.name, endpointId });

  try {
    await requestJson<unknown>(`/api/stacks/${stack.id}/git/redeploy?endpointId=${endpointId}`, {
      method: 'PUT',
      body: JSON.stringify({ prune: false, repullImageAndRedeploy: true }),
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
