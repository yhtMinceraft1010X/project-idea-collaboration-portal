/* ============================================================
   Digital Hub Technical Knowledge & Collaboration Platform
   Single-page app — vanilla JS, no framework, no build step.

   Module layout (single IIFE namespace, no globals leaked):
     - CONFIG guard        : validates window.APP_CONFIG
     - dom helpers         : h(), clear(), small builders
     - Auth                : Cognito IDP JSON API + JWT decode + storage
     - api()               : fetch helper that injects Authorization
     - router / shell      : client-side nav, role-gated views
     - view render fns     : one per screen
   ============================================================ */
(function () {
  "use strict";

  /* ---------------------------------------------------------- */
  /* Runtime config contract                                     */
  /* ---------------------------------------------------------- */
  var CONFIG = window.APP_CONFIG || null;

  function configIsUsable(c) {
    return !!(c && c.apiUrl && c.region && c.userPoolId && c.userPoolClientId);
  }

  /* ----------------------------------------------------------
     LOCAL DEV BYPASS — never active against a real backend.
     It only turns on when the pool id is the local preview stub
     (see frontend/config.js). Any deployed pool id (e.g.
     "ap-southeast-1_ab12CdEfG") will NOT match, so sign-up/confirm/
     login always hit real Cognito in a deployed build.
     When on: sign-up sends no email, confirm accepts any code, and
     login mints a local unsigned JWT so the app shell renders.
     ---------------------------------------------------------- */
  var DEV_BYPASS = !!(CONFIG && CONFIG.userPoolId === "ap-southeast-1_LOCALSTUB");

  /* Build an unsigned JWT that decodeJwt() can read (base64url payload).
     NOT a valid Cognito token — for local UI preview only. */
  function fakeIdToken(email, groups) {
    function b64url(obj) {
      return btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }
    var header = { alg: "none", typ: "JWT" };
    var payload = {
      email: email || "dev@example.com",
      "cognito:username": email || "dev@example.com",
      "cognito:groups": groups || ["Lead", "SME", "Reviewer", "Portfolio", "Mgmt", "Ops"],
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 8
    };
    return b64url(header) + "." + b64url(payload) + ".";
  }

  /* localStorage keys for the Cognito token set */
  var LS = {
    id: "dh_idToken",
    access: "dh_accessToken",
    refresh: "dh_refreshToken"
  };

  /* Cognito groups that unlock role-gated views */
  var GROUPS = ["Lead", "SME", "Reviewer", "Portfolio", "Mgmt", "Ops"];

  /* Entity types used across submit / search / graph */
  /* Keys MUST match the backend's plural entity types (crud/search/graph). */
  var ENTITY_TYPES = [
    { key: "problems", label: "Problem" },
    { key: "initiatives", label: "Initiative" },
    { key: "solutions", label: "Solution" },
    { key: "findings", label: "Finding" },
    { key: "assets", label: "Asset" },
    { key: "sme-profiles", label: "SME Profile" }
  ];

  /* ---------------------------------------------------------- */
  /* Tiny DOM builder (hyperscript). Text nodes keep it XSS-safe */
  /* ---------------------------------------------------------- */
  function h(tag, attrs) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    for (var key in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue;
      var val = attrs[key];
      if (val == null || val === false) continue;
      if (key === "class") node.className = val;
      else if (key === "html") node.innerHTML = val; /* trusted static markup only */
      else if (key === "value") node.value = val;
      else if (key === "checked") node.checked = !!val;
      else if (key === "disabled") { if (val) node.setAttribute("disabled", ""); }
      else if (key.indexOf("on") === 0 && typeof val === "function") {
        node.addEventListener(key.slice(2).toLowerCase(), val);
      } else {
        node.setAttribute(key, val === true ? "" : val);
      }
    }
    for (var i = 2; i < arguments.length; i++) {
      appendChild(node, arguments[i]);
    }
    return node;
  }

  function appendChild(node, child) {
    if (child == null || child === false) return;
    if (Array.isArray(child)) {
      child.forEach(function (c) { appendChild(node, c); });
    } else if (typeof child === "string" || typeof child === "number") {
      node.appendChild(document.createTextNode(String(child)));
    } else {
      node.appendChild(child);
    }
  }

  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  var uidSeq = 0;
  function uid(prefix) { uidSeq += 1; return (prefix || "f") + "-" + uidSeq; }

  /* Common small builders ----------------------------------- */
  function alertEl(kind, message) {
    return h("div", { class: "alert alert-" + kind }, message);
  }
  function loadingEl(label) {
    return h("div", { class: "loading" }, h("span", { class: "spinner", "aria-hidden": "true" }), label || "Loading…");
  }
  function emptyEl(title, body) {
    return h("div", { class: "empty" }, h("strong", {}, title), body || "");
  }
  function badge(kind, text) {
    return h("span", { class: "badge badge-" + kind }, text);
  }

  /* A labelled form field. Returns the wrapper; input carries `name`. */
  function field(opts) {
    var id = uid("f");
    var control;
    if (opts.type === "textarea") {
      control = h("textarea", {
        id: id, name: opts.name, class: "textarea", placeholder: opts.placeholder || "",
        required: opts.required, value: opts.value || ""
      });
    } else if (opts.type === "select") {
      control = h("select", { id: id, name: opts.name, class: "select", required: opts.required });
      (opts.options || []).forEach(function (o) {
        control.appendChild(h("option", { value: o.value }, o.label));
      });
      if (opts.value) control.value = opts.value;
    } else {
      control = h("input", {
        id: id, name: opts.name, class: "input", type: opts.type || "text",
        placeholder: opts.placeholder || "", required: opts.required,
        value: opts.value || "", autocomplete: opts.autocomplete || "off"
      });
    }
    var wrap = h("div", { class: "field" },
      h("label", { "for": id }, opts.label),
      control,
      opts.help ? h("div", { class: "help" }, opts.help) : null
    );
    wrap._control = control;
    return wrap;
  }

  /* Normalise a list-ish API response into an array */
  function asList(data) {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== "object") return [];
    if (Array.isArray(data.items)) return data.items;
    for (var k in data) { if (Array.isArray(data[k])) return data[k]; }
    return [];
  }

  function pick() {
    for (var i = 0; i < arguments.length; i++) {
      if (arguments[i] != null && arguments[i] !== "") return arguments[i];
    }
    return "";
  }
  function recordId(r) {
    return pick(r.id, r.problemId, r.initiativeId, r.solutionId, r.findingId,
      r.assetId, r.smeId, r.userId, r.entityId, r.submissionId, r.questionId, r.answerId);
  }
  function recordTitle(r) {
    return pick(r.title, r.name, (r.content && r.content.title), recordId(r), "Untitled");
  }

  /* ---------------------------------------------------------- */
  /* Auth: Cognito IDP JSON API (no hosted UI)                   */
  /* ---------------------------------------------------------- */
  var Auth = {
    idToken: function () { return localStorage.getItem(LS.id); },

    isAuthed: function () {
      var t = this.idToken();
      if (!t) return false;
      var payload = decodeJwt(t);
      if (!payload) return false;
      if (payload.exp && payload.exp * 1000 < Date.now()) { this.clear(); return false; }
      return true;
    },

    /* Low-level call to the Cognito Identity Provider endpoint */
    cognito: function (target, body) {
      return fetch("https://cognito-idp." + CONFIG.region + ".amazonaws.com/", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-amz-json-1.1",
          "X-Amz-Target": "AWSCognitoIdentityProviderService." + target
        },
        body: JSON.stringify(body)
      }).then(function (res) {
        return res.text().then(function (txt) {
          var data = {};
          if (txt) { try { data = JSON.parse(txt); } catch (e) { data = {}; } }
          if (!res.ok) {
            throw new Error(prettyCognitoError(data));
          }
          return data;
        });
      });
    },

    signUp: function (email, password) {
      if (DEV_BYPASS) {
        /* No Cognito call, so no confirmation email is sent. */
        return Promise.resolve({ UserConfirmed: false, _devBypass: true });
      }
      return this.cognito("SignUp", {
        ClientId: CONFIG.userPoolClientId,
        Username: email,
        Password: password,
        UserAttributes: [{ Name: "email", Value: email }]
      });
    },

    confirm: function (email, code) {
      if (DEV_BYPASS) {
        /* Accept any code locally. */
        return Promise.resolve({ _devBypass: true });
      }
      return this.cognito("ConfirmSignUp", {
        ClientId: CONFIG.userPoolClientId,
        Username: email,
        ConfirmationCode: code
      });
    },

    login: function (email, password) {
      var self = this;
      if (DEV_BYPASS) {
        /* Mint a local unsigned token so the app shell renders. */
        localStorage.setItem(LS.id, fakeIdToken(email));
        self.user();
        return Promise.resolve({ _devBypass: true });
      }
      return this.cognito("InitiateAuth", {
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: CONFIG.userPoolClientId,
        AuthParameters: { USERNAME: email, PASSWORD: password }
      }).then(function (data) {
        var r = data.AuthenticationResult;
        if (!r || !r.IdToken) throw new Error("Login did not return tokens. Confirm the account first.");
        localStorage.setItem(LS.id, r.IdToken);
        if (r.AccessToken) localStorage.setItem(LS.access, r.AccessToken);
        if (r.RefreshToken) localStorage.setItem(LS.refresh, r.RefreshToken);
        self.user(); /* refresh cached identity */
        return data;
      });
    },

    /* Decode the IdToken to expose email + cognito:groups */
    user: function () {
      var payload = decodeJwt(this.idToken());
      if (!payload) return null;
      return {
        email: payload.email || payload["cognito:username"] || "unknown",
        groups: payload["cognito:groups"] || []
      };
    },

    hasGroup: function (groups) {
      if (!groups) return true; /* ungated view */
      var mine = (this.user() && this.user().groups) || [];
      return groups.some(function (g) { return mine.indexOf(g) !== -1; });
    },

    clear: function () {
      localStorage.removeItem(LS.id);
      localStorage.removeItem(LS.access);
      localStorage.removeItem(LS.refresh);
    },

    logout: function () { this.clear(); state.view = "discover"; mount(); }
  };

  /* Base64url JWT payload decode (middle segment) */
  function decodeJwt(token) {
    if (!token) return null;
    try {
      var seg = token.split(".")[1];
      if (!seg) return null;
      var b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
      b64 += "=".repeat((4 - (b64.length % 4)) % 4);
      var raw = atob(b64);
      var json = decodeURIComponent(raw.split("").map(function (c) {
        return "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2);
      }).join(""));
      return JSON.parse(json);
    } catch (e) {
      return null;
    }
  }

  function prettyCognitoError(data) {
    if (data && data.message) return data.message;
    if (data && data.__type) return String(data.__type).replace(/.*#/, "");
    return "Authentication request failed.";
  }

  /* ---------------------------------------------------------- */
  /* mockApi(): LOCAL-PREVIEW ONLY (DEV_BYPASS). Returns canned  */
  /* responses so views can be exercised without a backend.      */
  /* NEVER runs against a real backend — only when CONFIG points  */
  /* at the ap-southeast-1_LOCALSTUB user pool. Returns undefined */
  /* for anything it doesn't handle (caller resolves undefined).  */
  /* ---------------------------------------------------------- */
  function mockApi(path, opts) {
    /* Knowledge-graph read: /graph/{entityType}/{id} (both URI-encoded). */
    /* Shape matches src/handlers/crud.js getGraph():                     */
    /*   { nodes: [{ id, entityType }], edges: [{ from, to, type }] }     */
    /* where from/to are composite keys `entityType + '#' + id`.          */
    if (path.indexOf("/graph/") === 0) {
      var parts = path.split("/"); /* ["", "graph", entityType, id] */
      var rootType = decodeURIComponent(parts[2] || "");
      var rootId = decodeURIComponent(parts[3] || "");
      var linked = [
        { id: "demo-init-1", entityType: "initiatives", type: "addressed-by" },
        { id: "demo-sol-1", entityType: "solutions", type: "resolved-by" },
        { id: "demo-sme-1", entityType: "sme-profiles", type: "advised-by" }
      ];
      var nodes = [{ id: rootId, entityType: rootType }];
      var edges = [];
      var rootKey = rootType + "#" + rootId;
      linked.forEach(function (n) {
        nodes.push({ id: n.id, entityType: n.entityType });
        edges.push({ from: rootKey, to: n.entityType + "#" + n.id, type: n.type });
      });
      return { nodes: nodes, edges: edges };
    }

    /* Ask-an-expert round-trip (DEV_BYPASS only). */
    if (path === "/guidance-requests") {
      if (opts && (opts.method === "POST")) {
        return { requestId: "demo-" + Date.now(), matchedSmeIds: ["demo-sme-1", "demo-sme-2"] };
      }
      return {
        items: [
          {
            requestId: "demo-req-1",
            query: "How should we structure multi-account IAM for a new landing zone?",
            requesterId: "demo-user",
            matchedSmeIds: ["demo-sme-1", "demo-sme-2"],
            status: "routed",
            responderId: null,
            responseComments: null,
            createdAt: "2026-01-01T09:00:00.000Z"
          },
          {
            requestId: "demo-req-2",
            query: "Best practice for S3 Vectors index sizing?",
            requesterId: "demo-user",
            matchedSmeIds: ["demo-sme-3"],
            status: "accepted",
            responderId: "demo-sme-3",
            responseComments: "Happy to help — let's set up office hours Thursday. Start with one index per entity type.",
            createdAt: "2026-01-02T09:00:00.000Z"
          }
        ]
      };
    }
    if (/^\/guidance-requests\/[^/]+\/respond$/.test(path) && opts && opts.method === "POST") {
      var decision = (opts.body && opts.body.decision) || "accept";
      return {
        requestId: path.split("/")[2],
        status: decision === "reject" ? "rejected" : "accepted",
        responderId: "demo-sme-1",
        responseComments: (opts.body && opts.body.comments) || null,
        respondedAt: new Date().toISOString()
      };
    }

    /* Q&A round-trip (DEV_BYPASS only). */
    if (path === "/questions") {
      if (opts && opts.method === "POST") {
        return { questionId: "demo-q-" + Date.now(), status: "open" };
      }
      return {
        items: [
          {
            questionId: "demo-q-1",
            title: "What's the recommended way to size an S3 Vectors index?",
            content: "We're indexing about 2M documents and are unsure on the dimension/cost tradeoff.",
            status: "answered",
            creatorId: "demo-user",
            creatorUsername: "demo-user@example.com",
            createdAt: "2026-01-01T09:00:00.000Z"
          },
          {
            questionId: "demo-q-2",
            title: "How do teams typically structure Bedrock guardrails?",
            content: "Looking for a starting point for enterprise compliance policy.",
            status: "open",
            creatorId: "demo-user",
            creatorUsername: "demo-user@example.com",
            createdAt: "2026-01-02T09:00:00.000Z"
          }
        ]
      };
    }
    if (/^\/questions\/[^/]+\/answers$/.test(path) && opts && opts.method === "POST") {
      return {
        answerId: "demo-a-" + Date.now(),
        questionId: path.split("/")[2],
        content: (opts.body && opts.body.content) || "",
        creatorUsername: "demo-expert@example.com",
        createdAt: new Date().toISOString()
      };
    }
    if (/^\/questions\/[^/]+$/.test(path)) {
      return {
        questionId: path.split("/")[2],
        title: "What's the recommended way to size an S3 Vectors index?",
        content: "We're indexing about 2M documents and are unsure on the dimension/cost tradeoff.",
        status: "answered",
        creatorId: "demo-user",
        creatorUsername: "demo-user@example.com",
        answers: [
          {
            answerId: "demo-a-1",
            content: "Start with 1024 dimensions and cosine distance; revisit once you have real recall numbers.",
            creatorUsername: "demo-expert@example.com",
            createdAt: "2026-01-01T10:00:00.000Z"
          }
        ]
      };
    }

    return undefined;
  }

  /* ---------------------------------------------------------- */
  /* api(): fetch helper — injects raw IdToken as Authorization  */
  /* ---------------------------------------------------------- */
  function api(path, opts) {
    opts = opts || {};
    if (DEV_BYPASS) {
      var mock = mockApi(path, opts);
      if (mock !== undefined) return Promise.resolve(mock);
    }
    var headers = { "Content-Type": "application/json" };
    var token = Auth.idToken();
    if (token) headers["Authorization"] = token; /* raw token, NO "Bearer " prefix */

    return fetch(CONFIG.apiUrl + path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (res) {
      return res.text().then(function (txt) {
        var data = null;
        if (txt) { try { data = JSON.parse(txt); } catch (e) { data = { raw: txt }; } }
        if (res.status === 401 || res.status === 403) {
          if (res.status === 401) Auth.logout();
          throw new Error((data && (data.error || data.message)) || "Not authorised for this action.");
        }
        if (!res.ok) {
          throw new Error((data && (data.error || data.message)) || ("Request failed (" + res.status + ")"));
        }
        return data;
      });
    });
  }

  /* ---------------------------------------------------------- */
  /* App state + navigation model                                */
  /* ---------------------------------------------------------- */
  var state = {
    view: "discover",
    navOpen: false,
    authMode: "login",
    authPrefillEmail: "",
    search: { types: {} } /* map key -> bool */
  };

  var NAV = [
    { id: "discover", label: "Discover", groups: null },
    { id: "submit", label: "Submit knowledge", groups: null },
    { id: "work", label: "Problems & initiatives", groups: null },
    { id: "expert", label: "Ask an expert", groups: null },
    { id: "qa", label: "Q&A", groups: null },
    { id: "review", label: "Review queue", groups: ["Reviewer", "Ops"] },
    { id: "portfolio", label: "Portfolio dashboard", groups: ["Portfolio", "Mgmt", "Ops"] },
    { id: "graph", label: "Knowledge graph", groups: null }
  ];

  var VIEWS = {
    discover: DiscoverView,
    submit: SubmitView,
    work: WorkView,
    expert: ExpertView,
    qa: QaView,
    review: ReviewView,
    portfolio: PortfolioView,
    graph: GraphView
  };

  /* Announce status/errors through the persistent aria-live region */
  function announce(kind, message) {
    var region = document.getElementById("status");
    if (!region) return;
    clear(region);
    region.appendChild(h("div", {
      class: "alert alert-" + kind,
      role: kind === "danger" ? "alert" : "status"
    }, message));
  }
  function clearStatus() {
    var region = document.getElementById("status");
    if (region) clear(region);
  }

  /* Run an async load into a container with loading / error UI */
  function loadInto(container, promiseFactory, renderOk, opts) {
    opts = opts || {};
    clear(container);
    container.appendChild(loadingEl(opts.loadingLabel));
    promiseFactory()
      .then(function (data) { clear(container); renderOk(data); })
      .catch(function (err) {
        clear(container);
        container.appendChild(alertEl("danger", err.message));
        announce("danger", err.message);
      });
  }

  /* ---------------------------------------------------------- */
  /* Shell + router                                              */
  /* ---------------------------------------------------------- */
  function mount() {
    var root = document.getElementById("app");
    clear(root);

    if (!configIsUsable(CONFIG)) { root.appendChild(ConfigNotice()); return; }
    if (!Auth.isAuthed()) { root.appendChild(AuthView()); return; }

    /* Start shown where there is room for it, hidden where there is not */
    state.navOpen = isWideViewport();
    root.appendChild(Shell());
    navigate(pickInitialView());
  }

  /* Land on the requested view, or the first the user is allowed to see */
  function pickInitialView() {
    var current = NAV.filter(function (n) { return n.id === state.view; })[0];
    if (current && Auth.hasGroup(current.groups)) return state.view;
    return "discover";
  }

  function Shell() {
    var user = Auth.user() || { email: "unknown", groups: [] };

    var nav = h("nav", { class: "nav", "aria-label": "Primary" });
    NAV.forEach(function (item) {
      if (!Auth.hasGroup(item.groups)) return;
      nav.appendChild(h("button", {
        class: "nav-link", type: "button", "data-view": item.id,
        onclick: function () { navigate(item.id); }
      }, h("span", { class: "nav-dot", "aria-hidden": "true" }), item.label));
    });

    var groupBadges = h("div", { class: "groups" });
    (user.groups.length ? user.groups : ["No groups"]).forEach(function (g) {
      groupBadges.appendChild(badge("neutral", g));
    });

    var sidebar = h("aside", { class: "sidebar", id: "sidebar" },
      h("div", { class: "brand" },
        h("div", { class: "brand-mark", "aria-hidden": "true" }, "DH"),
        h("div", {},
          h("div", { class: "brand-title" }, "Digital Hub"),
          h("div", { class: "brand-sub" }, "Knowledge & Collaboration")
        )
      ),
      nav,
      h("div", { class: "sidebar-footer" },
        h("div", { class: "user-card" },
          h("div", { class: "who" }, user.email),
          groupBadges
        ),
        h("button", { class: "btn btn-secondary btn-block", type: "button", onclick: function () { Auth.logout(); } }, "Log out")
      )
    );

    var scrim = h("div", { class: "scrim", id: "scrim", onclick: closeNav });

    var topbar = h("div", { class: "topbar" },
      h("button", {
        class: "menu-btn", type: "button", id: "nav-toggle",
        "aria-controls": "sidebar",
        "aria-expanded": state.navOpen ? "true" : "false",
        "aria-label": (state.navOpen ? "Hide" : "Show") + " navigation",
        onclick: toggleNav
      }, (state.navOpen ? "✕" : "☰") + " Menu"),
      h("strong", { class: "topbar-title" }, "Digital Hub")
    );

    var main = h("main", { class: "main" },
      topbar,
      h("div", { class: "content" },
        h("div", { class: "status-region", id: "status", "aria-live": "polite", "aria-atomic": "true" }),
        h("div", { id: "view-container" })
      )
    );

    return h("div", {
      class: "app-shell " + (state.navOpen ? "nav-open" : "nav-closed"),
      id: "app-shell"
    }, sidebar, scrim, main);
  }

  /* ---------------------------------------------------------- */
  /* Sidebar visibility                                          */
  /* ---------------------------------------------------------- */

  /* Above this width the sidebar takes a grid column and pushes the content
     across; below it there is no room, so it slides over as a drawer. Must
     match the breakpoint in styles.css. */
  var WIDE_NAV = "(min-width: 861px)";
  function isWideViewport() { return window.matchMedia(WIDE_NAV).matches; }

  function setNav(open) {
    state.navOpen = !!open;
    var shell = document.getElementById("app-shell");
    if (shell) {
      shell.classList.toggle("nav-open", state.navOpen);
      shell.classList.toggle("nav-closed", !state.navOpen);
    }
    var btn = document.getElementById("nav-toggle");
    if (btn) {
      btn.setAttribute("aria-expanded", state.navOpen ? "true" : "false");
      btn.setAttribute("aria-label", (state.navOpen ? "Hide" : "Show") + " navigation");
      btn.textContent = (state.navOpen ? "✕" : "☰") + " Menu";
    }
  }
  function toggleNav() { setNav(!state.navOpen); }
  function closeNav() { setNav(false); }

  /* Navigating only dismisses the sidebar while it is covering the content */
  function closeNavIfOverlay() { if (!isWideViewport()) setNav(false); }

  function navigate(viewId) {
    var item = NAV.filter(function (n) { return n.id === viewId; })[0];
    if (item && !Auth.hasGroup(item.groups)) { viewId = "discover"; }
    state.view = viewId;

    /* reflect active state in the nav */
    var links = document.querySelectorAll(".nav-link");
    Array.prototype.forEach.call(links, function (link) {
      var active = link.getAttribute("data-view") === viewId;
      link.classList.toggle("is-active", active);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });

    var container = document.getElementById("view-container");
    if (!container) return;
    clear(container);
    clearStatus();
    var render = VIEWS[viewId] || DiscoverView;
    container.appendChild(render());
    closeNavIfOverlay();
    /* move focus to the new view heading for keyboard/AT users */
    var heading = container.querySelector("h1, h2");
    if (heading) { heading.setAttribute("tabindex", "-1"); heading.focus(); }
  }

  /* ---------------------------------------------------------- */
  /* Config-missing notice                                       */
  /* ---------------------------------------------------------- */
  function ConfigNotice() {
    return h("div", { class: "config-notice" },
      h("div", { class: "card" },
        h("span", { class: "tag" }, "digital-hub"),
        h("h1", {}, "Configuration not loaded yet"),
        h("p", { class: "lead" },
          "The runtime configuration (config.js) has not been generated. Deploy the stack to produce it, then reload this page."),
        h("pre", { class: "code" },
          "window.APP_CONFIG = {\n  apiUrl, region,\n  userPoolId, userPoolClientId,\n  cognitoDomain\n};")
      )
    );
  }

  /* ---------------------------------------------------------- */
  /* Auth view (login / signup / confirm)                        */
  /* ---------------------------------------------------------- */
  function AuthView() {
    var localAlert = h("div", { class: "status-region", id: "auth-status", "aria-live": "polite" });

    function setAuthAlert(kind, msg) {
      clear(localAlert);
      localAlert.appendChild(h("div", { class: "alert alert-" + kind, role: kind === "danger" ? "alert" : "status" }, msg));
    }

    function tab(mode, label) {
      return h("button", {
        class: "auth-tab" + (state.authMode === mode ? " is-active" : ""),
        type: "button",
        onclick: function () { state.authMode = mode; rerender(); }
      }, label);
    }

    function busy(btn, on, labelIdle) {
      btn.disabled = on;
      clear(btn);
      if (on) { btn.appendChild(h("span", { class: "spinner", "aria-hidden": "true" })); btn.appendChild(document.createTextNode("Working…")); }
      else { btn.appendChild(document.createTextNode(labelIdle)); }
    }

    function loginForm() {
      var emailF = field({ name: "email", label: "Work email", type: "email", required: true, placeholder: "you@example.com", value: state.authPrefillEmail, autocomplete: "username" });
      var passF = field({ name: "password", label: "Password", type: "password", required: true, autocomplete: "current-password" });
      var submit = h("button", { class: "btn btn-primary btn-block", type: "submit" }, "Sign in");
      return h("form", {
        onsubmit: function (e) {
          e.preventDefault();
          var email = emailF._control.value.trim(), pass = passF._control.value;
          busy(submit, true);
          Auth.login(email, pass)
            .then(function () { mount(); })
            .catch(function (err) { busy(submit, false, "Sign in"); setAuthAlert("danger", err.message); });
        }
      }, emailF, passF, submit);
    }

    function signupForm() {
      var emailF = field({ name: "email", label: "Work email", type: "email", required: true, placeholder: "you@example.com", autocomplete: "username" });
      var passF = field({ name: "password", label: "Password", type: "password", required: true, autocomplete: "new-password" });
      var submit = h("button", { class: "btn btn-primary btn-block", type: "submit" }, "Create account");

      /* Build password rules from the pool's policy (CONFIG.passwordPolicy),
         falling back to Cognito defaults when the policy is absent. */
      var policy = (CONFIG && CONFIG.passwordPolicy) || {};
      var minLength = typeof policy.minLength === "number" ? policy.minLength : 8;
      var hasPolicy = CONFIG && CONFIG.passwordPolicy;
      var rules = [];
      rules.push({
        label: "At least " + minLength + " characters",
        test: function (v) { return v.length >= minLength; }
      });
      if (!hasPolicy || policy.requireUppercase) {
        rules.push({ label: "One uppercase letter", test: function (v) { return /[A-Z]/.test(v); } });
      }
      if (!hasPolicy || policy.requireLowercase) {
        rules.push({ label: "One lowercase letter", test: function (v) { return /[a-z]/.test(v); } });
      }
      if (!hasPolicy || policy.requireNumbers) {
        rules.push({ label: "One number", test: function (v) { return /[0-9]/.test(v); } });
      }
      if (!hasPolicy || policy.requireSymbols) {
        rules.push({ label: "One symbol", test: function (v) { return /[^A-Za-z0-9]/.test(v); } });
      }

      var checklist = h("ul", { class: "pw-checklist", "aria-live": "polite" });
      rules.forEach(function (rule) {
        var icon = h("span", { class: "pw-icon", "aria-hidden": "true" }, "\u2717");
        var li = h("li", { class: "pw-rule" }, icon, h("span", {}, rule.label));
        li._icon = icon;
        li._rule = rule;
        checklist.appendChild(li);
      });

      function updateChecklist() {
        var v = passF._control.value;
        for (var i = 0; i < checklist.childNodes.length; i++) {
          var li = checklist.childNodes[i];
          var met = li._rule.test(v);
          li._icon.textContent = met ? "\u2713" : "\u2717";
          if (met) li.classList.add("is-met"); else li.classList.remove("is-met");
        }
      }
      passF._control.addEventListener("input", updateChecklist);
      updateChecklist();

      function allRulesPass() {
        var v = passF._control.value;
        return rules.every(function (rule) { return rule.test(v); });
      }

      return h("form", {
        onsubmit: function (e) {
          e.preventDefault();
          if (!allRulesPass()) {
            setAuthAlert("danger", "Password does not meet all requirements.");
            passF._control.focus();
            return;
          }
          var email = emailF._control.value.trim();
          busy(submit, true);
          Auth.signUp(email, passF._control.value)
            .then(function () {
              state.authPrefillEmail = email;
              state.authMode = "confirm";
              rerender();
              setAuthAlert("success", "Account created. Check your email for a confirmation code.");
            })
            .catch(function (err) { busy(submit, false, "Create account"); setAuthAlert("danger", err.message); });
        }
      }, emailF, passF, checklist, submit);
    }

    function confirmForm() {
      var emailF = field({ name: "email", label: "Work email", type: "email", required: true, value: state.authPrefillEmail, autocomplete: "username" });
      var codeF = field({ name: "code", label: "Confirmation code", type: "text", required: true, placeholder: "6-digit code", autocomplete: "one-time-code" });
      var submit = h("button", { class: "btn btn-primary btn-block", type: "submit" }, "Confirm account");
      var intro = h("div", { class: "auth-confirm-intro" },
        h("h2", { class: "auth-confirm-title" }, "Confirm your account"),
        h("p", { class: "auth-confirm-hint" }, "We emailed a confirmation code to your inbox. Enter it below to activate your account.")
      );
      var back = h("button", {
        class: "auth-link", type: "button",
        onclick: function () { state.authMode = "login"; rerender(); }
      }, "← Back to sign in");
      var form = h("form", {
        onsubmit: function (e) {
          e.preventDefault();
          var email = emailF._control.value.trim();
          busy(submit, true);
          Auth.confirm(email, codeF._control.value.trim())
            .then(function () {
              state.authPrefillEmail = email;
              state.authMode = "login";
              rerender();
              setAuthAlert("success", "Account confirmed. You can sign in now.");
            })
            .catch(function (err) { busy(submit, false, "Confirm account"); setAuthAlert("danger", err.message); });
        }
      }, emailF, codeF, submit);
      return h("div", { class: "auth-confirm" }, intro, form, back);
    }

    var formArea = h("div", {});
    function renderForm() {
      clear(formArea);
      formArea.appendChild(state.authMode === "signup" ? signupForm()
        : state.authMode === "confirm" ? confirmForm()
          : loginForm());
    }

    var card = h("div", { class: "card auth-card" },
      state.authMode === "confirm" ? null : h("div", { class: "auth-tabs", role: "tablist" },
        tab("login", "Sign in"),
        tab("signup", "Create account")
        /* "Confirm" is intentionally not a tab: it is only reachable
           after a successful sign-up (see signupForm), so it stays hidden. */
      ),
      localAlert,
      formArea
    );

    function rerender() {
      var root = document.getElementById("app");
      clear(root);
      root.appendChild(AuthView());
    }

    renderForm();

    return h("div", { class: "auth-screen" },
      h("div", { class: "auth-aside" },
        h("div", { class: "brand-mark", "aria-hidden": "true" }, "DH"),
        h("h1", {}, "Find work, avoid duplication, reach the right people."),
        h("p", {}, "A shared discovery and collaboration layer for the Digital Hub Programme Centre — problems, initiatives, solutions, findings and experts in one place."),
        h("ul", {},
          h("li", {}, "Search across everything the programme knows."),
          h("li", {}, "Surface overlapping initiatives before effort is duplicated."),
          h("li", {}, "Route questions to contributors with real experience.")
        )
      ),
      h("div", { class: "auth-panel" }, card)
    );
  }

  /* ---------------------------------------------------------- */
  /* View: Discover / Search                                     */
  /* ---------------------------------------------------------- */
  function DiscoverView() {
    var view = h("div", { class: "view" });

    var queryF = field({ name: "query", label: "What are you looking for?", type: "text", placeholder: "e.g. fleet maintenance scheduling, claims triage, cloud landing zone", required: true });

    var chips = h("div", { class: "chips", role: "group", "aria-label": "Filter by entity type" });
    ENTITY_TYPES.forEach(function (t) {
      var pressed = !!state.search.types[t.key];
      var chip = h("button", {
        type: "button", class: "chip-toggle", "aria-pressed": pressed ? "true" : "false",
        onclick: function () {
          var now = chip.getAttribute("aria-pressed") === "true";
          chip.setAttribute("aria-pressed", now ? "false" : "true");
          state.search.types[t.key] = !now;
        }
      }, t.label);
      chips.appendChild(chip);
    });

    var results = h("div", { class: "grid-2" });
    results.appendChild(emptyEl("Search the knowledge base", "Enter a query above to find problems, initiatives, solutions, findings, assets and experts."));

    var submitBtn = h("button", { class: "btn btn-primary", type: "submit" }, "Search");

    var form = h("form", {
      onsubmit: function (e) {
        e.preventDefault();
        var query = queryF._control.value.trim();
        if (!query) { announce("warning", "Type something to search for."); return; }
        var selected = ENTITY_TYPES.filter(function (t) { return state.search.types[t.key]; }).map(function (t) { return t.key; });
        var body = { query: query };
        if (selected.length) body.entityTypes = selected;
        loadInto(results, function () { return api("/search", { method: "POST", body: body }); }, function (data) {
          renderResults(results, asList(data.results || data));
        }, { loadingLabel: "Searching…" });
      }
    },
      queryF,
      h("div", { class: "field" }, h("span", { class: "field-label" }, "Narrow by type (optional)"), chips),
      h("div", { class: "row" }, submitBtn)
    );

    view.appendChild(h("header", { class: "hero masthead" },
      h("span", { class: "tag" }, "Discover"),
      h("h1", {}, "Search the programme's collective knowledge"),
      h("p", {}, "One query across problems, initiatives, solutions, findings, reusable assets and subject-matter experts.")
    ));
    view.appendChild(h("section", {}, h("h2", { class: "visually-hidden" }, "Search"), h("div", { class: "card" }, form)));
    view.appendChild(h("section", {}, h("h2", {}, "Results"), results));
    return view;
  }

  function renderResults(container, results) {
    clear(container);
    if (!results.length) {
      container.appendChild(emptyEl("No matches", "Try a broader query or clear the type filters."));
      return;
    }
    results.forEach(function (r) {
      var type = pick(r.entityType, "result");
      var score = (typeof r.score === "number") ? r.score.toFixed(2) : pick(r.score, "");
      container.appendChild(h("div", { class: "card result-card" },
        h("div", { class: "card-head" },
          badge("accent", type),
          score !== "" ? h("span", { class: "score" }, "score " + score) : null
        ),
        h("div", { class: "card-body" },
          h("h4", {}, recordTitle(r)),
          h("p", {}, pick(r.snippet, r.description, "No preview available."))
        ),
        h("div", { class: "meta-line" }, "id: " + pick(r.entityId, recordId(r), "—"))
      ));
    });
  }

  /* ---------------------------------------------------------- */
  /* View: Submit knowledge (creates a pending submission)       */
  /* ---------------------------------------------------------- */
  function SubmitView() {
    var view = h("div", { class: "view" });

    var typeF = field({ name: "entityType", label: "What are you contributing?", type: "select", required: true, options: ENTITY_TYPES.map(function (t) { return { value: t.key, label: t.label }; }) });
    var titleF = field({ name: "title", label: "Title", type: "text", required: true, placeholder: "Give it a clear, findable name" });
    var bodyF = field({ name: "content", label: "Details", type: "textarea", required: true, placeholder: "Describe the problem, solution, finding or asset. What should others know?" });
    var tagsF = field({ name: "tags", label: "Tags", type: "text", placeholder: "comma,separated,tags", help: "Optional. Helps discovery and overlap detection." });

    var out = h("div", {});
    var submitBtn = h("button", { class: "btn btn-primary", type: "submit" }, "Submit for review");

    var form = h("form", {
      onsubmit: function (e) {
        e.preventDefault();
        var tags = tagsF._control.value.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
        var body = {
          entityType: typeF._control.value,
          template: true,
          content: {
            title: titleF._control.value.trim(),
            body: bodyF._control.value.trim(),
            tags: tags
          }
        };
        submitBtn.disabled = true;
        clear(out);
        api("/submissions", { method: "POST", body: body })
          .then(function (data) {
            submitBtn.disabled = false;
            form.reset();
            var id = pick(data && data.submissionId, "—");
            out.appendChild(alertEl("success", "Submitted for review (id " + id + "). A Content Reviewer will approve it before it is indexed."));
            announce("success", "Submission created and pending review.");
          })
          .catch(function (err) {
            submitBtn.disabled = false;
            out.appendChild(alertEl("danger", err.message));
            announce("danger", err.message);
          });
      }
    }, typeF, titleF, bodyF, tagsF, h("div", { class: "row" }, submitBtn));

    view.appendChild(sectionHeader("Submit knowledge", "Contribute a finding, solution, asset or profile. Submissions enter the review queue and are indexed once approved."));
    view.appendChild(h("section", {}, h("div", { class: "card" }, form), out));
    return view;
  }

  /* ---------------------------------------------------------- */
  /* View: Problems & Initiatives                                */
  /* ---------------------------------------------------------- */
  function WorkView() {
    var view = h("div", { class: "view" });
    view.appendChild(sectionHeader("Problems & initiatives", "Frame problems, register initiatives against them, and reach out to collaborators when work overlaps."));

    var problemsList = h("div", {});
    var initiativesList = h("div", {});
    var problemSelect = h("select", { class: "select", name: "linkedProblemId" });
    problemSelect.appendChild(h("option", { value: "" }, "— none —"));

    /* --- Problem create form --- */
    var pTitle = field({ name: "title", label: "Problem title", type: "text", required: true, placeholder: "What needs solving?" });
    var pDesc = field({ name: "description", label: "Description", type: "textarea", required: true });
    var pTags = field({ name: "tags", label: "Tags", type: "text", placeholder: "comma,separated" });
    var pBtn = h("button", { class: "btn btn-primary", type: "submit" }, "Create problem");
    var pForm = h("form", {
      onsubmit: function (e) {
        e.preventDefault();
        var body = {
          title: pTitle._control.value.trim(),
          description: pDesc._control.value.trim(),
          tags: pTags._control.value.split(",").map(function (s) { return s.trim(); }).filter(Boolean)
        };
        pBtn.disabled = true;
        api("/problems", { method: "POST", body: body })
          .then(function () { pBtn.disabled = false; pForm.reset(); announce("success", "Problem created."); loadProblems(); })
          .catch(function (err) { pBtn.disabled = false; announce("danger", err.message); });
      }
    }, pTitle, pDesc, pTags, h("div", { class: "row" }, pBtn));

    /* --- Initiative create form --- */
    var iTitle = field({ name: "title", label: "Initiative title", type: "text", required: true, placeholder: "What are you exploring or building?" });
    var iDesc = field({ name: "description", label: "Description", type: "textarea", required: true });
    var iStack = field({ name: "techStack", label: "Tech stack", type: "text", placeholder: "e.g. Lambda, DynamoDB, Bedrock" });
    var linkWrap = h("div", { class: "field" }, h("label", { "for": "link-problem" }, "Linked problem"), problemSelect);
    problemSelect.id = "link-problem";
    var iBtn = h("button", { class: "btn btn-primary", type: "submit" }, "Register initiative");
    var iForm = h("form", {
      onsubmit: function (e) {
        e.preventDefault();
        var body = {
          title: iTitle._control.value.trim(),
          description: iDesc._control.value.trim(),
          techStack: iStack._control.value.trim(),
          linkedProblemId: problemSelect.value || null
        };
        iBtn.disabled = true;
        api("/initiatives", { method: "POST", body: body })
          .then(function () { iBtn.disabled = false; iForm.reset(); announce("success", "Initiative registered."); loadInitiatives(); })
          .catch(function (err) { iBtn.disabled = false; announce("danger", err.message); });
      }
    }, iTitle, iDesc, iStack, linkWrap, h("div", { class: "row" }, iBtn));

    /* --- Loaders --- */
    function loadProblems() {
      loadInto(problemsList, function () { return api("/problems"); }, function (data) {
        var items = asList(data);
        /* refresh the linked-problem dropdown too */
        while (problemSelect.options.length > 1) problemSelect.remove(1);
        items.forEach(function (p) { problemSelect.appendChild(h("option", { value: recordId(p) }, recordTitle(p))); });

        if (!items.length) { problemsList.appendChild(emptyEl("No problems yet", "Create one on the left to get started.")); return; }
        items.forEach(function (p) {
          problemsList.appendChild(h("div", { class: "card card-soft" },
            h("div", { class: "card-head" }, h("h4", {}, recordTitle(p)), statusBadge(p.status)),
            h("p", {}, pick(p.description, "No description.")),
            tagRow(p.tags),
            h("div", { class: "meta-line" }, "created by " + pick(p.creatorUsername, p.creatorId, "—")),
            h("div", { class: "meta-line" }, "id: " + recordId(p))
          ));
        });
      });
    }

    function loadInitiatives() {
      loadInto(initiativesList, function () {
        return Promise.all([api("/initiatives"), api("/problems")]);
      }, function (results) {
        var items = asList(results[0]);
        var problems = asList(results[1]);
        var problemTitleById = {};
        problems.forEach(function (p) { problemTitleById[recordId(p)] = recordTitle(p); });

        if (!items.length) { initiativesList.appendChild(emptyEl("No initiatives yet", "Register one on the left.")); return; }
        items.forEach(function (it) {
          var id = recordId(it);
          var linkedTitle = it.linkedProblemId ? pick(problemTitleById[it.linkedProblemId], it.linkedProblemId) : null;
          initiativesList.appendChild(h("div", { class: "card card-soft" },
            h("div", { class: "card-head" }, h("h4", {}, recordTitle(it)), statusBadge(it.status)),
            h("p", {}, pick(it.description, "No description.")),
            it.techStack ? h("div", { class: "meta-line" }, "stack: " + it.techStack) : null,
            linkedTitle ? h("div", { class: "meta-line" }, "linked problem: " + linkedTitle) : null,
            h("div", { class: "meta-line" }, "created by " + pick(it.creatorUsername, it.creatorId, "—")),
            h("div", { class: "card-actions" },
              nudgeButton(id, "link", "Find collaborators"),
              nudgeButton(id, "office-hours", "Request office hours")
            ),
            h("div", { class: "meta-line" }, "id: " + id)
          ));
        });
      });
    }

    /* Collaboration nudge action */
    function nudgeButton(initiativeId, action, label) {
      var btn = h("button", { class: "btn btn-quiet btn-sm", type: "button" }, label);
      btn.addEventListener("click", function () {
        btn.disabled = true;
        api("/nudges/" + encodeURIComponent(initiativeId) + "/collaborate", {
          method: "POST", body: { action: action, targetInitiativeId: initiativeId }
        })
          .then(function (data) {
            btn.disabled = false;
            var ref = data && (data.linkedRef || data.status);
            announce("success", (action === "link" ? "Collaboration request sent." : "Office hours requested.") + (ref ? " (" + ref + ")" : ""));
          })
          .catch(function (err) { btn.disabled = false; announce("danger", err.message); });
      });
      return btn;
    }

    problemsList.appendChild(loadingEl());
    initiativesList.appendChild(loadingEl());

    view.appendChild(h("div", { class: "split" },
      h("div", {},
        h("section", {}, h("h2", {}, "New problem"), h("div", { class: "card" }, pForm)),
        h("section", {}, h("h2", {}, "New initiative"), h("div", { class: "card" }, iForm))
      ),
      h("div", {},
        h("section", {}, h("h2", {}, "Problems"), problemsList),
        h("section", {}, h("h2", {}, "Initiatives"), initiativesList)
      )
    ));

    loadProblems();
    loadInitiatives();
    return view;
  }

  function tagRow(tags) {
    if (!tags || !tags.length) return null;
    var row = h("div", { class: "row", style: "margin-top:var(--space-2)" });
    tags.forEach(function (t) { row.appendChild(badge("neutral", t)); });
    return row;
  }

  function statusBadge(status) {
    if (!status) return null;
    var s = String(status).toLowerCase();
    var kind = "neutral";
    if (s.indexOf("deploy") !== -1 || s === "approved" || s === "active") kind = "success";
    else if (s.indexOf("progress") !== -1 || s.indexOf("review") !== -1 || s.indexOf("pending") !== -1) kind = "accent";
    else if (s.indexOf("fail") !== -1 || s.indexOf("reject") !== -1) kind = "danger";
    else if (s.indexOf("draft") !== -1) kind = "neutral";
    return badge(kind, status);
  }

  /* ---------------------------------------------------------- */
  /* View: Ask an expert (guidance request)                      */
  /* ---------------------------------------------------------- */
  function ExpertView() {
    var view = h("div", { class: "view" });
    view.appendChild(sectionHeader("Ask an expert", "Describe what you need help with. We answer from existing knowledge first, then route you to contributors with demonstrated experience."));

    var queryF = field({ name: "query", label: "Your question", type: "textarea", required: true, placeholder: "e.g. How should we structure multi-account IAM for a new landing zone?" });
    var contextF = field({ name: "context", label: "Context", type: "text", placeholder: "Optional: initiative, team, constraints" });
    var out = h("div", {});
    var btn = h("button", { class: "btn btn-primary", type: "submit" }, "Request guidance");

    var form = h("form", {
      onsubmit: function (e) {
        e.preventDefault();
        var body = { query: queryF._control.value.trim() };
        var ctx = contextF._control.value.trim();
        if (ctx) body.context = ctx;
        btn.disabled = true;
        clear(out);
        api("/guidance-requests", { method: "POST", body: body })
          .then(function (data) {
            btn.disabled = false;
            var smes = (data && data.matchedSmeIds) || [];
            var requestId = data && data.requestId;
            var card = h("div", { class: "card" },
              h("h4", {}, "Request received"),
              requestId ? h("p", {}, "Request id: " + requestId) : null
            );
            if (smes.length) {
              card.appendChild(h("h3", { class: "subhead" }, "Matched experts"));
              var row = h("div", { class: "row" });
              smes.forEach(function (id) { row.appendChild(badge("accent", id)); });
              card.appendChild(row);
            } else {
              card.appendChild(h("p", {}, "No specific expert was matched yet — your request has been logged and routed."));
            }
            out.appendChild(card);
            announce("success", "Guidance request submitted.");
            loadMyRequests();
          })
          .catch(function (err) { btn.disabled = false; out.appendChild(alertEl("danger", err.message)); announce("danger", err.message); });
      }
    }, queryF, contextF, h("div", { class: "row" }, btn));

    /* Map a request status to a badge kind. */
    function statusBadge(status) {
      var kind = status === "accepted" ? "success" : status === "rejected" ? "danger" : "warn";
      return badge(kind, status || "routed");
    }

    function requestCard(r) {
      var q = pick(r.query, "(no question text)");
      if (q.length > 140) q = q.slice(0, 140) + "…";
      var matched = Array.isArray(r.matchedSmeIds) ? r.matchedSmeIds : [];
      var card = h("div", { class: "card" },
        h("div", { class: "card-head" },
          h("h4", {}, q),
          statusBadge(r.status)
        ),
        h("div", { class: "meta-line" },
          "id: " + pick(r.requestId, recordId(r), "—") +
          "  ·  matched: " + (matched.length ? matched.join(", ") : "—"))
      );
      if (r.status && r.status !== "routed") {
        card.appendChild(h("h3", { class: "subhead" }, "Expert response"));
        card.appendChild(h("div", { class: "meta-line" }, "responder: " + pick(r.responderId, "—")));
        if (r.responseComments) card.appendChild(h("p", {}, r.responseComments));
      }
      return card;
    }

    var myList = h("div", {});
    function loadMyRequests() {
      loadInto(myList, function () { return api("/guidance-requests"); }, function (data) {
        var items = asList(data);
        if (!items.length) { myList.appendChild(emptyEl("No requests yet", "Your guidance requests and expert responses will appear here.")); return; }
        items.forEach(function (r) { myList.appendChild(requestCard(r)); });
      }, { loadingLabel: "Loading your requests…" });
    }

    view.appendChild(h("section", {}, h("div", { class: "card" }, form), out));
    view.appendChild(h("section", {},
      h("h3", { class: "subhead" }, "My requests"),
      myList
    ));
    loadMyRequests();
    return view;
  }

  /* ---------------------------------------------------------- */
  /* View: Q&A (any user asks; experts (SME group) answer)       */
  /* ---------------------------------------------------------- */
  function QaView() {
    var view = h("div", { class: "view" });
    var expert = Auth.hasGroup(["SME"]);
    view.appendChild(sectionHeader("Q&A", expert
      ? "Answer questions submitted by anyone in the programme."
      : "Ask the experts a question and see their answers here."));

    var titleF = field({ name: "title", label: "Question title", type: "text", required: true, placeholder: "What do you need to know?" });
    var contentF = field({ name: "content", label: "Details", type: "textarea", placeholder: "Add any context that will help an expert answer." });
    var askOut = h("div", {});
    var askBtn = h("button", { class: "btn btn-primary", type: "submit" }, "Ask");
    var askForm = h("form", {
      onsubmit: function (e) {
        e.preventDefault();
        var body = { title: titleF._control.value.trim(), content: contentF._control.value.trim() };
        askBtn.disabled = true;
        clear(askOut);
        api("/questions", { method: "POST", body: body })
          .then(function () {
            askBtn.disabled = false;
            askForm.reset();
            announce("success", "Question submitted.");
            loadQuestions();
          })
          .catch(function (err) {
            askBtn.disabled = false;
            askOut.appendChild(alertEl("danger", err.message));
            announce("danger", err.message);
          });
      }
    }, titleF, contentF, h("div", { class: "row" }, askBtn));

    function qaStatusBadge(status) {
      return badge(status === "answered" ? "success" : "warn", status || "open");
    }

    function answerCard(a) {
      return h("div", { class: "card card-soft" },
        h("div", { class: "meta-line" }, "answered by " + pick(a.creatorUsername, a.creatorId, "expert")),
        h("p", {}, pick(a.content, ""))
      );
    }

    function answerForm(questionId, onDone) {
      var f = field({ name: "content", label: "Your answer", type: "textarea", required: true });
      var btn = h("button", { class: "btn btn-primary btn-sm", type: "submit" }, "Submit answer");
      return h("form", {
        class: "row",
        onsubmit: function (e) {
          e.preventDefault();
          var content = f._control.value.trim();
          if (!content) return;
          btn.disabled = true;
          api("/questions/" + encodeURIComponent(questionId) + "/answers", { method: "POST", body: { content: content } })
            .then(function () {
              btn.disabled = false;
              f._control.value = "";
              announce("success", "Answer submitted.");
              onDone();
            })
            .catch(function (err) { btn.disabled = false; announce("danger", err.message); });
        }
      }, f, h("div", { class: "row" }, btn));
    }

    function questionCard(q) {
      var id = pick(q.questionId, recordId(q));
      var answersWrap = h("div", {});
      var card = h("div", { class: "card" },
        h("div", { class: "card-head" }, h("h4", {}, pick(q.title, "Untitled question")), qaStatusBadge(q.status)),
        h("p", {}, pick(q.content, "")),
        h("div", { class: "meta-line" }, "asked by " + pick(q.creatorUsername, q.creatorId, "—")),
        answersWrap
      );

      function loadAnswers() {
        loadInto(answersWrap, function () { return api("/questions/" + encodeURIComponent(id)); }, function (data) {
          var answers = asList(data && data.answers);
          if (!answers.length) { answersWrap.appendChild(emptyEl("No answers yet", "")); return; }
          answers.forEach(function (a) { answersWrap.appendChild(answerCard(a)); });
        }, { loadingLabel: "Loading answers…" });
      }

      if (expert) {
        card.appendChild(answerForm(id, loadAnswers));
      }
      loadAnswers();
      return card;
    }

    var list = h("div", {});
    function loadQuestions() {
      loadInto(list, function () { return api("/questions"); }, function (data) {
        var items = asList(data);
        if (!items.length) {
          list.appendChild(emptyEl("No questions yet", expert
            ? "Questions from anyone in the programme will appear here."
            : "Ask a question above and expert answers will appear here."));
          return;
        }
        items.forEach(function (q) { list.appendChild(questionCard(q)); });
      }, { loadingLabel: "Loading questions…" });
    }

    view.appendChild(h("section", {}, h("div", { class: "card" }, askForm), askOut));
    view.appendChild(h("section", {},
      h("h3", { class: "subhead" }, expert ? "All questions" : "My questions"),
      list
    ));
    loadQuestions();
    return view;
  }

  /* ---------------------------------------------------------- */
  /* View: Review queue (Reviewer / Ops only)                    */
  /* ---------------------------------------------------------- */
  function ReviewView() {
    var view = h("div", { class: "view" });
    view.appendChild(sectionHeader("Review queue", "Approve or reject pending submissions before they are indexed into the knowledge base."));

    var list = h("div", {});
    view.appendChild(h("section", {}, list));

    function load() {
      loadInto(list, function () { return api("/submissions"); }, function (data) {
        var items = asList(data);
        if (!items.length) { list.appendChild(emptyEl("Queue is clear", "There are no submissions waiting for review.")); return; }
        items.forEach(function (s) { list.appendChild(reviewCard(s)); });
      }, { loadingLabel: "Loading queue…" });
    }

    function reviewCard(s) {
      var id = pick(s.submissionId, recordId(s));
      var commentsF = field({ name: "comments", label: "Reviewer comments", type: "text", placeholder: "Optional note back to the submitter" });
      var approve = h("button", { class: "btn btn-primary btn-sm", type: "button" }, "Approve");
      var reject = h("button", { class: "btn btn-danger btn-sm", type: "button" }, "Reject");

      function decide(decision) {
        approve.disabled = reject.disabled = true;
        api("/submissions/" + encodeURIComponent(id) + "/approve", {
          method: "POST", body: { decision: decision, comments: commentsF._control.value.trim() }
        })
          .then(function () { announce("success", "Submission " + id + " " + (decision === "approve" ? "approved" : "rejected") + "."); load(); })
          .catch(function (err) { approve.disabled = reject.disabled = false; announce("danger", err.message); });
      }
      approve.addEventListener("click", function () { decide("approve"); });
      reject.addEventListener("click", function () { decide("reject"); });

      var content = s.content || {};
      return h("div", { class: "card" },
        h("div", { class: "card-head" },
          h("h4", {}, pick(content.title, recordTitle(s))),
          badge("warn", pick(s.status, "pending"))
        ),
        h("div", { class: "meta-line" },
          "type: " + pick(s.entityType, "—") + "  ·  submitter: " + pick(s.submitterId, s.submitter, "—") + "  ·  id: " + id),
        content.body ? h("p", { style: "margin-top:var(--space-2)" }, content.body) : null,
        commentsF,
        h("div", { class: "card-actions" }, approve, reject)
      );
    }

    load();
    return view;
  }

  /* ---------------------------------------------------------- */
  /* View: Portfolio dashboard (Portfolio / Mgmt / Ops only)     */
  /* ---------------------------------------------------------- */
  function PortfolioView() {
    var view = h("div", { class: "view" });
    view.appendChild(sectionHeader("Portfolio dashboard", "Active themes, overlap hotspots, reuse rate and capability gaps across the programme."));

    var body = h("div", {});
    view.appendChild(h("section", {}, body));

    loadInto(body, function () { return api("/dashboard/portfolio"); }, function (data) {
      data = data || {};
      var totals = data.totals || {};
      var reuse = data.reuseRate;
      var reuseStr = (typeof reuse === "number") ? (reuse <= 1 ? Math.round(reuse * 100) + "%" : reuse + "%") : pick(reuse, "—");

      /* stat tiles: reuse rate + any totals provided */
      var tiles = h("div", { class: "grid-3" });
      tiles.appendChild(statTile(reuseStr, "Reuse rate"));
      Object.keys(totals).forEach(function (k) { tiles.appendChild(statTile(totals[k], k)); });
      body.appendChild(h("div", { style: "margin-bottom:var(--space-4)" }, tiles));

      /* themes */
      var themes = asList(data.themes);
      body.appendChild(h("h2", {}, "Active themes"));
      if (themes.length) {
        var tt = h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Theme"), h("th", { class: "num" }, "Count"))));
        var tbody = h("tbody", {});
        themes.forEach(function (t) {
          tbody.appendChild(h("tr", {}, h("td", {}, pick(t.key, t.name, t.theme, "—")), h("td", { class: "num" }, String(pick(t.count, 0)))));
        });
        tt.appendChild(tbody);
        body.appendChild(h("div", { class: "table-wrap" }, tt));
      } else {
        body.appendChild(emptyEl("No themes yet", "Themes appear once initiatives are indexed."));
      }

      /* overlap hotspots */
      var hotspots = asList(data.overlapHotspots);
      body.appendChild(h("h2", { style: "margin-top:var(--space-6)" }, "Overlap hotspots"));
      if (hotspots.length) {
        var ht = h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Initiative"), h("th", { class: "num" }, "Overlaps"))));
        var hbody = h("tbody", {});
        hotspots.forEach(function (o) {
          hbody.appendChild(h("tr", {}, h("td", {}, pick(o.initiativeId, o.id, "—")), h("td", { class: "num" }, String(pick(o.count, 0)))));
        });
        ht.appendChild(hbody);
        body.appendChild(h("div", { class: "table-wrap" }, ht));
      } else {
        body.appendChild(emptyEl("No overlap hotspots", "The overlap-detection workflow has not flagged clusters yet."));
      }

      /* gaps */
      var gaps = asList(data.gaps);
      body.appendChild(h("h2", { style: "margin-top:var(--space-6)" }, "Capability gaps"));
      if (gaps.length) {
        var grid = h("div", { class: "grid-2" });
        gaps.forEach(function (g) {
          var title = (typeof g === "string") ? g : pick(g.title, g.name, g.key, "Gap");
          var desc = (typeof g === "string") ? "" : pick(g.description, g.detail, "");
          grid.appendChild(h("div", { class: "card card-soft" }, h("h4", {}, title), desc ? h("p", {}, desc) : null));
        });
        body.appendChild(grid);
      } else {
        body.appendChild(emptyEl("No gaps identified", "Nothing flagged for this period."));
      }
    }, { loadingLabel: "Loading dashboard…" });

    return view;
  }

  function statTile(value, label) {
    return h("div", { class: "stat" },
      h("div", { class: "stat-value" }, String(value)),
      h("div", { class: "stat-label" }, String(label))
    );
  }

  /* ---------------------------------------------------------- */
  /* View: Knowledge graph                                       */
  /* ---------------------------------------------------------- */
  function GraphView() {
    var view = h("div", { class: "view" });
    view.appendChild(sectionHeader("Knowledge graph", "Explore how an entity connects to problems, initiatives, solutions, findings, assets and people."));

    var typeF = field({ name: "entityType", label: "Entity type", type: "select", options: ENTITY_TYPES.map(function (t) { return { value: t.key, label: t.label }; }) });
    var idF = field({ name: "id", label: "Entity id", type: "text", required: true, placeholder: "e.g. the id of a problem or initiative" });
    var out = h("div", {});
    var btn = h("button", { class: "btn btn-primary", type: "submit" }, "Load graph");

    var form = h("form", {
      onsubmit: function (e) {
        e.preventDefault();
        var type = typeF._control.value, id = idF._control.value.trim();
        if (!id) { announce("warning", "Enter an entity id."); return; }
        loadInto(out, function () {
          return api("/graph/" + encodeURIComponent(type) + "/" + encodeURIComponent(id));
        }, function (data) { renderGraph(out, data, type, id); }, { loadingLabel: "Loading graph…" });
      }
    }, h("div", { class: "row" },
      h("div", { style: "flex:1;min-width:180px" }, typeF),
      h("div", { style: "flex:2;min-width:220px" }, idF)
    ), h("div", { class: "row" }, btn));

    out.appendChild(emptyEl("No graph loaded", "Pick a type, enter an id, and load its connections."));

    view.appendChild(h("section", {}, h("div", { class: "card" }, form)));
    view.appendChild(h("section", {}, out));
    return view;
  }

  function renderGraph(container, data, rootType, rootId) {
    clear(container);
    data = data || {};
    var nodes = asList(data.nodes);
    var edges = asList(data.edges);

    if (!nodes.length) {
      container.appendChild(emptyEl("No connections", "This entity has no linked nodes in the graph."));
      return;
    }

    /* --- lightweight radial SVG --- */
    var W = 640, H = 420, cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 70;
    function nodeKey(n) { return pick(n.entityType, '') + '#' + pick(n.id, recordId(n)); }
    var rootKey = rootType + '#' + rootId;
    var pos = {};
    var rootIdx = nodes.map(nodeKey).indexOf(rootKey);
    nodes.forEach(function (n, i) {
      var key = nodeKey(n);
      if (key === rootKey || (rootIdx === -1 && i === 0)) { pos[key] = { x: cx, y: cy }; return; }
      var others = nodes.length - 1 || 1;
      var slot = (rootIdx === -1) ? i : (i < rootIdx ? i : i - 1);
      var ang = (slot / others) * Math.PI * 2 - Math.PI / 2;
      pos[key] = { x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang) };
    });

    var SVG = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("class", "graph-svg");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Knowledge graph for " + rootType + " " + rootId);

    function svgEl(name, attrs) {
      var el = document.createElementNS(SVG, name);
      for (var k in attrs) el.setAttribute(k, attrs[k]);
      return el;
    }

    edges.forEach(function (e) {
      var a = pos[pick(e.from, e.source)], b = pos[pick(e.to, e.target)];
      if (!a || !b) return;
      svg.appendChild(svgEl("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: "rgba(20,20,50,0.2)", "stroke-width": "1.5" }));
    });

    nodes.forEach(function (n) {
      var key = nodeKey(n);
      var nid = pick(n.id, recordId(n));
      var p = pos[key];
      if (!p) return;
      var isRoot = key === rootKey;
      svg.appendChild(svgEl("circle", {
        cx: p.x, cy: p.y, r: isRoot ? 12 : 8,
        fill: isRoot ? "#5B54F5" : "#FFFFFF",
        stroke: isRoot ? "#322E87" : "rgba(20,20,50,0.2)", "stroke-width": "2"
      }));
      var label = svgEl("text", { x: p.x, y: p.y - 16, "text-anchor": "middle", class: "graph-node-label" });
      label.textContent = pick(n.entityType, "") + (nid ? " · " + shorten(nid) : "");
      svg.appendChild(label);
    });

    container.appendChild(h("div", { style: "margin-bottom:var(--space-4)" }, svg));

    /* --- readable node + edge lists (accessible fallback) --- */
    var nodeGrid = h("div", { class: "grid-3" });
    nodes.forEach(function (n) {
      nodeGrid.appendChild(h("div", { class: "card card-soft" },
        badge("accent", pick(n.entityType, "node")),
        h("div", { class: "meta-line" }, pick(n.id, recordId(n)))
      ));
    });
    container.appendChild(h("section", {}, h("h2", {}, "Nodes"), nodeGrid));

    if (edges.length) {
      var ul = h("ul", { class: "edge-list" });
      edges.forEach(function (e) {
        ul.appendChild(h("li", {},
          h("code", { class: "inline" }, shorten(pick(e.from, e.source, "?"))),
          " —" + pick(e.type, "related") + "→ ",
          h("code", { class: "inline" }, shorten(pick(e.to, e.target, "?")))
        ));
      });
      container.appendChild(h("section", {}, h("h2", {}, "Edges"), h("div", { class: "card" }, ul)));
    }
  }

  function shorten(v) {
    v = String(v);
    return v.length > 28 ? v.slice(0, 26) + "…" : v;
  }

  /* ---------------------------------------------------------- */
  /* Shared: section header (masthead style)                     */
  /* ---------------------------------------------------------- */
  function sectionHeader(title, lead) {
    return h("header", { class: "masthead" },
      h("span", { class: "tag" }, "Digital Hub"),
      h("h1", {}, title),
      lead ? h("p", {}, lead) : null
    );
  }

  /* ---------------------------------------------------------- */
  /* Boot                                                        */
  /* ---------------------------------------------------------- */

  /* Escape dismisses the sidebar while it is covering the content */
  document.addEventListener("keydown", function (e) {
    if ((e.key === "Escape" || e.key === "Esc") && state.navOpen && !isWideViewport()) closeNav();
  });

  /* Crossing the breakpoint re-applies that size's default, so a sidebar opened
     on a wide window does not end up parked over a narrowed one */
  (function () {
    var mq = window.matchMedia(WIDE_NAV);
    var onChange = function (e) { setNav(e.matches); };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange);
  })();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
