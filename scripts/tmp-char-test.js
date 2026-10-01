/* 定位使老固件 console actor 挂死的字符类别 */
'use strict';
const net = require('net');
const sock = net.connect({ host: '127.0.0.1', port: 6000 });
sock.setNoDelay(true);
let buf = Buffer.alloc(0), actors = null;
const waiters = [];
function send(o){ const j=JSON.stringify(o); sock.write(j.length+':'+j); }
function request(o){ return new Promise(r=>{ waiters.push(r); send(o); }); }
function feed(){
  for(;;){
    const c=buf.indexOf(':'); if(c===-1)return;
    const len=parseInt(buf.slice(0,c).toString(),10); if(Number.isNaN(len))return;
    if(buf.length<c+1+len)return;
    const p=buf.slice(c+1,c+1+len).toString(); buf=buf.slice(c+1+len);
    let o; try{o=JSON.parse(p);}catch(e){continue;}
    if(o.from==='root'&&o.webappsActor&&!actors){actors=o;main();continue;}
    const w=waiters.shift(); if(w)w(o);
  }
}
sock.on('connect',()=>send({to:'root',type:'listTabs'}));
sock.on('data',d=>{buf=Buffer.concat([buf,d]);feed();});
sock.on('error',e=>{console.error('SOCK',e.message);process.exit(1);});
async function main(){
  const lr=await request({to:actors.webappsActor,type:'listRunningApps'});
  const host=lr.apps.find(a=>a.indexOf('33daac74')!==-1);
  const ar=await request({to:actors.webappsActor,type:'getAppActor',manifestURL:host});
  const ca=ar.actor.consoleActor;
  const tests = [
    ['P1 纯中文', "'宿主测试'"],
    ['P2 勾叉', "'✓ ✗'"],
    ['P3 破折号省略号', "'—— …'"],
    ['P4 u转义中文', "'\\u5bbf\\u4e3b'"]
  ];
  for(const [label,text] of tests){
    process.stdout.write(label+' … ');
    const r=await Promise.race([
      request({to:ca,type:'evaluateJS',text}),
      new Promise(res=>setTimeout(()=>res(null),5000))
    ]);
    console.log(r===null?'无响应':(r.exception?'EXC':JSON.stringify(r.result).slice(0,60)));
  }
  process.exit(0);
}
setTimeout(()=>{console.log('TIMEOUT');process.exit(1);},40000);
