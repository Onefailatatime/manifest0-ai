(function () {
  // Admins sign in with an emailed link (src/auth.ts); the session cookie does the rest.
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var label = function (s) { return s === "card" ? "Card" : s === "direct" ? "Typed or direct" : s === "web" ? "Another website" : s === "email" ? "Email" : s; };
  var post = function (path, body) { return fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); };
  var showErr = function (msg) { $("err").textContent = msg; $("err").classList.add("show"); };

  function applicant(a) {
    // The form asks only for email and company; name, state, role, phone and sizes show when present.
    var who = [a.company, a.role, a.state].filter(Boolean).map(esc).join(" · ");
    var more = [a.phone, a.field_workers ? a.field_workers + " field workers" : "", a.containers_per_month ? a.containers_per_month + " containers/month" : ""]
      .filter(Boolean).map(esc).join(" · ");
    var src = a.source && a.source !== "direct" ? ' <span class="pill src">From ' + esc(label(a.source).toLowerCase()) + "</span>" : "";
    return '<div class="app' + (a.approved ? "" : " pending") + '">' +
      '<div class="avatar" aria-hidden="true">' + esc((a.name || a.email).charAt(0)) + "</div>" +
      '<div class="who"><div class="name">' + esc(a.name || a.email) +
        (a.approved ? '<span class="pill ok">Approved</span>' : '<span class="pill wait">Waiting</span>') + src + "</div>" +
        (a.name ? '<div class="line">' + esc(a.email) + "</div>" : "") +
        (who ? '<div class="line">' + who + "</div>" : "") +
        (more ? '<div class="line">' + more + "</div>" : "") +
        '<div class="meta">Applied ' + esc(a.created_pt) + "</div></div>" +
      '<button class="btn ' + (a.approved ? "btn-quiet" : "btn-primary") + '" data-email="' + esc(a.email) + '">' +
        (a.approved ? "Resend sign-in link" : "Approve") + "</button></div>";
  }

  function load() {
    fetch("/api/landing/admin").then(function (r) { return r.json(); }).then(function (d) {
      $("login").hidden = !!d.ok; $("data").hidden = !d.ok; $("me").hidden = !d.ok;
      if (!d.ok) return;
      var pending = d.applications.filter(function (a) { return !a.approved; });
      $("kPending").textContent = pending.length;
      $("kPendingTile").classList.toggle("hot", pending.length > 0);
      $("kApps").textContent = d.totals.applications;
      $("kCard").textContent = d.totals.from_card_applications;
      $("kEmail").textContent = d.totals.from_email_applications;
      $("appCount").textContent = d.applications.length ? d.applications.length : "";
      // Waiting first, newest first within each group (the API sends newest first).
      var apps = pending.concat(d.applications.filter(function (a) { return a.approved; }));
      $("apps").innerHTML = apps.map(applicant).join("") || '<div class="empty">No applications yet.</div>';
      $("srcRows").innerHTML = d.sources.map(function (s) {
        return "<tr><td>" + esc(label(s.source)) + '</td><td class="n">' + s.visits + '</td><td class="n">' + s.app_clicks + '</td><td class="n">' + s.applications + "</td></tr>";
      }).join("") || '<tr><td colspan="4" class="empty">Nothing yet.</td></tr>';
    }).catch(function () { showErr("Network problem."); });
    fetch("/api/auth/get-session").then(function (r) { return r.json(); }).then(function (s) {
      $("meEmail").textContent = (s && s.user && s.user.email) || "";
    }).catch(function () {});
  }

  $("apps").addEventListener("click", function (e) {
    var b = e.target.closest("[data-email]"); if (!b) return;
    b.disabled = true; b.textContent = "Sending…";
    post("/api/landing/approve", { email: b.dataset.email }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) { b.disabled = false; b.textContent = "Try again"; showErr(d.error || "Could not approve."); return; }
      b.textContent = "Sign-in link sent"; setTimeout(load, 1200);
    }).catch(function () { b.disabled = false; b.textContent = "Try again"; showErr("Network problem."); });
  });
  $("signinForm").addEventListener("submit", function (e) {
    e.preventDefault();
    post("/api/auth/sign-in/magic-link", { email: $("email").value.trim(), callbackURL: "/admin/" }).then(function (r) {
      if (!r.ok) { showErr("Could not send the link. Try again in a minute."); return; }
      $("signinForm").hidden = true; $("sent").hidden = false;
    }).catch(function () { showErr("Network problem."); });
  });
  $("lock").onclick = function () { post("/api/auth/sign-out", {}).then(function () { location.reload(); }); };
  $("csv").onclick = function () {
    fetch("/api/landing/admin.csv").then(function (r) { return r.blob(); }).then(function (b) {
      var a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = "beta-applications.csv"; a.click();
    });
  };
  load();
})();
