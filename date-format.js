// Site-wide date display (window.usDate, plus Chart.js axis/tooltip defaults): charts hold ISO date labels (YYYY-MM-DD /
// YYYY-MM); readers see MM/DD/YYYY (MM/YYYY for monthly). Axes spanning 8+ years
// show years only, since dozens of full dates can't fit. Load right after
// Chart.js; pages that set their own x-axis tick callback are unaffected.
(function () {
  var DAY = /^(\d{4})-(\d{2})-(\d{2})/;
  var MONTH = /^(\d{4})-(\d{2})$/;

  function usDate(s) {
    s = String(s);
    var m = DAY.exec(s);
    if (m) return m[2] + "/" + m[3] + "/" + m[1];
    m = MONTH.exec(s);
    if (m) return m[2] + "/" + m[1];
    return s;
  }
  window.usDate = usDate;

  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  // Server-formatted stamps like "September 20, 2026 at 8:01 PM ET"
  window.usStamp = function (s) {
    return String(s).replace(/([A-Z][a-z]+) (\d{1,2}), (\d{4})/, function (all, mo, d, y) {
      var i = MONTHS.indexOf(mo);
      return i < 0 ? all : ("0" + (i + 1)).slice(-2) + "/" + ("0" + d).slice(-2) + "/" + y;
    }).replace(" at ", " ");
  };

  if (typeof Chart === "undefined") return;

  function spanYears(labels) {
    var a = DAY.exec(labels[0]) || MONTH.exec(labels[0]);
    var b = DAY.exec(labels[labels.length - 1]) || MONTH.exec(labels[labels.length - 1]);
    if (!a || !b) return 0;
    return (+b[1] - +a[1]) + (+b[2] - +a[2]) / 12;
  }

  Chart.defaults.scales.category.ticks.callback = function (val) {
    var label = this.getLabelForValue(val);
    var s = String(label);
    if (!DAY.test(s) && !MONTH.test(s)) return label;
    var labels = this.getLabels();
    if (spanYears(labels) < 8) return usDate(s);
    return s.slice(0, 4);
  };

  Chart.defaults.plugins.tooltip.callbacks.title = function (items) {
    if (!items.length) return "";
    var l = items[0].label;
    return DAY.test(l) || MONTH.test(l) ? usDate(l) : l;
  };
})();
