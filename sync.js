(() => {
  const TABLE = "bingo_rooms";
  const STORE = "bingo-k-config";
  let configPromise = null;
  let config = null;

  function normalize(raw) {
    if (!raw) return null;
    const url = String(raw.supabaseUrl || "").trim().replace(/\/+$/, "");
    const key = String(raw.supabaseAnonKey || "").replace(/\s+/g, "");
    if (!url || !key) return null;
    return { url: url, key: key };
  }

  function readStored() {
    try {
      return normalize(JSON.parse(localStorage.getItem(STORE) || "null"));
    } catch (e) {
      return null;
    }
  }

  function saveStored(raw) {
    const n = normalize(raw);
    if (!n) throw new Error("Wklej Project URL (https://xxxx.supabase.co) i klucz anon / publishable.");
    localStorage.setItem(STORE, JSON.stringify({
      supabaseUrl: n.url,
      supabaseAnonKey: n.key,
    }));
    config = n;
    configPromise = Promise.resolve(n);
    return n;
  }

  function loadConfig() {
    if (config) return Promise.resolve(config);
    if (configPromise) return configPromise;
    const stored = readStored();
    if (stored) {
      config = stored;
      configPromise = Promise.resolve(stored);
      return configPromise;
    }
    configPromise = fetch("config.json?v=2", { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) return null;
        return res.json();
      })
      .then(function (raw) {
        config = normalize(raw);
        if (!config) {
          throw new Error("Brak bazy. Wejdz w Ustawienia i wklej dane z supabase.com (projekt Conquest juz nie istnieje).");
        }
        return config;
      });
    return configPromise;
  }

  function headers(extra) {
    const h = {
      apikey: config.key,
      Authorization: "Bearer " + config.key,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (extra) Object.keys(extra).forEach(function (k) { h[k] = extra[k]; });
    return h;
  }

  function networkHint(err) {
    const msg = (err && err.message) || "fetch";
    if (/ENOTFOUND|Failed to fetch|NetworkError|Load failed/i.test(msg)) {
      return "Baza nie odpowiada — projekt Supabase jest usuniety albo uśpiony. Ustawienia → nowy Project URL i klucz z supabase.com (jak w Conquest).";
    }
    return "Brak sieci do bazy (" + msg + ").";
  }

  async function rest(path, options) {
    await loadConfig();
    let res;
    try {
      res = await fetch(config.url + path, Object.assign({ mode: "cors" }, options, {
        headers: headers(options && options.headers),
      }));
    } catch (err) {
      throw new Error(networkHint(err));
    }
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (e) { data = text; }
    }
    if (!res.ok) {
      const msg = (data && (data.message || data.hint || data.details || data.error)) || text || res.statusText;
      if (res.status === 404 || /could not find the table/i.test(String(msg))) {
        throw new Error("Brak tabeli bingo_rooms. W Supabase SQL Editor uruchom supabase/schema.sql.");
      }
      throw new Error(res.status + ": " + msg);
    }
    return data;
  }

  async function get(code, kind) {
    const c = encodeURIComponent(String(code || "").toUpperCase());
    const k = encodeURIComponent(kind);
    const rows = await rest("/rest/v1/" + TABLE + "?select=state&code=eq." + c + "&kind=eq." + k);
    if (!Array.isArray(rows) || !rows.length) return null;
    return rows[0].state || null;
  }

  async function save(code, kind, state) {
    const row = {
      code: String(code || "").toUpperCase(),
      kind: kind,
      state: state,
      updated_at: new Date().toISOString(),
    };
    await rest("/rest/v1/" + TABLE + "?on_conflict=code,kind", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(row),
    });
  }

  function watch(code, kind, onState, onError) {
    let stopped = false;
    const tick = function () {
      if (stopped) return;
      get(code, kind)
        .then(function (state) {
          if (!stopped && typeof onState === "function") onState(state);
        })
        .catch(function (err) {
          if (!stopped && typeof onError === "function") onError(err.message || String(err));
        });
    };
    tick();
    const timer = setInterval(tick, 1000);
    return function () {
      stopped = true;
      clearInterval(timer);
    };
  }

  async function testConfig(raw) {
    saveStored(raw);
    const rows = await rest("/rest/v1/" + TABLE + "?select=code&limit=1");
    return Array.isArray(rows);
  }

  function joinUrl() {
    const n = readStored() || config;
    if (!n) return "";
    const json = JSON.stringify({ supabaseUrl: n.url, supabaseAnonKey: n.key });
    const token = btoa(unescape(encodeURIComponent(json)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    const url = new URL(location.href);
    url.hash = "#/join/" + token;
    return url.toString();
  }

  function consumeJoin() {
    const raw = (location.hash || "").replace(/^#/, "");
    const match = raw.match(/^\/join\/([^/]+)$/);
    if (!match) return false;
    try {
      let token = match[1].replace(/-/g, "+").replace(/_/g, "/");
      while (token.length % 4) token += "=";
      const parsed = JSON.parse(decodeURIComponent(escape(atob(token))));
      saveStored(parsed);
      location.replace(location.pathname + location.search + "#/");
      return true;
    } catch (e) {
      return false;
    }
  }

  function currentPublic() {
    const n = readStored() || config;
    if (!n) return { supabaseUrl: "", supabaseAnonKey: "" };
    return { supabaseUrl: n.url, supabaseAnonKey: n.key };
  }

  window.BingoCloud = {
    loadConfig: loadConfig,
    get: get,
    save: save,
    watch: watch,
    testConfig: testConfig,
    joinUrl: joinUrl,
    consumeJoin: consumeJoin,
    currentPublic: currentPublic,
  };
})();
