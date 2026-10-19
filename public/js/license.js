/*
 * PixelQG — licence gate (window.HQLicense).
 *
 * Without a valid licence certificate the server answers 402 on every API route except
 * /api/license/* (pixelqg-site/docs/ACCOUNTS.md §2). This module asks GET /api/license, shows the
 * full-screen pixel login window while the app is not licensed, signs in through
 * POST /api/license/login, and adds the account button to the HUD toolbar (licence e-mail,
 * « Se déconnecter de ce PC ») plus the small « mode développeur » ribbon. main.js boots the
 * office only once this module calls onUnlocked.
 *
 * Safety rule: the DOM is built with createElement / textContent only. Nothing here parses HTML.
 */
(function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const DEFAULT_ACCOUNT_URL = 'https://pixelqg-site.pages.dev/compte.html';
  const GET_TIMEOUT = 20000;
  // Login = Supabase sign-in + licence activation on the server side (15 s timeout each).
  const LOGIN_TIMEOUT = 45000;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

  const FALLBACK_ERRORS = {
    0: 'Serveur PixelQG injoignable : vérifie qu\'il est toujours lancé, puis réessaie.',
    400: 'E-mail ou mot de passe incorrect.',
    402: 'Aucune licence active sur ce compte.',
    409: 'Trop d\'appareils : libère un PC depuis ton compte.',
    429: 'Trop de tentatives : patiente une minute avant de réessayer.',
    503: 'Impossible de joindre le serveur des licences : vérifie ta connexion Internet.',
    504: 'Le serveur des licences ne répond pas : réessaie dans un instant.'
  };

  const USER_ICON = ['..####..', '..####..', '..####..', '........', '.######.', '########', '########', '........'];
  const LOCK_ICON = ['..####..', '.#....#.', '.#....#.', '########', '###..###', '###..###', '########', '........'];

  const cb = { onUnlocked: null, onLocked: null };
  let token = '';
  let state = null;
  let unlocked = false;
  let checking = null;
  let gate = null;      // login window refs
  let account = null;   // toolbar button + menu refs
  let ribbon = null;

  // ------------------------------------------------------------------ helpers

  function str(v) {
    return v === null || v === undefined ? '' : String(v);
  }

  /** Minimal DOM builder. Children may be nodes or strings (inserted as text). */
  function h(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const key of Object.keys(attrs)) {
        const v = attrs[key];
        if (v === null || v === undefined || v === false) continue;
        if (key === 'class') node.className = v;
        else if (key === 'text') node.textContent = str(v);
        else if (key === 'hidden') node.hidden = true;
        else if (key.startsWith('on') && typeof v === 'function') node.addEventListener(key.slice(2), v);
        else node.setAttribute(key, v === true ? '' : String(v));
      }
    }
    if (children !== undefined && children !== null) {
      for (const c of Array.isArray(children) ? children : [children]) {
        if (c === null || c === undefined || c === false) continue;
        node.append(c instanceof Node ? c : str(c));
      }
    }
    return node;
  }

  function svgEl(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const key of Object.keys(attrs)) node.setAttribute(key, String(attrs[key]));
    return node;
  }

  /** 8×8 pixel icon drawn in currentColor. */
  function pixelIcon(rows) {
    const svg = svgEl('svg', { viewBox: '0 0 8 8', class: 'px-icon', 'aria-hidden': 'true', focusable: 'false', 'shape-rendering': 'crispEdges' });
    let d = '';
    rows.forEach((row, y) => {
      let x = 0;
      while (x < row.length) {
        if (row[x] !== '#') { x++; continue; }
        let w = 1;
        while (row[x + w] === '#') w++;
        d += 'M' + x + ' ' + y + 'h' + w + 'v1h-' + w + 'z';
        x += w;
      }
    });
    svg.appendChild(svgEl('path', { d, fill: 'currentColor' }));
    return svg;
  }

  /** The PixelQG mascot, same pixels as the HUD brand mark. */
  function brandMark() {
    const svg = svgEl('svg', { viewBox: '0 0 16 16', class: 'lic-mark', 'aria-hidden': 'true', focusable: 'false', 'shape-rendering': 'crispEdges' });
    const rects = [
      [2, 4, 12, 7, '#D97757'], [2, 4, 12, 1, '#F0A37F'], [2, 10, 12, 1, '#B65F42'], [0, 6, 2, 2, '#D97757'],
      [14, 6, 2, 2, '#B65F42'], [5, 6, 1, 2, '#1A1012'], [10, 6, 1, 2, '#1A1012'], [3, 11, 1, 2, '#B65F42'],
      [5, 11, 1, 2, '#B65F42'], [10, 11, 1, 2, '#B65F42'], [12, 11, 1, 2, '#B65F42']
    ];
    for (const [x, y, w, hgt, fill] of rects) svg.appendChild(svgEl('rect', { x, y, width: w, height: hgt, fill }));
    return svg;
  }

  /** Account page on the site (https only, else the default address). */
  function accountUrl() {
    const raw = state && typeof state.accountUrl === 'string' ? state.accountUrl : DEFAULT_ACCOUNT_URL;
    try {
      const u = new URL(raw);
      if (u.protocol === 'https:') return u.href;
    } catch (_) {
      /* malformed: fall back */
    }
    return DEFAULT_ACCOUNT_URL;
  }

  function externalLink(label, cls) {
    return h('a', { class: cls, href: accountUrl(), target: '_blank', rel: 'noopener' }, label);
  }

  function fmtDay(ms) {
    try {
      return new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
    } catch (_) {
      return new Date(ms).toISOString().slice(0, 10);
    }
  }

  function call(fn, ...args) {
    if (typeof fn !== 'function') return;
    try {
      fn(...args);
    } catch (err) {
      console.error('[PixelQG] licence : rappel en erreur.', err);
    }
  }

  async function request(method, path, body, timeoutMs) {
    const headers = { 'X-HQ-Token': token, Accept: 'application/json' };
    const init = { method, headers, cache: 'no-store', credentials: 'same-origin' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || GET_TIMEOUT);
    init.signal = ctrl.signal;
    try {
      const res = await fetch(path, init);
      let data = null;
      try {
        data = await res.json();
      } catch (_) {
        data = null;
      }
      return { status: res.status, data };
    } catch (err) {
      return { status: 0, data: null, timeout: !!(err && err.name === 'AbortError') };
    } finally {
      clearTimeout(timer);
    }
  }

  function errorText(r) {
    if (r.status === 401) return 'Session expirée : le serveur PixelQG a redémarré. Recharge la page.';
    const msg = r.data && typeof r.data.error === 'string' ? r.data.error.trim() : '';
    if (msg) return msg;
    if (r.timeout) return 'PixelQG ne répond pas (délai dépassé) : réessaie.';
    return FALLBACK_ERRORS[r.status] || 'Erreur inattendue (' + r.status + ').';
  }

  // ------------------------------------------------------------------ login window

  function buildGate() {
    const email = h('input', {
      type: 'email', id: 'lic-email', class: 'input', autocomplete: 'email', spellcheck: 'false',
      maxlength: '320', placeholder: 'toi@exemple.fr', required: true
    });
    const password = h('input', {
      type: 'password', id: 'lic-password', class: 'input', autocomplete: 'current-password',
      maxlength: '1024', required: true
    });
    const error = h('p', { class: 'lic-msg lic-msg--err', id: 'lic-error', role: 'alert', hidden: true });
    const info = h('p', { class: 'lic-msg lic-msg--info', id: 'lic-info', role: 'status', hidden: true });
    const label = h('span', { 'data-label': '' }, 'Se connecter');
    const submit = h('button', { type: 'submit', class: 'btn btn-primary lic-submit' }, label);
    const retry = h('button', { type: 'button', class: 'btn btn-sm', hidden: true }, 'Réessayer');
    const reload = h('button', { type: 'button', class: 'btn btn-sm btn-primary', hidden: true }, 'Recharger la page');
    const create = externalLink('Créer un compte', 'btn btn-sm btn-ghost lic-link');
    const buy = externalLink('Acheter PixelQG', 'btn btn-sm lic-link lic-link--buy');

    const form = h('form', { class: 'lic-form', novalidate: true, autocomplete: 'on' }, [
      h('div', { class: 'field' }, [h('label', { for: 'lic-email' }, 'E-mail'), email]),
      h('div', { class: 'field' }, [h('label', { for: 'lic-password' }, 'Mot de passe'), password]),
      error,
      info,
      h('div', { class: 'lic-retry' }, [retry, reload]),
      submit
    ]);

    const root = h('div', { class: 'lic-gate', id: 'license-gate', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'lic-title' }, [
      h('section', { class: 'lic-win' }, [
        h('header', { class: 'win-head' }, [
          h('span', { class: 'win-ico' }, pixelIcon(LOCK_ICON)),
          h('h2', { class: 'win-title', id: 'lic-title' }, 'Connexion'),
          h('span', { class: 'win-hint' }, 'Licence PixelQG')
        ]),
        h('div', { class: 'lic-body' }, [
          h('div', { class: 'lic-hero' }, [
            brandMark(),
            h('div', null, [
              h('p', { class: 'lic-brand' }, 'PixelQG'),
              h('p', { class: 'lic-sub' }, 'Connecte-toi avec ton compte pour ouvrir ton bureau.')
            ])
          ]),
          form,
          h('div', { class: 'lic-links' }, [create, buy]),
          h('p', { class: 'lic-note' }, 'Une licence fonctionne sur 3 PC. Sans Internet, PixelQG reste ouvert jusqu\'à 14 jours après ta dernière connexion.')
        ])
      ])
    ]);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submitLogin();
    });
    retry.addEventListener('click', () => {
      setGateMessage('', '');
      check();
    });
    reload.addEventListener('click', () => window.location.reload());
    for (const input of [email, password]) {
      input.addEventListener('input', () => {
        if (!error.hidden) setGateMessage('', '');
      });
    }
    gate = { root, form, email, password, error, info, submit, label, retry, reload, create, buy, busy: false, shown: false };
    return gate;
  }

  /** kind: 'err' | 'info' | '' (clears). opts: { code, retry, reload } */
  function setGateMessage(kind, text, opts) {
    if (!gate) return;
    const o = opts || {};
    gate.error.textContent = kind === 'err' ? text : '';
    gate.error.hidden = kind !== 'err' || !text;
    gate.info.textContent = kind === 'info' ? text : '';
    gate.info.hidden = kind !== 'info' || !text;
    gate.retry.hidden = !o.retry;
    gate.reload.hidden = !o.reload;
    gate.buy.classList.toggle('is-hot', o.code === 'no_license');
    gate.create.classList.toggle('is-hot', o.code === 'too_many_devices');
  }

  function setGateBusy(on) {
    gate.busy = on;
    gate.submit.setAttribute('aria-busy', on ? 'true' : 'false');
    if (on) gate.submit.setAttribute('aria-disabled', 'true');
    else gate.submit.removeAttribute('aria-disabled');
    gate.label.textContent = on ? 'Connexion…' : 'Se connecter';
  }

  /** The office behind the login window is neither focusable nor read out. */
  function setAppInert(on) {
    for (const node of document.querySelectorAll('#app, body > .skip-link')) {
      node.inert = on;
      if (on) node.setAttribute('aria-hidden', 'true');
      else node.removeAttribute('aria-hidden');
    }
  }

  function showGate(st) {
    if (!gate) buildGate();
    closeMenu();
    if (!gate.root.isConnected) document.body.appendChild(gate.root);
    setAppInert(true);
    if (st && st.email && !gate.email.value) gate.email.value = str(st.email);
    if (st && st.error && gate.error.hidden && gate.info.hidden) setGateMessage('info', str(st.error));
    if (!gate.shown) {
      gate.shown = true;
      const target = gate.email.value ? gate.password : gate.email;
      setTimeout(() => target.focus(), 30);
    }
  }

  function hideGate() {
    if (!gate) return;
    gate.password.value = '';
    gate.shown = false;
    setGateMessage('', '');
    gate.root.remove();
    setAppInert(false);
  }

  async function submitLogin() {
    if (!gate || gate.busy) return;
    const email = gate.email.value.trim();
    const password = gate.password.value;
    if (!email || !password) {
      setGateMessage('err', 'Indique ton e-mail et ton mot de passe.');
      (email ? gate.password : gate.email).focus();
      return;
    }
    if (!EMAIL_RE.test(email)) {
      setGateMessage('err', 'Adresse e-mail invalide : vérifie ce que tu as saisi.');
      gate.email.focus();
      return;
    }
    setGateMessage('', '');
    setGateBusy(true);
    const r = await request('POST', '/api/license/login', { email, password }, LOGIN_TIMEOUT);
    setGateBusy(false);
    if (r.status === 200 && r.data && r.data.ok && r.data.license && r.data.license.licensed) {
      apply(r.data.license, { fresh: true });
      return;
    }
    const code = r.data && typeof r.data.code === 'string' ? r.data.code : '';
    if (code === 'invalid_credentials') {
      gate.password.value = '';
      gate.password.focus();
    }
    setGateMessage('err', errorText(r), { code, reload: r.status === 401 });
  }

  // ------------------------------------------------------------------ HUD: account button + menu

  function buildAccount() {
    const toolbar = document.getElementById('toolbar');
    if (!toolbar) return null;
    const btn = h('button', {
      type: 'button', class: 'tb', id: 'tb-account', 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
      'aria-controls': 'lic-menu', 'aria-label': 'Compte et licence', 'data-tip': 'Compte et licence'
    }, h('span', { class: 'tb-ico' }, pixelIcon(USER_ICON)));
    toolbar.append(h('span', { class: 'tb-sep', 'aria-hidden': 'true' }), btn);

    const email = h('p', { class: 'lic-menu-email' });
    const status = h('p', { class: 'lic-menu-status' });
    const manage = externalLink('Gérer mon compte', 'btn btn-sm btn-ghost');
    const logout = h('button', { type: 'button', class: 'btn btn-sm btn-warn' }, 'Se déconnecter de ce PC');
    const yesLabel = h('span', null, 'Oui, me déconnecter');
    const yes = h('button', { type: 'button', class: 'btn btn-sm btn-danger' }, yesLabel);
    const no = h('button', { type: 'button', class: 'btn btn-sm btn-ghost' }, 'Annuler');
    const confirm = h('div', { class: 'lic-confirm', role: 'group', 'aria-labelledby': 'lic-confirm-q', hidden: true }, [
      h('p', { class: 'lic-confirm-q', id: 'lic-confirm-q' }, 'Libérer ce PC et revenir à l\'écran de connexion ? Tes agents en cours continuent.'),
      h('div', { class: 'lic-confirm-actions' }, [yes, no])
    ]);
    const error = h('p', { class: 'lic-msg lic-msg--err', role: 'alert', hidden: true });
    const actions = h('div', { class: 'lic-menu-actions' }, [manage, logout]);
    const menu = h('div', { class: 'lic-menu px-panel', id: 'lic-menu', role: 'dialog', 'aria-label': 'Compte et licence', hidden: true }, [
      h('p', { class: 'px-label' }, 'Licence'),
      email,
      status,
      actions,
      confirm,
      error
    ]);
    document.body.appendChild(menu);

    btn.addEventListener('click', () => (menu.hidden ? openMenu() : closeMenu()));
    logout.addEventListener('click', () => {
      confirm.hidden = false;
      logout.hidden = true;
      no.focus();
    });
    no.addEventListener('click', () => {
      resetConfirm();
      logout.focus();
    });
    yes.addEventListener('click', () => doLogout());
    // Capture phase: the menu closes before main.js / ui.js see the Escape key.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || menu.hidden || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
      btn.focus();
    }, true);
    document.addEventListener('pointerdown', (e) => {
      if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) closeMenu();
    }, true);
    window.addEventListener('resize', () => {
      if (!menu.hidden) placeMenu();
    });
    account = { btn, menu, email, status, manage, logout, confirm, yes, yesLabel, no, error, busy: false };
    return account;
  }

  function resetConfirm() {
    if (!account) return;
    account.confirm.hidden = true;
    account.logout.hidden = !(state && state.mode === 'active');
  }

  function placeMenu() {
    const r = account.btn.getBoundingClientRect();
    account.menu.style.top = Math.round(r.bottom + 8) + 'px';
    account.menu.style.right = Math.max(8, Math.round(window.innerWidth - r.right)) + 'px';
  }

  function openMenu() {
    if (!account) return;
    renderAccount();
    account.error.hidden = true;
    resetConfirm();
    account.menu.hidden = false;
    account.btn.setAttribute('aria-expanded', 'true');
    account.btn.classList.add('is-open');
    placeMenu();
    const first = account.logout.hidden ? account.manage : account.logout;
    first.focus();
  }

  function closeMenu() {
    if (!account || account.menu.hidden) return;
    account.menu.hidden = true;
    account.btn.setAttribute('aria-expanded', 'false');
    account.btn.classList.remove('is-open');
    resetConfirm();
  }

  function renderAccount() {
    if (!state || !state.licensed) return;
    if (!account && !buildAccount()) return;
    const dev = state.mode !== 'active';
    account.email.textContent = dev ? 'Mode développeur' : str(state.email) || 'Compte PixelQG';
    let status;
    if (dev) status = 'Les comptes ne sont pas configurés dans cette version : aucune licence n\'est vérifiée.';
    else if (!state.expiresAt) status = 'Licence active sur ce PC.';
    else if (state.offline) status = 'Hors ligne : PixelQG reste ouvert jusqu\'au ' + fmtDay(state.expiresAt) + '. Reconnecte-toi à Internet d\'ici là.';
    else status = 'Licence active sur ce PC, renouvelée toute seule (valable jusqu\'au ' + fmtDay(state.expiresAt) + ').';
    account.status.textContent = status;
    account.manage.href = accountUrl();
    if (account.confirm.hidden) account.logout.hidden = dev;
  }

  async function doLogout() {
    if (!account || account.busy) return;
    account.busy = true;
    account.error.hidden = true;
    account.yes.setAttribute('aria-busy', 'true');
    account.yes.setAttribute('aria-disabled', 'true');
    account.yesLabel.textContent = 'Déconnexion…';
    const r = await request('POST', '/api/license/logout', {}, LOGIN_TIMEOUT);
    account.busy = false;
    account.yes.removeAttribute('aria-busy');
    account.yes.removeAttribute('aria-disabled');
    account.yesLabel.textContent = 'Oui, me déconnecter';
    if (r.status === 200 && r.data && r.data.ok) {
      closeMenu();
      const st = r.data.license && typeof r.data.license === 'object' ? r.data.license : Object.assign({}, state, { licensed: false, mode: 'locked', email: null });
      apply(st);
      const message = typeof r.data.message === 'string' ? r.data.message : 'Tu es déconnecté de ce PC.';
      setGateMessage('info', message);
      return;
    }
    account.error.textContent = errorText(r);
    account.error.hidden = false;
  }

  // ------------------------------------------------------------------ developer ribbon

  function renderRibbon() {
    const on = !!(state && state.devMode);
    if (on && !ribbon) {
      ribbon = h('div', {
        class: 'lic-dev', role: 'status',
        title: 'Comptes non configurés (server/cloud-config.js) : la licence n\'est pas vérifiée.'
      }, 'Mode développeur');
      document.body.appendChild(ribbon);
    }
    if (ribbon) ribbon.hidden = !on;
  }

  // ------------------------------------------------------------------ state

  function apply(st, opts) {
    if (!st || typeof st !== 'object') return;
    state = st;
    renderRibbon();
    if (st.licensed) {
      renderAccount();
      hideGate();
      if (!unlocked) {
        unlocked = true;
        call(cb.onUnlocked, st, { fresh: !!(opts && opts.fresh) });
      }
      return;
    }
    showGate(st);
    if (unlocked) {
      unlocked = false;
      call(cb.onLocked, st);
    }
  }

  /** Asks the server for the licence state (boot, stream failures, 402 answers). */
  function check() {
    if (checking) return checking;
    checking = (async () => {
      const r = await request('GET', '/api/license');
      if (r.status === 200 && r.data && r.data.ok && r.data.license) {
        apply(r.data.license);
        return;
      }
      // Before the first unlock the gate explains why nothing loads; afterwards main.js shows
      // the connection state (server down, session expired) itself.
      if (!unlocked) {
        showGate(null);
        setGateMessage('err', errorText(r), { retry: r.status !== 401, reload: r.status === 401 });
      }
    })().finally(() => {
      checking = null;
    });
    return checking;
  }

  /**
   * options: { token, onUnlocked(state, { fresh }), onLocked(state) }.
   * onUnlocked runs once the server says the app is licensed (again after each re-login).
   */
  function init(options) {
    const o = options || {};
    token = typeof o.token === 'string' ? o.token : '';
    cb.onUnlocked = typeof o.onUnlocked === 'function' ? o.onUnlocked : null;
    cb.onLocked = typeof o.onLocked === 'function' ? o.onLocked : null;
    check();
  }

  window.HQLicense = {
    init,
    check,
    /** Licence state pushed by the server (SSE « license » event, config). */
    update: (st) => apply(st),
    isUnlocked: () => unlocked,
    state: () => state
  };
})();
