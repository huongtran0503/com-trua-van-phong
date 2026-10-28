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
  const AVATAR_COLORS = [
    "#2B5282", // Deep Indigo Blue
    "#14171A", // Matte Nori Black
    "#3A6094", // Cobalt Blue
    "#4A6FA5", // Periwinkle Slate Blue
    "#203E66", // Midnight Indigo
    "#597BB2", // Swirl Accent Blue
    "#344E72"  // Muted Indigo
  ];
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

  function getFoodEmoji(name) {
    const n = (name || "").toLowerCase();
    if (n.includes("sườn") || n.includes("heo") || n.includes("thịt")) return "🍖";
    if (n.includes("bò")) return "🥩";
    if (n.includes("gà")) return "🍗";
    if (n.includes("cá") || n.includes("tôm") || n.includes("hải sản") || n.includes("basa")) return "🐟";
    if (n.includes("canh") || n.includes("súp")) return "🍲";
    if (n.includes("rau") || n.includes("cải") || n.includes("muống") || n.includes("xào")) return "🥗";
    if (n.includes("trứng")) return "🍳";
    if (n.includes("đậu") || n.includes("tofu")) return "🥢";
    return "🍱";
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
      text.textContent = "Realtime";
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
      if (res.ok) {
        const data = await res.json();
        applyState(data);
        if (!wsConnected) {
          updateWsStatus("cloud");
          startSmartPolling();
        }
      } else {
        if (!wsConnected) updateWsStatus("offline");
      }
    } catch (err) {
      if (!silent) {
        console.warn("Không kết nối được server, dùng fallback local:", err);
      }
      if (!wsConnected) updateWsStatus("offline");
      fallbackLocalLoad(d);
    }
  }

  function applyState(data) {
    menu = data.menu;
    menuLoaded = true;
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
    $("todayBtn").style.opacity = isToday ? "0.6" : "1";

    const locked = !!(menu && menu.locked);
    const hasMenu = !!(menu && menu.dishes && menu.dishes.length);

    // Update Tab Badges
    const menuBadge = $("menuCountBadge");
    if (menuBadge) menuBadge.textContent = `${menu?.dishes?.length || 0} món`;

    const ordersBadge = $("ordersCountBadge");
    if (ordersBadge) ordersBadge.textContent = `${orders.length} suất`;

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

    renderOrderForm();
    renderMyOrderSummary();
    renderMenuTab();
    renderList();
    renderMessage();
  }

  function renderMyOrderSummary() {
    const myOrder = orders.find(o => o.createdBy === myId || (o.forUser && o.forUser === myId));
    const noHint = $("noMyOrderHint");
    const hasBox = $("hasMyOrderBox");
    const ticket = $("myOrderTicket");

    if (myOrder) {
      if (noHint) noHint.hidden = true;
      if (hasBox) hasBox.hidden = false;
      if (ticket) {
        ticket.innerHTML = `
          <div style="font-weight:700;color:var(--primary);margin-bottom:2px">${displayName(myOrder)}</div>
          <div>${orderLine(myOrder)}</div>
          <div style="font-size:0.75rem;color:var(--muted);margin-top:4px">
            🕒 Đặt lúc ${new Date(myOrder.createdAt || Date.now()).toLocaleTimeString("vi-VN", {hour:"2-digit", minute:"2-digit"})}
          </div>
        `;
      }
    } else {
      if (noHint) noHint.hidden = false;
      if (hasBox) hasBox.hidden = true;
    }
  }

  function renderMenuTab() {
    const locked = !!(menu && menu.locked);
    const dishes = (menu && menu.dishes) || [];

    // Header info
    $("menuCoverDate").textContent = prettyDate(date);
    const poster = menu && menu.postedBy ? (people.get(menu.postedBy) ? people.get(menu.postedBy).name : "Đồng nghiệp") : "Đồng nghiệp";
    $("menuCoverPoster").textContent = poster;
    $("menuCoverDishCount").textContent = `${dishes.length} món`;

    const st = $("menuCoverStatus");
    if (st) {
      if (locked) {
        st.textContent = "Đã chốt nhận đơn";
        st.className = "status-pill-green locked";
      } else {
        st.textContent = "Đang nhận đơn";
        st.className = "status-pill-green";
      }
    }

    // Popularity counts
    const dishCounts = {};
    orders.forEach(o => {
      (o.dishes || []).forEach(d => {
        dishCounts[d] = (dishCounts[d] || 0) + 1;
      });
    });

    // Render Grid
    const grid = $("menuDishesGrid");
    if (!grid) return;
    grid.replaceChildren();

    if (!dishes.length) {
      const empty = document.createElement("div");
      empty.style.gridColumn = "1 / -1";
      empty.className = "empty-state-clean";
      empty.innerHTML = `
        <div class="empty-emoji">📋</div>
        <h4>Chưa có thực đơn cho ngày này</h4>
        <p>Bấm "Sửa thực đơn" để thêm danh sách món ăn hôm nay.</p>
      `;
      grid.appendChild(empty);
      return;
    }

    dishes.forEach((dish, idx) => {
      const count = dishCounts[dish] || 0;
      const isChosen = selected.includes(dish);

      const card = document.createElement("div");
      card.className = "food-card";

      const top = document.createElement("div");
      top.className = "food-card-top";

      const icon = document.createElement("div");
      icon.className = "food-card-icon";
      icon.textContent = getFoodEmoji(dish);

      const badge = document.createElement("span");
      badge.className = "food-card-badge" + (count > 0 ? " popular" : "");
      badge.textContent = count > 0 ? `🔥 ${count} người chọn` : "Món ngon";

      top.append(icon, badge);

      const nameEl = document.createElement("div");
      nameEl.className = "food-card-name";
      nameEl.textContent = dish;

      const bottom = document.createElement("div");
      bottom.className = "food-card-bottom";

      const subText = document.createElement("span");
      subText.style.fontSize = "0.82rem";
      subText.style.color = "var(--text-muted)";
      subText.textContent = `Món #${idx + 1}`;

      const actionBtn = document.createElement("button");
      actionBtn.type = "button";
      actionBtn.className = "food-card-action-btn" + (isChosen ? " active" : "");
      actionBtn.textContent = isChosen ? "✓ Đã chọn" : "+ Chọn món";

      bottom.append(subText, actionBtn);
      card.append(top, nameEl, bottom);

      card.addEventListener("click", () => {
        if (!selected.includes(dish)) {
          selected.push(dish);
        }
        switchTab("order");
        renderDishChips(locked);
        renderPreview();
        toast(`Đã chọn: ${dish}`);
      });

      grid.appendChild(card);
    });
  }

  function renderOrderForm() {
    const locked = !!(menu && menu.locked);
    const poster = menu && menu.postedBy ? (people.get(menu.postedBy) ? people.get(menu.postedBy).name : "Đồng nghiệp") : null;
    $("posterLine").textContent = poster ? `Thực đơn bởi ${poster}` : "";

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
    $("submitBtn").disabled = locked;
    document.querySelectorAll("#orderForm input, #orderForm textarea, #orderForm button:not(#unlockBtn)")
      .forEach(el => {
        if (el.id !== "unlockBtn") {
          el.disabled = locked;
        }
      });
  }

  function renderDishChips(locked) {
    const wrap = $("dishChips");
    wrap.replaceChildren();

    const dishes = (menu && menu.dishes) || [];
    dishes.forEach((d) => {
      const isChosen = selected.includes(d);
      const card = document.createElement("div");
      card.className = "dish-choice-card" + (isChosen ? " selected" : "");

      const left = document.createElement("div");
      left.className = "dish-choice-left";

      const icon = document.createElement("span");
      icon.className = "dish-choice-icon";
      icon.textContent = getFoodEmoji(d);

      const title = document.createElement("span");
      title.className = "dish-choice-title";
      title.textContent = d;

      left.append(icon, title);

      const check = document.createElement("div");
      check.className = "dish-choice-check";
      check.textContent = isChosen ? "✓" : "";

      card.append(left, check);

      if (!locked) {
        card.addEventListener("click", () => {
          if (selected.includes(d)) {
            selected = selected.filter(x => x !== d);
          } else {
            selected.push(d);
          }
          renderDishChips(locked);
          renderPreview();
        });
      }

      wrap.appendChild(card);
    });
  }

  function renderPreview() {
    const count = selected.length;
    $("pickCount").textContent = count ? `· Đã chọn ${count} món` : "Chọn ít nhất 1 món";
    const subBtn = $("submitBtn");
    if (editingId) {
      subBtn.textContent = count ? `Cập nhật đơn (${count} món) ➜` : "Cập nhật đơn ➜";
    } else {
      subBtn.textContent = count ? `Đặt cơm ngay (${count} món) ➜` : "Đặt cơm ngay ➜";
    }
  }

  function renderList() {
    const list = $("orderList");
    const totalCount = orders.length;
    $("countLabel").textContent = `${totalCount} suất`;
    $("orderEmpty").hidden = totalCount > 0;

    const filtered = searchQuery
      ? orders.filter(o => displayName(o).toLowerCase().includes(searchQuery.toLowerCase()) || orderLine(o).toLowerCase().includes(searchQuery.toLowerCase()))
      : orders;

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
      who.textContent = name + (o.forUser && o.createdBy && o.createdBy !== name ? ` (bởi ${o.createdBy})` : "");

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
        edit.addEventListener("click", () => startEdit(o));

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

    Object.entries(dishTally).forEach(([name, count]) => {
      const chip = document.createElement("div");
      chip.className = "tally-chip";
      chip.innerHTML = `<span>${getFoodEmoji(name)} ${name}</span>: <strong>${count}</strong>`;
      container.appendChild(chip);
    });

    Object.entries(riceTally).forEach(([rName, count]) => {
      const chip = document.createElement("div");
      chip.className = "tally-chip";
      chip.style.background = "var(--surface)";
      chip.style.border = "1px solid var(--border)";
      chip.innerHTML = `<span>🍚 ${rName}</span>: <strong>${count}</strong>`;
      container.appendChild(chip);
    });
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
    $("orderPanel").scrollIntoView({ behavior: "smooth" });
  }

  function resetForm() {
    editingId = null;
    selected = [];
    $("noteInput").value = "";
    const normRadio = $("rice-normal");
    if (normRadio) normRadio.checked = true;
    $("dupNotice").hidden = true;
    $("submitBtn").textContent = "Đặt cơm ngay";
    $("cancelEditBtn").hidden = true;
    $("forOther").checked = false;
    $("otherNameWrap").hidden = true;
    renderPreview();
  }

  $("cancelEditBtn").addEventListener("click", resetForm);

  async function submitOrder() {
    const name = targetName();
    if (!name) {
      toast("Vui lòng nhập tên người đặt");
      $("nameInput").focus();
      return;
    }
    if (!selected.length) {
      toast("Vui lòng chọn ít nhất một món ăn");
      return;
    }

    const riceInput = document.querySelector('#riceSeg input:checked');
    const rice = riceInput ? riceInput.value : "";
    const note = $("noteInput").value.trim();
    const forOther = $("forOther").checked;

    const payload = {
      id: editingId || undefined,
      date,
      name,
      dishes: selected,
      rice,
      note,
      forUser: forOther ? undefined : myId,
      createdBy: myName() || name
    };

    try {
      const res = await fetch("/api/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        toast(editingId ? "Đã cập nhật đơn thành công!" : `Đã đặt cơm cho ${name}!`);
        resetForm();
        fetchDateState(date);
      } else {
        const err = await res.json();
        toast(err.error || "Không gửi được đơn");
      }
    } catch {
      toast("Mất kết nối server, lưu tạm bộ nhớ local");
    }
  }

  $("submitBtn").addEventListener("click", submitOrder);

  async function deleteOrder(o) {
    try {
      const res = await fetch(`/api/order/${o.id}`, { method: "DELETE" });
      if (res.ok) {
        toast(`Đã xóa đơn của ${displayName(o)}`);
        fetchDateState(date);
      }
    } catch {
      toast("Không xóa được đơn");
    }
  }

  // Name management
  async function saveName() {
    const val = cleanName($("nameInput").value);
    if (!val) { toast("Vui lòng nhập tên"); return; }
    localStorage.setItem("com_trua_user_name", val);
    editingName = false;

    try {
      await fetch("/api/people", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: myId, name: val })
      });
      people.set(myId, { id: myId, name: val });
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
  document.querySelectorAll(".quick-tag-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tag = btn.dataset.tag;
      const cur = $("noteInput").value.trim();
      $("noteInput").value = cur ? `${cur}, ${tag}` : tag;
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
    if (!lines.length) { toast("Thực đơn trống"); return; }
    try {
      const res = await fetch("/api/menu", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, dishes: lines, postedBy: myId })
      });
      if (res.ok) {
        editingMenu = false;
        toast(`Đã lưu thực đơn với ${lines.length} món`);
        fetchDateState(date);
      }
    } catch {
      toast("Không lưu được thực đơn");
    }
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
    if (d && d !== date) {
      date = d;
      resetForm();
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
      const myOrder = orders.find(o => o.createdBy === myId || (o.forUser && o.forUser === myId));
      if (myOrder) {
        switchTab("order");
        startEdit(myOrder);
      }
    });
  }

  if ($("deleteMyOrderBtn")) {
    $("deleteMyOrderBtn").addEventListener("click", () => {
      const myOrder = orders.find(o => o.createdBy === myId || (o.forUser && o.forUser === myId));
      if (myOrder) {
        deleteOrder(myOrder);
      }
    });
  }

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
      const lines = ["📊 TỔNG HỢP CƠM TRƯA (" + orders.length + " suất):"];
      Object.entries(dishTally).forEach(([k, v]) => lines.push(`- ${k}: ${v} suất`));
      if (Object.keys(riceTally).length) {
        lines.push("\nLượng cơm:");
        Object.entries(riceTally).forEach(([k, v]) => lines.push(`- ${k}: ${v}`));
      }
      copyText(lines.join("\n"), "Đã copy tổng hợp món!");
    });
  }

  // ---------- Init ----------
  initWebSocket();
  fetchDateState(date);
})();
