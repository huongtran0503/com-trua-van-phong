(() => {
  const $ = (id) => document.getElementById(id);
  const TZ = "Asia/Ho_Chi_Minh";
  const RICE = { "": "", it: "Ít cơm", nhieu: "Nhiều cơm", khong: "Không cơm" };
  const WEEKDAY = ["Chủ nhật", "Thứ hai", "Thứ ba", "Thứ tư", "Thứ năm", "Thứ sáu", "Thứ bảy"];

  let myId = localStorage.getItem("com_trua_user_id");
  if (!myId) {
    myId = "user_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
    localStorage.setItem("com_trua_user_id", myId);
  }

  let date = todayVN();
  let menu = null;          // { date, dishes: [], locked, lockedAt }
  let menuLoaded = false;
  let orders = [];
  let editingId = null;
  let editingMenu = false;
  let selected = [];        // dish names in pick order
  let busy = false;
  let people = new Map();   // userId -> { name }
  let editingName = false;
  let lastOrder = null;
  let searchQuery = "";
  let ws = null;
  let wsConnected = false;
  let loadFailed = false;
  let allDishes = [];          // every dish ever served: { key, dish, served, lastDate, avg, count, score, recommended }
  let ratingStats = new Map(); // dishKey -> entry above, rated dishes only
  let myRatings = new Map();   // dishKey -> my stars (one vote per dish)
  let ratingQuery = "";
  let ratingFilter = "all";    // all | menu | unrated

  // ---------- Helpers ----------
  function todayVN() {
    return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  }
  function shiftDate(iso, days) {
    const d = new Date(iso + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }
  function prettyDate(iso) {
    const d = new Date(iso + "T12:00:00Z");
    return `${WEEKDAY[d.getUTCDay()]} ${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  // Native date inputs follow the browser locale (10/28/2026 on en-US), so show dd/mm/yyyy ourselves.
  function fullDate(iso) {
    const [y, m, d] = iso.split("-");
    const weekday = WEEKDAY[new Date(iso + "T12:00:00Z").getUTCDay()];
    return `${weekday.charAt(0).toUpperCase() + weekday.slice(1)}, ${d}/${m}/${y}`;
  }
  const cleanName = (s) => (s || "").trim().replace(/\s+/g, " ");
  // Same normalization as the server: dishes are matched across days by name.
  const dishKey = (name) => String(name || "").normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
  const fmtAvg = (n) => Number(n).toLocaleString("vi-VN", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const ratingSummary = (stat) => `${fmtAvg(stat.avg)} sao · ${stat.count} lượt chấm${stat.recommended ? " · Được đề cử" : ""}`;
  const myRating = (dish) => myRatings.get(dishKey(dish)) || 0;
  const onMenuLabel = () => date === todayVN() ? "Có hôm nay" : "Có ngày " + prettyDate(date).split(" ").pop();

  const myName = () => (myId && people.get(myId) && people.get(myId).name) || localStorage.getItem("com_trua_user_name") || "";
  const displayName = (o) => (o.forUser && people.get(o.forUser) && people.get(o.forUser).name) || o.name;
  const isPoster = () => !!(menu && myId && menu.postedBy === myId);

  // Cucumber green avatars, matching --brand
  const AVATAR_COLORS = ["#2f6b3b"];
  function getAvatarColor(name) {
    let hash = 0;
    for (let i = 0; i < (name || "").length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
  }
  function getInitials(name) {
    if (!name) return "?";
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }



  function icon(name) {
    const el = document.createElement("i");
    el.className = "ph ph-" + name;
    el.setAttribute("aria-hidden", "true");
    return el;
  }


  function starIcon() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("class", "star-icon"); svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", "M12 2.5l2.94 5.96 6.56.95-4.75 4.63 1.12 6.54L12 17.5l-5.87 3.08 1.12-6.54L2.5 9.41l6.56-.95z");
    svg.append(path); return svg;
  }

  function fieldError(id, message, inputId) {
    $(id).textContent = message; $(id).hidden = !message;
    if (inputId) $(inputId).setAttribute("aria-invalid", message ? "true" : "false");
  }
  function ownOrder() {
    return orders.find(o => o.forUser === myId || (!o.forUser && o.createdBy === myId && o.name === myName()));
  }
  function scrollToForm() {
    $("orderPanel").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
  }

  function orderLine(o) {
    const dishes = (o.dishes && o.dishes.length) ? o.dishes.join(" + ") : "(chưa chọn món)";
    const r = RICE[o.rice] ? ` (${RICE[o.rice]})` : "";
    const n = o.note ? ` [${o.note}]` : "";
    return dishes + r + n;
  }

  // Toast
  let toastTimer;
  function toast(msg) {
    const el = $("toast");
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  // ---------- Realtime WebSocket & Cloud Sync Client ----------
  let pollTimer = null;
  let serverless = false;   // Vercel has no WebSocket; stop retrying once health says so

  function initWebSocket() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${location.host}`;

    try {
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        wsConnected = true;
        updateWsStatus("ws");
        // Request state for current date
        ws.send(JSON.stringify({ type: "SUBSCRIBE_DATE", date }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          handleRealtimeMessage(msg);
        } catch (e) {
          console.error("Lỗi parse WS message:", e);
        }
      };

      ws.onclose = () => {
        wsConnected = false;
        // On serverless/Vercel or if WS closes, switch to Cloud Sync polling
        checkCloudSync();
        // Re-attempt WS after 15s in case running locally
        setTimeout(() => { if (!serverless) initWebSocket(); }, 15000);
      };

      ws.onerror = () => { wsConnected = false; };   // onclose always follows and runs checkCloudSync
    } catch {
      wsConnected = false;
      checkCloudSync();
    }
  }

  async function checkCloudSync() {
    try {
      const res = await fetch(`/api/health?_t=${Date.now()}`);
      if (res.ok) {
        serverless = (await res.json().catch(() => ({}))).env === "vercel";
        try { serverless ? localStorage.setItem("com_trua_serverless", "1") : localStorage.removeItem("com_trua_serverless"); } catch {}
        if (!serverless && !ws) initWebSocket();
        updateWsStatus("cloud");
        startSmartPolling();
      } else {
        updateWsStatus("offline");
      }
    } catch {
      updateWsStatus("offline");
    }
  }

  function startSmartPolling() {
    if (pollTimer) return;
    let ticks = 0;
    pollTimer = setInterval(() => {
      // Smart Polling: only poll when tab is active/visible, not busy submitting, and WS is disconnected
      if (!wsConnected && !document.hidden && !busy) {
        fetchDateState(date, true);
        // Ratings change slowly; refresh them about once a minute instead of every tick.
        if (++ticks % 18 === 0) fetchRatings();
      }
    }, 3500);
  }

  function updateWsStatus(mode) {
    const badge = $("wsStatusBadge");
    const text = $("wsStatusText");
    if (!badge || !text) return;

    if (mode === "ws") {
      badge.classList.remove("offline");
      badge.classList.remove("cloud-sync");
      text.textContent = "Đã đồng bộ";
      badge.title = "Đang kết nối Realtime WebSocket máy chủ";
    } else if (mode === "cloud") {
      badge.classList.remove("offline");
      badge.classList.add("cloud-sync");
      text.textContent = "Đám mây";
      badge.title = "Đang đồng bộ trực tiếp MongoDB Cloud";
    } else {
      badge.classList.add("offline");
      badge.classList.remove("cloud-sync");
      text.textContent = "Ngoại tuyến";
      badge.title = "Mất kết nối mạng";
    }
  }

  function handleRealtimeMessage(msg) {
    if (msg.type === "INIT" || msg.type === "DATE_STATE") {
      if (msg.date === date && msg.data) {
        applyState(msg.data);
      }
    } else if (msg.type === "MENU_UPDATED") {
      if (msg.date === date && msg.data) {
        menu = msg.data;
        menuLoaded = true;
        selected = selected.filter(d => (menu?.dishes || []).includes(d));
        render();
      }
    } else if (msg.type === "ORDER_UPDATED" || msg.type === "ORDER_DELETED") {
      if (msg.date === date) {
        fetchDateState(date, true);
      }
    } else if (msg.type === "RATING_UPDATED") {
      fetchRatings();
    } else if (msg.type === "PEOPLE_UPDATED") {
      if (msg.data && msg.data.person) {
        people.set(msg.data.person.id, msg.data.person);
        render();
      }
    }
  }

  // Paint the last known state for this date instantly (stale-while-revalidate); the fetch replaces it.
  function paintCached(d) {
    try { if (JSON.parse(localStorage.getItem("com_trua_db_v1"))?.menus?.[d]) fallbackLocalLoad(d); } catch {}
  }

  async function fetchDateState(d, silent = false) {
    if (!menuLoaded) paintCached(d);
    try {
      const res = await fetch(`/api/state?date=${d}&_t=${Date.now()}`);
      if (!res.ok) throw new Error("Không tải được dữ liệu");
      const data = await res.json();
      if (d !== date) return;
      loadFailed = false; applyState(data);
      try {
        const store = JSON.parse(localStorage.getItem("com_trua_db_v1") || "{}");
        store.menus = { ...store.menus, [d]: data.menu };
        store.orders = { ...store.orders };
        Object.keys(store.orders).forEach(k => { if (store.orders[k].date === d) delete store.orders[k]; });
        (data.orders || []).forEach(o => { store.orders[o.id] = o; });
        store.people = data.people || {};
        localStorage.setItem("com_trua_db_v1", JSON.stringify(store));
      } catch {}
      if (!wsConnected) { updateWsStatus("cloud"); startSmartPolling(); }
    } catch {
      if (d !== date) return;
      loadFailed = true;
      if (!wsConnected) updateWsStatus("offline");
      if (silent && menuLoaded) render(); else fallbackLocalLoad(d);
      startSmartPolling();
    }
  }

  // Ratings live outside /api/state so the 3.5s poll doesn't aggregate them every time.
  async function fetchRatings() {
    try {
      const res = await fetch(`/api/ratings?user=${encodeURIComponent(myId)}&_t=${Date.now()}`);
      if (!res.ok) return;
      const data = await res.json();
      applyRatings(data);
      try { localStorage.setItem("com_trua_ratings_v2", JSON.stringify({ dishes: allDishes, mine: [...myRatings] })); } catch {}
    } catch {}
  }

  function applyRatings(data) {
    allDishes = Array.isArray(data.dishes) ? data.dishes : [];
    ratingStats = new Map(allDishes.filter(d => d.count).map(d => [d.key, d]));
    if (Array.isArray(data.mine)) myRatings = new Map(data.mine.map(r => Array.isArray(r) ? r : [r.key || dishKey(r.dish), r.stars]));
    render();
  }

  function applyState(data) {
    menu = data.menu;
    menuLoaded = true;
    loadFailed = false;
    selected = selected.filter(d => (menu?.dishes || []).includes(d));
    orders = data.orders || [];
    if (data.people) {
      people = new Map(Object.entries(data.people));
    }
    render();
  }

  // Fallback if server is not reachable
  function fallbackLocalLoad(d) {
    const key = "com_trua_db_v1";
    let store = {};
    try { store = JSON.parse(localStorage.getItem(key)) || {}; } catch {}
    menu = (store.menus && store.menus[d]) || null;
    menuLoaded = true;
    orders = Object.values(store.orders || {}).filter(o => o.date === d);
    people = new Map(Object.entries(store.people || {}));
    render();
  }

  // ---------- Rendering Logic & Tab Navigation ----------
  let currentTab = "order";

  function switchTab(t) {
    currentTab = t;
    const tabs = [
      { id: "order", btn: $("tabOrderBtn"), view: $("viewOrder") },
      { id: "menu", btn: $("tabMenuBtn"), view: $("viewMenu") },
      { id: "ordersList", btn: $("tabOrdersListBtn"), view: $("viewOrdersList") },
      { id: "ratings", btn: $("tabRatingsBtn"), view: $("viewRatings") }
    ];

    tabs.forEach(item => {
      const isAct = item.id === t;
      if (item.btn) {
        item.btn.classList.toggle("active", isAct);
        item.btn.setAttribute("aria-selected", isAct ? "true" : "false");
        item.btn.tabIndex = isAct ? 0 : -1;
      }
      if (item.view) {
        item.view.hidden = !isAct;
        item.view.classList.toggle("active", isAct);
      }
    });

    if (t === "menu") {
      renderMenuTab();
    } else if (t === "ordersList") {
      renderList();
      renderMessage();
    } else if (t === "ratings") {
      renderRatingsTab();
    }
  }

  function canLock() {
    return isPoster() || (orders.length > 0 && orders.some(o => o.createdBy === myId || o.forUser === myId));
  }

  function targetName() {
    const forOther = $("forOther").checked;
    if (forOther) return cleanName($("otherName").value);
    return myName();
  }

  function render() {
    $("dateInput").value = date;
    const isToday = date === todayVN();
    $("todayBtn").setAttribute("aria-pressed", String(isToday));
    $("pageDateLabel").textContent = (isToday ? "Hôm nay · " : "") + fullDate(date);
    const notice = $("globalNotice"); notice.hidden = !loadFailed;
    if (loadFailed && !notice.childElementCount) {
      const text = document.createElement("span"); text.textContent = "Chưa thể kết nối. Dữ liệu đã lưu có thể chưa phải mới nhất.";
      const retry = document.createElement("button"); retry.type = "button"; retry.className = "btn-sm btn-subtle"; retry.textContent = "Thử lại";
      retry.addEventListener("click", () => fetchDateState(date)); notice.append(text, retry);
    }
    for (const id of ["dateInput", "prevDay", "nextDay", "todayBtn"]) $(id).disabled = busy;

    const locked = !!(menu && menu.locked);
    const hasMenu = !!(menu && menu.dishes && menu.dishes.length);

    // Update Tab Badges
    const menuBadge = $("menuCountBadge");
    if (menuBadge) menuBadge.textContent = String(menu?.dishes?.length || 0);

    const ordersBadge = $("ordersCountBadge");
    if (ordersBadge) ordersBadge.textContent = String(orders.length);

    // Status Pill
    const pill = $("statusPill");
    const stext = $("statusText");
    if (!hasMenu) {
      pill.className = "pill";
      stext.textContent = "Chưa có thực đơn";
    } else if (locked) {
      pill.className = "pill locked";
      stext.textContent = `Đã chốt sổ (${orders.length} suất)`;
    } else {
      pill.className = "pill";
      stext.textContent = `Đang mở đặt món (${orders.length} suất)`;
    }

    // Panels visibility in Menu Tab
    const menuEd = $("menuEditor");
    if (menuEd) {
      menuEd.hidden = !editingMenu;
    }
    if (!hasMenu || editingMenu) {
      $("menuDateLabel").textContent = prettyDate(date);
    }

    $("dishTotalLabel").textContent = `${menu?.dishes?.length || 0} món`;
    renderOrderForm();
    renderRecommendLine();
    renderMyOrderSummary();
    renderTeamOrders();
    renderMenuTab();
    if (currentTab === "ratings") renderRatingsTab();
    renderList();
    renderMessage();
  }

  function renderMyOrderSummary() {
    const order = ownOrder();
    $("myOrderSummaryCard").hidden = !order;
    const ticket = $("myOrderTicket");
    const focus = ticket.contains(document.activeElement) ? { ...document.activeElement.dataset } : null;
    ticket.replaceChildren();
    if (!order) return;
    const name = document.createElement("strong"); name.textContent = displayName(order);
    const list = document.createElement("ul"); list.className = "my-order-dishes";
    (order.dishes || []).forEach(dish => {
      const li = document.createElement("li");
      const label = document.createElement("span"); label.className = "my-order-dish"; label.textContent = dish;
      li.append(label);
      li.append(starInput(dish));
      list.append(li);
    });
    ticket.append(name, list);
    const extras = [RICE[order.rice], order.note].filter(Boolean).join(" · ");
    if (extras) { const p = document.createElement("p"); p.className = "my-order-extras"; p.textContent = extras; ticket.append(p); }
    const meta = [];
    if (order.createdAt) meta.push("Đặt lúc " + new Date(order.createdAt).toLocaleTimeString("vi-VN", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }));
    const rated = (order.dishes || []).filter(d => myRating(d)).length;
    meta.push(rated ? `Đã chấm ${rated}/${order.dishes.length} món` : "Ăn xong nhớ chấm sao để gợi ý món ngon cho mọi người");
    const time = document.createElement("p"); time.className = "helper-text"; time.textContent = meta.join(" · ");
    ticket.append(time);
    if (focus?.star) ticket.querySelector(`.star-btn[data-dish="${CSS.escape(focus.dish)}"][data-star="${focus.star}"]`)?.focus({ preventScroll: true });
    $("editMyOrderBtn").disabled = !!menu?.locked || busy;
    $("deleteMyOrderBtn").disabled = !!menu?.locked || busy;
  }

  function starInput(dish) {
    const current = myRating(dish);
    const group = document.createElement("span"); group.className = "star-input";
    group.setAttribute("role", "group"); group.setAttribute("aria-label", "Chấm sao " + dish);
    for (let n = 1; n <= 5; n++) {
      const b = document.createElement("button"); b.type = "button";
      b.className = "star-btn" + (n <= current ? " on" : ""); b.dataset.dish = dish; b.dataset.star = String(n);
      b.setAttribute("aria-label", n + " sao"); b.setAttribute("aria-pressed", String(n === current));
      b.title = n === current ? "Bấm lại để bỏ chấm" : n + " sao";
      b.append(starIcon());
      b.addEventListener("click", () => rateDish(dish, n === current ? 0 : n));
      group.append(b);
    }
    return group;
  }

  async function rateDish(dish, stars) {
    const key = dishKey(dish), before = new Map(myRatings);
    if (stars) myRatings.set(key, stars); else myRatings.delete(key);
    renderMyOrderSummary(); if (currentTab === "ratings") renderRatingsTab();
    try {
      const res = await fetch("/api/rating", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: myId, dish, stars }) });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || "Chưa lưu được đánh giá."); }
      toast(stars ? `Đã chấm ${dish} ${stars} sao` : `Đã bỏ chấm ${dish}`);
      fetchRatings();
    } catch (err) {
      myRatings = before; renderMyOrderSummary(); if (currentTab === "ratings") renderRatingsTab();
      toast(err instanceof TypeError ? "Chưa lưu được đánh giá. Kiểm tra kết nối rồi thử lại." : err.message);
    }
  }

  // Today's best-rated dishes, so the recommendation is visible before anyone scrolls the menu.
  function renderRecommendLine() {
    const picks = (menu?.dishes || [])
      .map(dish => ({ dish, stat: ratingStats.get(dishKey(dish)) }))
      .filter(p => p.stat?.recommended)
      .sort((a, b) => b.stat.score - a.stat.score)
      .slice(0, 3);
    const line = $("recommendLine");
    line.hidden = !picks.length;
    line.replaceChildren(starIcon(), document.createTextNode("Đề cử hôm nay: " + picks.map(p => `${p.dish} (${fmtAvg(p.stat.avg)})`).join(", ")));
  }

  function renderTopDishes() {
    const top = allDishes.filter(stat => stat.recommended).slice(0, 10);
    const onMenu = new Set((menu?.dishes || []).map(dishKey));
    $("topDishEmpty").hidden = top.length > 0;
    $("topDishList").replaceChildren(...top.map((stat, i) => {
      const li = document.createElement("li"); li.className = "top-dish" + (stat.recommended ? " recommended" : "");
      const rank = document.createElement("span"); rank.className = "top-dish-rank"; rank.textContent = String(i + 1);
      const info = document.createElement("div"); info.className = "top-dish-info";
      const name = document.createElement("span"); name.className = "top-dish-name"; name.textContent = stat.dish;
      const meta = document.createElement("span"); meta.className = "top-dish-meta";
      meta.textContent = stat.count + " lượt chấm" + (onMenu.has(stat.key) ? " · " + onMenuLabel() : "");
      info.append(name, meta);
      const score = document.createElement("span"); score.className = "top-dish-score";
      score.append(starIcon(), document.createTextNode(fmtAvg(stat.avg)));
      score.setAttribute("aria-label", ratingSummary(stat));
      li.append(rank, info, score); return li;
    }));
  }

  // Ratings tab: every dish ever served, anyone can vote, one vote per person per dish.
  function renderRatingsTab() {
    renderTopDishes();
    $("ratingMenuFilter").textContent = onMenuLabel();
    document.querySelectorAll("[data-rating-filter]").forEach(btn => btn.setAttribute("aria-pressed", String(btn.dataset.ratingFilter === ratingFilter)));
    const onMenu = new Set((menu?.dishes || []).map(dishKey));
    const q = dishKey(ratingQuery);
    const shown = allDishes.filter(d =>
      (!q || d.key.includes(q)) &&
      (ratingFilter !== "menu" || onMenu.has(d.key)) &&
      (ratingFilter !== "unrated" || !myRatings.has(d.key)));
    const list = $("ratingList");
    const focus = list.contains(document.activeElement) ? { ...document.activeElement.dataset } : null;
    $("ratingEmpty").hidden = shown.length > 0;
    $("ratingEmptyTitle").textContent = !allDishes.length ? "Chưa có món nào" : "Không có món phù hợp";
    $("ratingEmptyText").textContent = !allDishes.length ? "Món sẽ xuất hiện ở đây sau khi có thực đơn." : ratingFilter === "unrated" && !q ? "Bạn đã chấm hết các món rồi." : "Thử bỏ bộ lọc hoặc tìm tên khác.";
    list.replaceChildren(...shown.map(d => {
      const li = document.createElement("li"); li.className = "rating-row";
      const info = document.createElement("div"); info.className = "rating-row-info";
      const name = document.createElement("span"); name.className = "rating-row-name"; name.textContent = d.dish;
      if (d.recommended) { const tag = document.createElement("span"); tag.className = "rating-tag"; tag.textContent = "Đề cử"; name.append(" ", tag); }
      const meta = document.createElement("span"); meta.className = "rating-row-meta" + (d.recommended ? " recommended" : "");
      const facts = [d.count ? `${fmtAvg(d.avg)} · ${d.count} lượt chấm` : "Chưa ai chấm", onMenu.has(d.key) && onMenuLabel(), d.served && `Lên thực đơn ${d.served} lần`].filter(Boolean);
      if (d.count) meta.append(starIcon());
      meta.append(document.createTextNode(facts.join(" · ")));
      info.append(name, meta);
      li.append(info, starInput(d.dish)); return li;
    }));
    if (focus?.star) list.querySelector(`.star-btn[data-dish="${CSS.escape(focus.dish)}"][data-star="${focus.star}"]`)?.focus({ preventScroll: true });
  }

  function renderMenuTab() {
    const locked = !!menu?.locked, dishes = menu?.dishes || [];
    $("menuCoverDate").textContent = prettyDate(date);
    $("menuCoverPoster").textContent = people.get(menu?.postedBy)?.name ? "Đăng bởi " + people.get(menu.postedBy).name : "";
    $("menuCoverDishCount").textContent = dishes.length + " món";
    $("editMenuLabel").textContent = dishes.length ? "Sửa thực đơn" : "Thêm thực đơn";
    $("menuCoverStatus").textContent = !dishes.length ? "Chưa có thực đơn" : locked ? "Đã chốt nhận đơn" : "Đang nhận đơn";
    $("menuCoverStatus").className = "status-pill-green" + (locked ? " locked" : "");
    const grid = $("menuDishesGrid"); grid.replaceChildren();
    if (!dishes.length) { grid.append(emptyState("Chưa có thực đơn cho ngày này", "Bấm Thêm thực đơn hoặc lấy thực đơn hôm trước.", "book-open")); return; }
    dishes.forEach(dish => {
      const card = document.createElement("article"); card.className = "menu-dish-row";
      const copy = document.createElement("div");
      const name = document.createElement("h2"); name.className = "menu-dish-name"; name.textContent = dish;
      copy.append(name);
      const count = orders.filter(o => o.dishes?.includes(dish)).length;
      const stat = ratingStats.get(dishKey(dish));
      const facts = [stat && ratingSummary(stat), count && count + " suất đã đặt"].filter(Boolean);
      if (facts.length) {
        const caption = document.createElement("p"); caption.className = "menu-dish-count" + (stat?.recommended ? " recommended" : "");
        if (stat) caption.append(starIcon());
        caption.append(document.createTextNode(facts.join(" · "))); copy.append(caption);
      }
      const action = document.createElement("button"); action.type = "button";
      action.className = "menu-dish-action" + (selected.includes(dish) ? " active" : ""); action.disabled = locked || busy;
      action.append(icon(selected.includes(dish) ? "check" : "plus"), document.createTextNode(selected.includes(dish) ? "Đã chọn" : "Chọn món"));
      action.setAttribute("aria-label", "Chọn " + dish);
      action.addEventListener("click", () => {
        if (!selected.includes(dish)) selected.push(dish);
        switchTab("order"); renderDishChips(locked); renderPreview(); scrollToForm();
      });
      card.append(copy, action); grid.append(card);
    });
  }

  function emptyState(title, description, glyph) {
    const box = document.createElement("div"); box.className = "empty-state-clean";
    const heading = document.createElement("h3"); heading.textContent = title;
    const text = document.createElement("p"); text.textContent = description;
    box.append(icon(glyph), heading, text); return box;
  }

  function renderOrderForm() {
    const locked = !!(menu && menu.locked);
    const poster = people.get(menu?.postedBy)?.name;
    $("posterLine").textContent = poster ? `Đăng bởi ${poster}` : "";
    $("posterLine").hidden = !poster;

    // Lock Notice
    const lockNotice = $("lockNotice");
    lockNotice.hidden = !locked;
    if (locked) {
      $("unlockBtn").hidden = !canLock();
    }

    // Name Section
    const curName = myName();
    const hasName = !!curName && !editingName;
    $("meEdit").hidden = hasName;
    $("meView").hidden = !hasName;
    $("cancelNameBtn").hidden = !editingName;
    if (hasName) {
      $("meName").textContent = curName;
      $("meAvatar").textContent = getInitials(curName);
      $("meAvatar").style.background = getAvatarColor(curName);
    }
    $("heroGreeting").textContent = curName ? `Chào ${curName}` : "";
    $("heroGreeting").hidden = !curName;
    $("formTitle").replaceChildren(...(curName ? ["Hôm nay ăn gì?"] : ["Hôm nay bạn", document.createElement("br"), "muốn ăn gì?"]));

    // Suggestions datalist for ordering for others
    const dl = $("peopleList");
    dl.replaceChildren();
    for (const [uid, p] of people) {
      if (uid !== myId && p.name) {
        const opt = document.createElement("option");
        opt.value = p.name;
        dl.appendChild(opt);
      }
    }

    // Dish Chips
    renderDishChips(locked);

    // Preview & Button text
    renderPreview();

    // Disable inputs if locked
    $("submitBtn").disabled = locked || busy || !menuLoaded || !menu?.dishes?.length || loadFailed;
    document.querySelectorAll("#orderForm input, #orderForm textarea, #orderForm button:not(#unlockBtn)")
      .forEach(el => {
        if (el.id !== "unlockBtn") {
          el.disabled = locked || busy;
          if (el.id === "submitBtn") el.disabled = locked || busy || !menuLoaded || !menu?.dishes?.length || loadFailed;
        }
      });
  }

  function renderDishChips(locked) {
    const wrap = $("dishChips");
    const focused = wrap.contains(document.activeElement) ? document.activeElement.dataset.dish : null;
    wrap.replaceChildren(); wrap.setAttribute("aria-busy", String(!menuLoaded));
    if (!menuLoaded) {
      for (let i = 0; i < 6; i++) { const skeleton = document.createElement("div"); skeleton.className = "dish-skeleton"; wrap.append(skeleton); }
      return;
    }
    const dishes = menu?.dishes || [];
    if (!dishes.length) { wrap.append(emptyState("Chưa có thực đơn", "Vào Thực đơn để thêm món cho ngày này.", "bowl-food")); return; }
    dishes.forEach(dish => {
      const chosen = selected.includes(dish);
      const card = document.createElement("button"); card.type = "button";
      card.className = "dish-choice-card" + (chosen ? " selected" : ""); card.dataset.dish = dish;
      card.disabled = locked || busy; card.setAttribute("aria-pressed", String(chosen)); card.setAttribute("aria-label", dish);
      const name = document.createElement("span"); name.className = "dish-choice-title"; name.textContent = dish;
      if (chosen) card.append(icon("check"));
      card.append(name);
      const stat = ratingStats.get(dishKey(dish));
      if (stat) {
        const rating = document.createElement("span"); rating.className = "dish-rating";
        rating.append(starIcon(), document.createTextNode(fmtAvg(stat.avg)));
        card.append(rating); card.title = ratingSummary(stat);
        card.setAttribute("aria-label", `${dish}, ${ratingSummary(stat)}`);
        if (stat.recommended) card.classList.add("recommended");
      }
      const count = orders.filter(o => o.dishes?.includes(dish)).length;
      if (count) { const badge = document.createElement("span"); badge.className = "dish-count"; badge.textContent = "×" + count; badge.title = count + " người đã chọn"; card.append(badge); }
      card.addEventListener("click", () => {
        selected = selected.includes(dish) ? selected.filter(d => d !== dish) : [...selected, dish];
        fieldError("dishError", ""); fieldError("submitError", ""); renderDishChips(locked); renderPreview();
      });
      wrap.append(card); if (focused === dish) card.focus({ preventScroll: true });
    });
  }

  // Order page: everyone's picks at a glance, own order highlighted, one-tap copy for the group chat.
  function renderTeamOrders() {
    $("teamOrders").hidden = !orders.length;
    $("teamCount").textContent = orders.length ? `· ${orders.length} suất` : "";
    const mine = ownOrder();
    $("teamOrderList").replaceChildren(...orders.map(o => {
      const li = document.createElement("li"); li.className = "team-order" + (o === mine ? " mine" : "");
      const who = document.createElement("strong"); who.textContent = displayName(o);
      li.append(who);
      if (o === mine) { const tag = document.createElement("span"); tag.className = "team-order-tag"; tag.textContent = "Bạn"; li.append(tag); }
      const what = document.createElement("span"); what.className = "team-order-dishes"; what.textContent = orderLine(o);
      li.append(what); return li;
    }));
  }

  function renderPreview() {
    $("pickCount").textContent = selected.length ? selected.length + " món đã chọn" : "Chưa chọn món";
    $("selectedDishNames").textContent = selected.join(", ");
    const btn = $("submitBtn");
    btn.replaceChildren(document.createTextNode(busy ? "Đang gửi đơn…" : menu?.locked ? "Đã chốt đơn" : editingId ? "Cập nhật đơn" : "Đặt cơm ngay"), icon(busy ? "bowl-food" : "arrow-right"));
    btn.setAttribute("aria-busy", String(busy));
    const tags = $("noteInput").value.split(",").map(s => s.trim());
    document.querySelectorAll("[data-tag]").forEach(btn => btn.setAttribute("aria-pressed", String(tags.includes(btn.dataset.tag))));
  }

  function renderList() {
    const list = $("orderList");
    const totalCount = orders.length;
    $("countLabel").textContent = `${totalCount} suất`;


    const filtered = searchQuery
      ? orders.filter(o => displayName(o).toLowerCase().includes(searchQuery.toLowerCase()) || orderLine(o).toLowerCase().includes(searchQuery.toLowerCase()))
      : orders;

    $("orderEmpty").hidden = filtered.length > 0;
    $("orderEmptyTitle").textContent = searchQuery ? "Không tìm thấy đơn" : "Chưa có ai đặt cơm";
    const locked = !!(menu && menu.locked);
    list.replaceChildren(...filtered.map((o) => {
      const li = document.createElement("li");
      li.className = "order-row-card";

      const left = document.createElement("div");
      left.className = "order-row-left";

      const av = document.createElement("div");
      av.className = "order-avatar";
      const name = displayName(o);
      av.textContent = getInitials(name);
      av.style.background = getAvatarColor(name);

      const info = document.createElement("div");
      info.className = "order-info";

      const who = document.createElement("div");
      who.className = "order-user-name";
      const creator = people.get(o.createdBy)?.name;
      who.textContent = name + (creator && o.createdBy !== o.forUser && creator !== name ? ` (bởi ${creator})` : "");

      const what = document.createElement("div");
      what.className = "order-dishes-text";
      what.textContent = orderLine(o);

      info.append(who, what);
      left.append(av, info);

      const acts = document.createElement("div");
      acts.className = "order-row-actions";

      const mayManage = isPoster() || o.createdBy === myId || o.forUser === myId;

      if (mayManage && !locked) {
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "btn-sm btn-subtle";
        edit.textContent = "Sửa";
        edit.addEventListener("click", () => { switchTab("order"); startEdit(o); });

        const del = document.createElement("button");
        del.type = "button";
        del.className = "btn-sm btn-danger-subtle";
        del.textContent = "Xóa";

        let armTimer;
        del.addEventListener("click", async () => {
          if (!del.classList.contains("armed")) {
            del.classList.add("armed");
            del.textContent = "Xóa?";
            armTimer = setTimeout(() => { del.classList.remove("armed"); del.textContent = "Xóa"; }, 3000);
            return;
          }
          clearTimeout(armTimer);
          deleteOrder(o);
        });

        acts.append(edit, del);
      }

      li.append(left, acts);
      return li;
    }));
  }

  function messageText() {
    if (!orders.length) return "";
    const lines = orders.map((o, i) => `${i + 1}. ${displayName(o)}: ${orderLine(o)}`);
    return lines.join("\n");
  }

  function renderMessage() {
    const box = $("msgBox");
    box.value = messageText();
    box.placeholder = "Tin nhắn dạng “1. Tên: món + món” sẽ tự động sinh khi có đơn.";
    $("copyMsgBtn").disabled = !orders.length;

    // Update lock button state
    const locked = !!(menu && menu.locked);
    $("lockBtn").textContent = locked ? "Mở nhận đơn" : "Chốt đơn";
    $("lockBtn").disabled = !canLock();
    $("lockHint").textContent = locked ? "Đang khóa, không nhận đơn mới" : "";
  }

  // ---------- Actions ----------
  function startEdit(o) {
    editingId = o.id;
    selected = [...(o.dishes || [])];
    $("noteInput").value = o.note || "";
    const rRadio = document.querySelector(`#riceSeg input[value="${o.rice || ""}"]`);
    if (rRadio) rRadio.checked = true;

    if (o.forUser && o.forUser !== myId) {
      $("forOther").checked = true;
      $("otherNameWrap").hidden = false;
      $("otherName").value = displayName(o);
    } else {
      $("forOther").checked = false;
      $("otherNameWrap").hidden = true;
    }

    $("submitBtn").textContent = "Cập nhật đơn";
    $("cancelEditBtn").hidden = false;
    render();
    switchTab("order");
    scrollToForm();
  }

  function resetForm() {
    editingId = null;
    selected = [];
    $("noteInput").value = "";
    const normRadio = $("rice-normal");
    if (normRadio) normRadio.checked = true;
    fieldError("submitError", "");
    fieldError("dishError", "");
    $("submitBtn").textContent = "Đặt cơm ngay";
    $("cancelEditBtn").hidden = true;
    $("forOther").checked = false;
    $("otherNameWrap").hidden = true;
    renderPreview();
  }

  $("cancelEditBtn").addEventListener("click", () => { resetForm(); render(); });

  async function submitOrder() {
    if (busy || menu?.locked || !menu?.dishes?.length || loadFailed) return;
    fieldError("submitError", "");
    const name = targetName();
    if (!name) {
      if ($("forOther").checked) { fieldError("submitError", "Vui lòng nhập tên đồng nghiệp."); $("otherName").focus(); }
      else { fieldError("nameError", "Nhập tên và bấm Lưu trước khi đặt cơm.", "nameInput"); $("nameInput").focus(); }
      return;
    }
    if (!selected.length) { fieldError("dishError", "Chọn ít nhất một món cho bữa trưa."); $("dishChips").querySelector("button")?.focus(); return; }
    const requestDate = date, wasEditing = !!editingId;
    const payload = { id: editingId || undefined, date, name, dishes: [...selected], rice: document.querySelector('#riceSeg input:checked')?.value || "", note: $("noteInput").value.trim(), forUser: $("forOther").checked ? undefined : myId, createdBy: myId };
    busy = true; render();
    try {
      const res = await fetch("/api/order", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error || "Không gửi được đơn. Vui lòng thử lại."); }
      const { order } = await res.json();
      toast(wasEditing ? "Đã cập nhật đơn." : "Đã đặt cơm cho " + name + "!");
      if (requestDate === date) {
        resetForm();
        // Show the saved order now; the full refresh below syncs everyone else's in the background.
        if (order) orders = [...orders.filter(o => o.id !== order.id), order].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      }
      fetchDateState(requestDate, true);
    } catch (err) { fieldError("submitError", err instanceof TypeError ? "Chưa gửi được đơn. Kiểm tra kết nối rồi thử lại, món đã chọn vẫn được giữ." : err.message); }
    finally { busy = false; render(); }
  }

  $("submitBtn").addEventListener("click", submitOrder);

  async function deleteOrder(o) {
    if (menu?.locked || busy) return;
    try {
      const res = await fetch(`/api/order/${o.id}`, { method: "DELETE" });
      if (res.ok) {
        toast(`Đã xóa đơn của ${displayName(o)}`);
        orders = orders.filter(x => x.id !== o.id); render();
        fetchDateState(date, true);
      } else {
        const error = await res.json();
        toast(error.error || "Không xóa được đơn. Vui lòng thử lại.");
      }
    } catch {
      toast("Không xóa được đơn");
    }
  }

  // Name management
  async function saveName() {
    const val = cleanName($("nameInput").value);
    if (!val) { fieldError("nameError", "Vui lòng nhập tên của bạn.", "nameInput"); return; }
    fieldError("nameError", "", "nameInput");
    localStorage.setItem("com_trua_user_name", val);
    editingName = false;
    people.set(myId, { id: myId, name: val });

    try {
      await fetch("/api/people", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: myId, name: val })
      });
    } catch {}

    toast(`Đã lưu tên: ${val}`);
    render();
  }

  $("saveNameBtn").addEventListener("click", saveName);
  $("nameInput").addEventListener("keydown", (e) => { if (e.key === "Enter") saveName(); });
  $("renameBtn").addEventListener("click", () => {
    editingName = true;
    $("nameInput").value = myName();
    render();
    $("nameInput").focus();
  });
  $("cancelNameBtn").addEventListener("click", () => { editingName = false; render(); });

  $("forOther").addEventListener("change", (e) => {
    $("otherNameWrap").hidden = !e.target.checked;
    renderPreview();
  });
  $("otherName").addEventListener("input", renderPreview);
  $("noteInput").addEventListener("input", renderPreview);
  document.querySelectorAll('#riceSeg input').forEach(r => r.addEventListener("change", renderPreview));

  // Quick Tags
  document.querySelectorAll("[data-tag]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tag = btn.dataset.tag;
      const tags = $("noteInput").value.split(",").map(s => s.trim()).filter(Boolean);
      $("noteInput").value = (tags.includes(tag) ? tags.filter(t => t !== tag) : [...tags, tag]).join(", ").slice(0, 120);
      renderPreview();
    });
  });

  // Menu editing
  $("editMenuBtn").addEventListener("click", () => {
    editingMenu = true;
    $("menuText").value = (menu.dishes || []).join("\n");
    render();
    $("menuText").focus();
  });
  $("cancelMenuBtn").addEventListener("click", () => { editingMenu = false; render(); });

  $("saveMenuBtn").addEventListener("click", async () => {
    const lines = $("menuText").value.split("\n").map(s => s.trim()).filter(Boolean);
    if (!lines.length) { fieldError("menuError", "Nhập ít nhất một món ăn."); return; }
    fieldError("menuError", "");
    $("saveMenuBtn").disabled = true;
    $("saveMenuBtn").textContent = "Đang lưu…";
    try {
      const res = await fetch("/api/menu", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, dishes: lines, postedBy: myId })
      });
      if (res.ok) {
        editingMenu = false;
        toast(`Đã lưu thực đơn với ${lines.length} món`);
        await fetchDateState(date);
      } else { const err = await res.json(); throw new Error(err.error || "Không lưu được thực đơn."); }
    } catch (err) { fieldError("menuError", err instanceof TypeError ? "Chưa lưu được. Kiểm tra kết nối rồi thử lại." : err.message); }
    finally { $("saveMenuBtn").disabled = false; $("saveMenuBtn").textContent = "Lưu thực đơn"; }
  });

  // Copy the most recent earlier menu into the editor (looks back a week so Monday finds Friday). Not saved until "Lưu".
  $("prevMenuBtn").addEventListener("click", async () => {
    const btn = $("prevMenuBtn"); btn.disabled = true; fieldError("menuError", "");
    try {
      for (let i = 1; i <= 7; i++) {
        const d = shiftDate(date, -i);
        const res = await fetch(`/api/state?date=${d}&_t=${Date.now()}`);
        if (!res.ok) throw new Error("Chưa lấy được thực đơn. Kiểm tra kết nối rồi thử lại.");
        const dishes = (await res.json()).menu?.dishes || [];
        if (dishes.length) { $("menuText").value = dishes.join("\n"); $("menuText").focus(); toast(`Đã lấy thực đơn ${prettyDate(d)}`); return; }
      }
      fieldError("menuError", "Không có thực đơn nào trong 7 ngày trước.");
    } catch (err) { fieldError("menuError", err instanceof TypeError ? "Chưa lấy được thực đơn. Kiểm tra kết nối rồi thử lại." : err.message); }
    finally { btn.disabled = false; }
  });

  $("sampleMenuBtn").addEventListener("click", () => {
    $("menuText").value = [
      "Sườn heo sốt chua ngọt",
      "Bò xào tiêu đen rau củ",
      "Gà ta chiên nước mắm",
      "Cá basa kho tộ",
      "Canh cải thịt băm",
      "Rau muống xào tỏi"
    ].join("\n");
  });

  // Lock / Unlock
  async function toggleLock() {
    if (!canLock() || busy) return;
    const currentLocked = !!(menu && menu.locked);
    const nextLocked = !currentLocked;
    try {
      const res = await fetch("/api/menu", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, locked: nextLocked })
      });
      if (res.ok) {
        toast(nextLocked ? "Đã chốt sổ nhận đơn" : "Đã mở lại nhận đơn");
        fetchDateState(date);
      }
    } catch {
      toast("Không cập nhật được trạng thái chốt");
    }
  }

  $("lockBtn").addEventListener("click", toggleLock);
  $("unlockBtn").addEventListener("click", toggleLock);

  // Copy text
  async function copyText(text, msg) {
    try {
      await navigator.clipboard.writeText(text);
      toast(msg);
    } catch {
      toast("Đã có lỗi khi copy");
    }
  }

  $("copyMsgBtn").addEventListener("click", () => copyText(messageText(), "Đã copy tin nhắn!"));
  $("copyTeamMsgBtn").addEventListener("click", () => copyText(messageText(), "Đã copy tin nhắn!"));

  // Date Navigation
  function gotoDate(d) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d !== date && !busy) {
      date = d;
      menu = null; orders = []; menuLoaded = false; loadFailed = false;
      editingMenu = false;
      resetForm();
      render();
      fetchDateState(date);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "SUBSCRIBE_DATE", date }));
      }
    }
  }

  $("dateInput").addEventListener("change", (e) => gotoDate(e.target.value));
  $("dateInput").addEventListener("click", (e) => { try { e.target.showPicker(); } catch {} });
  $("prevDay").addEventListener("click", () => gotoDate(shiftDate(date, -1)));
  $("nextDay").addEventListener("click", () => gotoDate(shiftDate(date, 1)));
  $("todayBtn").addEventListener("click", () => gotoDate(todayVN()));

  // Search in orders
  $("ratingSearchInput").addEventListener("input", (e) => { ratingQuery = e.target.value; renderRatingsTab(); });
  document.querySelectorAll("[data-rating-filter]").forEach(btn => btn.addEventListener("click", () => { ratingFilter = btn.dataset.ratingFilter; renderRatingsTab(); }));

  $("orderSearchInput").addEventListener("input", (e) => {
    searchQuery = e.target.value.trim();
    renderList();
  });

  // Theme Switcher
  const savedTheme = localStorage.getItem("com-trua-theme") || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", savedTheme);
  updateThemeIcons(savedTheme);

  function updateThemeIcons(th) {
    const isDark = th === "dark";
    $("themeIconSun").hidden = !isDark;
    $("themeIconMoon").hidden = isDark;
    $("themeToggleBtn").setAttribute("aria-label", isDark ? "Chuyển sang giao diện sáng" : "Chuyển sang giao diện tối");
    document.querySelector('meta[name="theme-color"]').content = isDark ? "#17191b" : "#fafafa";
  }
  $("themeToggleBtn").addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("com-trua-theme", next);
    updateThemeIcons(next);
  });

  // Wi-Fi / Web Share Modal
  $("shareBtn").addEventListener("click", async () => {
    $("shareModal").hidden = false;
    const box = $("shareUrlBox");
    // If running on a public domain (like Vercel), share current origin
    if (location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
      box.textContent = window.location.origin;
      return;
    }
    try {
      const res = await fetch("/api/network");
      if (res.ok) {
        const net = await res.json();
        const firstLan = net.lanIps && net.lanIps[0] ? net.lanIps[0].url : net.localUrl;
        box.textContent = firstLan;
      } else {
        box.textContent = window.location.href;
      }
    } catch {
      box.textContent = window.location.href;
    }
  });
  $("closeShareBtn").addEventListener("click", () => { $("shareModal").hidden = true; });
  $("copyShareBtn").addEventListener("click", () => {
    copyText($("shareUrlBox").textContent, "Đã copy link truy cập!");
  });

  // Re-sync when switching back into tab
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !wsConnected) {
      fetchDateState(date, true);
      fetchRatings();
    }
  });

  // ---------- Tab Navigation Event Listeners ----------
  if ($("tabOrderBtn")) $("tabOrderBtn").addEventListener("click", () => switchTab("order"));
  if ($("tabMenuBtn")) $("tabMenuBtn").addEventListener("click", () => switchTab("menu"));
  if ($("tabOrdersListBtn")) $("tabOrdersListBtn").addEventListener("click", () => switchTab("ordersList"));
  $("tabRatingsBtn").addEventListener("click", () => switchTab("ratings"));
  if ($("viewFullMenuBtn")) $("viewFullMenuBtn").addEventListener("click", () => switchTab("menu"));
  if ($("viewAllOrdersBtn")) $("viewAllOrdersBtn").addEventListener("click", () => switchTab("ordersList"));

  // Menu Tab Action Listeners
  if ($("toggleEditMenuTabBtn")) {
    $("toggleEditMenuTabBtn").addEventListener("click", () => {
      editingMenu = !editingMenu;
      $("menuEditor").hidden = !editingMenu;
      if (editingMenu) {
        $("menuText").value = (menu && menu.dishes ? menu.dishes.join("\n") : "");
        $("menuDateLabel").textContent = prettyDate(date);
        $("menuText").focus();
      }
    });
  }

  if ($("closeMenuEditorBtn")) {
    $("closeMenuEditorBtn").addEventListener("click", () => {
      editingMenu = false;
      $("menuEditor").hidden = true;
    });
  }

  $("quickPrevMenuTabBtn").addEventListener("click", () => {
    editingMenu = true;
    $("menuEditor").hidden = false;
    $("menuDateLabel").textContent = prettyDate(date);
    $("prevMenuBtn").click();
  });

  // My Order Summary buttons
  if ($("editMyOrderBtn")) {
    $("editMyOrderBtn").addEventListener("click", () => {
      const myOrder = ownOrder();
      if (myOrder) {
        switchTab("order");
        startEdit(myOrder);
      }
    });
  }

  $("deleteMyOrderBtn").addEventListener("click", () => {
    const order = ownOrder(), btn = $("deleteMyOrderBtn");
    if (!order || menu?.locked) return;
    if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = "Hủy đơn"; deleteOrder(order); return; }
    btn.dataset.armed = "true"; btn.textContent = "Xác nhận hủy?";
    setTimeout(() => { delete btn.dataset.armed; btn.textContent = "Hủy đơn"; }, 3000);
  });

  // ---------- Init ----------
  // Roving focus for the tablist; preserve native button keyboard behavior.
  const tabKeys = ["order", "menu", "ordersList", "ratings"];
  const tabButtons = ["tabOrderBtn", "tabMenuBtn", "tabOrdersListBtn", "tabRatingsBtn"];
  document.querySelector(".segment-tabs").addEventListener("keydown", e => {
    const index = tabKeys.indexOf(currentTab);
    const n = tabKeys.length;
    const next = e.key === "ArrowRight" ? (index + 1) % n : e.key === "ArrowLeft" ? (index + n - 1) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : null;
    if (next !== null) { e.preventDefault(); switchTab(tabKeys[next]); $(tabButtons[next]).focus(); }
  });
  $("nameInput").addEventListener("input", () => fieldError("nameError", "", "nameInput"));
  // Modal focus containment, Escape and focus restoration.
  const closeShare = () => { $("shareModal").hidden = true; document.body.style.overflow = ""; $("shareBtn").focus(); };
  $("shareBtn").addEventListener("click", () => { document.body.style.overflow = "hidden"; $("closeShareBtn").focus(); });
  $("closeShareBtn").addEventListener("click", closeShare);
  $("shareModal").addEventListener("click", e => { if (e.target === $("shareModal")) closeShare(); });
  $("shareModal").addEventListener("keydown", e => {
    if (e.key === "Escape") closeShare();
    if (e.key === "Tab") {
      const first = $("closeShareBtn"), last = $("copyShareBtn");
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  try {
    const cached = JSON.parse(localStorage.getItem("com_trua_ratings_v2"));
    if (Array.isArray(cached?.dishes)) applyRatings(cached);
  } catch {}
  render();
  // Known serverless host: skip the doomed WebSocket handshake; checkCloudSync re-enables it if that changes.
  let knownServerless = false;
  try { knownServerless = localStorage.getItem("com_trua_serverless") === "1"; } catch {}
  if (knownServerless) { serverless = true; checkCloudSync(); } else initWebSocket();
  fetchDateState(date);
  fetchRatings();
})();
