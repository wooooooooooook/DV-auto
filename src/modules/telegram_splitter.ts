/**
 * Telegram 메시지 길이 제한(4096자) 대응을 위한 분할(Split) 및 Truncation 유틸리티
 */

export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
export const TELEGRAM_SAFE_MESSAGE_LENGTH = 4000;
export const TELEGRAM_MAX_CAPTION_LENGTH = 1024;
export const TELEGRAM_SAFE_CAPTION_LENGTH = 1000;

export interface SplitOptions {
  maxLength?: number;
  parseMode?: 'HTML' | 'MarkdownV2' | 'Markdown' | undefined;
}

export interface TruncateOptions {
  maxLength?: number;
  suffix?: string;
  parseMode?: 'HTML' | 'MarkdownV2' | 'Markdown' | undefined;
}

interface OpenTagInfo {
  tag: string;
  fullOpenTag: string;
}

const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'meta', 'link']);
const TAG_REGEX = /<(\/)?([a-zA-Z0-9_-]+)(?:\s+[^>]*?)?(\/)?>/g;

function findLastTagIndex(openTags: OpenTagInfo[], tagName: string): number {
  for (let i = openTags.length - 1; i >= 0; i--) {
    if (openTags[i].tag === tagName) return i;
  }
  return -1;
}

/**
 * 텍스트 내의 HTML 태그를 분석하여 열린 태그 스택을 업데이트합니다.
 */
function updateOpenTags(text: string, openTags: OpenTagInfo[]): void {
  const regex = new RegExp(TAG_REGEX.source, 'g');
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const isClosing = match[1] === '/';
    const tagName = match[2].toLowerCase();
    const isSelfClosing = match[3] === '/' || VOID_TAGS.has(tagName);

    if (isSelfClosing) continue;

    if (isClosing) {
      const idx = findLastTagIndex(openTags, tagName);
      if (idx !== -1) {
        openTags.splice(idx, 1);
      }
    } else {
      openTags.push({
        tag: tagName,
        fullOpenTag: match[0],
      });
    }
  }
}

/**
 * 열린 태그들을 닫는 문자열을 생성합니다. (역순)
 */
function getClosingTagsString(openTags: OpenTagInfo[]): string {
  return openTags
    .slice()
    .reverse()
    .map((item) => `</${item.tag}>`)
    .join('');
}

/**
 * 열린 태그들을 다시 여는 문자열을 생성합니다. (정순)
 */
function getOpeningTagsString(openTags: OpenTagInfo[]): string {
  return openTags.map((item) => item.fullOpenTag).join('');
}

/**
 * HTML 메시지를 태그 구조가 깨지지 않도록 여러 개의 유효한 HTML 청크로 분할합니다.
 */
export function splitHtml(html: string, maxLength = TELEGRAM_SAFE_MESSAGE_LENGTH): string[] {
  if (!html) return [];
  if (html.length <= maxLength) {
    return [html];
  }

  const lines = html.split('\n');
  const chunks: string[] = [];

  let currentChunk = '';
  const currentOpenTags: OpenTagInfo[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isFirstLineInChunk = currentChunk.length === 0;
    const lineWithSeparator = isFirstLineInChunk ? line : `\n${line}`;

    // 해당 줄을 추가했을 때 필요한 닫는 태그 계산
    const simulatedOpenTags = [...currentOpenTags];
    updateOpenTags(lineWithSeparator, simulatedOpenTags);
    const closingTagsStr = getClosingTagsString(simulatedOpenTags);

    const projectedLength = currentChunk.length + lineWithSeparator.length + closingTagsStr.length;

    if (projectedLength <= maxLength) {
      currentChunk += lineWithSeparator;
      updateOpenTags(lineWithSeparator, currentOpenTags);
    } else {
      // 만약 현재 청크에 이미 내용이 있다면, 현재 청크를 닫아서 완료하고 새 청크 시작
      if (currentChunk.length > 0) {
        const chunkClosingTags = getClosingTagsString(currentOpenTags);
        chunks.push(currentChunk + chunkClosingTags);

        // 새 청크는 이전 열린 태그들을 다시 연 상태로 시작
        const chunkOpeningTags = getOpeningTagsString(currentOpenTags);
        currentChunk = chunkOpeningTags;

        // 새 청크에 현재 줄을 다시 시도
        const newSimulatedOpenTags = [...currentOpenTags];
        updateOpenTags(line, newSimulatedOpenTags);
        const newClosingTagsStr = getClosingTagsString(newSimulatedOpenTags);

        if (currentChunk.length + line.length + newClosingTagsStr.length <= maxLength) {
          currentChunk += line;
          updateOpenTags(line, currentOpenTags);
          continue;
        }
      }

      // 한 줄 자체가 maxLength보다 긴 경우: 글자 단위로 분할
      let remainingLine = line;
      while (remainingLine.length > 0) {
        const currentOpeningTagsStr = getOpeningTagsString(currentOpenTags);
        const currentClosingTagsStr = getClosingTagsString(currentOpenTags);

        const availableLen = Math.max(50, maxLength - currentChunk.length - currentClosingTagsStr.length - 10);

        if (remainingLine.length <= availableLen) {
          currentChunk += remainingLine;
          updateOpenTags(remainingLine, currentOpenTags);
          remainingLine = '';
        } else {
          // 태그 중간이나 HTML 엔티티 중간에 잘리지 않도록 안전 슬라이스
          let sliceLen = availableLen;
          const ampIdx = remainingLine.lastIndexOf('&', sliceLen);
          const semiIdx = remainingLine.lastIndexOf(';', sliceLen);
          if (ampIdx !== -1 && (semiIdx === -1 || ampIdx > semiIdx) && sliceLen - ampIdx < 10) {
            sliceLen = ampIdx;
          }

          const ltIdx = remainingLine.lastIndexOf('<', sliceLen);
          const gtIdx = remainingLine.lastIndexOf('>', sliceLen);
          if (ltIdx !== -1 && (gtIdx === -1 || ltIdx > gtIdx)) {
            sliceLen = ltIdx;
          }

          sliceLen = Math.max(1, sliceLen);
          const piece = remainingLine.slice(0, sliceLen);
          remainingLine = remainingLine.slice(sliceLen);

          currentChunk += piece;
          updateOpenTags(piece, currentOpenTags);

          const closingTags = getClosingTagsString(currentOpenTags);
          chunks.push(currentChunk + closingTags);

          currentChunk = getOpeningTagsString(currentOpenTags);
        }
      }
    }
  }

  if (currentChunk.length > 0) {
    const closingTagsStr = getClosingTagsString(currentOpenTags);
    chunks.push(currentChunk + closingTagsStr);
  }

  return chunks.filter((c) => c.length > 0);
}

/**
 * 일반 텍스트 메시지를 줄바꿈 단위로 여러 청크로 분할합니다.
 */
export function splitPlainText(text: string, maxLength = TELEGRAM_SAFE_MESSAGE_LENGTH): string[] {
  if (!text) return [];
  if (text.length <= maxLength) {
    return [text];
  }

  const lines = text.split('\n');
  const chunks: string[] = [];
  let currentChunk = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineWithSep = currentChunk.length === 0 ? line : `\n${line}`;

    if (currentChunk.length + lineWithSep.length <= maxLength) {
      currentChunk += lineWithSep;
    } else {
      if (currentChunk.length > 0) {
        chunks.push(currentChunk);
        currentChunk = '';
      }

      if (line.length <= maxLength) {
        currentChunk = line;
      } else {
        // 한 줄 자체가 긴 경우 글자 수 단위로 분할
        let remaining = line;
        while (remaining.length > 0) {
          const piece = remaining.slice(0, maxLength);
          remaining = remaining.slice(maxLength);
          if (remaining.length > 0) {
            chunks.push(piece);
          } else {
            currentChunk = piece;
          }
        }
      }
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

/**
 * MarkdownV2 텍스트를 이스케이프 문자 깨짐 없이 분할합니다.
 */
export function splitMarkdownV2(text: string, maxLength = TELEGRAM_SAFE_MESSAGE_LENGTH): string[] {
  if (!text) return [];
  if (text.length <= maxLength) {
    return [text];
  }

  const lines = text.split('\n');
  const chunks: string[] = [];
  let currentChunk = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineWithSep = currentChunk.length === 0 ? line : `\n${line}`;

    if (currentChunk.length + lineWithSep.length <= maxLength) {
      currentChunk += lineWithSep;
    } else {
      if (currentChunk.length > 0) {
        chunks.push(currentChunk);
        currentChunk = '';
      }

      if (line.length <= maxLength) {
        currentChunk = line;
      } else {
        let remaining = line;
        while (remaining.length > 0) {
          let sliceEnd = Math.min(maxLength, remaining.length);
          if (sliceEnd < remaining.length && remaining[sliceEnd - 1] === '\\') {
            let backslashCount = 0;
            let j = sliceEnd - 1;
            while (j >= 0 && remaining[j] === '\\') {
              backslashCount++;
              j--;
            }
            if (backslashCount % 2 === 1) {
              sliceEnd -= 1;
            }
          }

          const piece = remaining.slice(0, sliceEnd);
          remaining = remaining.slice(sliceEnd);
          if (remaining.length > 0) {
            chunks.push(piece);
          } else {
            currentChunk = piece;
          }
        }
      }
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

/**
 * 옵션(parseMode, maxLength 등)에 따라 메시지를 안전한 크기의 청크 배열로 분할합니다.
 */
export function splitTelegramMessage(text: string, options: SplitOptions = {}): string[] {
  if (!text) return [];

  const maxLength = options.maxLength ?? TELEGRAM_SAFE_MESSAGE_LENGTH;
  const parseMode = options.parseMode;

  if (text.length <= maxLength) {
    return [text];
  }

  if (parseMode === 'HTML') {
    return splitHtml(text, maxLength);
  }

  if (parseMode === 'MarkdownV2') {
    return splitMarkdownV2(text, maxLength);
  }

  return splitPlainText(text, maxLength);
}

/**
 * HTML 문자열을 태그 깨짐 없이 안전하게 maxLength 이내로 자릅니다 (단일 메시지 축약용).
 */
export function truncateHtml(
  html: string,
  maxLength = TELEGRAM_SAFE_MESSAGE_LENGTH,
  suffix = '\n\n... (길이 제한으로 생략됨)',
): string {
  if (!html || html.length <= maxLength) {
    return html;
  }

  const estimatedClosingTagsOverhead = 150;
  const targetContentLength = Math.max(50, maxLength - suffix.length - estimatedClosingTagsOverhead);

  const tagRegex = new RegExp(TAG_REGEX.source, 'g');
  const openTags: OpenTagInfo[] = [];

  let result = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(html)) !== null) {
    const textChunk = html.slice(lastIndex, match.index);
    const fullTag = match[0];
    const isClosing = match[1] === '/';
    const tagName = match[2].toLowerCase();
    const isSelfClosing = match[3] === '/' || VOID_TAGS.has(tagName);

    if (result.length + textChunk.length >= targetContentLength) {
      const allowedTextLen = Math.max(0, targetContentLength - result.length);
      let sliceEnd = allowedTextLen;

      const ampIndex = textChunk.lastIndexOf('&', sliceEnd);
      const semiIndex = textChunk.lastIndexOf(';', sliceEnd);
      if (ampIndex !== -1 && (semiIndex === -1 || ampIndex > semiIndex) && sliceEnd - ampIndex < 10) {
        sliceEnd = ampIndex;
      }

      result += textChunk.slice(0, sliceEnd);
      break;
    }

    result += textChunk;

    if (result.length + fullTag.length >= targetContentLength) {
      break;
    }

    result += fullTag;
    lastIndex = tagRegex.lastIndex;

    if (!isSelfClosing) {
      if (isClosing) {
        const idx = findLastTagIndex(openTags, tagName);
        if (idx !== -1) {
          openTags.splice(idx, 1);
        }
      } else {
        openTags.push({ tag: tagName, fullOpenTag: fullTag });
      }
    }
  }

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

  result += suffix;
  result += getClosingTagsString(openTags);

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
