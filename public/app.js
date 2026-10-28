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

  // ---------- Rendering Logic ----------
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

    // Panels visibility
    $("menuEditor").hidden = hasMenu && !editingMenu;
    $("orderForm").hidden = !hasMenu || editingMenu;

    if (!hasMenu || editingMenu) {
      $("menuDateLabel").textContent = prettyDate(date);
    }

    if (hasMenu && !editingMenu) {
      renderOrderForm();
    }

    renderList();
    renderMessage();
  }

  function renderOrderForm() {
    const locked = !!(menu && menu.locked);
    const poster = menu && menu.postedBy ? (people.get(menu.postedBy) ? people.get(menu.postedBy).name : "Đồng nghiệp") : null;
    $("posterLine").textContent = poster ? `Thực đơn đăng bởi: ${poster}` : "";

    // Lock Notice
    const lockNotice = $("lockNotice");
    lockNotice.hidden = !locked;
    if (locked) {
      $("lockNoticeText").textContent = "Đơn ngày này đã chốt sổ.";
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

    // Preview
    renderPreview();

    // Disable inputs if locked
    $("submitBtn").disabled = locked;
    document.querySelectorAll("#orderForm input, #orderForm textarea, #orderForm button:not(#unlockBtn):not(#editMenuBtn)")
      .forEach(el => {
        if (el.id !== "unlockBtn" && el.id !== "editMenuBtn") {
          el.disabled = locked;
        }
      });
  }

  function renderDishChips(locked) {
    const wrap = $("dishChips");
    wrap.replaceChildren();

    const dishes = (menu && menu.dishes) || [];
    dishes.forEach((d) => {
      const label = document.createElement("label");
      label.className = "chip";

      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = d;
      input.checked = selected.includes(d);
      input.disabled = locked;

      input.addEventListener("change", () => {
        if (input.checked) {
          if (!selected.includes(d)) selected.push(d);
        } else {
          selected = selected.filter(x => x !== d);
        }
        renderPreview();
      });

      const span = document.createElement("span");
      span.textContent = d;

      label.append(input, span);
      wrap.appendChild(label);
    });
  }

  function renderPreview() {
    const name = targetName() || "Tên bạn";
    const riceInput = document.querySelector('#riceSeg input:checked');
    const rice = riceInput ? riceInput.value : "";
    $("pickCount").textContent = selected.length ? `· đã chọn ${selected.length} món` : "";

    const p = $("preview");
    p.replaceChildren();
    if (!selected.length) {
      p.innerHTML = "<span style='color:var(--muted)'>Chọn ít nhất một món ở trên để xem trước đơn đặt.</span>";
      return;
    }
    const b = document.createElement("b");
    b.textContent = name + ": ";
    p.append(b, orderLine({ rice, dishes: selected, note: $("noteInput").value.trim() }));
  }

  function renderList() {
    const list = $("orderList");
    const totalCount = orders.length;
    $("countLabel").textContent = `${totalCount} suất`;
    $("orderEmpty").hidden = totalCount > 0;
    $("searchWrap").style.display = totalCount >= 4 ? "block" : "none";

    const filtered = searchQuery
      ? orders.filter(o => displayName(o).toLowerCase().includes(searchQuery.toLowerCase()) || orderLine(o).toLowerCase().includes(searchQuery.toLowerCase()))
      : orders;

    const locked = !!(menu && menu.locked);
    list.replaceChildren(...filtered.map((o) => {
      const li = document.createElement("li");
      if (o.id === editingId) li.className = "editing";

      const av = document.createElement("div");
      av.className = "order-avatar";
      const name = displayName(o);
      av.textContent = getInitials(name);
      av.style.background = getAvatarColor(name);

      const body = document.createElement("div");
      body.className = "order-body";

      const headerLine = document.createElement("div");
      headerLine.className = "order-header-line";

      const who = document.createElement("span");
      who.className = "who";
      who.textContent = name;
      headerLine.appendChild(who);

      if (o.forUser && o.createdBy && o.createdBy !== name) {
        const byTag = document.createElement("span");
        byTag.className = "by-tag";
        byTag.textContent = `(bởi ${o.createdBy})`;
        headerLine.appendChild(byTag);
      }

      const what = document.createElement("span");
      what.className = "what";
      what.textContent = orderLine(o);

      body.append(headerLine, what);

      const acts = document.createElement("div");
      acts.className = "acts";

      const mayManage = isPoster() || o.createdBy === myId || o.forUser === myId;

      const edit = document.createElement("button");
      edit.className = "ghost small";
      edit.textContent = "Sửa";
      edit.hidden = !mayManage || locked;
      edit.addEventListener("click", () => startEdit(o));

      const del = document.createElement("button");
      del.className = "ghost small danger";
      del.textContent = "Xóa";
      del.hidden = !mayManage || locked;

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
      li.append(av, body, acts);
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

  // ---------- Init ----------
  initWebSocket();
  fetchDateState(date);
})();
