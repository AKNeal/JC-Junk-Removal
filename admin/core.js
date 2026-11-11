// Shared helpers for every /admin page: talk to the server, check the login, brand header.

export async function api(path, { method = "GET", body } = {}) {
  let r;
  try {
    r = await fetch(path, {
      method, credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw { status: 0, error: "No connection. Check signal and try again." };
  }
  let data = {};
  try { data = await r.json(); } catch (_) {}
  if (!r.ok) throw { status: r.status, error: data.error || "Something went wrong.", code: data.code };
  return data;
}

export const whoAmI = () => api("/api/admin/login");

/** For inner pages: bounce to /admin/ unless logged in (and not stuck on "pick a new password"). */
export async function requireStaff() {
  try {
    const s = await whoAmI();
    if (s.user && !s.user.mustChange) return s.user;
  } catch (_) {}
  location.replace("/admin/");
  return new Promise(() => {});
}

export const isFull = (u) => u && (u.role === "owner" || u.role === "admin");

export async function signOutNow() {
  try { await api("/api/admin/login", { method: "DELETE" }); } catch (_) {}
  location.replace("/admin/");
}

export function header(title, { back = false } = {}) {
  return `
  <header class="top">
    <div class="badge">Est. 2026</div>
    <div class="wordmark">JC'S <span>Junk</span> Removal</div>
    <div class="sub">${title}</div>
    <div class="divider"></div>
    ${back ? `<div class="toprow"><a href="/admin/" class="backlink">← Dashboard</a><button class="linkbtn" id="signOutBtn">Sign out</button></div>` : ""}
  </header>`;
}

export function toast(msg, ms = 2600) {
  let t = document.getElementById("toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add("show");
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove("show"), ms);
}

export const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
