const http = require('http'), https = require('https'), fs = require('fs'), path = require('path'), { spawn, execSync } = require('child_process');

// ==============================================================================
//   1. 基础配置
// ==============================================================================
const APP_DIR = path.join(__dirname, 'uptime-kuma-app'); 
const DATA_DIR = path.join(__dirname, 'data');           
const ZIP_FILE = path.join(__dirname, 'uptime-kuma.zip');

// 🔴 在这里指定你想要的版本，填 '2.0.2' 就会强制下载 2.0.2
// 如果填空字符串 ''，则自动去获取 Latest
const FIXED_VERSION = '2.0.2'; 

const PORT = parseInt(process.env.SERVER_PORT || process.env.PORT || 7860); 

// ==============================================================================
//   2. 辅助函数
// ==============================================================================
const download = (url, dest) => new Promise((resolve, reject) => {
  const file = fs.createWriteStream(dest);
  (url.startsWith('https') ? https : http).get(url, res => {
    if (res.statusCode === 301 || res.statusCode === 302) {
      if (!res.headers.location) return reject('No location');
      return download(res.headers.location, dest).then(resolve).catch(reject);
    }
    if (res.statusCode !== 200) return reject('Status ' + res.statusCode);
    res.pipe(file);
    file.on('finish', () => file.close(resolve));
  }).on('error', (err) => { fs.unlink(dest, () => {}); reject(err); });
});

// 获取下载地址 (支持指定版本)
const getDownloadUrl = () => new Promise((resolve) => {
    // 1. 如果指定了版本，直接构造 URL，不请求 GitHub API，速度更快且准
    if (FIXED_VERSION) {
        console.log(`🎯 Target version locked: ${FIXED_VERSION}`);
        resolve(`https://github.com/louislam/uptime-kuma/archive/refs/tags/${FIXED_VERSION}.zip`);
        return;
    }

    // 2. 否则自动获取 Latest
    console.log('🔍 Checking Latest Uptime Kuma version...');
    const fallback = 'https://github.com/louislam/uptime-kuma/archive/refs/tags/2.0.2.zip';
    const req = https.get('https://github.com/louislam/uptime-kuma/releases/latest', (res) => {
        try {
            const loc = res.headers.location;
            if (loc) {
                const tag = path.basename(loc); 
                resolve(`https://github.com/louislam/uptime-kuma/archive/refs/tags/${tag}.zip`);
            } else { resolve(fallback); }
        } catch(e) { resolve(fallback); }
    });
    req.on('error', () => resolve(fallback));
    req.setTimeout(5000, () => { req.destroy(); resolve(fallback); });
});

// ==============================================================================
//   3. 主程序
// ==============================================================================
(async () => {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    // ⚠️ 核心逻辑修改：如果指定了版本，且当前安装的不是这个版本(简单判断文件夹)，建议手动删除
    // 这里为了安全，只做基本检查。如果 APP_DIR 不存在，就视为需要安装。
    const isInstalled = fs.existsSync(path.join(APP_DIR, 'server', 'server.js')) && fs.existsSync(path.join(APP_DIR, 'node_modules'));

    try {
        if (!isInstalled) {
            console.log('⚡ Uptime Kuma not found. Starting installation...');
            
            // 清理残余
            if (fs.existsSync(APP_DIR)) fs.rmSync(APP_DIR, { recursive: true, force: true });
            if (fs.existsSync(ZIP_FILE)) fs.unlinkSync(ZIP_FILE);

            // 1. 获取 URL
            const url = await getDownloadUrl();
            console.log(`⏬ Downloading from: ${url}`);
            await download(url, ZIP_FILE);

            // 2. 解压
            console.log('📦 Unzipping...');
            try { execSync(`unzip -q ${ZIP_FILE} -d ${__dirname}`); } 
            catch (e) { console.error('❌ Unzip failed. Ensure "unzip" is installed.'); process.exit(1); }
            
            // 处理解压后的文件夹名
            const files = fs.readdirSync(__dirname);
            const extractedDir = files.find(f => f.startsWith('uptime-kuma-') && fs.statSync(path.join(__dirname, f)).isDirectory());
            if (!extractedDir) throw new Error('Extracted directory not found');
            
            fs.renameSync(path.join(__dirname, extractedDir), APP_DIR);
            fs.unlinkSync(ZIP_FILE);

            // 3. 安装依赖
            console.log('☕ Installing dependencies (1-3 mins)...');
            execSync('npm install --production', { 
                cwd: APP_DIR, 
                stdio: 'inherit',
                env: { ...process.env, PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: 'true' } 
            });

            // 4. 下载前端资源
            console.log('📥 Downloading frontend assets...');
            execSync('npm run download-dist', { cwd: APP_DIR, stdio: 'inherit' });

        } else {
            console.log('✅ Found existing installation.');
            console.log('💡 To update, please delete the "uptime-kuma-app" folder and restart.');
        }

        // 5. 启动
        console.log(`🚀 Starting Uptime Kuma (${FIXED_VERSION || 'Latest'}) on port ${PORT}...`);
        
        const child = spawn('node', [path.join(APP_DIR, 'server', 'server.js')], {
            cwd: APP_DIR,
            env: { ...process.env, UPTIME_KUMA_PORT: String(PORT), DATA_DIR: DATA_DIR, PORT: String(PORT) },
            stdio: 'inherit'
        });

        child.on('close', (code) => process.exit(code));

    } catch (e) {
        console.error('❌ Error:', e);
        process.exit(1);
    }
})();
