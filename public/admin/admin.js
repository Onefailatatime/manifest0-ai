(function () {
  var KEY = "m0_admin_key", $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var label = function (s) { return s === "card" ? "Card" : s === "direct" ? "Typed or direct" : s === "web" ? "Another website" : s === "email" ? "Email" : s; };
  function load(key) {
    fetch("/api/landing/admin", { headers: { "x-admin-key": key } }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) { sessionStorage.removeItem(KEY); $("err").textContent = d.error || "Could not load."; $("err").classList.add("show"); return; }
      sessionStorage.setItem(KEY, key);
      $("login").hidden = true; $("data").hidden = false; $("lock").hidden = false;
      $("kApps").textContent = d.totals.applications; $("kCard").textContent = d.totals.from_card_applications;
      $("kCardVisits").textContent = d.totals.from_card_visits; $("kEmail").textContent = d.totals.from_email_applications;
      $("srcRows").innerHTML = d.sources.map(function (s) { return "<tr><td>" + esc(label(s.source)) + "</td><td>" + s.visits + "</td><td>" + s.app_clicks + "</td><td>" + s.applications + "</td></tr>"; }).join("") || '<tr><td colspan="4">Nothing yet.</td></tr>';
      $("apps").innerHTML = d.applications.map(function (a) {
        // The form asks only for email and company; name, state, role and field workers show when present.
        var who = [a.company, a.state, a.role].filter(Boolean).map(esc).join(" &middot; ");
        var more = [a.field_workers ? "Field workers: " + esc(a.field_workers) : "", a.containers_per_month ? "Containers per month: " + esc(a.containers_per_month) : ""].filter(Boolean).join(" &middot; ");
        return '<div class="app"><h3>' + esc(a.name || a.email) + (a.from_card ? ' <span class="badge">From card</span>' : a.from_email ? ' <span class="badge">From email</span>' : "") + "</h3>" +
          "<p>" + who + "</p><p>" + esc(a.email) + (a.phone ? " &middot; " + esc(a.phone) : "") + "</p>" +
          (more ? "<p>" + more + "</p>" : "") +
          "<p>Applied " + esc(a.created_pt) + " &middot; Came from " + esc(label(a.source || "direct")) + "</p></div>";
      }).join("") || "<p>No applications yet.</p>";
    }).catch(function () { $("err").textContent = "Network problem."; $("err").classList.add("show"); });
  }
  $("keyForm").addEventListener("submit", function (e) { e.preventDefault(); load($("key").value.trim()); });
  $("lock").onclick = function () { sessionStorage.removeItem(KEY); location.reload(); };
  $("csv").onclick = function () {
    fetch("/api/landing/admin.csv", { headers: { "x-admin-key": sessionStorage.getItem(KEY) || "" } }).then(function (r) { return r.blob(); }).then(function (b) {
      var a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = "beta-applications.csv"; a.click();
    });
  };
  var saved = sessionStorage.getItem(KEY); if (saved) load(saved);
})();
