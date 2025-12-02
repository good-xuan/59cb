const http = require('http'), https = require('https'), fs = require('fs'), path = require('path'), { spawn, execSync } = require('child_process');

// ==============================================================================
//   1. 基础配置
// ==============================================================================
const APP_DIR = path.join(__dirname, 'uptime-kuma-app'); // 应用安装目录
const DATA_DIR = path.join(__dirname, 'data');           // 数据持久化目录
const ZIP_FILE = path.join(__dirname, 'uptime-kuma.zip');

// 端口定义 (默认 7860)
const PORT = parseInt(process.env.SERVER_PORT || process.env.PORT || 7860); 

// ==============================================================================
//   2. 辅助函数
// ==============================================================================

// 下载文件
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

// 获取 Uptime Kuma 最新版下载地址
const getLatestUrl = () => new Promise((resolve) => {
    console.log('🔍 Checking Uptime Kuma version...');
    // 默认回退版本 1.23.13
    const fallback = 'https://github.com/louislam/uptime-kuma/archive/refs/tags/1.23.13.zip';
    
    const req = https.get('https://github.com/louislam/uptime-kuma/releases/latest', (res) => {
        try {
            const loc = res.headers.location;
            if (loc) {
                const tag = path.basename(loc); 
                // 下载源码 zip
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
    // 确保数据目录存在
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    // 检查是否已经安装
    const isInstalled = fs.existsSync(path.join(APP_DIR, 'server', 'server.js')) && fs.existsSync(path.join(APP_DIR, 'node_modules'));

    try {
        if (!isInstalled) {
            console.log('⚡ Uptime Kuma not found. Starting installation process...');
            
            // 清理旧文件
            if (fs.existsSync(APP_DIR)) fs.rmSync(APP_DIR, { recursive: true, force: true });
            if (fs.existsSync(ZIP_FILE)) fs.unlinkSync(ZIP_FILE);

            // 1. 下载源码
            const url = await getLatestUrl();
            console.log(`⏬ Downloading source from: ${url}`);
            await download(url, ZIP_FILE);

            // 2. 解压
            console.log('📦 Unzipping...');
            // 使用系统 unzip 命令，如果没有 unzip，可能需要安装
            try {
                execSync(`unzip -q ${ZIP_FILE} -d ${__dirname}`);
            } catch (e) {
                console.error('❌ Unzip failed. Please ensure "unzip" is installed.');
                process.exit(1);
            }
            
            // 找到解压后的文件夹名 (通常是 uptime-kuma-1.23.x)
            const files = fs.readdirSync(__dirname);
            const extractedDir = files.find(f => f.startsWith('uptime-kuma-') && fs.statSync(path.join(__dirname, f)).isDirectory());
            
            if (!extractedDir) throw new Error('Extracted directory not found');
            fs.renameSync(path.join(__dirname, extractedDir), APP_DIR);
            fs.unlinkSync(ZIP_FILE);

            // 3. 安装依赖 (这是最耗时的一步)
            console.log('☕ Installing dependencies (this may take 1-3 minutes)...');
            console.log('   (Running: npm install --production)');
            
            try {
                execSync('npm install --production', { 
                    cwd: APP_DIR, 
                    stdio: 'inherit',
                    env: { ...process.env, PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: 'true' } // 跳过 Chromium 下载以节省时间和空间
                });
            } catch (e) {
                console.error('❌ NPM Install failed. Ensure you have Node.js and build tools installed.');
                process.exit(1);
            }

            // 4. 下载预编译的前端资源 (避免编译 Vue)
            console.log('📥 Downloading pre-built frontend assets...');
            try {
                execSync('npm run download-dist', { cwd: APP_DIR, stdio: 'inherit' });
            } catch (e) {
                console.error('❌ Failed to download frontend assets.');
                process.exit(1);
            }
        } else {
            console.log('✅ Uptime Kuma is already installed. Skipping setup.');
        }

        // 5. 启动应用
        console.log(`🚀 Starting Uptime Kuma on port ${PORT}...`);
        console.log(`📂 Data Directory: ${DATA_DIR}`);

        // Uptime Kuma 使用 UPTIME_KUMA_PORT 和 DATA_DIR 环境变量
        const startEnv = { 
            ...process.env, 
            UPTIME_KUMA_PORT: String(PORT),
            DATA_DIR: DATA_DIR,
            PORT: String(PORT) // 某些环境可能还需要这个
        };

        const serverPath = path.join(APP_DIR, 'server', 'server.js');
        
        const child = spawn('node', [serverPath], {
            cwd: APP_DIR,
            env: startEnv,
            stdio: 'inherit'
        });

        child.on('close', (code) => {
            console.log(`Application exited with code ${code}`);
            process.exit(code);
        });

    } catch (e) {
        console.error('❌ Error:', e);
        process.exit(1);
    }
})();
