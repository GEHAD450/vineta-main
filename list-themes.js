#!/usr/bin/env node
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import puppeteer from 'puppeteer';

const {
  ZID_BASE,
  ZID_EMAIL,
  ZID_PASSWORD
} = process.env;

if (!ZID_EMAIL || !ZID_PASSWORD) {
  console.error('❌ Please set ZID_EMAIL and ZID_PASSWORD in .env');
  process.exit(1);
}

const COOKIES_FILE = path.join(process.cwd(), 'cookies.json');

let cookie = '';
let xsrfToken = '';

function serializeCookies(cookies) {
  return cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
}

async function saveCookiesToFile(cookies) {
  fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
}

function loadCookiesFromFile() {
  if (!fs.existsSync(COOKIES_FILE)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf-8'));
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function extractTokensFromCookies(cookies) {
  cookie = serializeCookies(cookies);
  const xsrf = cookies.find(c => c.name === 'XSRF-TOKEN');
  if (!xsrf) throw new Error('XSRF-TOKEN not found in cookies');
  xsrfToken = decodeURIComponent(xsrf.value);
}

async function performLoginWithPuppeteer() {
  console.log('🔐 Opening browser for login...');

  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();

  await page.goto(`${ZID_BASE}/login`, { waitUntil: 'networkidle2' });

  console.log('👁️ Auto-filling credentials...');

  let emailSubmitted = false;
  let passwordSubmitted = false;

  const interval = setInterval(async () => {
    if (page.isClosed()) return clearInterval(interval);

    const url = page.url();

    try {
      if (!emailSubmitted) {
        const emailInput = await page.$('input[name="email"]');
        if (emailInput) {
          const value = await page.evaluate(el => el.value, emailInput);
          if (!value) {
            await emailInput.type(ZID_EMAIL);
            console.log('📧 Email filled');
            setTimeout(async () => {
              const submitBtn = await page.$('button.zid-form__submit[type="button"]');
              if (submitBtn) {
                await submitBtn.click();
                console.log('🖱️ Email submit clicked');
                emailSubmitted = true;
              }
            }, 1000);
          }
        }
      }

      if (url.includes('/otp')) {
        const passwordLink = await page.$('a[href="/login/password"]');
        if (passwordLink) {
          await passwordLink.click();
          console.log('🔁 Switched to password login');
        }
      }

      if (url.includes('/login/password') && !passwordSubmitted) {
        const passwordInput = await page.$('input[name="password"]');
        if (passwordInput) {
          const value = await page.evaluate(el => el.value, passwordInput);
          if (!value) {
            await passwordInput.type(ZID_PASSWORD);
            console.log('🔒 Password filled');
            setTimeout(async () => {
              const loginBtn = await page.$('button.zid-form__submit[type="button"]');
              if (loginBtn) {
                await loginBtn.click();
                console.log('🖱️ Login clicked');
                passwordSubmitted = true;
              }
            }, 1000);
          }
        }
      }
    } catch {}
  }, 1000);

  await page.waitForFunction(() => location.href === 'https://web.zid.sa/home', { timeout: 300000 });
  clearInterval(interval);

  const cookies = await page.cookies();
  extractTokensFromCookies(cookies);
  await saveCookiesToFile(cookies);

  await browser.close();
  console.log('✅ Logged in successfully');
}

async function ensureAuth(forceLogin = false) {
  if (!forceLogin) {
    const saved = loadCookiesFromFile();
    if (saved) {
      try {
        extractTokensFromCookies(saved);
        const check = await axios.get(`${ZID_BASE}/api/v1/account`, {
          headers: {
            'X-Xsrf-Token': xsrfToken,
            'Cookie': cookie
          },
          validateStatus: s => s < 500
        });
        if (check.status === 200) {
          console.log('✅ Using saved cookies');
          return;
        } else {
          console.warn('⚠️ Invalid cookies, logging in again');
        }
      } catch {
        console.warn('⚠️ Error with saved cookies, logging in again');
      }
    }
  }
  await performLoginWithPuppeteer();
}

async function listThemes() {
  try {
    await ensureAuth();
    console.log('🔍 Fetching available themes...');
    
    const res = await axios.get(`${ZID_BASE}/api/v1/themes`, {
      headers: {
        'X-Xsrf-Token': xsrfToken,
        'Cookie': cookie
      }
    });
    
    if (res.data && res.data.data) {
      console.log('\n📋 Available themes in your account:');
      console.log('=' .repeat(60));
      
      res.data.data.forEach((theme, index) => {
        console.log(`${index + 1}. Name: ${theme.name}`);
        console.log(`   ID: ${theme.id}`);
        console.log(`   Status: ${theme.status || 'N/A'}`);
        console.log(`   Created: ${theme.created_at || 'N/A'}`);
        console.log('-'.repeat(40));
      });
      
      console.log('\n💡 To use a theme, copy its ID and update THEME_ID in your .env file');
      console.log('💡 Current THEME_ID in .env:', process.env.THEME_ID);
      
      return res.data.data;
    } else {
      console.log('❌ No themes found or unexpected response format');
    }
  } catch (err) {
    console.error('❌ Error listing themes:', err.response?.data || err.message);
  }
  return [];
}

// Run the script
listThemes().then(() => {
  console.log('\n✅ Done! Update your .env file with the correct THEME_ID');
  process.exit(0);
}).catch(err => {
  console.error('❌ Script failed:', err);
  process.exit(1);
});
