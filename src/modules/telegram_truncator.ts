/**
 * Telegram 메시지 길이 제한 상수 및 Truncation 유틸리티
 */

export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
export const TELEGRAM_SAFE_MESSAGE_LENGTH = 4000;
export const TELEGRAM_MAX_CAPTION_LENGTH = 1024;
export const TELEGRAM_SAFE_CAPTION_LENGTH = 1000;

export interface TruncateOptions {
  maxLength?: number;
  suffix?: string;
  parseMode?: 'HTML' | 'MarkdownV2' | 'Markdown' | undefined;
}

/**
 * HTML 태그가 포함된 문자열을 태그 구조 손상 없이 maxLength 이하로 자릅니다.
 * 열려 있는 태그(<b>, <s>, <code>, <blockquote>, <a> 등)를 역순으로 안전하게 닫아줍니다.
 */
export function truncateHtml(
  html: string,
  maxLength = TELEGRAM_SAFE_MESSAGE_LENGTH,
  suffix = '\n\n... (길이 제한으로 생략됨)',
): string {
  if (!html || html.length <= maxLength) {
    return html;
  }

  // 닫는 태그 및 suffix 여유 공간 고려
  const estimatedClosingTagsOverhead = 150;
  const targetContentLength = Math.max(50, maxLength - suffix.length - estimatedClosingTagsOverhead);

  // HTML 태그 토큰화 정규식
  const tagRegex = /<(\/)?([a-zA-Z0-9_-]+)(?:\s+[^>]*?)?(\/)?>/g;
  const openTags: string[] = [];

  let result = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(html)) !== null) {
    const textChunk = html.slice(lastIndex, match.index);
    const fullTag = match[0];
    const isClosing = match[1] === '/';
    const tagName = match[2].toLowerCase();
    const isSelfClosing = match[3] === '/' || ['img', 'br', 'hr', 'input'].includes(tagName);

    // 텍스트 청크 추가 시 목표 길이 초과 여부 확인
    if (result.length + textChunk.length >= targetContentLength) {
      const allowedTextLen = Math.max(0, targetContentLength - result.length);
      let sliceEnd = allowedTextLen;

      // HTML 엔티티(&amp; 등) 중간에 잘리지 않도록 조정
      const ampIndex = textChunk.lastIndexOf('&', sliceEnd);
      const semiIndex = textChunk.lastIndexOf(';', sliceEnd);
      if (ampIndex !== -1 && (semiIndex === -1 || ampIndex > semiIndex) && sliceEnd - ampIndex < 10) {
        sliceEnd = ampIndex;
      }

      result += textChunk.slice(0, sliceEnd);
      break;
    }

    result += textChunk;

    // 태그 자체를 추가했을 때 길이 초과 여부 확인
    if (result.length + fullTag.length >= targetContentLength) {
      break;
    }

    result += fullTag;
    lastIndex = tagRegex.lastIndex;

    // 태그 스택 관리
    if (!isSelfClosing) {
      if (isClosing) {
        const idx = openTags.lastIndexOf(tagName);
        if (idx !== -1) {
          openTags.splice(idx, 1);
        }
      } else {
        openTags.push(tagName);
      }
    }
  }

  // 루프 종료 후 남은 텍스트 추가 (목표 길이 미달 시)
  if (lastIndex < html.length && result.length < targetContentLength) {
    const remainingText = html.slice(lastIndex);
    const allowedTextLen = Math.max(0, targetContentLength - result.length);
    let sliceEnd = allowedTextLen;

    const ampIndex = remainingText.lastIndexOf('&', sliceEnd);
    const semiIndex = remainingText.lastIndexOf(';', sliceEnd);
    if (ampIndex !== -1 && (semiIndex === -1 || ampIndex > semiIndex) && sliceEnd - ampIndex < 10) {
      sliceEnd = ampIndex;
    }

    result += remainingText.slice(0, sliceEnd);
  }

  // suffix 추가
  result += suffix;

  // 열려 있는 태그들을 역순으로 닫아줌
  while (openTags.length > 0) {
    const tag = openTags.pop();
    result += `</${tag}>`;
  }

  // 최종 결과물이 여전히 maxLength를 초과하는 극단적 경우 plain text fallback
  if (result.length > maxLength) {
    const plainText = html.replace(/<[^>]+>/g, '');
    const plainAllowed = Math.max(0, maxLength - suffix.length);
    return plainText.slice(0, plainAllowed) + suffix;
  }

  return result;
}

/**
 * MarkdownV2 형식의 텍스트를 이스케이프 문자 깨짐 없이 자릅니다.
 */
export function truncateMarkdownV2(
  text: string,
  maxLength = TELEGRAM_SAFE_MESSAGE_LENGTH,
  suffix = '\n\n... \\(길이 제한으로 생략됨\\)',
): string {
  if (!text || text.length <= maxLength) {
    return text;
  }

  const allowedLen = Math.max(0, maxLength - suffix.length);
  let sliceEnd = allowedLen;

  // 끝부분이 홀수 개의 백슬래시로 끝나면 마지막 백슬래시 제외
  if (sliceEnd > 0 && text[sliceEnd - 1] === '\\') {
    let backslashCount = 0;
    let i = sliceEnd - 1;
    while (i >= 0 && text[i] === '\\') {
      backslashCount++;
      i--;
    }
    if (backslashCount % 2 === 1) {
      sliceEnd -= 1;
    }
  }

  return text.slice(0, sliceEnd) + suffix;
}

/**
 * 일반 텍스트를 지정한 길이 이하로 자릅니다.
 */
export function truncatePlainText(
  text: string,
  maxLength = TELEGRAM_SAFE_MESSAGE_LENGTH,
  suffix = '\n\n... (길이 제한으로 생략됨)',
): string {
  if (!text || text.length <= maxLength) {
    return text;
  }
  const allowedLen = Math.max(0, maxLength - suffix.length);
  return text.slice(0, allowedLen) + suffix;
}

/**
 * 옵션(parseMode, maxLength 등)에 따라 적절한 Truncation을 수행합니다.
 */
export function truncateTelegramMessage(text: string, options: TruncateOptions = {}): string {
  if (!text) return '';

  const maxLength = options.maxLength ?? TELEGRAM_SAFE_MESSAGE_LENGTH;
  const suffix = options.suffix;
  const parseMode = options.parseMode;

  if (text.length <= maxLength) {
    return text;
  }

  if (parseMode === 'HTML') {
    return truncateHtml(text, maxLength, suffix);
  }

  if (parseMode === 'MarkdownV2') {
    return truncateMarkdownV2(text, maxLength, suffix);
  }

  return truncatePlainText(text, maxLength, suffix);
}
