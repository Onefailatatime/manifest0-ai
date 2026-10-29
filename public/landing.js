(function () {
  // Traffic source. A tagged link (?src=card from the printed card QR, ?src=email from our emails, or utm_source /
  // utm_campaign) wins and is remembered for 30 days in localStorage, so the tag survives reloads and coming back later
  // without the query. The apply form always sends it in the hidden "source" field.
  var SRC_KEY = "m0b_src", SRC_DAYS = 30;
  function post(url, body) {
    try { fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), keepalive: true }).catch(function () {}); } catch (e) {}
  }
  var qs = new URLSearchParams(location.search);
  function tagFromUrl() {
    var s = (qs.get("src") || qs.get("utm_source") || "").trim();
    var c = (qs.get("utm_campaign") || "").trim();
    if (!s && !c) return "";
    return (s || "campaign") + (c && c !== s ? ":" + c : "");
  }
  function stored() {
    try { var o = JSON.parse(localStorage.getItem(SRC_KEY) || "null"); return o && o.v && Date.now() - o.t < SRC_DAYS * 864e5 ? o.v : ""; } catch (e) { return ""; }
  }
  var tag = tagFromUrl();
  if (tag) {
    try { localStorage.setItem(SRC_KEY, JSON.stringify({ v: tag, t: Date.now() })); } catch (e) {}
    try {
      if (sessionStorage.getItem("m0b_visit") !== tag) {
        sessionStorage.setItem("m0b_visit", tag);
        post("/api/landing/visit", { source: tag, kind: "visit" });
      }
    } catch (e) {}
  }
  var source = tag || stored() || (document.referrer && document.referrer.indexOf(location.host) < 0 ? "web" : "direct");
  var src = document.getElementById("source");
  if (src) src.value = source;

  var form = document.getElementById("apply-form");
  if (!form) return;
  var alertBox = document.getElementById("apply-alert");
  var note = document.getElementById("apply-note");
  var btn = document.getElementById("apply-btn");
  var LABEL = btn.textContent;

  function say(msg) { alertBox.textContent = msg || ""; alertBox.classList.toggle("show", !!msg); note.hidden = !!msg; }
  function clearErrors() {
    form.querySelectorAll(".field.invalid").forEach(function (f) { f.classList.remove("invalid"); });
    say("");
  }
  function showErrors(errors) {
    var first = null, msgs = [];
    Object.keys(errors || {}).forEach(function (k) {
      var el = form.querySelector('[name="' + k + '"]'); if (!el) return;
      var f = el.closest(".field"); f.classList.add("invalid"); el.setAttribute("aria-invalid", "true");
      var e = f.querySelector(".err"); if (e) e.textContent = errors[k];
      msgs.push(errors[k]);
      if (!first) first = el;
    });
    if (msgs.length) say(msgs.join(" "));
    if (first) first.focus();
  }
  form.addEventListener("input", function (ev) {
    var f = ev.target.closest && ev.target.closest(".field");
    if (f && f.classList.contains("invalid")) { f.classList.remove("invalid"); ev.target.removeAttribute("aria-invalid"); }
  });
  function localCheck(d) {
    var e = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email)) e.email = "Enter a valid work email.";
    if (!d.company) e.company = "Enter your company name.";
    return e;
  }
  form.addEventListener("submit", function (ev) {
    ev.preventDefault(); clearErrors();
    var d = {}; new FormData(form).forEach(function (v, k) { d[k] = String(v).trim(); });
    var errs = localCheck(d);
    if (Object.keys(errs).length) { showErrors(errs); return; }
    btn.disabled = true; btn.textContent = "Sending...";
    fetch("/api/landing/apply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(d) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: "Something went wrong. Please try again." }; }); })
      .then(function (res) {
        if (!res.ok) { if (res.errors) showErrors(res.errors); else say(res.error || "Something went wrong."); return; }
        form.hidden = true;
        var s = document.getElementById("apply-success"); s.hidden = false;
        document.getElementById("success-email").textContent = d.email;
        s.focus({ preventScroll: true });
      })
      .catch(function () { say("Network problem. Check your connection and try again."); })
      .finally(function () { btn.disabled = false; btn.textContent = LABEL; });
  });
})();
