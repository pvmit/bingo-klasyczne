(() => {
  const SIZE = 5;
  const CELL_COUNT = SIZE * SIZE;
  const ROOM_KEY = "bingo.k.room";
  const ROLE_KEY = "bingo.k.role";
  const PID_KEY = "bingo.k.pid";
  const NICK_KEY = "bingo.k.nick";
  const GAME_KEY = "bingo.k.game";
  const GOALS_KEY = "bingo.k.goals";
  const GOALS_VER_KEY = "bingo.k.goalsVer";
  const GOALS_VER = "katowice-1";
  const KIND = "classic";
  const LIVE = "LIVE";

  const app = document.getElementById("app");
  let game = null;
  let roomCode = LIVE;
  let role = localStorage.getItem(ROLE_KEY) || "";
  let playerId = localStorage.getItem(PID_KEY) || "";
  let nickDraft = localStorage.getItem(NICK_KEY) || "";
  let customGoals = null;
  let watchStop = null;
  let watchingCode = "";
  let joiningPlayer = false;
  let emptyPublish = false;
  let repaint = null;
  let syncStatus = "offline";
  let syncError = "";
  let reconnectTimer = null;
  let joining = false;

  if (!playerId) {
    playerId = (crypto.randomUUID && crypto.randomUUID()) || ("p" + Math.random().toString(36).slice(2, 12));
    try { localStorage.setItem(PID_KEY, playerId); } catch (e) { /* ignore */ }
  }

  try {
    const cached = localStorage.getItem(GAME_KEY);
    if (cached) game = JSON.parse(cached);
  } catch (e) {
    game = null;
  }
  try {
    if (localStorage.getItem(GOALS_VER_KEY) !== GOALS_VER) {
      localStorage.removeItem(GOALS_KEY);
      localStorage.setItem(GOALS_VER_KEY, GOALS_VER);
    }
    const rawGoals = localStorage.getItem(GOALS_KEY);
    if (rawGoals) {
      const parsed = JSON.parse(rawGoals);
      if (Array.isArray(parsed) && parsed.length) customGoals = parsed;
    }
  } catch (e) {
    customGoals = null;
  }

  function defaultGoals() {
    return Array.isArray(window.GOALS) ? window.GOALS.slice() : [];
  }

  function getGoalsPool() {
    if (customGoals && customGoals.length) return customGoals.slice();
    return defaultGoals();
  }

  function parseGoalsText(text) {
    return String(text || "")
      .split(/\r?\n/)
      .map(function (line) { return line.trim(); })
      .filter(Boolean);
  }

  function goalsToText(list) {
    return (list || []).join("\n");
  }

  function saveCustomGoals(list) {
    if (!list || !list.length) {
      customGoals = null;
      localStorage.removeItem(GOALS_KEY);
      return;
    }
    customGoals = list.slice();
    try {
      localStorage.setItem(GOALS_KEY, JSON.stringify(customGoals));
    } catch (e) { /* ignore quota */ }
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashSeed(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function pickBoard(seedStr, pool) {
    const list = (pool || []).slice();
    if (list.length < CELL_COUNT) {
      throw new Error("Za malo pytan (potrzeba min. " + CELL_COUNT + ", masz " + list.length + ").");
    }
    const rand = mulberry32(hashSeed(seedStr));
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = list[i];
      list[i] = list[j];
      list[j] = tmp;
    }
    return list.slice(0, CELL_COUNT);
  }

  function countLines(done) {
    const at = function (r, c) {
      return !!(done && done[r * SIZE + c]);
    };
    let lines = 0;
    let r;
    let c;
    for (r = 0; r < SIZE; r++) {
      let ok = true;
      for (c = 0; c < SIZE; c++) if (!at(r, c)) { ok = false; break; }
      if (ok) lines++;
    }
    for (c = 0; c < SIZE; c++) {
      let ok = true;
      for (r = 0; r < SIZE; r++) if (!at(r, c)) { ok = false; break; }
      if (ok) lines++;
    }
    let d1 = true;
    let d2 = true;
    for (let i = 0; i < SIZE; i++) {
      if (!at(i, i)) d1 = false;
      if (!at(i, SIZE - 1 - i)) d2 = false;
    }
    if (d1) lines++;
    if (d2) lines++;
    return lines;
  }

  function lineCells(done) {
    const marked = {};
    const at = function (r, c) {
      return !!(done && done[r * SIZE + c]);
    };
    const add = function (idx) {
      marked[idx] = true;
    };
    let r;
    let c;
    for (r = 0; r < SIZE; r++) {
      let ok = true;
      for (c = 0; c < SIZE; c++) if (!at(r, c)) { ok = false; break; }
      if (ok) for (c = 0; c < SIZE; c++) add(r * SIZE + c);
    }
    for (c = 0; c < SIZE; c++) {
      let ok = true;
      for (r = 0; r < SIZE; r++) if (!at(r, c)) { ok = false; break; }
      if (ok) for (r = 0; r < SIZE; r++) add(r * SIZE + c);
    }
    let d1 = true;
    let d2 = true;
    for (let i = 0; i < SIZE; i++) {
      if (!at(i, i)) d1 = false;
      if (!at(i, SIZE - 1 - i)) d2 = false;
    }
    if (d1) for (let i = 0; i < SIZE; i++) add(i * SIZE + i);
    if (d2) for (let i = 0; i < SIZE; i++) add(i * SIZE + (SIZE - 1 - i));
    return marked;
  }

  function boardDone(board, called) {
    const done = {};
    (board || []).forEach(function (text, idx) {
      if (called && called[text]) done[idx] = true;
    });
    return done;
  }

  function playerStats(p) {
    if (!p || !p.board) return { lines: 0, marks: 0, bingo: false, done: {} };
    const done = boardDone(p.board, game && game.called);
    const lines = countLines(done);
    let marks = 0;
    for (const k in done) if (done[k]) marks++;
    return { lines: lines, marks: marks, bingo: lines > 0, done: done };
  }

  function playerList() {
    if (!game || !game.players) return [];
    return Object.keys(game.players).map(function (id) {
      const p = game.players[id];
      const st = playerStats(p);
      return {
        id: id,
        nick: p.nick || "Gracz",
        board: p.board,
        lines: st.lines,
        marks: st.marks,
        bingo: st.bingo,
        done: st.done,
      };
    }).sort(function (a, b) {
      if (a.bingo !== b.bingo) return a.bingo ? -1 : 1;
      if (b.lines !== a.lines) return b.lines - a.lines;
      return String(a.nick).localeCompare(String(b.nick), "pl");
    });
  }

  function newGame(code, pool) {
    return {
      code: String(code || "").toUpperCase(),
      pool: (pool || getGoalsPool()).slice(),
      called: {},
      players: {},
      updatedAt: Date.now(),
    };
  }

  function setRoom() {
    roomCode = LIVE;
    try { localStorage.setItem(ROOM_KEY, LIVE); } catch (e) { /* ignore */ }
  }

  function setRole(next) {
    role = next || "";
    if (role) localStorage.setItem(ROLE_KEY, role);
    else localStorage.removeItem(ROLE_KEY);
  }

  function saveNick(nick) {
    nickDraft = String(nick || "").trim().slice(0, 20);
    if (nickDraft) localStorage.setItem(NICK_KEY, nickDraft);
    else localStorage.removeItem(NICK_KEY);
  }

  function saveGameCache() {
    try {
      if (game) localStorage.setItem(GAME_KEY, JSON.stringify(game));
      else localStorage.removeItem(GAME_KEY);
    } catch (e) { /* ignore quota */ }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      resumeIfNeeded();
    }, 1500);
  }

  function roomConnected() {
    return syncStatus === "polaczono";
  }

  function publishState() {
    if (!game || !roomCode || typeof BingoCloud === "undefined") return Promise.resolve();
    return BingoCloud.save(roomCode, KIND, game).catch(function (err) {
      syncError = err.message || String(err);
      if (typeof repaint === "function") repaint();
    });
  }

  function acceptIncomingGame(incoming) {
    if (incoming == null) return false;
    if (!incoming.pool || !incoming.players) return false;
    if (!game || (incoming.updatedAt || 0) >= (game.updatedAt || 0)) {
      game = incoming;
      if (!game.called) game.called = {};
      if (!game.players) game.players = {};
      saveGameCache();
      return true;
    }
    return false;
  }

  function ensurePlayerBoard(pid, nick) {
    if (!game) return false;
    if (!game.players) game.players = {};
    const existing = game.players[pid];
    if (existing && existing.board && existing.board.length === CELL_COUNT) {
      if (nick && existing.nick !== nick) {
        existing.nick = nick;
        game.updatedAt = Date.now();
        saveGameCache();
      }
      return false;
    }
    const seed = "k-" + game.code + "-" + pid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    game.players[pid] = {
      nick: (nick || "Gracz").slice(0, 20),
      board: pickBoard(seed, game.pool),
      locked: true,
      joinedAt: Date.now(),
    };
    game.updatedAt = Date.now();
    saveGameCache();
    return true;
  }

  function applyCall(text, on) {
    if (!game) return false;
    if (!game.called) game.called = {};
    const key = String(text || "");
    if (!key) return false;
    if (on) game.called[key] = true;
    else delete game.called[key];
    game.updatedAt = Date.now();
    saveGameCache();
    return true;
  }

  function clearCalled() {
    if (!game) return false;
    game.called = {};
    game.updatedAt = Date.now();
    saveGameCache();
    return true;
  }

  function stopSync() {
    if (watchStop) {
      watchStop();
      watchStop = null;
    }
    watchingCode = "";
    joining = false;
    joiningPlayer = false;
    syncStatus = "offline";
  }

  function maybeJoinPlayer() {
    if (role !== "player" || !nickDraft || !playerId || joiningPlayer) return;
    if (game && game.players && game.players[playerId] && game.players[playerId].board) return;
    joiningPlayer = true;
    BingoCloud.get(roomCode, KIND)
      .then(function (remote) {
        if (remote) acceptIncomingGame(remote);
        if (!game) return;
        if (game.players && game.players[playerId] && game.players[playerId].board) return;
        ensurePlayerBoard(playerId, nickDraft);
        return BingoCloud.save(roomCode, KIND, game);
      })
      .catch(function (err) {
        syncError = err.message || String(err);
      })
      .finally(function () {
        joiningPlayer = false;
        if (typeof repaint === "function") repaint();
      });
  }

  function ensureRoomConnection() {
    const r = route();
    if (r.view === "home" || !roomCode) {
      stopSync();
      return;
    }
    if (typeof BingoCloud === "undefined") {
      syncError = "Brak sync.js";
      return;
    }
    if (watchingCode === roomCode && watchStop && syncStatus !== "blad") return;
    if (joining) return;
    joining = true;
    if (watchStop) watchStop();
    watchingCode = roomCode;
    syncStatus = "laczenie";
    syncError = "";
    watchStop = BingoCloud.watch(roomCode, KIND, function (state) {
      joining = false;
      if (!state) {
        if (role === "admin" && game && game.code === roomCode) {
          syncStatus = "polaczono";
          if (!emptyPublish) {
            emptyPublish = true;
            publishState();
          }
        } else {
          syncStatus = "brak gry";
        }
      } else {
        emptyPublish = false;
        acceptIncomingGame(state);
        syncStatus = "polaczono";
        syncError = "";
        maybeJoinPlayer();
      }
      if (typeof repaint === "function") repaint();
    }, function (err) {
      joining = false;
      syncError = err;
      syncStatus = "blad";
      if (typeof repaint === "function") repaint();
      scheduleReconnect();
    });
  }

  function resumeIfNeeded() {
    if (document.visibilityState === "hidden") return;
    const r = route();
    if (r.view === "player" || r.view === "admin") ensureRoomConnection();
  }

  function sendCall(text, on) {
    if (!applyCall(text, on)) return false;
    publishState();
    return true;
  }

  function route() {
    const raw = (location.hash || "#/").replace(/^#/, "") || "/";
    const parts = raw.split("/").filter(Boolean);
    setRoom();
    if (parts[0] === "admin") {
      setRole("admin");
      return { view: "admin" };
    }
    if (parts[0] === "settings") {
      return { view: "settings" };
    }
    if (parts[0] === "play") {
      setRole("player");
      return { view: "player" };
    }
    return { view: "home" };
  }

  function restoreHashFromStorage() {
    const raw = (location.hash || "#/").replace(/^#/, "") || "/";
    const parts = raw.split("/").filter(Boolean);
    if (parts.length) return false;
    if (role === "player") {
      location.replace("#/play");
      return true;
    }
    if (role === "admin") {
      location.replace("#/admin");
      return true;
    }
    return false;
  }

  function el(tag, attrs, kids) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        const v = attrs[k];
        if (k === "class") node.className = v;
        else if (k === "text") node.textContent = v;
        else if (k.indexOf("on") === 0 && typeof v === "function") {
          node.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (v !== false && v != null) {
          node.setAttribute(k, v === true ? "" : String(v));
        }
      });
    }
    (kids || []).forEach(function (c) {
      if (c == null || c === false) return;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }

  function go(hash) {
    location.hash = hash;
  }

  function syncBadge() {
    if (syncError && syncError !== "no-host") {
      return el("p", { class: "error" }, ["Sync: " + syncError]);
    }
    let label = "Oczekiwanie";
    if (syncStatus === "polaczono") label = "Polaczono — gra na zywo";
    else if (syncStatus === "laczenie") label = "Laczenie…";
    else if (syncStatus === "brak gry") label = "Czekam az admin kliknie Nowa gra";
    else label = syncStatus;
    const ok = syncStatus === "polaczono";
    return el("p", { class: ok ? "status-ok" : "status-muted" }, [label]);
  }

  function renderBoard(board) {
    const wrap = el("div", { class: "board" });
    wrap.style.gridTemplateColumns = "repeat(" + SIZE + ", minmax(0, 1fr))";
    const called = (game && game.called) || {};
    const done = boardDone(board, called);
    const winSet = lineCells(done);
    (board || []).forEach(function (text, idx) {
      const marked = !!done[idx];
      const cls =
        "cell readonly" +
        (marked ? " called" : "") +
        (winSet[idx] ? " line-win" : "");
      wrap.appendChild(el("div", { class: cls }, [text]));
    });
    return wrap;
  }

  function renderHome() {
    const nickInput = el("input", {
      type: "text",
      maxlength: "20",
      placeholder: "np. Zosia",
      value: nickDraft,
    });
    const kids = [
      el("h1", null, ["BINGO"]),
      el("p", { class: "lead" }, ["Wybierz role tego urzadzenia"]),
      el("label", { class: "field" }, [
        el("span", null, ["Pseudonim (gracz)"]),
        nickInput,
      ]),
      el("div", { class: "role-grid" }, [
        el("button", {
          class: "role p1",
          type: "button",
          onClick: function () {
            const nick = nickInput.value.trim();
            if (!nick) {
              alert("Wpisz pseudonim.");
              return;
            }
            saveNick(nick);
            setRole("player");
            go("#/play");
          },
        }, ["GRACZ"]),
        el("button", {
          class: "role p2",
          type: "button",
          onClick: function () {
            setRole("admin");
            go("#/admin");
          },
        }, ["ADMINISTRATOR"]),
      ]),
      el("p", { class: "hint" }, [
        "Bez kodu. Wlasna plansza, cele odznacza prowadzacy.",
      ]),
      el("p", { class: "hint" }, [
        el("a", { href: "#/settings" }, ["Ustawienia bazy (Supabase)"]),
      ]),
    ];
    app.replaceChildren(el("section", { class: "screen home" }, kids));
  }

  function renderSettings() {
    const cur = (typeof BingoCloud !== "undefined" && BingoCloud.currentPublic()) || {
      supabaseUrl: "",
      supabaseAnonKey: "",
    };
    const urlInput = el("input", {
      type: "url",
      placeholder: "https://xxxx.supabase.co",
      value: cur.supabaseUrl || "",
    });
    const keyInput = el("input", {
      type: "text",
      placeholder: "anon public / sb_publishable_…",
      value: cur.supabaseAnonKey || "",
    });
    const status = el("p", { class: "hint" });
    const linkBox = el("p", { class: "hint" });

    function paintLink() {
      if (typeof BingoCloud === "undefined") return;
      const link = BingoCloud.joinUrl();
      linkBox.replaceChildren();
      if (!link) return;
      linkBox.appendChild(document.createTextNode("Link dla telefonow (juz z baza): "));
      linkBox.appendChild(el("a", { href: link }, [link]));
    }
    paintLink();

    app.replaceChildren(
      el("section", { class: "screen" }, [
        el("div", { class: "topbar" }, [
          el("button", {
            class: "ghost small",
            type: "button",
            onClick: function () { go("#/"); },
          }, ["← Menu"]),
          el("strong", null, ["USTAWIENIA"]),
        ]),
        el("h1", null, ["Baza"]),
        el("p", { class: "lead" }, [
          "Stary projekt Conquest juz nie istnieje (adres nie dziala). Zaloz nowy na supabase.com, wklej URL i klucz, uruchom supabase/schema.sql.",
        ]),
        el("label", { class: "field" }, [el("span", null, ["Project URL"]), urlInput]),
        el("label", { class: "field" }, [el("span", null, ["anon / publishable key"]), keyInput]),
        el("button", {
          class: "primary",
          type: "button",
          onClick: function () {
            status.textContent = "Sprawdzam…";
            BingoCloud.testConfig({
              supabaseUrl: urlInput.value,
              supabaseAnonKey: keyInput.value,
            })
              .then(function () {
                status.className = "status-ok";
                status.textContent = "Polaczono. Skopiuj link na telefony.";
                paintLink();
              })
              .catch(function (err) {
                status.className = "error";
                status.textContent = err.message || String(err);
                paintLink();
              });
          },
        }, ["Zapisz i sprawdz"]),
        status,
        linkBox,
      ])
    );
  }

  function renderAdmin() {
    let busy = false;
    const goalsArea = el("textarea", {
      class: "goals-editor",
      rows: "12",
      placeholder: "Jedno pytanie / cel w linii (min. 25)…",
    });
    goalsArea.value = goalsToText((game && game.pool) || getGoalsPool());
    const goalsMeta = el("p", { class: "hint goals-meta" });
    const goalsBlock = el("div", { class: "goals-block" });
    const error = el("p", { class: "error hidden" });
    const status = el("div");
    const codeBox = el("div", { class: "room-code" });
    const bingoBanner = el("div");
    const playersWrap = el("div", { class: "admin-summary" });
    const poolWrap = el("div", { class: "call-pool" });
    const boardsWrap = el("div", { class: "admin-mini-boards" });

    function showErr(msg) {
      if (!msg) {
        error.classList.add("hidden");
        error.textContent = "";
        return;
      }
      error.textContent = msg;
      error.classList.remove("hidden");
    }

    function refreshGoalsMeta() {
      const n = parseGoalsText(goalsArea.value).length;
      goalsMeta.textContent =
        n + " pytan w puli (min. " + CELL_COUNT + "). Nowa gra = nowe plansze dla wszystkich graczy.";
    }

    function applyGoalsFromEditor() {
      const list = parseGoalsText(goalsArea.value);
      if (list.length < CELL_COUNT) {
        throw new Error("Za malo pytan (potrzeba min. " + CELL_COUNT + ", masz " + list.length + ").");
      }
      saveCustomGoals(list);
      return list;
    }

    function paint() {
      status.replaceChildren(syncBadge());
      codeBox.replaceChildren(
        el("p", { class: "hint" }, [
          "Gracze: ten sam link → pseudonim → GRACZ. Bez kodu.",
        ])
      );
      refreshGoalsMeta();
      bingoBanner.replaceChildren();
      playersWrap.replaceChildren();
      poolWrap.replaceChildren();
      boardsWrap.replaceChildren();
      if (!game) {
        playersWrap.appendChild(
          el("p", { class: "status-muted" }, ["Brak aktywnej gry — ustaw pytania i kliknij Nowa gra."])
        );
        return;
      }
      const list = playerList();
      const winners = list.filter(function (p) { return p.bingo; });
      if (winners.length) {
        bingoBanner.appendChild(
          el("div", { class: "winner" }, [
            "BINGO: " + winners.map(function (p) { return p.nick; }).join(", "),
          ])
        );
      } else if (!list.length) {
        bingoBanner.appendChild(
          el("p", { class: "status-muted" }, ["Nikt jeszcze nie dolaczyl."])
        );
      } else {
        bingoBanner.appendChild(
          el("p", { class: "status-muted" }, ["Brak bingo."])
        );
      }
      list.forEach(function (p) {
        playersWrap.appendChild(
          el("div", { class: "sum-card" + (p.bingo ? " bingo" : "") }, [
            el("strong", null, [p.nick]),
            el("span", { class: p.bingo ? "score-lines" : "" }, [p.bingo ? "BINGO" : "brak bingo"]),
            el("span", { class: "muted" }, [p.lines + " lin. · " + p.marks + "/" + CELL_COUNT]),
          ])
        );
      });
      const called = game.called || {};
      (game.pool || []).forEach(function (text) {
        const on = !!called[text];
        poolWrap.appendChild(
          el("button", {
            type: "button",
            class: "call-item" + (on ? " on" : ""),
            onClick: function () {
              sendCall(text, !on);
              paint();
            },
          }, [text])
        );
      });
      list.forEach(function (p) {
        boardsWrap.appendChild(
          el("div", { class: "mini-board-card" }, [
            el("h3", null, [p.nick + (p.bingo ? " · BINGO" : "")]),
            renderBoard(p.board),
          ])
        );
      });
    }

    function startNew() {
      if (busy) return;
      showErr("");
      busy = true;
      try {
        const pool = applyGoalsFromEditor();
        game = newGame(LIVE, pool);
      } catch (err) {
        busy = false;
        showErr(err.message || String(err));
        return;
      }
      stopSync();
      setRoom();
      setRole("admin");
      saveGameCache();
      history.replaceState(null, "", "#/admin");
      paint();
      publishState()
        .then(function () {
          syncStatus = "polaczono";
          ensureRoomConnection();
          paint();
        })
        .catch(function (err) {
          showErr(err.message || String(err));
          paint();
        })
        .finally(function () {
          busy = false;
        });
    }

    function resetMarks() {
      if (!game) {
        showErr("Brak gry — najpierw Nowa gra.");
        return;
      }
      if (!confirm("Wyczyscic zaznaczenia? Plansze graczy zostaja.")) return;
      clearCalled();
      paint();
      publishState();
    }

    function restoreDefaultGoals() {
      goalsArea.value = goalsToText(defaultGoals());
      saveCustomGoals(null);
      refreshGoalsMeta();
    }

    goalsArea.addEventListener("input", refreshGoalsMeta);
    goalsBlock.replaceChildren(
      el("label", { class: "field" }, [
        el("span", null, ["Pytania / cele (jedno w linii)"]),
        goalsArea,
      ]),
      goalsMeta,
      el("button", {
        class: "ghost small",
        type: "button",
        onClick: restoreDefaultGoals,
      }, ["Przywroc domyslne z goals.js"])
    );

    app.replaceChildren(
      el("section", { class: "screen admin" }, [
        el("div", { class: "topbar" }, [
          el("button", {
            class: "ghost small",
            type: "button",
            onClick: function () { go("#/"); },
          }, ["← Menu"]),
          el("strong", null, ["ADMIN · klasyczne"]),
        ]),
        el("h1", { class: "admin-title" }, ["BINGO"]),
        el("p", { class: "lead" }, [
          "Startuj gre. Telefony: ten sam link, pseudonim, GRACZ.",
        ]),
        status,
        codeBox,
        goalsBlock,
        el("div", { class: "admin-actions" }, [
          el("button", { class: "primary", type: "button", onClick: startNew }, ["Nowa gra"]),
          el("button", { class: "danger", type: "button", onClick: resetMarks }, ["Wyczysc zaznaczenia"]),
        ]),
        error,
        bingoBanner,
        playersWrap,
        el("h2", { class: "section-title" }, ["Pula — kliknij, zeby odznaczyc"]),
        poolWrap,
        boardsWrap,
      ])
    );
    paint();

    if (roomCode && !roomConnected()) {
      ensureRoomConnection();
    }

    return paint;
  }

  function renderPlayer() {
    const title = el("strong", null, [nickDraft || "Gracz"]);
    const status = el("div");
    const bingoEl = el("div");
    const empty = el("p", { class: "status-muted" }, [
      "Czekam na plansze… Admin klika Nowa gra na tym samym linku.",
    ]);
    const boardHost = el("div");
    const lockedNote = el("p", { class: "hint" }, [
      "To Twoja plansza — nie da sie jej wylosowac ponownie. Pola zaznacza prowadzacy.",
    ]);

    function paint() {
      status.replaceChildren(syncBadge());
      bingoEl.replaceChildren();
      boardHost.replaceChildren();
      const me = game && game.players && game.players[playerId];
      if (!me || !me.board) {
        empty.classList.remove("hidden");
        lockedNote.classList.add("hidden");
        title.textContent = nickDraft || "Gracz";
        if (roomConnected()) maybeJoinPlayer();
        return;
      }
      empty.classList.add("hidden");
      lockedNote.classList.remove("hidden");
      title.textContent = me.nick || nickDraft || "Gracz";
      const st = playerStats(me);
      if (st.bingo) {
        bingoEl.appendChild(el("div", { class: "winner" }, ["BINGO!"]));
      } else {
        bingoEl.appendChild(
          el("p", { class: "status-muted" }, [st.marks + "/" + CELL_COUNT + " · " + st.lines + " lin."])
        );
      }
      boardHost.appendChild(renderBoard(me.board));
    }

    app.replaceChildren(
      el("section", { class: "screen player" }, [
        el("div", { class: "topbar" }, [
          el("button", {
            class: "ghost small",
            type: "button",
            onClick: function () { go("#/"); },
          }, ["← Menu"]),
          el("div", null, [title]),
        ]),
        status,
        bingoEl,
        empty,
        boardHost,
        lockedNote,
      ])
    );
    paint();

    if (roomCode && !roomConnected()) {
      ensureRoomConnection();
    } else {
      maybeJoinPlayer();
    }

    return paint;
  }

  function showBootError(err) {
    const msg = err && err.message ? err.message : String(err);
    app.innerHTML =
      '<section class="screen"><h1>BINGO</h1>' +
      '<p class="error">Blad: ' + msg.replace(/</g, "&lt;") + "</p></section>";
  }

  function mount() {
    const r = route();
    if (r.view === "admin") repaint = renderAdmin();
    else if (r.view === "player") repaint = renderPlayer();
    else if (r.view === "settings") {
      stopSync();
      repaint = null;
      renderSettings();
    } else {
      stopSync();
      repaint = null;
      renderHome();
    }
  }

  window.addEventListener("hashchange", function () {
    try {
      mount();
    } catch (err) {
      showBootError(err);
    }
  });

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") resumeIfNeeded();
  });
  window.addEventListener("pageshow", function () {
    resumeIfNeeded();
  });
  window.addEventListener("online", function () {
    resumeIfNeeded();
  });

  try {
    if (!app) throw new Error("Brak #app");
    if (typeof BingoCloud !== "undefined" && BingoCloud.consumeJoin()) return;
    if (!restoreHashFromStorage()) mount();
  } catch (err) {
    showBootError(err);
  }
})();
