const http = require('http'), https = require('https'), fs = require('fs'), path = require('path'), { spawn, execSync } = require('child_process');

// ==============================================================================
//   1. 配置区
// ==============================================================================
const VERSION = '2.0.2'; // 锁定版本
const APP_DIR = path.join(__dirname, 'uptime-kuma-app'); 
const DATA_DIR = path.join(__dirname, 'data');           
const ZIP_FILE = path.join(__dirname, 'uptime-kuma.zip');
const PORT = parseInt(process.env.SERVER_PORT || process.env.PORT || 7860); 

// --- 账户配置逻辑 ---
// 优先读取环境变量，否则使用默认值或随机生成
const ADMIN_USER = process.env.KUMA_ADMIN_USER || 'admin';
let ADMIN_PASS = process.env.KUMA_ADMIN_PASSWORD || ''; // 如果为空，后面会随机生成

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

const genPassword = () => {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#%^&*';
    let pass = '';
    for (let i = 0; i < 12; i++) pass += chars.charAt(Math.floor(Math.random() * chars.length));
    return pass;
};

// ==============================================================================
//   3. 主程序
// ==============================================================================
(async () => {
    // 1. 初始化目录
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    // 2. 检查安装状态
    const isInstalled = fs.existsSync(path.join(APP_DIR, 'server', 'server.js')) && fs.existsSync(path.join(APP_DIR, 'node_modules'));

    try {
        if (!isInstalled) {
            console.log(`⚡ Uptime Kuma not found. Installing v${VERSION}...`);
            
            // 清理旧文件
            if (fs.existsSync(APP_DIR)) fs.rmSync(APP_DIR, { recursive: true, force: true });
            
            // 下载
            const url = `https://github.com/louislam/uptime-kuma/archive/refs/tags/${VERSION}.zip`;
            console.log(`⏬ Downloading: ${url}`);
            await download(url, ZIP_FILE);

            // 解压
            console.log('📦 Unzipping...');
            execSync(`unzip -q ${ZIP_FILE} -d ${__dirname}`);
            const extracted = fs.readdirSync(__dirname).find(f => f.startsWith(`uptime-kuma-${VERSION}`));
            fs.renameSync(path.join(__dirname, extracted), APP_DIR);
            fs.unlinkSync(ZIP_FILE);

            // 安装依赖
            console.log('☕ Installing dependencies (1-3 mins)...');
            execSync('npm install --production', { 
                cwd: APP_DIR, 
                stdio: 'inherit',
                env: { ...process.env, PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: 'true' } 
            });

            // 下载前端
            console.log('📥 Downloading assets...');
            execSync('npm run download-dist', { cwd: APP_DIR, stdio: 'inherit' });
        }

        // ==========================================================================
        //   🔴 自动初始化 (Auto Setup)
        // ==========================================================================
        const dbFile = path.join(DATA_DIR, 'kuma.db');
        
        // 仅在数据库不存在时执行初始化
        if (!fs.existsSync(dbFile)) {
            console.log('⚙️  No database found. Running Auto-Setup...');
            
            // 决定密码来源
            let passSource = 'ENV';
            if (!ADMIN_PASS) {
                ADMIN_PASS = genPassword();
                passSource = 'GENERATED';
            }

            // 使用 JSON.stringify 安全地注入字符串，防止密码中包含特殊字符破坏脚本
            const safeUser = JSON.stringify(ADMIN_USER);
            const safePass = JSON.stringify(ADMIN_PASS);

            // 创建临时 setup 脚本
            const setupScriptContent = `
                const Database = require('./server/database');
                const { R } = require('redbean-node');
                const bcrypt = require('bcryptjs');

                (async () => {
                    try {
                        console.log('   -> Connecting & initializing SQLite schema...');
                        await Database.connect(); 

                        console.log('   -> Creating admin user...');
                        const bean = R.dispense('user');
                        bean.username = ${safeUser}; 
                        bean.password = bcrypt.hashSync(${safePass}, 10);
                        bean.timezone = 'auto';
                        bean.active = 1;
                        await R.store(bean);
                        
                        console.log('   -> Setup done.');
                        process.exit(0);
                    } catch (e) {
                        console.error(e);
                        process.exit(1);
                    }
                })();
            `;

            const setupScriptPath = path.join(APP_DIR, 'autosetup_temp.js');
            fs.writeFileSync(setupScriptPath, setupScriptContent);

            // 执行 setup
            execSync('node autosetup_temp.js', {
                cwd: APP_DIR,
                env: { ...process.env, DATA_DIR: DATA_DIR },
                stdio: 'inherit'
            });

            fs.unlinkSync(setupScriptPath);

            // 🟢 显示账号密码
            console.log('\n=============================================================');
            console.log('✅ Auto Setup Completed Successfully!');
            console.log('-------------------------------------------------------------');
            console.log(`👤 Username : ${ADMIN_USER}`);
            console.log(`🔑 Password : ${ADMIN_PASS}  [Source: ${passSource}]`);
            console.log('=============================================================\n');
            
            // 备份到文件
            fs.writeFileSync(path.join(DATA_DIR, 'credentials.txt'), `User: ${ADMIN_USER}\nPass: ${ADMIN_PASS}`);

        } else {
            console.log('✅ Database exists. Skipping auto-setup.');
        }

        // ==========================================================================
        //   启动服务器
        // ==========================================================================
        console.log(`🚀 Starting Uptime Kuma on port ${PORT}...`);
        
        const child = spawn('node', ['server/server.js'], {
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
