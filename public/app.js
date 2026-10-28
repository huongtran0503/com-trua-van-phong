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
  const cleanName = (s) => (s || "").trim().replace(/\s+/g, " ");

  const myName = () => (myId && people.get(myId) && people.get(myId).name) || localStorage.getItem("com_trua_user_name") || "";
  const displayName = (o) => (o.forUser && people.get(o.forUser) && people.get(o.forUser).name) || o.name;
  const isPoster = () => !!(menu && myId && menu.postedBy === myId);

  // Indigo Blue, Slate & Nori Black Palette for Colleague Avatars
  const AVATAR_COLORS = ["#2b5282"];
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
        setTimeout(initWebSocket, 15000);
      };

      ws.onerror = () => {
        wsConnected = false;
        checkCloudSync();
      };
    } catch {
      wsConnected = false;
      checkCloudSync();
    }
  }

  async function checkCloudSync() {
    try {
      const res = await fetch(`/api/health?_t=${Date.now()}`);
      if (res.ok) {
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
    pollTimer = setInterval(() => {
      // Smart Polling: only poll when tab is active/visible, not busy submitting, and WS is disconnected
      if (!wsConnected && !document.hidden && !busy) {
        fetchDateState(date, true);
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
    } else if (msg.type === "PEOPLE_UPDATED") {
      if (msg.data && msg.data.person) {
        people.set(msg.data.person.id, msg.data.person);
        render();
      }
    }
  }

  async function fetchDateState(d, silent = false) {
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
      { id: "ordersList", btn: $("tabOrdersListBtn"), view: $("viewOrdersList") }
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
    $("pageDateLabel").textContent = prettyDate(date);
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
    renderMyOrderSummary();
    renderMenuTab();
    renderList();
    renderMessage();
  }

  function renderMyOrderSummary() {
    const order = ownOrder();
    $("noMyOrderHint").hidden = !!order; $("hasMyOrderBox").hidden = !order;
    const ticket = $("myOrderTicket"); ticket.replaceChildren();
    if (!order) return;
    const name = document.createElement("strong"); name.textContent = displayName(order);
    const detail = document.createElement("p"); detail.textContent = orderLine(order);
    const time = document.createElement("p"); time.className = "helper-text";
    if (order.createdAt) time.textContent = "Đặt lúc " + new Date(order.createdAt).toLocaleTimeString("vi-VN", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
    ticket.append(name, detail, time);
    $("editMyOrderBtn").disabled = !!menu?.locked || busy;
    $("deleteMyOrderBtn").disabled = !!menu?.locked || busy;
  }

  function renderMenuTab() {
    const locked = !!menu?.locked, dishes = menu?.dishes || [];
    $("menuCoverDate").textContent = prettyDate(date);
    $("menuCoverPoster").textContent = people.get(menu?.postedBy)?.name ? "Đăng bởi " + people.get(menu.postedBy).name : "Thực đơn văn phòng";
    $("menuCoverDishCount").textContent = dishes.length + " món";
    $("menuCoverStatus").textContent = !dishes.length ? "Chưa có thực đơn" : locked ? "Đã chốt nhận đơn" : "Đang nhận đơn";
    $("menuCoverStatus").className = "status-pill-green" + (locked ? " locked" : "");
    const grid = $("menuDishesGrid"); grid.replaceChildren();
    if (!dishes.length) { grid.append(emptyState("Chưa có thực đơn cho ngày này", "Bấm Sửa thực đơn để thêm danh sách món ăn.", "book-open")); return; }
    dishes.forEach(dish => {
      const card = document.createElement("article"); card.className = "menu-dish-row";
      const copy = document.createElement("div");
      const name = document.createElement("h2"); name.className = "menu-dish-name"; name.textContent = dish;
      copy.append(name);
      const count = orders.filter(o => o.dishes?.includes(dish)).length;
      if (count) { const caption = document.createElement("p"); caption.className = "menu-dish-count"; caption.textContent = count + " suất đã đặt"; copy.append(caption); }
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
    const poster = menu && menu.postedBy ? (people.get(menu.postedBy) ? people.get(menu.postedBy).name : "Đồng nghiệp") : null;
    $("posterLine").textContent = poster ? `Thực đơn bởi ${poster}` : "Chọn một hoặc nhiều món cho bữa trưa.";

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
      const check = document.createElement("span"); check.className = "dish-choice-check"; check.append(icon(chosen ? "check" : "plus"));
      card.append(name, check);
      card.addEventListener("click", () => {
        selected = selected.includes(dish) ? selected.filter(d => d !== dish) : [...selected, dish];
        fieldError("dishError", ""); fieldError("submitError", ""); renderDishChips(locked); renderPreview();
      });
      wrap.append(card); if (focused === dish) card.focus({ preventScroll: true });
    });
  }

  function renderPreview() {
    $("pickCount").textContent = selected.length ? selected.length + " món đã chọn" : "Chưa chọn món";
    $("selectedDishNames").textContent = selected.length ? selected.join(", ") : "Món bạn chọn sẽ xuất hiện ở đây.";
    const btn = $("submitBtn");
    btn.replaceChildren(document.createTextNode(busy ? "Đang gửi đơn..." : menu?.locked ? "Đã chốt đơn" : editingId ? "Cập nhật đơn" : "Đặt cơm ngay"), icon(busy ? "bowl-food" : "arrow-right"));
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
    $("orderEmptyText").textContent = searchQuery ? "Thử tìm bằng tên hoặc món ăn khác." : "Đơn đặt của mọi người sẽ xuất hiện ở đây.";
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

    renderTally();
  }

  function renderTally() {
    const container = $("tallyCards");
    if (!container) return;
    container.replaceChildren();

    if (!orders.length) {
      container.innerHTML = "<span style='font-size:0.82rem;color:var(--text-muted)'>Chưa có đơn đặt</span>";
      return;
    }

    const dishTally = {};
    const riceTally = {};
    orders.forEach(o => {
      (o.dishes || []).forEach(d => {
        dishTally[d] = (dishTally[d] || 0) + 1;
      });
      if (o.rice) {
        const rName = RICE[o.rice] || o.rice;
        riceTally[rName] = (riceTally[rName] || 0) + 1;
      }
    });

    const add = (name, count) => {
      const row = document.createElement("div"); row.className = "tally-chip";
      const label = document.createElement("span"); label.textContent = name;
      const number = document.createElement("strong"); number.textContent = count + " suất";
      row.append(label, number); container.append(row);
    };
    Object.entries(dishTally).forEach(([name, count]) => add(name, count));
    Object.entries(riceTally).forEach(([name, count]) => add(name, count));
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
    $("copyTallyBtn").disabled = !orders.length;
    $("lockHint").textContent = locked ? "Đang khóa không nhận đơn mới" : "Bấm để chốt danh sách khi hết giờ";
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
      toast(wasEditing ? "Đã cập nhật đơn." : "Đã đặt cơm cho " + name + "!");
      if (requestDate === date) resetForm();
      await fetchDateState(requestDate, true);
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
        fetchDateState(date);
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
    $("saveMenuBtn").textContent = "Đang lưu...";
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
  $("prevDay").addEventListener("click", () => gotoDate(shiftDate(date, -1)));
  $("nextDay").addEventListener("click", () => gotoDate(shiftDate(date, 1)));
  $("todayBtn").addEventListener("click", () => gotoDate(todayVN()));

  // Search in orders
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
    }
  });

  // ---------- Tab Navigation Event Listeners ----------
  if ($("tabOrderBtn")) $("tabOrderBtn").addEventListener("click", () => switchTab("order"));
  if ($("tabMenuBtn")) $("tabMenuBtn").addEventListener("click", () => switchTab("menu"));
  if ($("tabOrdersListBtn")) $("tabOrdersListBtn").addEventListener("click", () => switchTab("ordersList"));
  if ($("goToOrderTabBtn")) $("goToOrderTabBtn").addEventListener("click", () => switchTab("order"));
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

  if ($("quickSampleMenuTabBtn")) {
    $("quickSampleMenuTabBtn").addEventListener("click", () => {
      editingMenu = true;
      $("menuEditor").hidden = false;
      $("sampleMenuBtn").click();
      $("menuDateLabel").textContent = prettyDate(date);
      $("menuText").focus();
    });
  }

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

  if ($("copyTallyBtn")) {
    $("copyTallyBtn").addEventListener("click", () => {
      if (!orders.length) { toast("Chưa có đơn để tổng hợp"); return; }
      const dishTally = {};
      const riceTally = {};
      orders.forEach(o => {
        (o.dishes || []).forEach(d => { dishTally[d] = (dishTally[d] || 0) + 1; });
        if (o.rice) {
          const rName = RICE[o.rice] || o.rice;
          riceTally[rName] = (riceTally[rName] || 0) + 1;
        }
      });
      const lines = ["TỔNG HỢP CƠM TRƯA (" + orders.length + " suất):"];
      Object.entries(dishTally).forEach(([k, v]) => lines.push(`- ${k}: ${v} suất`));
      if (Object.keys(riceTally).length) {
        lines.push("\nLượng cơm:");
        Object.entries(riceTally).forEach(([k, v]) => lines.push(`- ${k}: ${v}`));
      }
      copyText(lines.join("\n"), "Đã copy tổng hợp món!");
    });
  }

  // ---------- Init ----------
  // Roving focus for the tablist; preserve native button keyboard behavior.
  const tabKeys = ["order", "menu", "ordersList"];
  const tabButtons = ["tabOrderBtn", "tabMenuBtn", "tabOrdersListBtn"];
  document.querySelector(".segment-tabs").addEventListener("keydown", e => {
    const index = tabKeys.indexOf(currentTab);
    const next = e.key === "ArrowRight" ? (index + 1) % 3 : e.key === "ArrowLeft" ? (index + 2) % 3 : e.key === "Home" ? 0 : e.key === "End" ? 2 : null;
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
  render();
  initWebSocket();
  fetchDateState(date);
})();
