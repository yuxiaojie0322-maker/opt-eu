// tests/optiklink.spec.js
const { test, expect } = require('@playwright/test');
const https = require('https');

// 环境变量解析
const DISCORD_TOKEN = (process.env.DISCORD_TOKEN || '').trim();
let [email, password] = (process.env.DISCORD_ACCOUNT || ',').split(',');
if (!email && process.env.DISCORD_EMAIL) email = process.env.DISCORD_EMAIL;
if (!password && process.env.DISCORD_PASSWORD) password = process.env.DISCORD_PASSWORD;

const PANEL_API_KEY = (process.env.PANEL_API_KEY || '').trim();
const PANEL_URL = (process.env.PANEL_URL || 'https://control.optiklink.net').replace(/\/+$/, '');
const PANEL_SERVER_ID = (process.env.PANEL_SERVER_ID || '').trim();

// Telegram 推送配置（支持 TG_BOT 格式 "chat_id,token" 或分别配置 CHAT_ID / BOT_TOKEN）
const TG_CHAT_ID = (process.env.CHAT_ID || (process.env.TG_BOT || ',').split(',')[0] || '').trim();
const TG_TOKEN = (process.env.BOT_TOKEN || (process.env.TG_BOT || ',').split(',')[1] || '').trim();

const TIMEOUT = 60000;

function nowStr() {
    return new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).replace(/\//g, '-');
}

function sendTG(result, serverName = 'OptikLink') {
    return new Promise((resolve) => {
        if (!TG_CHAT_ID || !TG_TOKEN) {
            console.log('⚠️ TG 推送未配置 (缺少 TG_BOT 或 BOT_TOKEN / CHAT_ID)，跳过推送');
            return resolve();
        }

        const msg = [
            `🎮 OptikLink 保活与巡检通知`,
            `🕐 运行时间: ${nowStr()}`,
            `🖥 服务器: ${serverName}`,
            `📊 执行结果:\n${result}`,
        ].join('\n');

        const body = JSON.stringify({ chat_id: TG_CHAT_ID, text: msg });
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${TG_TOKEN}/sendMessage`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        }, (res) => {
            if (res.statusCode === 200) {
                console.log('📨 TG 推送成功');
            } else {
                console.log(`⚠️ TG 推送失败：HTTP ${res.statusCode}`);
            }
            resolve();
        });

        req.on('error', (e) => {
            console.log(`⚠️ TG 推送异常：${e.message}`);
            resolve();
        });

        req.setTimeout(15000, () => {
            console.log('⚠️ TG 推送超时');
            req.destroy();
            resolve();
        });

        req.write(body);
        req.end();
    });
}

// 🧮 主站数学验证码自动求解（支持 label 或正文提示）
async function solveMathCaptcha(page) {
    try {
        const captchaLabel = page.locator('label:has-text("+"), label:has-text("-"), label:has-text("*"), .captcha-text, [id*="captcha"], p:has-text("What is")');
        if (await captchaLabel.count() > 0) {
            const text = await captchaLabel.first().innerText();
            const match = text.match(/(\d+)\s*([\+\-\*])\s*(\d+)/);
            if (match) {
                const n1 = parseInt(match[1], 10);
                const op = match[2];
                const n2 = parseInt(match[3], 10);
                let ans = 0;
                if (op === '+') ans = n1 + n2;
                else if (op === '-') ans = n1 - n2;
                else if (op === '*') ans = n1 * n2;

                console.log(`🧮 识别到主站数学算式: ${n1} ${op} ${n2} = ${ans}`);
                const captchaInput = page.locator('input[name="captcha"], input[placeholder*="captcha"], #captcha, input[name="math_answer"], input[type="text"], input[type="number"]');
                if (await captchaInput.count() > 0) {
                    await captchaInput.first().fill(ans.toString());
                    console.log('✅ 数学验证码填写完成');
                    await page.waitForTimeout(500);
                }
            }
        }
    } catch (e) {
        console.log(`ℹ️ 数学验证码处理跳过: ${e.message}`);
    }
}

// 🧮 处理 Quick Verification 与 Cloudflare Turnstile 页面
async function handleQuickVerification(page) {
    try {
        const content = await page.content();
        const isVerifyPage = content.includes('Quick Verification') 
            || content.includes('Please solve the simple math question')
            || content.includes('OptikLink | Verification')
            || page.url().includes('verification')
            || (page.url().includes('/login') && content.includes('math_answer'));

        if (!isVerifyPage) {
            return;
        }

        console.log('🔍 检测到 Quick Verification / Cloudflare Turnstile 验证页，正在处理...');

        // 打印表单与输入框结构用于诊断
        try {
            const formInfo = await page.evaluate(() => {
                const form = document.querySelector('form');
                if (!form) return '未找到 form 元素';
                const inputs = Array.from(form.querySelectorAll('input, button, select')).map(el => ({
                    tag: el.tagName,
                    type: el.type || '',
                    name: el.name || '',
                    id: el.id || '',
                    value: el.value ? el.value.slice(0, 20) : ''
                }));
                return { action: form.action, method: form.method, inputs };
            });
            console.log(`📋 表单信息: ${JSON.stringify(formInfo)}`);
        } catch {}

        // 1. 提取并计算算术题
        const bodyText = await page.innerText('body').catch(() => '');
        const match = bodyText.match(/What is\s+(\d+)\s*([\+\-\*])\s*(\d+)/i) 
                   || bodyText.match(/(\d+)\s*([\+\-\*])\s*(\d+)/);

        let ans = null;
        if (match) {
            const n1 = parseInt(match[1], 10);
            const op = match[2];
            const n2 = parseInt(match[3], 10);
            if (op === '+') ans = n1 + n2;
            else if (op === '-') ans = n1 - n2;
            else if (op === '*') ans = n1 * n2;
            console.log(`🧮 求解 Quick Verification 算式: ${n1} ${op} ${n2} = ${ans}`);

            const inp = page.locator("input[name='math_answer'], input[name='captcha'], input[type='text'], input[type='number']");
            if (await inp.count() > 0) {
                await inp.first().fill(ans.toString());
                console.log(`✅ 已填入算式答案: ${ans}`);
            }
        } else {
            console.log('⚠️ 未在页面文本中识别出算术算式');
        }

        // 2. 检测并处理 Cloudflare Turnstile
        const hasTurnstile = await page.evaluate(() => {
            return !!document.querySelector('script[src*="turnstile"]') 
                || !!document.querySelector('input[name="cf-turnstile-response"]')
                || !!document.querySelector('.cf-turnstile')
                || !!document.querySelector('iframe[src*="challenges.cloudflare.com"]');
        });

        if (hasTurnstile) {
            console.log('🛡️ 检测到 Cloudflare Turnstile 验证组件，等待生成 Response Token...');
            
            // 尝试通过模拟鼠标真实坐标点击 Turnstile 复选框区域
            const turnstileEl = page.locator('.cf-turnstile, iframe[src*="challenges.cloudflare.com"], [data-sitekey]').first();
            if (await turnstileEl.count() > 0) {
                await turnstileEl.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
                await page.waitForTimeout(500);
                const box = await turnstileEl.boundingBox().catch(() => null);
                if (box) {
                    const clickX = box.x + 32;
                    const clickY = box.y + (box.height / 2);
                    console.log(`🖱️ 模拟真实鼠标点击 Turnstile 勾选框区域 (${Math.round(clickX)}, ${Math.round(clickY)})...`);
                    await page.mouse.move(clickX, clickY, { steps: 8 });
                    await page.waitForTimeout(200);
                    await page.mouse.click(clickX, clickY);
                }
            }

            let turnstileToken = '';
            for (let i = 0; i < 35; i++) {
                turnstileToken = await page.evaluate(() => {
                    const el = document.querySelector('input[name="cf-turnstile-response"]');
                    if (el && el.value && el.value.length > 10) return el.value;
                    if (window.turnstile && typeof window.turnstile.getResponse === 'function') {
                        const resp = window.turnstile.getResponse();
                        if (resp && resp.length > 10) return resp;
                    }
                    return '';
                });

                if (turnstileToken && turnstileToken.length > 10) {
                    console.log(`✅ Cloudflare Turnstile 验证通过 (Token 长度: ${turnstileToken.length})`);
                    break;
                }

                // 尝试在所有 Frame 中寻找并点击 Turnstile 勾选框
                try {
                    for (const frame of page.frames()) {
                        const fUrl = frame.url();
                        if (fUrl.includes('challenges.cloudflare.com') || fUrl.includes('turnstile')) {
                            const cb = frame.locator('input[type="checkbox"], [type="checkbox"], .ctp-checkbox-label, #challenge-stage, body');
                            if (await cb.count() > 0) {
                                await cb.first().click({ timeout: 1000 }).catch(() => {});
                            }
                        }
                    }
                } catch {}

                // 每隔 6 秒若未通过，再次模拟点击一下控件区域
                if (i === 6 || i === 15 || i === 25) {
                    const box = await turnstileEl.boundingBox().catch(() => null);
                    if (box) {
                        await page.mouse.click(box.x + 32, box.y + (box.height / 2)).catch(() => {});
                    }
                }

                await page.waitForTimeout(1000);
            }

            if (!turnstileToken || turnstileToken.length <= 10) {
                console.log('⚠️ Turnstile 在轮询时间内未就绪，继续尝试提交表单');
            } else {
                // 确保 hidden input 包含该 token
                await page.evaluate((tok) => {
                    let inp = document.querySelector('input[name="cf-turnstile-response"]');
                    if (inp && !inp.value) inp.value = tok;
                }, turnstileToken).catch(() => {});
            }
        }

        // 3. 再次确保数学输入框未被刷新清空
        if (ans !== null) {
            const inp = page.locator("input[name='math_answer'], input[name='captcha'], input[type='text'], input[type='number']");
            if (await inp.count() > 0) {
                const curVal = await inp.first().inputValue().catch(() => '');
                if (curVal !== ans.toString()) {
                    await inp.first().fill(ans.toString());
                    console.log(`🔄 重新补充填入算式答案: ${ans}`);
                }
            }
        }

        await page.waitForTimeout(800);

        // 4. 点击提交按钮
        console.log('📤 点击 CONTINUE WITH LOGIN 提交...');
        const btn = page.locator('button:has-text("CONTINUE"), input[type="submit"], button[type="submit"], button:has-text("LOGIN")');
        if (await btn.count() > 0) {
            await btn.first().click();
        } else {
            const inp = page.locator("input[name='math_answer']");
            if (await inp.count() > 0) {
                await inp.first().press('Enter');
            }
        }

        console.log('⏳ 验证答案已提交，等待页面处理与跳转...');
        await page.waitForTimeout(4000);

    } catch (e) {
        console.log(`ℹ️ Quick Verification 处理异常: ${e.message}`);
    }
}

// 处理 Discord OAuth 授权页（如果需要手动点击）
async function handleOAuthPage(page) {
    await page.waitForTimeout(2000);

    for (let i = 0; i < 5; i++) {
        if (!page.url().includes('discord.com')) return;

        try {
            const btn = await page.waitForSelector('button.primary_a22cb0, button:has-text("Authorize"), button:has-text("授权")', { timeout: 4000 });
            const text = (await btn.innerText()).trim();

            if (/scroll/i.test(text) || text.includes('滚动')) {
                await page.evaluate(() => {
                    const s = document.querySelector('[class*="scroller"]')
                        || document.querySelector('[class*="scrollerBase"]')
                        || document.querySelector('[class*="content"]');
                    if (s) s.scrollTop = s.scrollHeight;
                    window.scrollTo(0, document.body.scrollHeight);
                });
                await page.waitForTimeout(1500);
                await btn.click();
                await page.waitForTimeout(1500);
            } else if (/authorize/i.test(text) || text.includes('授权')) {
                await btn.click();
                console.log('✅ 已点击 Discord 授权按钮');
                await page.waitForTimeout(3000);
                return;
            } else {
                await page.waitForTimeout(1500);
            }
        } catch {
            try {
                await page.waitForURL(url => !url.toString().includes('discord.com'), { timeout: 10000 });
            } catch { /* 继续等待 */ }
            return;
        }
    }
}

// 📡 Pterodactyl API 请求封装（绕过网页端 reCAPTCHA）
function callPanelAPI(path, method = 'GET', body = null) {
    return new Promise((resolve, reject) => {
        if (!PANEL_API_KEY) {
            return reject(new Error('未配置 PANEL_API_KEY 环境变量'));
        }

        const url = new URL(`${PANEL_URL}/api/client${path}`);
        const payload = body ? JSON.stringify(body) : null;
        const req = https.request({
            hostname: url.hostname,
            port: url.port || 443,
            path: url.pathname + url.search,
            method: method,
            headers: {
                'Authorization': `Bearer ${PANEL_API_KEY}`,
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: data ? JSON.parse(data) : null });
                } catch {
                    resolve({ status: res.statusCode, data });
                }
            });
        });

        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

test('OptikLink 自动化保活与巡检', async ({ page }, testInfo) => {
    page.setDefaultTimeout(TIMEOUT);

    if (!DISCORD_TOKEN && (!email || !password)) {
        throw new Error('❌ 缺少 Discord 登录凭据：请配置 DISCORD_TOKEN 或 DISCORD_ACCOUNT (email,password)');
    }

    // 1. 防自动化检测：仅移除 webdriver 特征，保留原生 DOM 原型完整性
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    // 2. 广告拦截：在网络请求层拦截，不篡改页面原生 JS 环境
    const AD_DOMAINS = [
        'tzegilo.com', 'alwingulla.com', 'auqot.com', 'jmosl.com', '094kk.com',
        'tmll7.com', 'oundhertobeconsist.org',
        'pagead2.googlesyndication.com', 'googlesyndication.com',
        'googletagservices.com', 'doubleclick.net',
        'adsbygoogle', 'popads', 'popcash', 'clickadu', 'tsyndicate',
        'trafficjunky', 'afu.php',
    ];

    await page.route('**/*', (route) => {
        const url = route.request().url();
        if (AD_DOMAINS.some(d => url.includes(d))) {
            return route.abort();
        }
        return route.continue();
    });

    // 自动关闭广告弹窗
    page.on('popup', async (popup) => {
        const u = popup.url();
        if (!u.includes('optiklink') && !u.includes('discord.com')) {
            await popup.close().catch(() => {});
        }
    });

    console.log('🚀 浏览器就绪！');

    try {
        // 验证出口 IP
        console.log('🌐 验证代理出口 IP...');
        try {
            const res = await page.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded', timeout: 20000 });
            const body = await res.text();
            const ip = JSON.parse(body).ip || body;
            const masked = ip.replace(/(\d+\.\d+\.\d+\.)\d+/, '$1xx');
            console.log(`✅ 出口 IP 确认：${masked}`);
        } catch {
            console.log('⚠️ IP 验证超时，继续执行');
        }

        // ================= 1. 主站 3 天登录保活 =================
        console.log('🔑 打开 OptikLink 登录授权页...');
        await page.goto('https://optiklink.com/auth', { waitUntil: 'domcontentloaded', timeout: 35000 });

        // 计算并填写主站前置数学验证码（若有）
        await solveMathCaptcha(page);

        // 监听请求以捕获 Discord OAuth URL
        let capturedOAuthUrl = '';
        page.on('request', req => {
            const u = req.url();
            if (u.includes('discord.com/oauth2/authorize')) {
                capturedOAuthUrl = u;
            }
        });

        console.log('📤 点击 Login with Discord...');
        const discordLoginBtn = page.locator("a[href='login'], a[href*='login'], a:has-text('Discord'), button:has-text('Discord')");
        if (await discordLoginBtn.count() > 0) {
            await discordLoginBtn.first().click();
        } else {
            await page.click("a[href='login']");
        }

        console.log('⏳ 等待跳转 Discord 登录/授权页...');
        await page.waitForURL(url => !url.toString().includes('optiklink.com/auth'), { timeout: TIMEOUT });

        let landedUrl = page.url();
        console.log(`📍 当前跳转地址: ${landedUrl}`);

        // 🔑 模式 A: 如果配置了 DISCORD_TOKEN，直接通过 Discord API 高速完成授权 (无需界面与2FA)
        if (DISCORD_TOKEN) {
            console.log('🔑 检测到 DISCORD_TOKEN，尝试通过 Discord API 直接授权...');
            try {
                const targetOAuthUrl = capturedOAuthUrl || (landedUrl.includes('discord.com/oauth2/authorize') ? landedUrl : '');
                let clientId = '933437142254887052';
                let redirectUri = 'https://optiklink.com/login';
                let scope = 'guilds guilds.join identify email';
                let state = '';

                if (targetOAuthUrl) {
                    try {
                        const parsed = new URL(targetOAuthUrl);
                        clientId = parsed.searchParams.get('client_id') || clientId;
                        redirectUri = parsed.searchParams.get('redirect_uri') || redirectUri;
                        scope = parsed.searchParams.get('scope') || scope;
                        state = parsed.searchParams.get('state') || '';
                    } catch {}
                }

                const postData = {
                    authorize: true,
                    permissions: '0',
                };
                let authorizeApiUrl = `https://discord.com/api/v10/oauth2/authorize?client_id=${clientId}&response_type=code&scope=${encodeURIComponent(scope)}&redirect_uri=${encodeURIComponent(redirectUri)}`;
                if (state) authorizeApiUrl += `&state=${encodeURIComponent(state)}`;

                const apiRes = await page.request.post(authorizeApiUrl, {
                    headers: {
                        'Authorization': DISCORD_TOKEN,
                        'Content-Type': 'application/json',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    },
                    data: postData,
                });

                if (apiRes.ok()) {
                    const json = await apiRes.json();
                    const callbackUrl = json.location || json.url;
                    if (callbackUrl) {
                        console.log(`✅ Discord API 授权成功！跳转回调: ${callbackUrl.replace(/code=[^&]+/, 'code=***')}`);
                        await page.goto(callbackUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
                        await page.waitForTimeout(3000);
                    }
                } else {
                    console.log(`ℹ️ Discord API 授权返回 HTTP ${apiRes.status()}，尝试浏览器登录流程...`);
                }
            } catch (apiErr) {
                console.log(`ℹ️ Discord API 授权调用异常: ${apiErr.message}`);
            }
        }

        // 🔑 模式 B: 如果浏览器仍停留在 Discord 登录页，尝试账号密码登录
        if (page.url().includes('discord.com/login')) {
            if (email && password) {
                console.log('✏️ 使用账号密码登录 Discord...');
                await page.fill('input[name="email"]', email);
                await page.fill('input[name="password"]', password);
                console.log('📤 提交登录表单...');
                await page.click('button[type="submit"]');
                try {
                    await page.waitForURL(url => !url.toString().includes('discord.com/login'), { timeout: 20000 });
                } catch {
                    let err = '账密错误或触发了 2FA / 验证码';
                    try { err = await page.locator('[class*="errorMessage"]').first().innerText(); } catch {}
                    throw new Error(`❌ Discord 登录失败: ${err}`);
                }
            }
        }

        // 处理 Discord OAuth 授权页（如果需要手动点击）
        if (page.url().includes('discord.com/oauth2')) {
            console.log('🔍 进入 OAuth 授权页，处理中...');
            await handleOAuthPage(page);
        }

        // 等待离开 Discord
        try {
            await page.waitForURL(url => !url.toString().includes('discord.com'), { timeout: 20000 });
        } catch { /* 继续 */ }

        // 🧮 自动处理 Quick Verification 与 Cloudflare Turnstile
        await handleQuickVerification(page);

        // 如果页面仍处于验证页，再次尝试处理一次
        const pageContentNow = await page.content().catch(() => '');
        if (page.url().includes('verification') || pageContentNow.includes('Quick Verification') || pageContentNow.includes('Please solve')) {
            console.log('🔄 仍处于验证页，再次执行 Quick Verification 验证求解...');
            await handleQuickVerification(page);
        }

        console.log('⏳ 确认到达 OptikLink 主站...');
        try {
            await page.waitForURL(url => {
                const u = url.toString();
                return (u.includes('/home') || u.includes('/dashboard') || u.includes('optiklink.net')) && !u.includes('error');
            }, { timeout: 35000 });
        } catch { /* 继续检查当前页面状态 */ }

        const currentUrl = page.url();
        console.log(`🌐 最终页面 URL: ${currentUrl}`);

        // 严谨校验：严禁把错误页面判为成功
        if (currentUrl.includes('error') || currentUrl.includes('wrong_answer')) {
            const errText = await page.innerText('body').catch(() => '');
            console.log(`❌ 错误页面文本摘要: ${errText.slice(0, 300)}`);
            throw new Error(`❌ 验证码错误或 Turnstile 校验未通过，停留在错误页面: ${currentUrl}`);
        }

        if (!currentUrl.includes('optiklink')) {
            throw new Error(`❌ 未到达 OptikLink 主站，当前 URL: ${currentUrl}`);
        }

        const pageText = await page.innerText('body').catch(() => '');
        if (pageText.includes('ERROR:') && pageText.includes('wrong answer')) {
            throw new Error(`❌ 页面包含错误信息: wrong answer / failed on reCAPTCHA`);
        }

        console.log(`🎉 主站登录保活成功！当前页面：${currentUrl}`);

        // ================= 2. 控制台 API 巡检与开机 =================
        console.log('\n📡 开始执行控制台 API 巡检 (直接调用 Pterodactyl 接口)...');

        if (!PANEL_API_KEY) {
            console.log('⚠️ 未检测到 PANEL_API_KEY 环境变量，跳过控制台巡检。');
            await sendTG('✅ 主站登录保活成功！\n⚠️ 未配置 PANEL_API_KEY，跳过控制台巡检');
            return;
        }

        const serverListRes = await callPanelAPI('');
        let servers = [];
        if (serverListRes.status === 200 && serverListRes.data?.data) {
            servers = serverListRes.data.data;
        }

        if (servers.length === 0 && PANEL_SERVER_ID) {
            servers = [{ attributes: { identifier: PANEL_SERVER_ID, name: `Server-${PANEL_SERVER_ID}` } }];
        }

        console.log(`✅ 控制台 API 连接成功！发现 ${servers.length} 台服务器。`);
        let reportMsg = '✅ 主站 3 天保活已成功重置！\n';

        for (const item of servers) {
            const server = item.attributes;
            const serverId = server.identifier;
            const serverName = server.name;

            console.log(`🔍 正在检查服务器: [${serverName}] (ID: ${serverId})...`);
            const resourceRes = await callPanelAPI(`/servers/${serverId}/resources`);

            if (resourceRes.status === 200) {
                const currentState = resourceRes.data.attributes.current_state;
                console.log(`💻 当前状态: ${currentState}`);

                if (currentState === 'offline' || currentState === 'stopped') {
                    console.log('⚠️ 服务器处于离线状态，正在发送启动指令 [start]...');
                    const powerRes = await callPanelAPI(`/servers/${serverId}/power`, 'POST', { signal: 'start' });
                    
                    if (powerRes.status === 204) {
                        console.log('🚀 开机指令已成功发送！');
                        reportMsg += `🖥 [${serverName}]: 🔄 离线自动拉起中 (Running)\n`;
                    } else {
                        console.log(`❌ 发送开机指令失败: HTTP ${powerRes.status}`);
                        reportMsg += `🖥 [${serverName}]: ❌ 离线且开机失败 (HTTP ${powerRes.status})\n`;
                    }
                } else {
                    console.log('🎉 服务器运行正常！');
                    reportMsg += `🖥 [${serverName}]: 🚀 运行正常 (Running)\n`;
                }
            } else {
                console.log(`⚠️ 无法获取服务器状态，HTTP ${resourceRes.status}`);
                reportMsg += `🖥 [${serverName}]: ⚠️ 获取状态失败 (HTTP ${resourceRes.status})\n`;
            }
        }

        await sendTG(reportMsg.trim());

    } catch (e) {
        try {
            const screenshotPath = testInfo.outputPath('failure.png');
            await page.screenshot({ path: screenshotPath, fullPage: true });
            await testInfo.attach('failure', { path: screenshotPath, contentType: 'image/png' });
            console.log('📸 失败截图已保存');
        } catch { /* 忽略 */ }
        
        await sendTG(`❌ 脚本异常：${e.message}`);
        throw e;
    }
});
