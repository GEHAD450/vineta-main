#!/usr/bin/env node
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import FormData from 'form-data';
import chokidar from 'chokidar';
import { exec } from 'child_process';
import { promisify } from 'util';
import puppeteer from 'puppeteer';

const execPromise = promisify(exec);

const {
  ZID_BASE,
  ZID_EMAIL,
  ZID_PASSWORD,
  THEME_ID,
  THEME_NAME,
  THEME_CODE,
  THEME_FOLDER,
  ZIP_EXE_PATH
} = process.env;

if (!ZID_EMAIL || !ZID_PASSWORD || !THEME_ID) {
  console.error('❌ Please set ZID_EMAIL, ZID_PASSWORD and THEME_ID in .env');
  process.exit(1);
}

const FOLDER_PATH = path.join(process.cwd(), THEME_FOLDER);
const ZIP_PATH = path.join(process.cwd(), 'zip', `${THEME_FOLDER}.zip`);
const COOKIES_FILE = path.join(process.cwd(), 'cookies.json');

// Debug information
console.log('🔧 Debug Information:');
console.log('📂 Current working directory:', process.cwd());
console.log('📁 Theme folder name:', THEME_FOLDER);
console.log('📍 Full folder path:', FOLDER_PATH);
console.log('📦 Zip path:', ZIP_PATH);
console.log('🍪 Cookies file:', COOKIES_FILE);
console.log('📋 Folder exists:', fs.existsSync(FOLDER_PATH));
if (fs.existsSync(FOLDER_PATH)) {
  const files = fs.readdirSync(FOLDER_PATH);
  console.log('📄 Files in folder:', files.length, 'files');
  console.log('📝 Sample files:', files.slice(0, 5));
}

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
  console.log('🔐 Opening browser… please log in manually, we’ll assist where possible');

  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();

  await page.goto(`${ZID_BASE}/login`, { waitUntil: 'networkidle2' });

  console.log('👁️ Monitoring page to auto-fill email/password when fields appear…');

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
  console.log('✅ Logged in and cookies saved.');
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
          console.log('✅ Reused saved cookies');
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

async function zipTheme() {
  console.log('📦 Zipping theme folder…');
  
  // Try to delete the existing zip file with retry logic
  if (fs.existsSync(ZIP_PATH)) {
    let retries = 5;
    while (retries > 0) {
      try {
        fs.unlinkSync(ZIP_PATH);
        break;
      } catch (err) {
        if (err.code === 'EBUSY' && retries > 1) {
          console.log(`⏳ File busy, retrying... (${retries - 1} attempts left)`);
          await new Promise(resolve => setTimeout(resolve, 1000));
          retries--;
        } else {
          throw err;
        }
      }
    }
  }
  
  await execPromise(
    `"${ZIP_EXE_PATH}" a -tzip "${ZIP_PATH}" "*" -r -y`,
    { cwd: FOLDER_PATH }
  );
  console.log('✅ Zipped to', ZIP_PATH);
}

async function listThemes() {
  try {
    await ensureAuth();
    const res = await axios.get(`${ZID_BASE}/api/v1/themes`, {
      headers: {
        'X-Xsrf-Token': xsrfToken,
        'Cookie': cookie
      }
    });
    
    if (res.data && res.data.data) {
      console.log('📋 Available themes:');
      res.data.data.forEach(theme => {
        console.log(`  - ${theme.name} (ID: ${theme.id})`);
      });
      return res.data.data;
    }
  } catch (err) {
    console.error('❌ Error listing themes:', err.response?.data || err.message);
  }
  return [];
}

async function uploadTheme() {
  try {
    await ensureAuth();
    await new Promise(resolve => setTimeout(resolve, 500));
    await zipTheme();

    const form = new FormData();
    form.append('name', THEME_NAME);
    form.append('code', THEME_CODE);
    form.append('file', fs.createReadStream(ZIP_PATH));

    const res = await axios.post(
      `${ZID_BASE}/api/v1/themes/${THEME_ID}/update`,
      form,
      {
        headers: {
          ...form.getHeaders(),
          'X-Xsrf-Token': xsrfToken,
          'Cookie': cookie,
          'Origin': ZID_BASE,
          'Referer': `${ZID_BASE}/theme-market`
        }
      }
    );
    if(res.data && res.data.status === 'success'){
      console.log('🚀 Upload success:', res.data);
    }else{
      const errorMessage = res.data?.message || 'Unknown error';
      console.error('❌ Upload error:', errorMessage);
      
      // If theme not found, list available themes
      if (errorMessage && errorMessage.includes('لم يتم إيجاد الثييم المطلوب')) {
        console.log('🔍 Theme ID not found. Listing available themes...');
        await listThemes();
        console.log('💡 Please update THEME_ID in .env file with the correct ID from the list above.');
        return;
      }
      
      // remove cookies.json and login again for other errors
      if (fs.existsSync(COOKIES_FILE)) {
        fs.unlinkSync(COOKIES_FILE);
      }
      await ensureAuth(true);
      return uploadTheme();
    }
  } catch (err) {
    if (err.response?.status === 401) {
      console.log('⚠️ Session expired, retrying login…');
      await ensureAuth(true);
      return uploadTheme();
    }

    const errorData = err.response?.data;
    const errorMessage = errorData?.message || errorData || err.message || 'Unknown error';
    console.error('❌ Upload error:', errorMessage);
  }
}

let uploadInProgress = false;
let uploadTimeout = null;

console.log('👀 Watching folder for changes:', FOLDER_PATH);
console.log('📁 Full path being watched:', path.resolve(FOLDER_PATH));

const watcher = chokidar.watch(FOLDER_PATH, { 
  ignoreInitial: true,
  persistent: true,
  followSymlinks: false,
  depth: 99,
  awaitWriteFinish: {
    stabilityThreshold: 100,
    pollInterval: 50
  },
  usePolling: false,
  interval: 100,
  binaryInterval: 300
});

watcher
  .on('ready', () => {
    console.log('✅ File watcher is ready and watching for changes...');
  })
  .on('error', error => {
    console.error('❌ Watcher error:', error);
  })
  .on('all', (evt, file) => {
    console.log(`🔄 Detected ${evt}: ${file}`);
    console.log(`📝 File extension: ${path.extname(file)}`);
    console.log(`⏰ Time: ${new Date().toLocaleTimeString()}`);
    
    // Clear any existing timeout
    if (uploadTimeout) {
      clearTimeout(uploadTimeout);
    }
    
    // Set a new timeout to debounce rapid changes
    uploadTimeout = setTimeout(async () => {
      if (uploadInProgress) {
        console.log('⏳ Upload already in progress, skipping...');
        return;
      }
      
      uploadInProgress = true;
      try {
        console.log('🚀 Starting upload process...');
        await uploadTheme();
      } finally {
        uploadInProgress = false;
        console.log('✅ Upload process completed');
      }
    }, 1000); // Wait 1 second after last change
  });
