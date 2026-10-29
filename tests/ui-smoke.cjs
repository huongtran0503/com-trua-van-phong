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
  let failOrder = false, failState = false, delayState = 0, lastRating = null;
  // Two colleagues already loved the fried chicken, so it starts out recommended.
  const ratingRows = [{userId:'x1',dish:'Gà ta chiên nước mắm',stars:5},{userId:'x2',dish:'Gà ta chiên nước mắm',stars:5}];
  const ratingBoard = user => {
    const groups = new Map();
    for (const st of stores.values()) (st.menu?.dishes || []).forEach(d => { if (!groups.has(d.toLowerCase())) groups.set(d.toLowerCase(),{key:d.toLowerCase(),dish:d,sum:0,count:0}); });
    ratingRows.forEach(r => { const key = r.dish.toLowerCase(), g = groups.get(key) || {key,dish:r.dish,sum:0,count:0}; g.sum += r.stars; g.count += 1; groups.set(key,g); });
    const dishes = [...groups.values()].map(g => ({key:g.key,dish:g.dish,served:1,lastDate:null,avg:g.count ? g.sum/g.count : 0,count:g.count,score:g.count ? g.sum/g.count : null,recommended:g.count >= 2 && g.sum/g.count >= 4})).sort((a,b) => (b.score ?? -1)-(a.score ?? -1));
    return {dishes,mine:ratingRows.filter(r => r.userId === user).map(r => ({key:r.dish.toLowerCase(),dish:r.dish,stars:r.stars}))};
  };
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
    if (url.pathname === '/api/ratings') return route.fulfill({json:ratingBoard(url.searchParams.get('user'))});
    if (url.pathname === '/api/rating') {
      lastRating = request.postDataJSON();
      const i = ratingRows.findIndex(r => r.userId === lastRating.userId && r.dish.toLowerCase() === lastRating.dish.toLowerCase());
      if (i >= 0) ratingRows.splice(i,1);
      if (lastRating.stars) ratingRows.push(lastRating);
      return route.fulfill({json:{success:true}});
    }
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
    assert.match(await page.locator('#recommendLine').textContent(),/Gà ta chiên nước mắm/,'Recommended dish on the menu is called out');
    assert.equal(await page.locator('#dishChips .dish-choice-card.recommended').count(),1);
    await page.locator('#myOrderTicket .star-btn[data-star="4"]').first().click();
    await page.waitForFunction(() => document.querySelectorAll('#myOrderTicket .star-btn.on').length === 4);
    assert.deepEqual([lastRating.dish,lastRating.stars],['Sườn heo sốt chua ngọt',4]);
    await page.locator('#tabRatingsBtn').click(); await waitFor('#topDishList li',1); // a single 4-star vote isn't a recommendation yet
    assert.match(await page.locator('#topDishList li').first().textContent(),/Gà ta chiên nước mắm/);
    await waitFor('#ratingList .rating-row',6);
    await page.locator('#ratingList .star-btn[data-dish="Cá basa kho tộ"][data-star="5"]').click(); // not ordered, still votable
    await page.waitForFunction(() => document.querySelectorAll('#ratingList .star-btn[data-dish="Cá basa kho tộ"].on').length === 5);
    assert.deepEqual([lastRating.dish,lastRating.stars,'date' in lastRating],['Cá basa kho tộ',5,false]);
    await page.locator('[data-rating-filter="unrated"]').click(); await waitFor('#ratingList .rating-row',4);
    await page.locator('#ratingSearchInput').fill('gà ta'); await waitFor('#ratingList .rating-row',1);
    await page.locator('#ratingSearchInput').fill('zz'); assert.equal(await page.locator('#ratingEmpty').isVisible(),true);
    await page.locator('#ratingSearchInput').fill(''); await page.locator('[data-rating-filter="all"]').click(); await waitFor('#ratingList .rating-row',6);
    await page.locator('#tabOrderBtn').click();
    await page.locator('#myOrderTicket .star-btn[data-star="4"]').first().click(); // same star again clears it
    await page.waitForFunction(() => document.querySelectorAll('#myOrderTicket .star-btn.on').length === 0);
    assert.equal(lastRating.stars,0);
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
      for (const id of ['tabMenuBtn','tabOrdersListBtn','tabRatingsBtn','tabOrderBtn']) { await page.locator('#'+id).click(); await noOverflow(); }
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
    console.log('PASS: choose dishes, validation, notes, submit failure/retry, save/edit/delete, proxy orders, locks, menu editing, star ratings tab and recommendations, keyboard tabs, modal, light/dark, 320-1440px, loading, empty and offline/retry states.');
    console.log('Screenshots: artifacts/desktop-{light,dark}.png and artifacts/mobile-{light,dark}.png');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
