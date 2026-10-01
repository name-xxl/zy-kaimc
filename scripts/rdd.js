#!/usr/bin/env node
/* KaiOS 远程调试工具（B2G/Gecko 48 debugger-socket 协议）。
 *
 * 用法（先 adb forward tcp:6000 localfilesystem:/data/local/debugger-socket）：
 *   node scripts/rdd.js shot [png路径]     远程截屏
 *   node scripts/rdd.js running            列出正在运行的 App
 *   node scripts/rdd.js install <app目录>   安装打包应用（push + webappsActor install）
 *   node scripts/rdd.js request <json>     原始请求透传（探测用，自动替换 actor 占位符）
 */
'use strict';
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const PORT = parseInt(process.env.RDD_PORT || '6000', 10);
const cmd = process.argv[2];
const arg = process.argv[3];

const sock = net.connect({ host: '127.0.0.1', port: PORT });
sock.setNoDelay(true);

let buf = Buffer.alloc(0);
let actors = null;
let seq = 0;
const waiters = [];   /* 每个元素等待一个响应 */

function send(obj) {
  const json = JSON.stringify(obj);
  if (process.env.RDD_DEBUG) console.error('SEND ' + json.slice(0, 140));
  sock.write(json.length + ':' + json);
}

function request(obj) {
  return new Promise((resolve, reject) => {
    waiters.push({ resolve, reject });
    send(obj);
  });
}

/* longString 字段拼接。此固件的 substring 参数是 start/end（非 Gecko 标准的 from/charLength），
 * 且返回的 value 可能仍是嵌套 longString 对象，需递归展开。 */
async function unlongify(v) {
  if (!v || typeof v !== 'object') return v;
  if (v.type !== 'longString') return v;
  let out = v.initial || '';
  while (out.length < v.length) {
    const r = await request({
      to: v.actor,
      type: 'substring',
      start: out.length,
      end: Math.min(out.length + 1000000, v.length)
    });
    if (r.error) throw new Error('substring failed: ' + JSON.stringify(r).slice(0, 200));
    /* 此固件的响应字段是 substring（字符串），也可能是嵌套 longString（value） */
    const piece = (typeof r.substring === 'string') ? r.substring : await unlongify(r.value);
    if (!piece) throw new Error('substring 返回空: ' + JSON.stringify(r).slice(0, 200));
    out += piece;
  }
  /* release 的响应可能不来，不能等它 */
  try { send({ to: v.actor, type: 'release' }); } catch (e) { /* 忽略 */ }
  return out;
}

function feed() {
  for (;;) {
    const colon = buf.indexOf(':');
    if (colon === -1) return;
    const len = parseInt(buf.slice(0, colon).toString(), 10);
    if (Number.isNaN(len) || len < 0 || len > 256 * 1024 * 1024) return;
    if (buf.length < colon + 1 + len) return;
    const payload = buf.slice(colon + 1, colon + 1 + len).toString();
    buf = buf.slice(colon + 1 + len);
    let o;
    try { o = JSON.parse(payload); } catch (e) { continue; }
    if (process.env.RDD_DEBUG) console.error('RECV ' + payload.slice(0, 140));
    if (o.from === 'root' && o.webappsActor && !actors) {
      actors = o;
      main().catch((e) => { console.error('FAIL:', e.message || e); process.exit(1); });
      continue;
    }
    const w = waiters.shift();
    if (w) w.resolve(o);
  }
}

async function listTabs() {
  const r = await request({ to: 'root', type: 'listTabs' });
  if (!r.webappsActor) throw new Error('listTabs 无 webappsActor: ' + JSON.stringify(r).slice(0, 200));
  actors = r;
  return r;
}

async function shot(outFile) {
  const r = await request({ to: actors.deviceActor, type: 'screenshotToDataURL' });
  const dataUrl = await unlongify(r.value !== undefined ? r.value : r);
  if (typeof dataUrl !== 'string' || dataUrl.indexOf('data:image') !== 0) {
    throw new Error('截屏返回异常: ' + JSON.stringify(dataUrl).slice(0, 200));
  }
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const out = outFile || 'logs/shot-' + Date.now() + '.png';
  fs.writeFileSync(out, Buffer.from(b64, 'base64'));
  console.log('SAVED ' + out + ' (' + b64.length + ' b64 chars)');
}

async function running() {
  const r = await request({ to: actors.webappsActor, type: 'listRunningApps' });
  const apps = r.apps || [];
  console.log('RUNNING ' + apps.length);
  for (const a of apps) {
    console.log('  ' + a);
    /* 拉每个运行中 App 的 manifest 看名字 */
    try {
      const ar = await request({ to: actors.webappsActor, type: 'getAppActor', manifestURL: a });
      if (ar.actor) console.log('    actor=' + ar.actor);
      if (ar.name) console.log('    name=' + ar.name);
      if (ar.error) console.log('    (' + ar.error + ')');
    } catch (e) { /* 忽略 */ }
  }
}

async function install(appDir) {
  const manifestPath = path.join(appDir, 'manifest.webapp');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const uuid = crypto.randomUUID();
  const remoteDir = '/data/local/tmp/b2g/' + uuid;
  console.log('PUSH ' + appDir + ' -> ' + remoteDir);
  execFileSync('adb', ['shell', 'mkdir', '-p', remoteDir]);
  pushDir(appDir, remoteDir);
  const verify = execFileSync('adb', ['shell', 'ls', remoteDir]).toString();
  console.log('VERIFY ' + JSON.stringify(verify.trim()));
  const req = {
    to: actors.webappsActor,
    type: 'install',
    appId: uuid,
    metadata: {},
    manifest: manifest
  };
  console.log('INSTALL appId=' + uuid);
  const r = await request(req);
  console.log('RESPONSE ' + JSON.stringify(r).slice(0, 600));
  return r;
}

function pushDir(localDir, remoteDir) {
  for (const entry of fs.readdirSync(localDir, { withFileTypes: true })) {
    const lp = path.join(localDir, entry.name);
    const rp = remoteDir + '/' + entry.name;
    if (entry.isDirectory()) {
      execFileSync('adb', ['shell', 'mkdir', '-p', rp]);
      pushDir(lp, rp);
    } else {
      execFileSync('adb', ['push', lp, rp], { stdio: 'pipe' });
    }
  }
}

async function raw(jsonArg) {
  const placeholders = {
    webapps: actors.webappsActor,
    device: actors.deviceActor,
    settings: actors.settingsActor,
    root: 'root'
  };
  const obj = JSON.parse(jsonArg, (k, v) => (typeof v === 'string' && placeholders[v] !== undefined) ? placeholders[v] : v);
  const r = await request(obj);
  console.log(JSON.stringify(r).slice(0, 3000));
}

async function main() {
  await listTabs();
  if (cmd === 'shot') await shot(arg);
  else if (cmd === 'running') await running();
  else if (cmd === 'install') await install(arg);
  else if (cmd === 'request') await raw(arg);
  else throw new Error('未知命令: ' + cmd + '（shot/running/install/request）');
  sock.end();
  setTimeout(() => process.exit(0), 200);
}

sock.on('connect', () => {
  send({ to: 'root', type: 'listTabs' });
});
sock.on('data', (d) => { buf = Buffer.concat([buf, d]); feed(); });
sock.on('error', (e) => { console.error('SOCKET ERROR:', e.message); process.exit(1); });
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 120000);
