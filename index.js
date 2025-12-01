const http = require('http'), https = require('https'), fs = require('fs'), path = require('path'), { spawn, execSync } = require('child_process');

// ==============================================================================
//   1. 基础配置
// ==============================================================================
const TMP = path.join(__dirname, 'tmp');
const HUB_BIN = path.join(TMP, 'hub_app');      // HubProxy Binary
const ARGO_BIN = path.join(TMP, 'cloudflared'); // Cloudflared Binary
const HUB_TAR = path.join(TMP, 'hub.tar.gz');

// 端口定义 (直接使用主端口)
const PORT = parseInt(process.env.SERVER_PORT || process.env.PORT || 7860); 

// Argo 配置 (可选)
const ENABLE_ARGO = 0; // 默认开启 Argo
const ARGO_TOKEN = process.env.ARGO_TOKEN || '';         // 如果有固定 Token
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || '';       // 如果有固定域名

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

// 获取 HubProxy 最新地址
const getHubProxyUrl = () => new Promise((resolve) => {
    console.log('🔍 Checking HubProxy version...');
    const fallback = 'https://github.com/sky22333/hubproxy/releases/download/v1.1.9/hubproxy-v1.1.9-linux-amd64.tar.gz';
    const req = https.get('https://github.com/sky22333/hubproxy/releases/latest', (res) => {
        try {
            if (res.statusCode === 302 && res.headers.location) {
                 const loc = res.headers.location;
                 const tag = loc ? path.basename(loc) : 'v1.1.9';
                 resolve(`https://github.com/sky22333/hubproxy/releases/download/${tag}/hubproxy-${tag}-linux-amd64.tar.gz`);
            } else { resolve(fallback); }
        } catch(e) { resolve(fallback); }
    });
    req.on('error', () => resolve(fallback));
    req.setTimeout(5000, () => { req.destroy(); resolve(fallback); });
});

// 查找解压后的二进制文件
const findBin = (dir, name) => {
    try {
        const files = fs.readdirSync(dir, { withFileTypes: true });
        for (const f of files) {
            const fullPath = path.join(dir, f.name);
            if (f.isDirectory()) {
                const res = findBin(fullPath, name);
                if (res) return res;
            } else if (f.name === name || (f.name.startsWith(name) && !f.name.endsWith('.gz'))) {
                return fullPath;
            }
        }
    } catch (e) {}
    return null;
};

// ==============================================================================
//   3. 主程序
// ==============================================================================
(async () => {
    // 初始化临时目录
    if (fs.existsSync(TMP)) fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(TMP, { recursive: true });

    try {
        console.log('⏳ Starting initialization...');
        const downloadList = [];

        // 1. 获取并下载 HubProxy
        const hubUrl = await getHubProxyUrl();
        console.log(`⏬ Downloading HubProxy from: ${hubUrl}`);
        downloadList.push(download(hubUrl, HUB_TAR));

        // 2. 下载 Cloudflared (如果开启)
        if (ENABLE_ARGO) {
            console.log('⏬ Downloading Cloudflared...');
            downloadList.push(download('https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64', ARGO_BIN));
        }

        await Promise.all(downloadList);

        // 3. 解压并运行 HubProxy
        console.log('📦 Unzipping HubProxy...');
        execSync(`tar -xzf ${HUB_TAR} -C ${TMP}`);
        const hubFound = findBin(TMP, 'hubproxy');
        
        if (!hubFound) throw new Error('HubProxy binary not found in archive');
        
        // 移动并赋权
        if (hubFound !== HUB_BIN) fs.renameSync(hubFound, HUB_BIN);
        fs.chmodSync(HUB_BIN, 0o755);

        console.log(`🐳 Starting HubProxy on port ${PORT}...`);
        // HubProxy 运行参数
        spawn(HUB_BIN, ['--addr', `:${PORT}`], {
            stdio: 'inherit', // 将日志输出到控制台
            detached: true,
            env: { ...process.env }
        }).unref();

        // 4. 运行 Argo Tunnel (Cloudflared)
        if (ENABLE_ARGO && fs.existsSync(ARGO_BIN)) {
            fs.chmodSync(ARGO_BIN, 0o755);
            console.log('☁️  Starting Cloudflared...');

            if (ARGO_TOKEN) {
                // 使用固定 Token (推荐)
                spawn(ARGO_BIN, ['tunnel', 'run', '--token', ARGO_TOKEN], { stdio: 'inherit', detached: true }).unref();
                if (ARGO_DOMAIN) console.log(`🔗 Custom Domain: https://${ARGO_DOMAIN}`);
            } else {
                // 使用临时隧道 (Quick Tunnel)
                const t = spawn(ARGO_BIN, ['tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate'], { stdio: ['ignore', 'ignore', 'pipe'] });
                t.stderr.on('data', d => {
                    const m = d.toString().match(/(https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com)/);
                    if (m) console.log(`\n🔗 Argo Quick Link: ${m[1]}\n`);
                });
            }
        }

    } catch (e) {
        console.error('❌ Error during startup:', e);
        process.exit(1);
    }

    // 5. 清理与保活
    setTimeout(() => {
        if (fs.existsSync(TMP)) {
             // 保留二进制文件运行，但可以清理压缩包，这里为了简单暂时不清理BIN目录
             // fs.rmSync(TMP, { recursive: true, force: true }); 
             console.log('✅ Startup sequence completed.');
        }
    }, 10000);

    // 防止 Node 进程退出
    setInterval(() => console.log('💗 Keep alive', new Date().toISOString()), 300000);

})();
