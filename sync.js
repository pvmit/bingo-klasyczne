(() => {
  const TABLE = "bingo_rooms";
  let configPromise = null;
  let config = null;

  function loadConfig() {
    if (configPromise) return configPromise;
    configPromise = fetch("config.json?v=1")
      .then(function (res) {
        if (!res.ok) throw new Error("Nie wczytano config.json (" + res.status + ").");
        return res.json();
      })
      .then(function (raw) {
        config = {
          url: String((raw && raw.supabaseUrl) || "").trim().replace(/\/+$/, ""),
          key: String((raw && raw.supabaseAnonKey) || "").replace(/\s+/g, ""),
        };
        if (!config.url || !config.key) throw new Error("Pusty config.json — brak URL / klucza Supabase.");
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

  async function rest(path, options) {
    await loadConfig();
    let res;
    try {
      res = await fetch(config.url + path, Object.assign({}, options, {
        headers: headers(options && options.headers),
      }));
    } catch (err) {
      throw new Error("Brak sieci do bazy (" + ((err && err.message) || "fetch") + ").");
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

  window.BingoCloud = { loadConfig: loadConfig, get: get, save: save, watch: watch };
})();
