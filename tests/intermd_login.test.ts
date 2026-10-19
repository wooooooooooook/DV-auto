import http from 'http';
import crypto from 'crypto';
import assert from 'assert';
import { describe, it } from 'vitest';
import { InterMDClient } from '../src/modules/intermd_api';

describe('InterMD Login Tests', () => {
  it('checkEnc.do RSA 암호화 및 login.do multipart/form-data 전송 검증', async () => {
    // 1. RSA 테스트용 키 쌍 생성
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const testPukey = publicKey.toString('base64');
    const testKeyno = 98765;
    const testUserId = 'test_user_id';
    const testUserPw = 'test_password_1234!';

    let checkEncCalled = false;
    let loginCalled = false;
    let loginContentType = '';
    const receivedFields: Record<string, string> = {};

    // 2. Mock HTTP 서버 생성
    const server = http.createServer((req, res) => {
      const url = req.url || '';

      if (url.includes('/login/checkEnc.do') && req.method === 'GET') {
        checkEncCalled = true;
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=UTF-8',
          'Set-Cookie': ['JSESSIONID=dummy_session_123; Path=/; HttpOnly'],
        });
        res.end(
          JSON.stringify({
            pukey: testPukey,
            keyno: testKeyno,
          }),
        );
        return;
      }

      if (url.includes('/login/login.do') && req.method === 'POST') {
        loginCalled = true;
        loginContentType = req.headers['content-type'] || '';

        const chunks: Buffer[] = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
          const bodyBuffer = Buffer.concat(chunks);
          const bodyText = bodyBuffer.toString('latin1');

          // multipart/form-data 필드 파싱
          const boundaryMatch = loginContentType.match(/boundary=(?:["']?)([^"';]+)/i);
          if (boundaryMatch) {
            const boundary = boundaryMatch[1];
            const parts = bodyText.split(`--${boundary}`);
            for (const part of parts) {
              const nameMatch = part.match(/name="([^"]+)"/);
              if (nameMatch) {
                const name = nameMatch[1];
                const headerEndIndex = part.indexOf('\r\n\r\n');
                if (headerEndIndex !== -1) {
                  let value = part.slice(headerEndIndex + 4);
                  if (value.endsWith('\r\n')) {
                    value = value.slice(0, -2);
                  }
                  receivedFields[name] = value;
                }
              }
            }
          }

          res.writeHead(200, {
            'Content-Type': 'application/json; charset=UTF-8',
            'Set-Cookie': ['LOGIN_STATUS=1; Path=/'],
          });
          res.end(
            JSON.stringify({
              code: 'SUCC',
              loginStatus: 1,
              member: true,
              sessionKey: 'valid_session_key_abc',
              memberInfo: {
                memberId: testUserId,
                memberName: '테스트회원',
              },
            }),
          );
        });
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const client = new InterMDClient();
      (client as unknown as { baseUrl: string }).baseUrl = `http://127.0.0.1:${port}`;

      const result = await client.login(testUserId, testUserPw);

      // 검증
      assert.strictEqual(checkEncCalled, true, 'checkEnc.do 가 호출되어야 함');
      assert.strictEqual(loginCalled, true, 'login.do 가 호출되어야 함');
      assert.ok(
        loginContentType.startsWith('multipart/form-data; boundary='),
        `Content-Type이 multipart/form-data 이어야 함 (받은 헤더: ${loginContentType})`,
      );

      // 전송된 필드 검증
      assert.strictEqual(receivedFields['memberId'], testUserId);
      assert.strictEqual(receivedFields['keyno'], String(testKeyno));
      assert.strictEqual(receivedFields['renewYn'], '');
      assert.strictEqual(receivedFields['uuid'], '');
      assert.strictEqual(receivedFields['pushKey'], '');
      assert.strictEqual(receivedFields['device'], '');
      assert.strictEqual(receivedFields['memberOsInfo'], 'P');
      assert.strictEqual(receivedFields['DM_FINAL_DATA'], 'A');

      // RSA 암호화된 비밀번호 복호화 검증
      const encPw = receivedFields['memberPw'];
      assert.ok(encPw, 'memberPw 가 전송되어야 함');
      const decryptedPw = crypto
        .privateDecrypt(
          {
            key: privateKey,
            padding: crypto.constants.RSA_PKCS1_PADDING,
          },
          Buffer.from(encPw, 'base64'),
        )
        .toString('utf8');
      assert.strictEqual(decryptedPw, testUserPw, '서버에서 복호화한 비밀번호가 원래 비밀번호와 일치해야 함');

      // 로그인 결과 검증
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.status_code, '1');
      assert.strictEqual(result.session_key, 'valid_session_key_abc');
      assert.strictEqual(result.member_info?.memberName, '테스트회원');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('로그인 실패 응답 처리 검증', async () => {
    const { publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'der' },
    });

    const server = http.createServer((req, res) => {
      const url = req.url || '';
      if (url.includes('/login/checkEnc.do')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ pukey: publicKey.toString('base64'), keyno: 123 }));
        return;
      }
      if (url.includes('/login/login.do')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            code: 'FAIL',
            loginStatus: '-9',
            msg: '아이디 또는 비밀번호 불일치',
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const client = new InterMDClient();
      (client as unknown as { baseUrl: string }).baseUrl = `http://127.0.0.1:${port}`;

      const result = await client.login('wrong_id', 'wrong_pw');
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.status_code, '-9');
      assert.strictEqual(result.message, '입력한 아이디와 비밀번호가 일치하지 않습니다.');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
