/* =========================================================================
   auth.js — Login, session and role-based access control.
   PROTOTYPE ONLY: demo users live in the browser. When the Python backend
   is added, login() will POST to /api/login and store the returned token;
   passwords must then be hashed and checked on the server.
   ========================================================================= */
const Auth = (() => {
  const SESSION_KEY = 'phc_session';

  const USERS = [
    { username: 'admin', password: 'admin123', role: 'admin', name: 'National Health Admin' },
    { username: 'dho.patna', password: 'dho123', role: 'district', districtId: 'PAT', name: 'District Health Officer, Patna' },
    { username: 'dho.pune', password: 'dho123', role: 'district', districtId: 'PUN', name: 'District Health Officer, Pune' },
    { username: 'phc.danapur', password: 'phc123', role: 'phc', phcId: 'PAT-01', name: 'Medical Officer, PHC Danapur' },
    { username: 'phc.aluva', password: 'phc123', role: 'phc', phcId: 'ERN-01', name: 'Medical Officer, PHC Aluva' },
  ];

  const ROLE_LABEL = { admin: 'Admin', district: 'District Health Officer', phc: 'PHC Staff' };

  // Which roles may open which page
  const ACCESS = {
    'dashboard.html': ['admin', 'district', 'phc'],
    'phc.html': ['admin', 'district', 'phc'],
    'medicines.html': ['admin', 'district', 'phc'],
    'prediction.html': ['admin', 'district', 'phc'],
    'simulation.html': ['admin', 'district'],
    'redistribution.html': ['admin', 'district', 'phc'],
    'alerts.html': ['admin', 'district', 'phc'],
  };

  const HOME = { admin: 'dashboard.html', district: 'dashboard.html', phc: 'dashboard.html' };

  // Returns a Promise. Live mode checks the password on the server; demo mode checks USERS below.
  async function login(username, password, role) {
    if (Api.enabled) {
      let session;
      try { session = await Api.login(username.trim().toLowerCase(), password); }
      catch (e) { return { ok: false, error: e.message === 'Invalid username or password' ? 'Invalid username or password.' : e.message }; }
      if (role && session.role !== role) { Api.logout(); return { ok: false, error: `This account is not a ${ROLE_LABEL[role]} account.` }; }
      session.loginAt = new Date().toISOString();
      session.live = true;
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      return { ok: true, session, home: HOME[session.role] };
    }
    const u = USERS.find((x) => x.username === username.trim().toLowerCase() && x.password === password);
    if (!u) return { ok: false, error: 'Invalid username or password.' };
    if (role && u.role !== role) return { ok: false, error: `This account is not a ${ROLE_LABEL[role]} account.` };
    const { password: _, ...session } = u;
    session.loginAt = new Date().toISOString();
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    return { ok: true, session, home: HOME[u.role] };
  }

  function session() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch (e) { return null; }
  }

  function logout() {
    localStorage.removeItem(SESSION_KEY);
    Api.logout();
    location.href = 'index.html';
  }

  // Redirect to login if not signed in; to home page if role lacks access
  function guard() {
    const s = session();
    // Sessions from the other mode are not valid here (e.g. demo login while the backend is running)
    if (!s || (Api.enabled && (!s.live || !Api.hasToken())) || (!Api.enabled && s.live)) {
      localStorage.removeItem(SESSION_KEY); location.replace('index.html'); return null;
    }
    const page = location.pathname.split('/').pop() || 'index.html';
    const allowed = ACCESS[page];
    if (allowed && !allowed.includes(s.role)) { location.replace(HOME[s.role]); return null; }
    return s;
  }

  const can = (page) => { const s = session(); return !!s && (ACCESS[page] || []).includes(s.role); };

  // PHCs the current user is allowed to see
  function scopePHCs() {
    const s = session();
    if (!s) return [];
    if (s.role === 'admin') return DB.phcs;
    if (s.role === 'district') return DB.phcsInDistrict(s.districtId);
    return [DB.getPHC(s.phcId)];
  }

  function scopeLabel() {
    const s = session();
    if (!s) return '';
    if (s.role === 'admin') return 'National';
    if (s.role === 'district') return `${DB.getDistrict(s.districtId).name} District`;
    return DB.getPHC(s.phcId).name;
  }

  // Can this user approve a transfer between two PHCs?
  function canApprove(fromPhc, toPhc) {
    const s = session();
    if (!s) return false;
    if (s.role === 'admin') return true;
    if (s.role === 'district') return fromPhc.districtId === s.districtId || toPhc.districtId === s.districtId;
    return false;
  }

  return { USERS, ROLE_LABEL, HOME, login, session, logout, guard, can, scopePHCs, scopeLabel, canApprove };
})();
