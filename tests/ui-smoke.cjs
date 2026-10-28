const { chromium } = require('@playwright/test');
const express = require('express');
const path = require('path');
const fs = require('fs');
const assert = require('assert/strict');
const dishes = ['Sườn heo sốt chua ngọt','Bò xào tiêu đen rau củ','Gà ta chiên nước mắm','Cá basa kho tộ','Canh cải thịt băm','Rau muống xào tỏi'];
const app = express();
app.use(express.static(path.join(__dirname, '../public')));
const fixture = (date) => ({date, menu:{date,dishes:[...dishes],locked:false,postedBy:'admin'},orders:[],people:{}});
(async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({channel:'chrome',headless:true});
  const errors = [];
  const page = await browser.newPage({viewport:{width:1440,height:1100},colorScheme:'light',reducedMotion:'reduce'});
  const stores = new Map();
  let failOrder = false, failState = false, delayState = 0;
  const stateFor = date => { if (!stores.has(date)) stores.set(date, fixture(date)); return stores.get(date); };
  await page.routeWebSocket('**', socket => { socket.onMessage(() => {}); });
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/api/state') {
      if (delayState) await new Promise(resolve => setTimeout(resolve, delayState));
      if (failState) return route.fulfill({status:503,json:{error:'Offline fixture'}});
      return route.fulfill({json:stateFor(url.searchParams.get('date'))});
    }
    if (url.pathname === '/api/health') return route.fulfill({json:{ok:true}});
    if (url.pathname === '/api/network') return route.fulfill({json:{localUrl:origin,lanIps:[]}});
    const data = request.method() === 'POST' ? request.postDataJSON() : null;
    const date = data?.date || await page.locator('#dateInput').inputValue();
    const state = stateFor(date);
    if (url.pathname === '/api/people') { state.people[data.id] = data; return route.fulfill({json:{success:true}}); }
    if (url.pathname === '/api/order' && request.method() === 'POST') {
      if (failOrder) return route.fulfill({status:503,json:{error:'Chưa gửi được đơn. Vui lòng thử lại.'}});
      if (state.menu?.locked) return route.fulfill({status:403,json:{error:'Đơn ngày này đã chốt.'}});
      const order = {...data,id:data.id || 'fixture-'+Date.now(),createdAt:Date.now()};
      state.orders = [...state.orders.filter(o => o.id !== order.id),order];
      return route.fulfill({json:{success:true,order}});
    }
    if (url.pathname.startsWith('/api/order/') && request.method() === 'DELETE') { state.orders = state.orders.filter(o => o.id !== decodeURIComponent(url.pathname.split('/').pop())); return route.fulfill({json:{success:true}}); }
    if (url.pathname === '/api/menu') { state.menu = {...(state.menu || {}),...data}; return route.fulfill({json:{success:true,menu:state.menu}}); }
    return route.fulfill({json:{success:true}});
  });
  page.on('pageerror', err => errors.push(err.message));
  page.on('response', response => { if (response.status() >= 400 && new URL(response.url()).pathname.startsWith('/assets/')) errors.push('Missing asset: '+response.url()); });
  const waitFor = async (selector, count) => {
    await page.waitForFunction(({selector,count}) => document.querySelectorAll(selector).length === count,{selector,count});
  };
  const noOverflow = async () => { const info = await page.evaluate(() => ({width:innerWidth,scroll:document.documentElement.scrollWidth,nodes:[...document.querySelectorAll('body *')].filter(el => el.getBoundingClientRect().right > innerWidth+1).map(el => ({tag:el.tagName,id:el.id,class:el.className,right:el.getBoundingClientRect().right})).slice(0,12)})); assert.equal(info.scroll <= info.width,true,JSON.stringify(info)); };
  try {
    await page.goto(origin);
    await waitFor('#dishChips .dish-choice-card',6);
    await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(img => img.decode().catch(() => {}))); });
    await page.locator('#toast').evaluate(el => { el.hidden = true; }); await page.screenshot({path:'artifacts/desktop-light.png',fullPage:true});
    await noOverflow();
    await page.locator('#submitBtn').click();
    assert.equal(await page.locator('#nameError').isVisible(),true);
    await page.locator('#nameInput').fill('Minh Anh'); await page.locator('#saveNameBtn').click();
    await page.locator('#meView').waitFor({state:'visible'});
    await page.locator('#dishChips button').nth(0).click(); await page.locator('#dishChips button').nth(4).click();
    assert.equal(await page.locator('#dishChips [aria-pressed="true"]').count(),2);
    await page.locator('[data-tag="Ít cay"]').click(); assert.equal(await page.locator('#noteInput').inputValue(),'Ít cay');
    await page.locator('[data-tag="Ít cay"]').click(); assert.equal(await page.locator('#noteInput').inputValue(),'');
    await page.locator('[data-tag="Canh riêng"]').click();
    await page.locator('label:has(#rice-it)').click();
    failOrder = true; await page.locator('#submitBtn').click();
    await page.locator('#submitError').waitFor({state:'visible'});
    assert.equal(await page.locator('#dishChips [aria-pressed="true"]').count(),2,'Failed submission retains choices');
    failOrder = false; await page.locator('#submitBtn').click();
    await page.locator('#hasMyOrderBox').waitFor({state:'visible'});
    assert.match(await page.locator('#myOrderTicket').textContent(),/Minh Anh/);
    await page.locator('#editMyOrderBtn').click(); await page.locator('#noteInput').fill('Không hành');
    await page.locator('#submitBtn').click();
    await page.waitForFunction(() => document.querySelector('#myOrderTicket').textContent.includes('Không hành'));
    await page.locator('#tabOrdersListBtn').click(); await waitFor('#orderList li',1);
    await page.locator('#orderSearchInput').fill('zz-no-result'); assert.equal(await page.locator('#orderEmpty').isVisible(),true);
    await page.locator('#orderSearchInput').fill('');
    await page.locator('#orderList button').filter({hasText:'Sửa'}).click();
    assert.equal(await page.locator('#viewOrder').isVisible(),true,'Editing a list order opens the order tab');
    await page.locator('#cancelEditBtn').click();
    await page.locator('#tabOrdersListBtn').click(); await page.locator('#lockBtn').click();
    await page.locator('#tabOrderBtn').click();
    await page.locator('#lockNotice').waitFor({state:'visible'});
    assert.equal(await page.locator('#submitBtn').isDisabled(),true);
    await page.locator('#tabMenuBtn').click(); assert.equal(await page.locator('.menu-dish-action:disabled').count(),6);
    await page.locator('#tabOrderBtn').click(); await page.locator('#unlockBtn').click();
    await page.locator('#lockNotice').waitFor({state:'hidden'});
    await page.locator('#forOther').check(); await page.locator('#otherName').fill('Bảo Trâm');
    await page.locator('#dishChips button').first().click(); await page.locator('#submitBtn').click();
    await page.locator('#tabOrdersListBtn').click(); await waitFor('#orderList li',2);
    assert.equal(await page.locator('#orderList button').filter({hasText:'Sửa'}).count(),2,'Orders placed for others remain manageable');
    await page.locator('#tabOrderBtn').click(); await page.locator('#deleteMyOrderBtn').click(); await page.locator('#deleteMyOrderBtn').click();
    await page.locator('#hasMyOrderBox').waitFor({state:'hidden'});
    await page.locator('#tabOrderBtn').focus(); await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#tabMenuBtn').getAttribute('aria-selected'),'true');
    await page.locator('#toggleEditMenuTabBtn').click();
    await page.locator('#menuText').fill(''); await page.locator('#saveMenuBtn').click(); assert.equal(await page.locator('#menuError').isVisible(),true);
    await page.locator('#menuText').fill('Đậu hũ hấp nấm\nBí xanh luộc\nCá thu sốt cà');
    await page.locator('#saveMenuBtn').click(); await page.locator('#menuEditor').waitFor({state:'hidden'});
    await page.locator('#tabOrderBtn').click(); await waitFor('#dishChips .dish-choice-card',3);
    assert.match(await page.locator('#dishChips').textContent(),/Đậu hũ hấp nấm/,'Arbitrary daily names work without category or image records');
    assert.equal(await page.locator('#dishChips img').count(),0);
    await page.locator('#tabMenuBtn').click(); await page.locator('#toggleEditMenuTabBtn').click();
    await page.locator('#menuText').fill(''); await page.locator('#prevMenuBtn').click(); await page.waitForFunction(() => document.querySelector('#menuText').value.includes('Sườn heo'), null, {timeout:3000}); // previous day's menu copied, not saved yet
    assert.equal(await page.locator('#menuEditor').isVisible(),true);
    await page.locator('#sampleMenuBtn').click(); await page.locator('#saveMenuBtn').click(); await page.locator('#menuEditor').waitFor({state:'hidden'});
    await page.locator('#shareBtn').click(); assert.equal(await page.locator('#shareModal').isVisible(),true);
    await page.keyboard.press('Escape'); assert.equal(await page.locator('#shareModal').isVisible(),false);
    assert.equal(await page.locator('#shareBtn').evaluate(el => el === document.activeElement),true);
    await page.locator('#tabOrderBtn').click(); await page.locator('#themeToggleBtn').click();
    await page.locator('#toast').evaluate(el => { el.hidden = true; }); await page.screenshot({path:'artifacts/desktop-dark.png',fullPage:true}); await noOverflow();
    await page.locator('#themeToggleBtn').click();
    for (const width of [320,375,390,768,1024]) {
      await page.setViewportSize({width,height:900}); await noOverflow();
      if (width === 390) await page.locator('#toast').evaluate(el => { el.hidden = true; }); await page.screenshot({path:'artifacts/mobile-light.png',fullPage:true});
      for (const id of ['tabMenuBtn','tabOrdersListBtn','tabOrderBtn']) { await page.locator('#'+id).click(); await noOverflow(); }
    }
    await page.setViewportSize({width:390,height:844}); await page.locator('#themeToggleBtn').click();
    await page.locator('#toast').evaluate(el => { el.hidden = true; }); await page.screenshot({path:'artifacts/mobile-dark.png',fullPage:true});
    const today = await page.locator('#dateInput').inputValue();
    const tomorrow = new Date(today+'T12:00:00Z'); tomorrow.setUTCDate(tomorrow.getUTCDate()+1);
    stores.set(tomorrow.toISOString().slice(0,10),{...fixture(tomorrow.toISOString().slice(0,10)),menu:null});
    delayState = 400; await page.locator('#nextDay').click();
    assert.equal(await page.locator('#dishChips').getAttribute('aria-busy'),'true');
    await page.waitForFunction(() => document.querySelector('#dishChips').getAttribute('aria-busy') === 'false');
    assert.match(await page.locator('#dishChips').textContent(),/Chưa có thực đơn/);
    assert.equal(await page.locator('#submitBtn').isDisabled(),true);
    delayState = 0; await page.locator('#todayBtn').click(); await waitFor('#dishChips .dish-choice-card',6);
    failState = true; await page.reload(); await page.locator('#globalNotice').waitFor({state:'visible'});
    assert.equal(await page.locator('#submitBtn').isDisabled(),true);
    assert.equal(await page.locator('#dishChips .dish-choice-card').count(),6,'Cached menu renders during outage');
    failState = false; await page.getByRole('button',{name:'Thử lại',exact:true}).click(); await page.locator('#globalNotice').waitFor({state:'hidden'});
    await page.evaluate(() => localStorage.removeItem('com-trua-theme'));
    await page.emulateMedia({colorScheme:'dark'}); await page.reload(); await waitFor('#dishChips .dish-choice-card',6);
    assert.equal(await page.locator('html').getAttribute('data-theme'),'dark','Default theme follows the system');
    assert.equal(errors.length,0,errors.join('\n'));
    console.log('PASS: choose dishes, validation, notes, submit failure/retry, save/edit/delete, proxy orders, locks, menu editing, keyboard tabs, modal, light/dark, 320-1440px, loading, empty and offline/retry states.');
    console.log('Screenshots: artifacts/desktop-{light,dark}.png and artifacts/mobile-{light,dark}.png');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
