(function () {
  // Admins sign in with an emailed link (src/auth.ts); the session cookie does the rest.
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var label = function (s) { return s === "card" ? "Card" : s === "direct" ? "Typed or direct" : s === "web" ? "Another website" : s === "email" ? "Email" : s; };
  var post = function (path, body) { return fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); };
  var showErr = function (msg) { $("err").textContent = msg; $("err").classList.add("show"); };
  function load() {
    fetch("/api/landing/admin").then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) { $("login").hidden = false; $("data").hidden = true; $("lock").hidden = true; return; }
      $("login").hidden = true; $("data").hidden = false; $("lock").hidden = false;
      $("kApps").textContent = d.totals.applications; $("kCard").textContent = d.totals.from_card_applications;
      $("kCardVisits").textContent = d.totals.from_card_visits; $("kEmail").textContent = d.totals.from_email_applications;
      $("srcRows").innerHTML = d.sources.map(function (s) { return "<tr><td>" + esc(label(s.source)) + "</td><td>" + s.visits + "</td><td>" + s.app_clicks + "</td><td>" + s.applications + "</td></tr>"; }).join("") || '<tr><td colspan="4">Nothing yet.</td></tr>';
      $("apps").innerHTML = d.applications.map(function (a) {
        // The form asks only for email and company; name, state, role and field workers show when present.
        var who = [a.company, a.state, a.role].filter(Boolean).map(esc).join(" &middot; ");
        var more = [a.field_workers ? "Field workers: " + esc(a.field_workers) : "", a.containers_per_month ? "Containers per month: " + esc(a.containers_per_month) : ""].filter(Boolean).join(" &middot; ");
        return '<div class="app"><h3>' + esc(a.name || a.email) + (a.from_card ? ' <span class="badge">From card</span>' : a.from_email ? ' <span class="badge">From email</span>' : "") +
          (a.approved ? ' <span class="badge">Approved</span>' : "") + "</h3>" +
          "<p>" + who + "</p><p>" + esc(a.email) + (a.phone ? " &middot; " + esc(a.phone) : "") + "</p>" +
          (more ? "<p>" + more + "</p>" : "") +
          "<p>Applied " + esc(a.created_pt) + " &middot; Came from " + esc(label(a.source || "direct")) + "</p>" +
          '<button class="btn-secondary approve" data-email="' + esc(a.email) + '">' + (a.approved ? "Resend sign-in link" : "Approve and email sign-in link") + "</button></div>";
      }).join("") || "<p>No applications yet.</p>";
    }).catch(function () { showErr("Network problem."); });
  }
  $("apps").addEventListener("click", function (e) {
    var b = e.target.closest("[data-email]"); if (!b) return;
    b.disabled = true;
    post("/api/landing/approve", { email: b.dataset.email }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) { b.disabled = false; showErr(d.error || "Could not approve."); return; }
      b.textContent = "Sign-in link sent"; load();
    }).catch(function () { b.disabled = false; showErr("Network problem."); });
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
