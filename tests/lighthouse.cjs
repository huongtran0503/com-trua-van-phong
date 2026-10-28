const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
(async () => {
  const app = express();
  const state = date => ({date,menu:{date,locked:false,postedBy:'admin',dishes:['Sườn heo sốt chua ngọt','Bò xào tiêu đen rau củ','Gà ta chiên nước mắm','Cá basa kho tộ','Canh cải thịt băm','Rau muống xào tỏi']},orders:[],people:{}});
  app.get('/api/state',(req,res) => res.json(state(req.query.date)));
  app.get('/api/health',(req,res) => res.json({ok:true}));
  app.use(express.static(path.join(__dirname,'../public')));
  const server = http.createServer(app);
  const ws = new WebSocketServer({server});
  ws.on('connection',socket => socket.on('message',text => {
    const msg = JSON.parse(text.toString());
    if (msg.type === 'SUBSCRIBE_DATE') socket.send(JSON.stringify({type:'DATE_STATE',date:msg.date,data:state(msg.date)}));
  }));
  server.listen(0,'127.0.0.1');
  await new Promise(resolve => server.once('listening',resolve));
  const {default:lighthouse} = await import('lighthouse');
  const {launch} = await import('chrome-launcher');
  const chrome = await launch({chromePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',chromeFlags:['--headless=new','--no-sandbox','--disable-dev-shm-usage']});
  try {
    const result = await lighthouse('http://127.0.0.1:'+server.address().port,{port:chrome.port,output:['json','html'],logLevel:'error',onlyCategories:['performance','accessibility','best-practices','seo'],blockedUrlPatterns:['*kaspersky-labs.com*']});
    fs.mkdirSync('artifacts',{recursive:true});
    fs.writeFileSync('artifacts/lighthouse.json',result.report[0]);
    fs.writeFileSync('artifacts/lighthouse.html',result.report[1]);
    const categories = Object.fromEntries(Object.entries(result.lhr.categories).map(([key,value]) => [key,Math.round(value.score*100)]));
    const metrics = Object.fromEntries(['first-contentful-paint','largest-contentful-paint','total-blocking-time','cumulative-layout-shift'].map(key=>[key,result.lhr.audits[key].displayValue]));
    const failures = Object.entries(result.lhr.audits).filter(([,a]) => a.score !== null && a.score < 1 && a.details?.type !== 'opportunity').map(([id,a])=>({id,title:a.title,score:a.score,items:Array.isArray(a.details?.items) ? a.details.items.slice(0,3) : undefined}));
    console.log(JSON.stringify({categories,metrics,failedAudits:failures.map(a=>a.id),reports:['artifacts/lighthouse.json','artifacts/lighthouse.html']},null,2));
  } finally { await chrome.kill(); ws.close(); await new Promise(resolve=>server.close(resolve)); }
})().catch(err => { console.error(err); process.exitCode=1; });
