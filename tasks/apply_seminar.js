const { safeGoto, sendTelegram } = require('../modules/utils');

const SEMINAR_PAGE = 'https://www.doctorville.co.kr/seminar/main';

async function run({ page, context, env }) {
    // Placeholder: implement seminar application logic here
    try {
        await safeGoto(page, SEMINAR_PAGE, { waitUntil: 'load', timeout: 30000 }, 1);

        const totalSeminarLinks = await page.locator('a.list_detail');
        const totalCount = await totalSeminarLinks.count();
        console.log('Total seminar links found:', totalCount);

        // Collect hrefs (and visible text) from elements that have the apply icon
        const applyLocator = page.locator('a:has(.ico_apply)');
        const items = await applyLocator.evaluateAll(nodes => nodes.map(n => ({ href: n.getAttribute('href'), text: (n.textContent || '').trim() })));

        for (const item of items) {
            console.log('Applying for seminar:', item.text, item.href);
            await safeGoto(page, item.href, { waitUntil: 'load', timeout: 30000 }, 1);
            // await page.screenshot({ path: 'screenshot/shot.png', fullPage: true }).catch(() => { });

            // Click the apply button but avoid long default timeouts
            try {
                await page.click('a#applyLiveSeminarMemberBtn', { timeout: 5000 }).catch((e) => { console.error('Error clicking apply button:', e); });
            } catch (e) {
                console.error('apply button click threw:', e && e.message ? e.message : e);
            }

            // If the agree checkbox/button appears quickly, click it — use a short timeout to avoid waiting for the global timeout
            try {
                await page.waitForSelector('#seminarAgree', { timeout: 2000 });
                await page.click('#seminarAgree').catch((e) => { console.error('Error clicking agree checkbox:', e); });
            } catch (e) {
                // Not present within 2s — continue without blocking
            }

            // small delay to allow any client-side actions to settle
            await page.waitForTimeout(500);
            console.log('success applied for seminar');
        }

        const appliedCount = await page.locator('a:has(.ico_completion)').count();
        await sendTelegram(`✅ ${items.length}개 세미나 신청 완료! (${appliedCount}/${totalCount})`).catch(() => { });
        return true;
    } catch (e) {
        console.error('seminar task error', e && e.stack ? e.stack : e);
        await sendTelegram(`❗ 세미나 신청 작업 오류: ${e && e.message ? e.message : String(e)}`).catch(() => { });
        return false;
    }
}

module.exports = { run };
