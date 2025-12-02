const http = require('http'), https = require('https'), fs = require('fs'), path = require('path'), { spawn, execSync } = require('child_process');

// ==============================================================================
//   1. 基础配置
// ==============================================================================
const APP_DIR = path.join(__dirname, 'uptime-kuma-app'); 
const DATA_DIR = path.join(__dirname, 'data');           
const ZIP_FILE = path.join(__dirname, 'uptime-kuma.zip');
const PORT = parseInt(process.env.SERVER_PORT || process.env.PORT || 7860); 

// --- 账户配置 ---
// 优先读取环境变量，否则使用默认值或随机生成
const ADMIN_USER = process.env.KUMA_ADMIN_USER || 'admin';
let ADMIN_PASS = process.env.KUMA_ADMIN_PASSWORD || ''; 

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

// 获取 Latest Tag (例如: "2.0.2")
const getLatestTag = () => new Promise((resolve) => {
    console.log('🔍 Checking GitHub for latest version...');
    const fallback = '2.0.2'; // 网络失败时的保底版本
    const req = https.get('https://github.com/louislam/uptime-kuma/releases/latest', (res) => {
        try {
            // GitHub releases/latest 会 302 重定向到 /releases/tag/x.x.x
            if (res.headers.location) {
                const tag = path.basename(res.headers.location); 
                resolve(tag);
            } else { resolve(fallback); }
        } catch(e) { resolve(fallback); }
    });
    req.on('error', () => {
        console.log('⚠️ Network error checking latest, using fallback.');
        resolve(fallback);
    });
    req.setTimeout(5000, () => { req.destroy(); resolve(fallback); });
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

    // 2. 检查安装
    // 简单判断: 如果有 server.js 和 node_modules 就认为已安装，跳过下载
    const isInstalled = fs.existsSync(path.join(APP_DIR, 'server', 'server.js')) && fs.existsSync(path.join(APP_DIR, 'node_modules'));

    try {
        if (!isInstalled) {
            // --- 获取版本 ---
            const tag = await getLatestTag();
            console.log(`⚡ Installing Uptime Kuma [Latest: ${tag}]...`);
            
            // 清理旧残留
            if (fs.existsSync(APP_DIR)) fs.rmSync(APP_DIR, { recursive: true, force: true });
            if (fs.existsSync(ZIP_FILE)) fs.unlinkSync(ZIP_FILE);
            
            // 下载源码
            const url = `https://github.com/louislam/uptime-kuma/archive/refs/tags/${tag}.zip`;
            console.log(`⏬ Downloading: ${url}`);
            await download(url, ZIP_FILE);

            // 解压
            console.log('📦 Unzipping...');
            execSync(`unzip -q ${ZIP_FILE} -d ${__dirname}`);
            
            // 动态查找解压出的文件夹 (GitHub zip 解压后通常是 uptime-kuma-2.0.2 这种格式)
            // 过滤掉 data, tmp 等其他文件夹，只找 uptime-kuma 开头的
            const files = fs.readdirSync(__dirname);
            const extractedDir = files.find(f => f.startsWith('uptime-kuma-') && fs.statSync(path.join(__dirname, f)).isDirectory() && f !== 'uptime-kuma-app');
            
            if (!extractedDir) throw new Error('Could not find extracted directory');
            
            fs.renameSync(path.join(__dirname, extractedDir), APP_DIR);
            fs.unlinkSync(ZIP_FILE);

            // 安装依赖
            console.log('☕ Installing dependencies (Running npm install)...');
            execSync('npm install --production', { 
                cwd: APP_DIR, 
                stdio: 'inherit',
                env: { ...process.env, PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: 'true' } 
            });

            // 下载前端资源
            console.log('📥 Downloading frontend assets...');
            execSync('npm run download-dist', { cwd: APP_DIR, stdio: 'inherit' });
        }

        // ==========================================================================
        //   Auto Setup (自动数据库注入)
        // ==========================================================================
        const dbFile = path.join(DATA_DIR, 'kuma.db');
        
        if (!fs.existsSync(dbFile)) {
            console.log('⚙️  No database found. Running Auto-Setup (Pure SQL Mode)...');
            
            // 生成或使用密码
            let passSource = 'ENV';
            if (!ADMIN_PASS) {
                ADMIN_PASS = genPassword();
                passSource = 'GENERATED';
            }

            // 创建临时 setup 脚本 (使用 sqlite3 直接操作，避免引用 App 代码报错)
            const setupScriptContent = `
                const sqlite3 = require('sqlite3').verbose();
                const bcrypt = require('bcryptjs');
                const path = require('path');

                const dbPath = path.join(process.env.DATA_DIR, 'kuma.db');
                const user = process.env.SETUP_USER;
                const pass = process.env.SETUP_PASS;

                console.log('   -> Opening Database: ' + dbPath);
                const db = new sqlite3.Database(dbPath);

                db.serialize(() => {
                    // 创建 User 表 (仅最小化字段，App 启动后会自动迁移完整结构)
                    db.run(\`
                        CREATE TABLE IF NOT EXISTS user (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            username VARCHAR(255),
                            password VARCHAR(255),
                            active BOOLEAN DEFAULT 1,
                            timezone VARCHAR(50)
                        )
                    \`);

                    // 插入管理员
                    const hash = bcrypt.hashSync(pass, 10);
                    const stmt = db.prepare("INSERT INTO user (username, password, active, timezone) VALUES (?, ?, 1, 'auto')");
                    
                    stmt.run(user, hash, function(err) {
                        if (err) {
                            console.error('   ❌ SQL Error:', err.message);
                            process.exit(1);
                        } else {
                            console.log('   ✅ Admin user created.');
                            process.exit(0);
                        }
                    });
                    stmt.finalize();
                });
            `;

            const setupScriptPath = path.join(APP_DIR, 'autosetup_sql.js');
            fs.writeFileSync(setupScriptPath, setupScriptContent);

            // 执行注入
            execSync('node autosetup_sql.js', {
                cwd: APP_DIR,
                env: { 
                    ...process.env, 
                    DATA_DIR: DATA_DIR,
                    SETUP_USER: ADMIN_USER,
                    SETUP_PASS: ADMIN_PASS
                },
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
            
            fs.writeFileSync(path.join(DATA_DIR, 'credentials.txt'), `User: ${ADMIN_USER}\nPass: ${ADMIN_PASS}`);

        } else {
            console.log('✅ Database exists. Skipping setup.');
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
