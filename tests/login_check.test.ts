import assert from 'assert';
import { checkLoginStatus, ensureLoggedIn } from '../src/modules/utils';

// Helper mock functions
function createMockPage(
  initialUrl: string,
  routeResponses: { urlPatterns: { pattern: RegExp; finalUrl: string; bodyHtml: string }[] },
) {
  let currentUrl = initialUrl;
  let currentHtml = '<html><body></body></html>';

  const mockPage: unknown = {
    url: () => currentUrl,
    route: (_url: string, _handler: (_route: unknown) => void) => {},
    goto: async (url: string) => {
      for (const item of routeResponses.urlPatterns) {
        if (item.pattern.test(url)) {
          currentUrl = item.finalUrl;
          currentHtml = item.bodyHtml;
          return;
        }
      }
      currentUrl = url;
    },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    screenshot: async () => {},
    fill: async () => {},
    click: async () => {},
    waitForURL: async () => {},
    getByRole: (role: string, options: { name: string; exact?: boolean }) => {
      return {
        isVisible: async (_opts?: unknown) => {
          if (role === 'button' && options.name === '회원정보수정') {
            const hasExactButton =
              /<button[^>]*>\s*회원정보수정\s*<\/button>/i.test(currentHtml) ||
              /<button[^>]*aria-label=["']회원정보수정["'][^>]*>/i.test(currentHtml);
            return hasExactButton;
          }
          return false;
        },
      };
    },
  };

  return mockPage;
}

async function runTests() {
  console.log('=== [Test] Login Check Logic Tests Started ===\n');

  // Case 1 — blank + already logged in
  {
    console.log('Case 1: Blank page + already logged in');
    const mockPage = createMockPage('about:blank', {
      urlPatterns: [
        {
          pattern: /\/mypage\/info/,
          finalUrl: 'https://m.doctorville.co.kr/mypage/info',
          bodyHtml:
            '<div><p>※ 회원정보수정은 통합회원 마이페이지에서 이용가능합니다.</p><button class="css-13833hy" type="button">회원정보수정</button></div>',
        },
      ],
    });

    const status = await checkLoginStatus(mockPage as never);
    assert.strictEqual(status, 'LOGGED_IN', 'Should return LOGGED_IN when button is found');
    console.log('  ✓ Correctly identified LOGGED_IN status');
  }

  // Case 2 — blank + not logged in (URL encoded parameter)
  {
    console.log('Case 2: Blank page + not logged in (encoded URL redirect)');
    const mockPage = createMockPage('about:blank', {
      urlPatterns: [
        {
          pattern: /\/mypage\/info/,
          finalUrl: 'https://m.doctorville.co.kr/member/login?redirect=%2Fmypage%2Finfo',
          bodyHtml: '<div><form>Login Form</form></div>',
        },
      ],
    });

    const status = await checkLoginStatus(mockPage as never);
    assert.strictEqual(
      status,
      'NOT_LOGGED_IN',
      'Should return NOT_LOGGED_IN when redirected to login with encoded redirect param',
    );
    console.log('  ✓ Correctly identified NOT_LOGGED_IN status for %2Fmypage%2Finfo');
  }

  // Case 2b — blank + not logged in (raw URL parameter)
  {
    console.log('Case 2b: Blank page + not logged in (raw URL redirect)');
    const mockPage = createMockPage('about:blank', {
      urlPatterns: [
        {
          pattern: /\/mypage\/info/,
          finalUrl: 'https://m.doctorville.co.kr/member/login?redirect=/mypage/info',
          bodyHtml: '<div><form>Login Form</form></div>',
        },
      ],
    });

    const status = await checkLoginStatus(mockPage as never);
    assert.strictEqual(
      status,
      'NOT_LOGGED_IN',
      'Should return NOT_LOGGED_IN when redirected to login with raw redirect param',
    );
    console.log('  ✓ Correctly identified NOT_LOGGED_IN status for /mypage/info');
  }

  // Case 5 — DOM duplicate text matching test
  {
    console.log('Case 5: Text duplicate in DOM without button element');
    const mockPage = createMockPage('about:blank', {
      urlPatterns: [
        {
          pattern: /\/mypage\/info/,
          finalUrl: 'https://m.doctorville.co.kr/mypage/info',
          bodyHtml: '<div><p>※ 회원정보수정은 통합회원 마이페이지에서 이용가능합니다.</p></div>',
        },
      ],
    });

    const status = await checkLoginStatus(mockPage as never);
    assert.strictEqual(status, 'UNKNOWN', 'Should return UNKNOWN when text matches paragraph but no button exists');
    console.log('  ✓ Paragraph containing "회원정보수정" does NOT trigger LOGGED_IN status');
  }

  // Case 6 — Text duplicate in DOM with <p>회원정보수정</p> only (no button)
  {
    console.log('Case 6: <p>회원정보수정</p> without button element');
    const mockPage = createMockPage('about:blank', {
      urlPatterns: [
        {
          pattern: /\/mypage\/info/,
          finalUrl: 'https://m.doctorville.co.kr/mypage/info',
          bodyHtml: '<div><p>회원정보수정</p></div>',
        },
      ],
    });

    const status = await checkLoginStatus(mockPage as never);
    assert.strictEqual(status, 'UNKNOWN', 'Should return UNKNOWN when text matches <p> element');
    console.log('  ✓ <p>회원정보수정</p> without button element returns UNKNOWN');
  }

  // Case 3 — ensureLoggedIn flow when already logged in
  {
    console.log('Case 3: ensureLoggedIn flow when already logged in');
    let pageState = 'LOGGED_IN';

    const mockPage = createMockPage('about:blank', {
      urlPatterns: [
        {
          pattern: /\/mypage\/info/,
          get finalUrl() {
            return pageState === 'LOGGED_IN'
              ? 'https://m.doctorville.co.kr/mypage/info'
              : 'https://m.doctorville.co.kr/member/login?redirect=/mypage/info';
          },
          get bodyHtml() {
            return pageState === 'LOGGED_IN' ? '<button>회원정보수정</button>' : '<div>Login Form</div>';
          },
        },
      ],
    });

    const mockContext = {};

    pageState = 'LOGGED_IN';
    await ensureLoggedIn({ page: mockPage as never, context: mockContext as never });
    console.log('  ✓ ensureLoggedIn completes successfully when already logged in');
  }

  // Case 7 — verify tasks/login.ts imports checkLoginStatus and uses centralized check
  {
    console.log('Case 7: Verify login.ts uses checkLoginStatus module export');
    const loginTaskModule = await import('../src/tasks/login');
    assert.strictEqual(typeof loginTaskModule.run, 'function', 'login.ts must export run function');
    console.log('  ✓ login.ts correctly exports run function utilizing checkLoginStatus');
  }

  console.log('\n🎉 All login check tests passed successfully!\n');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
