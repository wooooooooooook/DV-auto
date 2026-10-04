import fs from 'fs';

/**
 * 현재 프로세스가 도커(또는 유사 컨테이너) 환경에서 동작하는지 판별합니다.
 *
 * 감지 우선순위:
 * 1. DV_DOCKER 환경변수 오버라이드 ('1'/'true' = 도커, '0'/'false' = 도커 아님)
 * 2. /.dockerenv 파일 존재 (도커가 컨테이너에 생성하는 표준 마커)
 * 3. /proc/1/cgroup 에 docker/containerd/kubepods/lxc 흔적
 *
 * 판별 결과는 캐시하지 않습니다. (테스트에서 환경변수로 제어할 수 있도록)
 */
export function isDockerEnv(): boolean {
  const override = process.env.DV_DOCKER?.toLowerCase();
  if (override === '1' || override === 'true') return true;
  if (override === '0' || override === 'false') return false;

  try {
    if (fs.existsSync('/.dockerenv')) return true;
  } catch {
    // 파일 접근 실패 시 다음 감지 단계로 진행
  }

  try {
    const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
    if (/docker|containerd|kubepods|lxc/.test(cgroup)) return true;
  } catch {
    // /proc/1/cgroup 읽기 실패 시 도커 아님으로 간주
  }

  return false;
}
